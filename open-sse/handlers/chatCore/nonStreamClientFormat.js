// Non-streaming responses: OpenAI Chat Completions body (the hub format) → the
// CLIENT's format. Shared by nonStreamingHandler.js and sseToJsonHandler.js, which
// cannot import each other (nonStreamingHandler already imports from sseToJsonHandler).
import { FORMATS } from "../../translator/formats.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM, RESPONSE_BODY, OPENAI_FINISH, MODEL_FALLBACK } from "../../translator/schema/index.js";

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Convert an OpenAI Chat Completions body into an Anthropic Messages `message`.
 * Bodies without `choices` are returned unchanged.
 */
export function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: CLAUDE_BLOCK.THINKING, thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: CLAUDE_BLOCK.TEXT, text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: CLAUDE_BLOCK.TOOL_USE,
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: CLAUDE_BLOCK.TEXT, text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: RESPONSE_BODY.CLAUDE_MESSAGE_TYPE,
    role: ROLE.ASSISTANT,
    model: responseBody.model || MODEL_FALLBACK,
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

/**
 * Convert an OpenAI Chat Completions body into the OpenAI Responses API shape, so
 * text, reasoning and tool calls surface as Responses `output` items.
 * Bodies without `choices` are returned unchanged.
 */
export function openAICompletionToResponses(responseBody, customToolNames = null) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;

  const message = choice.message || {};
  const output = [];

  // Reasoning → a reasoning item (summary text), mirroring the streaming path.
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    output.push({
      type: RESPONSES_ITEM.REASONING,
      summary: [{ type: RESPONSES_ITEM.SUMMARY_TEXT, text: reasoning }],
    });
  }

  // Assistant text → a message item with output_text content.
  const text = typeof message.content === "string" ? message.content : "";
  if (text.length > 0) {
    output.push({
      type: RESPONSES_ITEM.MESSAGE,
      role: ROLE.ASSISTANT,
      content: [{ type: RESPONSES_ITEM.OUTPUT_TEXT, text, annotations: [] }],
    });
  }

  // tool_calls → function_call/custom_tool_call items (Responses-native tool shape).
  for (const tc of message.tool_calls || []) {
    const fn = tc.function || {};
    const custom = customToolNames?.has(fn.name);
    output.push({
      type: custom ? RESPONSES_ITEM.CUSTOM_TOOL_CALL : RESPONSES_ITEM.FUNCTION_CALL,
      id: `${custom ? "ctc" : "fc"}_${tc.id || ""}`,
      call_id: tc.id || "",
      name: fn.name || "",
      ...(custom
        ? { input: extractCustomToolInput(fn.arguments) }
        : { arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}) }),
    });
  }

  const usage = responseBody.usage || {};
  const finish = choice.finish_reason;
  const status = (finish === OPENAI_FINISH.TOOL_CALLS || finish === OPENAI_FINISH.STOP) ? RESPONSE_BODY.RESPONSES_STATUS_COMPLETED : (finish || RESPONSE_BODY.RESPONSES_STATUS_COMPLETED);

  return {
    id: `resp_${responseBody.id || ""}`.replace(/^resp_chatcmpl-/, "resp_"),
    object: RESPONSE_BODY.RESPONSES_OBJECT,
    created_at: responseBody.created || Math.floor(Date.now() / 1000),
    model: responseBody.model || MODEL_FALLBACK,
    status,
    background: false,
    error: null,
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

/**
 * Convert an OpenAI Chat Completions body (the hub format every provider body is
 * first translated into) into the client's format: Anthropic `message` for Claude
 * clients, Responses `response` for Responses clients. Other client formats get the
 * hub body unchanged, as before.
 */
export function openAICompletionToClientFormat(responseBody, sourceFormat, customToolNames = null) {
  if (sourceFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(responseBody);
  if (sourceFormat === FORMATS.OPENAI_RESPONSES) return openAICompletionToResponses(responseBody, customToolNames);
  return responseBody;
}
