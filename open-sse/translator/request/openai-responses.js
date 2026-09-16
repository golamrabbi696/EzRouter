/**
 * Translator: OpenAI Responses API → OpenAI Chat Completions
 * 
 * Responses API uses: { input: [...], instructions: "..." }
 * Chat API uses: { messages: [...] }
 */
import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../formats/responsesApi.js";
import { ROLE, OPENAI_BLOCK, RESPONSES_ITEM } from "../schema/index.js";
import { generateToolCallId } from "../concerns/toolCall.js";

const MAX_TOOL_NAME_LEN = 128;

// JSON.stringify that never throws on circular / BigInt payloads.
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Split a Responses `function_call_output.output` into chat-safe text plus images.
 *
 * Responses allows `output` to be an array of content parts, and Codex uses that
 * to hand back screenshots produced by image tools. A chat `tool` message only
 * accepts a string, so the old `JSON.stringify(output)` fallback turned every
 * screenshot into a few hundred KB of base64 *text*. Upstream tokenizers bill
 * that as text (~1.5 chars/token), so two screenshots alone could add ~500K
 * tokens and push a 1M-context request past its limit (HTTP 400 "maximum context
 * length"). Keep the text in the tool message and re-attach the images as a
 * following user turn, which is how vision-capable chat upstreams expect them.
 *
 * @param {unknown} output - function_call_output.output (string | content parts | anything)
 * @returns {{ text: string, images: Array<{ type: string, image_url: { url: string, detail: string } }> }}
 */
function splitToolOutputContent(output) {
  if (typeof output === "string") return { text: output, images: [] };
  if (!Array.isArray(output)) return { text: coerceResponsesOutput(output), images: [] };

  const texts = [];
  const images = [];
  let contentParts = 0;

  for (const part of output) {
    if (part === undefined || part === null) continue;
    if (typeof part === "string") {
      contentParts++;
      texts.push(part);
      continue;
    }
    if (part.type === RESPONSES_ITEM.INPUT_TEXT || part.type === OPENAI_BLOCK.TEXT) {
      contentParts++;
      if (typeof part.text === "string") texts.push(part.text);
      continue;
    }
    if (part.type === RESPONSES_ITEM.INPUT_IMAGE || part.type === OPENAI_BLOCK.IMAGE_URL) {
      contentParts++;
      // Responses sends input_image with a plain string; relay chat-shaped
      // image_url { url, detail } too, and degrade to text when neither is present.
      const url = typeof part.image_url === "string"
        ? part.image_url
        : part.image_url?.url || part.file_id || "";
      const detail = typeof part.image_url === "object" ? part.image_url?.detail : part.detail;
      if (typeof url === "string" && url) {
        images.push({ type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: detail || "auto" } });
      } else {
        texts.push("[image omitted: missing image payload]");
      }
      continue;
    }
    texts.push(safeJson(part));
  }

  // Nothing looked like Responses content parts (e.g. output: [1, 2]) — keep the
  // old JSON.stringify(array) shape so this stays a pure upgrade for known shapes.
  if (contentParts === 0) return { text: safeJson(output), images: [] };
  return { text: texts.join("\n"), images };
}

/**
 * Scan a Responses API `input[]` and collect every `call_id` declared by a
 * `function_call` item. Returns a Set (possibly empty) of known call ids.
 *
 * Only `function_call` items introduce a tool call a downstream provider can
 * match a result against; other item types are ignored.
 */
function collectKnownCallIds(input) {
  const knownCallIds = new Set();
  for (const item of input) {
    if (item?.type === RESPONSES_ITEM.FUNCTION_CALL && typeof item.call_id === "string") {
      knownCallIds.add(item.call_id);
    }
  }
  return knownCallIds;
}

/**
 * Remove `function_call_output` items that reference a `call_id` with no
 * matching `function_call` in the same `input[]`.
 *
 * Clients that truncate or summarize conversation history (e.g. Codex CLI,
 * some agents) can drop the assistant turn containing the tool call while
 * keeping the subsequent tool result. The Responses API then rejects the
 * whole request with HTTP 400:
 *
 *   "No tool call found for function call output with call_id X"
 *
 * This is input validation only: it rewrites request payloads before they
 * leave the translator, regardless of provider or entry path.
 *
 * Returns the original array reference when nothing needs to change (non-array
 * input, no tool output items, or every output already has a matching call),
 * so callers can cheaply avoid cloning large inputs.
 */
function stripOrphanedToolOutputs(input) {
  if (!Array.isArray(input)) return input;
  const knownCallIds = collectKnownCallIds(input);

  const stripped = [];
  const deduped = input.filter(item => {
    if (item?.type !== RESPONSES_ITEM.FUNCTION_CALL_OUTPUT) return true;
    const hasMatch = typeof item.call_id === "string" && knownCallIds.has(item.call_id);
    if (!hasMatch) {
      console.warn(`[Translator] Stripped orphaned function_call_output (call_id=${item.call_id}) — no matching function_call in input`);
      stripped.push(item.call_id);
    }
    return hasMatch;
  });
  return stripped.length === 0 ? input : deduped;
}

/**
 * Convert OpenAI Responses API request to OpenAI Chat Completions format
 */
export function openaiResponsesToOpenAIRequest(model, body, stream, credentials) {
  if (!body.input) return body;

  const result = { ...body };
  result.messages = [];

  // Convert instructions to system message
  if (body.instructions) {
    result.messages.push({ role: ROLE.SYSTEM, content: body.instructions });
  }

  // Group items by conversation turn
  let currentAssistantMsg = null;
  let pendingToolResults = [];
  let pendingReasoning = "";
  let pendingReasoningEncrypted = "";
  const additionalTools = [];
  const customToolNames = new Set();
  // correlation ids of tool calls that have not received their *_output item yet,
  // used to repair outputs that arrive without `call_id`
  const pendingToolCallIds = [];
  let toolCallSeq = 0;

  const inputItems = stripOrphanedToolOutputs(normalizeResponsesInput(body.input));
  if (!inputItems) return body;

  // Extract reasoning text from summary[].text (encrypted_content is continuity-only)
  const extractReasoningText = (item) => {
    if (Array.isArray(item.summary)) {
      const txt = item.summary.map(s => s?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    if (Array.isArray(item.content)) {
      const txt = item.content.map(c => c?.text || "").filter(Boolean).join("\n");
      if (txt) return txt;
    }
    return "";
  };

  const attachPendingReasoning = (msg) => {
    if (pendingReasoning) msg.reasoning_content = pendingReasoning;
    if (pendingReasoningEncrypted) msg.encrypted_content = pendingReasoningEncrypted;
    pendingReasoning = "";
    pendingReasoningEncrypted = "";
  };

  for (const item of inputItems) {
    // Determine item type - Droid CLI sends role-based items without 'type' field
    // Fallback: if no type but has role property, treat as message
    const itemType = item.type || (item.role ? RESPONSES_ITEM.MESSAGE : null);

    if (itemType === RESPONSES_ITEM.MESSAGE) {
      // Flush any pending assistant message with tool calls
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush pending tool results
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }

      // Convert content: input_text → text, output_text → text, input_image → image_url
      const content = Array.isArray(item.content)
        ? item.content.map(c => {
          if (c.type === RESPONSES_ITEM.INPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.OUTPUT_TEXT) return { type: OPENAI_BLOCK.TEXT, text: c.text };
          if (c.type === RESPONSES_ITEM.INPUT_IMAGE) {
            const url = c.image_url || c.file_id || "";
            return { type: OPENAI_BLOCK.IMAGE_URL, image_url: { url, detail: c.detail || "auto" } };
          }
          return c;
        })
        : item.content;
      const msg = { role: item.role, content };
      // Chat-style tool item that leaked into the Responses endpoint (Droid/OpenCode):
      // repair its correlation id or downgrade it to user context.
      if (item.role === ROLE.TOOL && !item.tool_call_id) {
        const repairedToolId = pendingToolCallIds.shift();
        if (repairedToolId) {
          msg.tool_call_id = repairedToolId;
        } else {
          // orphaned result: salvage the text instead of sending an unpairable tool message
          msg.role = ROLE.USER;
          msg.content = `[Tool result: ${typeof item.content === "string" ? item.content : JSON.stringify(item.content)}]`;
        }
      }
      // Attach buffered reasoning to assistant turn (required by xiaomi-mimo + store=false continuity)
      if (item.role === ROLE.ASSISTANT) attachPendingReasoning(msg);
      else {
        pendingReasoning = "";
        pendingReasoningEncrypted = "";
      }
      result.messages.push(msg);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL || itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      // Start or append to assistant message with tool_calls
      if (!currentAssistantMsg) {
        currentAssistantMsg = {
          role: ROLE.ASSISTANT,
          content: null,
          tool_calls: []
        };
        attachPendingReasoning(currentAssistantMsg);
      }
      // Skip items with empty/missing name — Codex/OpenAI reject nameless tool calls (#444)
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") continue;
      if (itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL) customToolNames.add(item.name);
      const toolInput = itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL
        ? { input: typeof item.input === "string" ? item.input : JSON.stringify(item.input ?? "") }
        : item.arguments;
      // Correlation id must survive to the matching *_output item (#37xx): keep the
      // client's `call_id`, else mint one here instead of serializing `undefined`
      // (JSON.stringify drops the key, and strict upstreams then reject the whole
      // request with 400 "missing field `tool_call_id`").
      const callId = item.call_id || generateToolCallId(toolCallSeq++, currentAssistantMsg.tool_calls.length, item.name);
      currentAssistantMsg.tool_calls.push({
        id: callId,
        type: OPENAI_BLOCK.FUNCTION,
        function: {
          name: item.name,
          arguments: typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput ?? {})
        }
      });
      pendingToolCallIds.push(callId);
    }
    else if (itemType === RESPONSES_ITEM.FUNCTION_CALL_OUTPUT || itemType === RESPONSES_ITEM.CUSTOM_TOOL_CALL_OUTPUT) {
      // Flush assistant message first if exists
      if (currentAssistantMsg) {
        result.messages.push(currentAssistantMsg);
        currentAssistantMsg = null;
      }
      // Flush any pending tool results first
      if (pendingToolResults.length > 0) {
        for (const tr of pendingToolResults) {
          result.messages.push(tr);
        }
        pendingToolResults = [];
      }
      // Add tool result immediately, always carrying a usable correlation id:
      // an output whose `call_id` was dropped by the client used to serialize a
      // `role:"tool"` message without `tool_call_id`, which every strict upstream
      // rejects (NVIDIA 400 "missing field `tool_call_id`", OpenAI "must be a
      // response to a message with tool_calls").
      let outputCallId = typeof item.call_id === "string" && item.call_id ? item.call_id : "";
      if (outputCallId) {
        const queued = pendingToolCallIds.indexOf(outputCallId);
        if (queued >= 0) pendingToolCallIds.splice(queued, 1);
      } else {
        outputCallId = pendingToolCallIds.shift() || "";
      }
      if (outputCallId) {
        // Chat `tool` messages only take text, so an array output keeps its text
        // here and carries its images in a user turn.
        const { text, images } = splitToolOutputContent(item.output);
        result.messages.push({
          role: ROLE.TOOL,
          tool_call_id: outputCallId,
          content: text || (images.length > 0 ? "[tool returned images - see the next message]" : "")
        });
        if (images.length > 0) {
          result.messages.push({
            role: ROLE.USER,
            content: [{ type: OPENAI_BLOCK.TEXT, text: "[images returned by the tool result above]" }, ...images]
          });
        }
      }
      // else: orphaned output (no pending call to answer) is dropped, matching the
      // orphan-repair contract tracked in #2236 — a tool message without a call is
      // rejected by every strict upstream.
    }
    else if (itemType === RESPONSES_ITEM.ADDITIONAL_TOOLS) {
      if (Array.isArray(item.tools)) additionalTools.push(...item.tools);
    }
    else if (itemType === RESPONSES_ITEM.REASONING) {
      // Buffer reasoning text; attached to next assistant message/function_call.
      // Also stash encrypted_content so a later openai→responses hop can restore
      // the store=false continuity blob (Grok CLI / Codex multi-turn).
      const txt = extractReasoningText(item);
      if (txt) pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${txt}` : txt;
      if (typeof item.encrypted_content === "string" && item.encrypted_content) {
        // Prefer attaching to the next assistant message we create
        pendingReasoningEncrypted = item.encrypted_content;
      }
      continue;
    }
  }

  // Flush remaining
  if (currentAssistantMsg) {
    result.messages.push(currentAssistantMsg);
  }
  if (pendingToolResults.length > 0) {
    for (const tr of pendingToolResults) {
      result.messages.push(tr);
    }
  }

  // Convert tools format.
  // Responses API supports "hosted" tools (e.g. { type: "request_user_input" }) that carry no
  // explicit `name` field and cannot be represented as Chat Completions function declarations.
  // Filter them out to avoid sending nameless functionDeclarations to downstream providers
  // such as Gemini, which strictly validates function names.
  const responseTools = [
    ...(Array.isArray(body.tools) ? body.tools : []),
    ...additionalTools,
  ];
  if (responseTools.length > 0) {
    result.tools = responseTools
      .map(tool => {
        // Already in Chat Completions format: { type: "function", function: { name, ... } }
        if (tool.function) return tool;
        // Responses API function/custom tool: { type, name, description, parameters|format }.
        // Chat Completions has no freeform custom-tool declaration, so expose custom
        // tools as functions with one raw `input` string while retaining their names
        // in translator-only metadata for the response conversion.
        const name = tool.name;
        if (!name || typeof name !== "string" || name.trim() === "") return null;
        if (tool.type === "custom") {
          customToolNames.add(name);
          const formatHint = [tool.format?.syntax, tool.format?.definition].filter(Boolean).join("\n");
          return {
            type: OPENAI_BLOCK.FUNCTION,
            function: {
              name,
              description: [String(tool.description || ""), formatHint].filter(Boolean).join("\n\n"),
              parameters: {
                type: "object",
                properties: {
                  input: {
                    type: "string",
                    description: "Raw freeform input for this custom tool"
                  }
                },
                required: ["input"],
                additionalProperties: false
              }
            }
          };
        }
        // Responses API function tool: { type: "function", name, description, parameters }
        // Only convert when a non-empty name is present; skip hosted tools without one.
        return {
          type: OPENAI_BLOCK.FUNCTION,
          function: {
            name,
            description: String(tool.description || ""),
            parameters: normalizeToolParameters(tool.parameters),
            strict: tool.strict
          }
        };
      })
      .filter(Boolean);
  }
  if (customToolNames.size > 0) result._customToolNames = [...customToolNames];

  // Cleanup Responses API specific fields
  // Map Responses-only max_output_tokens to Chat max_tokens (avoid leaking unknown field upstream)
  if (result.max_output_tokens !== undefined) {
    if (result.max_tokens === undefined) result.max_tokens = result.max_output_tokens;
    delete result.max_output_tokens;
  }

  // Structured Output: Responses `text.format` → Chat `response_format` (`text` is not a Chat field)
  if (result.text !== undefined) {
    const responseFormat = textFormatToResponseFormat(result.text);
    if (responseFormat && result.response_format === undefined) result.response_format = responseFormat;
    delete result.text;
  }

  delete result.input;
  delete result.instructions;
  delete result.include;
  delete result.prompt_cache_key;
  delete result.store;
  if (typeof result.reasoning?.effort === "string") {
    result.reasoning_effort = result.reasoning.effort;
  }
  delete result.reasoning;
  delete result.client_metadata;

  return result;
}

/**
 * Extract plain text from a system/developer message for Responses instructions.
 * Array content (text parts) is joined; anything else falls back to "" rather
 * than leaking "[object Object]" upstream.
 */
function extractInstructionsText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c?.text === "string") return c.text;
      if (typeof c?.content === "string") return c.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/**
 * Ensure object schema always has properties field (required by Codex Responses API)
 */
function normalizeToolParameters(params) {
  if (!params) return { type: "object", properties: {} };
  if (params.type === "object" && !params.properties) return { ...params, properties: {} };
  return params;
}

// Share the image mapping between user content and images extracted from tool results.
function toResponsesImage(part) {
  if (part?.type === OPENAI_BLOCK.IMAGE_URL) {
    const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
    return { type: RESPONSES_ITEM.INPUT_IMAGE, image_url: url, detail: part.image_url?.detail || "auto" };
  }
  if (part?.type === RESPONSES_ITEM.INPUT_IMAGE) return part;
  return null;
}

/**
 * Build a Responses `reasoning` input item from Chat Completions assistant fields.
 * Preserves encrypted blobs needed by store=false multi-turn (Grok CLI / Codex).
 * Returns null when the message has nothing useful to re-send.
 */
function buildReasoningInputItem(msg) {
  if (!msg || typeof msg !== "object") return null;

  const encrypted =
    (typeof msg.encrypted_content === "string" && msg.encrypted_content) ||
    (typeof msg.reasoning_encrypted_content === "string" && msg.reasoning_encrypted_content) ||
    (typeof msg.reasoning?.encrypted_content === "string" && msg.reasoning.encrypted_content) ||
    "";

  let summaryText = "";
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()) {
    summaryText = msg.reasoning_content;
  } else if (typeof msg.reasoning === "string" && msg.reasoning.trim()) {
    summaryText = msg.reasoning;
  } else if (Array.isArray(msg.reasoning_details)) {
    summaryText = msg.reasoning_details
      .map((d) => (typeof d?.text === "string" ? d.text : typeof d?.content === "string" ? d.content : ""))
      .filter(Boolean)
      .join("\n");
  }

  if (!encrypted && !summaryText) return null;

  const item = { type: RESPONSES_ITEM.REASONING };
  if (summaryText) {
    item.summary = [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: summaryText }];
  }
  // encrypted_content is the continuity token for store=false backends
  if (encrypted) item.encrypted_content = encrypted;
  return item;
}

/**
 * Convert OpenAI Chat Completions to OpenAI Responses API format
 */
export function openaiToOpenAIResponsesRequest(model, body, stream, credentials) {
  if (body.input) {
    const cleanInput = stripOrphanedToolOutputs(body.input);
    const passthrough = cleanInput === body.input ? { ...body, model, stream: true } : { ...body, input: cleanInput, model, stream: true };
    // Responses API rejects Chat's max_tokens/max_completion_tokens — only max_output_tokens is valid.
    if (passthrough.max_output_tokens === undefined) {
      if (passthrough.max_completion_tokens !== undefined) passthrough.max_output_tokens = passthrough.max_completion_tokens;
      else if (passthrough.max_tokens !== undefined) passthrough.max_output_tokens = passthrough.max_tokens;
    }
    delete passthrough.max_tokens;
    delete passthrough.max_completion_tokens;
    return passthrough;
  }

  const result = {
    model,
    input: [],
    stream: true,
    store: false
  };

  // Extract system message as instructions
  let hasSystemMessage = false;
  const messages = body.messages || [];

  for (const msg of messages) {
    if (msg.role === ROLE.SYSTEM || msg.role === ROLE.DEVELOPER) {
      // Use the first instruction-bearing message as instructions.
      // OpenAI recommends role="developer" for GPT-5/Codex as the system-level prompt.
      if (!hasSystemMessage) {
        result.instructions = extractInstructionsText(msg.content);
        hasSystemMessage = true;
      }
      continue; // Skip instruction messages in input
    }

    // Convert user/assistant messages to input items
    if (msg.role === ROLE.USER || msg.role === ROLE.ASSISTANT) {
      // Multi-turn continuity for store=false Responses backends (Codex / Grok CLI):
      // re-emit a reasoning item before the assistant message when the chat-format
      // history carried reasoning text and/or encrypted_content from a prior turn.
      if (msg.role === ROLE.ASSISTANT) {
        const reasoningItem = buildReasoningInputItem(msg);
        if (reasoningItem) result.input.push(reasoningItem);
      }

      const contentType = msg.role === ROLE.USER ? RESPONSES_ITEM.INPUT_TEXT : RESPONSES_ITEM.OUTPUT_TEXT;
      const content = typeof msg.content === "string"
        ? [{ type: contentType, text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map(c => {
            if (c.type === OPENAI_BLOCK.TEXT) return { type: contentType, text: c.text };
            const image = toResponsesImage(c);
            if (image) return image;
            // Serialize any unknown type (tool_use, tool_result, thinking, etc.) as text
            const text = c.text || c.content || JSON.stringify(c);
            return { type: contentType, text: typeof text === "string" ? text : JSON.stringify(text) };
          })
          : [];

      // Only push a message block if content is non-empty.
      // Assistant messages with only tool_calls have content: null — skip the
      // message block in that case; the tool_calls are pushed separately below.
      if (content.length > 0) {
        result.input.push({
          type: RESPONSES_ITEM.MESSAGE,
          role: msg.role,
          content
        });
      }
    }

    // Convert tool calls
    if (msg.role === ROLE.ASSISTANT && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        // Skip nameless calls — strict Responses upstreams reject them (#444)
        const name = typeof tc.function?.name === "string" ? tc.function.name.trim() : "";
        if (!name) continue;
        result.input.push({
          type: RESPONSES_ITEM.FUNCTION_CALL,
          call_id: clampResponsesCallId(tc.id),
          name: name.slice(0, MAX_TOOL_NAME_LEN),
          arguments: coerceResponsesArguments(tc.function?.arguments)
        });
      }
    }

    // Keep scalar tool output for strict backends such as Codex. Images must
    // reach the visual input path, not be serialized as JSON inside output.
    if (msg.role === ROLE.TOOL) {
      const images = [];
      const output = Array.isArray(msg.content)
        ? msg.content.filter(part => {
          const image = toResponsesImage(part);
          if (!image) return true;
          images.push(image);
          return false;
        })
        : msg.content;
      result.input.push({
        type: RESPONSES_ITEM.FUNCTION_CALL_OUTPUT,
        call_id: clampResponsesCallId(msg.tool_call_id),
        output: coerceResponsesOutput(output)
      });
      if (images.length > 0) {
        result.input.push({ type: RESPONSES_ITEM.MESSAGE, role: ROLE.USER, content: images });
      }
    }
  }

  // If no system message, leave instructions empty (will be filled by executor)
  if (!hasSystemMessage) {
    result.instructions = "";
  }

  // Convert tools format
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => {
      if (tool.type === OPENAI_BLOCK.FUNCTION) {
        // Strict upstreams reject nameless/overlong tool declarations
        const name = typeof tool.function?.name === "string" ? tool.function.name.trim() : "";
        if (!name) return null;
        return {
          type: OPENAI_BLOCK.FUNCTION,
          name: name.slice(0, MAX_TOOL_NAME_LEN),
          description: String(tool.function.description || ""),
          parameters: normalizeToolParameters(tool.function.parameters),
          // Chat Completions defaults to non-strict. Responses may otherwise
          // normalize optional properties into required fields.
          strict: tool.function.strict ?? false
        };
      }
      return tool;
    }).filter(Boolean);
  }

  // Pass through other relevant fields
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.max_output_tokens !== undefined) {
    result.max_output_tokens = body.max_output_tokens;
  } else if (body.max_completion_tokens !== undefined) {
    result.max_output_tokens = body.max_completion_tokens;
  } else if (body.max_tokens !== undefined) {
    result.max_output_tokens = body.max_tokens;
  }
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.reasoning !== undefined) result.reasoning = body.reasoning;
  if (body.reasoning_effort !== undefined) result.reasoning = { effort: body.reasoning_effort, summary: "auto" };
  if (body.service_tier !== undefined) result.service_tier = body.service_tier;
  if (body.prompt_cache_key !== undefined) result.prompt_cache_key = body.prompt_cache_key;

  result.input = stripOrphanedToolOutputs(result.input);

  // Structured Output: Chat `response_format` → Responses `text.format` (#dropped otherwise)
  const textFormat = responseFormatToTextFormat(body.response_format);
  if (textFormat) result.text = { format: textFormat };

  return result;
}

/**
 * Chat Completions `response_format` → Responses API `text.format`.
 * Responses nests the schema one level up and flattens json_schema.{name,schema,strict}.
 */
function responseFormatToTextFormat(responseFormat) {
  if (responseFormat?.type === "json_schema") {
    const js = responseFormat.json_schema;
    if (!js?.schema) return null;
    return { type: "json_schema", name: js.name || "response", schema: js.schema, strict: js.strict ?? true };
  }
  if (responseFormat?.type === "json_object") return { type: "json_object" };
  return null;
}

/**
 * Responses API `text.format` → Chat Completions `response_format` (inverse of the above).
 */
function textFormatToResponseFormat(text) {
  const fmt = text?.format;
  if (fmt?.type === "json_schema" && fmt.schema) {
    return { type: "json_schema", json_schema: { name: fmt.name || "response", schema: fmt.schema, strict: fmt.strict ?? true } };
  }
  if (fmt?.type === "json_object") return { type: "json_object" };
  return null;
}

// Register both directions
register(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, openaiResponsesToOpenAIRequest, null);
register(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiToOpenAIResponsesRequest, null);
