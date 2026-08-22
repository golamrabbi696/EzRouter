import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { canonicalEchoModel } from "../../services/model.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "../../config/errorConfig.js";
import { parseSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";

/**
 * Whether a translated response actually contains something the client can use:
 * non-empty text, a tool call, or reasoning output. Providers occasionally answer
 * HTTP 200 with a fully empty body (upstream hiccup that isn't a real error status) —
 * treat that the same as an upstream failure so the account/combo fallback loop
 * moves on instead of handing the client nothing.
 */
function hasUsefulContent(translatedResponse, isClaudeMessageResponse, isResponsesResponse) {
  if (isClaudeMessageResponse) {
    const blocks = Array.isArray(translatedResponse?.content) ? translatedResponse.content : [];
    return blocks.some((b) => (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) || b?.type === "tool_use" || b?.type === "thinking");
  }
  if (isResponsesResponse) {
    return Array.isArray(translatedResponse?.output) && translatedResponse.output.length > 0;
  }
  const msg = translatedResponse?.choices?.[0]?.message;
  const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
  const hasText = typeof msg?.content === "string"
    ? msg.content.trim().length > 0
    : Array.isArray(msg?.content) && msg.content.length > 0;
  const hasReasoning = typeof msg?.reasoning_content === "string" && msg.reasoning_content.trim().length > 0;
  return hasToolCalls || hasText || hasReasoning;
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function openAICompletionToClaudeMessage(responseBody) {
  if (!responseBody?.choices?.[0]) return responseBody;
  const choice = responseBody.choices[0];
  const message = choice.message || {};
  const content = [];

  const reasoning = message.reasoning_content || message.provider_specific_fields?.reasoning_content || "";
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    content.push({ type: "text", text: message.content });
  }
  for (const toolCall of message.tool_calls || []) {
    const fn = toolCall.function || {};
    content.push({
      type: "tool_use",
      id: toolCall.id || `toolu_${Date.now()}_${content.length}`,
      name: fn.name || toolCall.name || "",
      input: parseToolArguments(fn.arguments || toolCall.arguments),
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = responseBody.usage || {};
  return {
    id: String(responseBody.id || `msg_${Date.now()}`).replace(/^chatcmpl-/, ""),
    type: "message",
    role: "assistant",
    model: responseBody.model || "unknown",
    content,
    stop_reason: fromOpenAIFinish(choice.finish_reason, FORMATS.CLAUDE),
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
    },
  };
}

/**
 * Convert a non-streaming OpenAI Responses API body (`output: [...]`) into an
 * OpenAI Chat Completions shape (`choices: [{ message, finish_reason }]`).
 * Mirrors the item types the streaming translator already understands
 * (openaiResponsesToOpenAIResponse in translator/response/openai-responses.js)
 * so both paths agree on what counts as text/reasoning/tool-call content.
 */
function openAIResponsesBodyToChatCompletion(responseBody) {
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];
  let textContent = "", reasoningContent = "";
  const toolCalls = [];

  for (const item of output) {
    if (item?.type === RESPONSES_ITEM.MESSAGE) {
      for (const block of item.content || []) {
        if (block?.type === RESPONSES_ITEM.OUTPUT_TEXT && typeof block.text === "string") {
          textContent += block.text;
        }
      }
    } else if (item?.type === RESPONSES_ITEM.REASONING) {
      for (const summary of item.summary || []) {
        if (summary?.type === RESPONSES_ITEM.SUMMARY_TEXT && typeof summary.text === "string") {
          reasoningContent += summary.text;
        }
      }
    } else if (item?.type === RESPONSES_ITEM.FUNCTION_CALL || item?.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL) {
      const isCustom = item.type === RESPONSES_ITEM.CUSTOM_TOOL_CALL;
      toolCalls.push({
        id: item.call_id || item.id || `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name || "",
          arguments: isCustom
            ? JSON.stringify({ input: item.input || "" })
            : (typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {})),
        },
      });
    }
  }

  const message = { role: "assistant" };
  if (textContent) message.content = textContent;
  if (reasoningContent) message.reasoning_content = reasoningContent;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  if (!message.content && !message.tool_calls) message.content = "";

  const usage = responseBody?.usage || {};
  return {
    id: String(responseBody?.id || `chatcmpl-${Date.now()}`).replace(/^resp_/, "chatcmpl-"),
    object: "chat.completion",
    created: responseBody?.created_at || Math.floor(Date.now() / 1000),
    model: responseBody?.model || "unknown",
    choices: [{ index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
    },
  };
}

/**
 * Translate non-streaming response body from provider format → OpenAI format.
 */
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat) {
  if (targetFormat === sourceFormat) {
    if (targetFormat === FORMATS.OPENAI) {
      for (const choice of responseBody?.choices || []) {
        const msg = choice?.message;
        if (msg?.reasoning && typeof msg.reasoning === "string" && !msg.reasoning_content) {
          msg.reasoning_content = msg.reasoning;
          delete msg.reasoning;
        }
      }
    }
    return responseBody;
  }

  // Provider responded in the Responses API shape (`output: []`) — every
  // client format below expects chat.completion-shaped input (`choices: []`),
  // so normalize once here instead of teaching each branch to parse `output[]`.
  if (targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat !== FORMATS.OPENAI_RESPONSES) {
    const chatBody = openAIResponsesBodyToChatCompletion(responseBody);
    if (sourceFormat === FORMATS.OPENAI) return chatBody;
    if (sourceFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(chatBody);
  }

  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.CLAUDE) {
    return openAICompletionToClaudeMessage(responseBody);
  }
  if (targetFormat === FORMATS.OPENAI) return responseBody;

  // Gemini / Antigravity
  if (targetFormat === FORMATS.GEMINI || targetFormat === FORMATS.ANTIGRAVITY || targetFormat === FORMATS.GEMINI_CLI || targetFormat === FORMATS.VERTEX) {
    const response = responseBody.response || responseBody;
    if (!response?.candidates?.[0]) return responseBody;

    const candidate = response.candidates[0];
    const content = candidate.content;
    const usage = response.usageMetadata || responseBody.usageMetadata;
    let textContent = "", reasoningContent = "";
    const toolCalls = [];

    if (content?.parts) {
      for (const part of content.parts) {
        if (part.thought === true && part.text) reasoningContent += part.text;
        else if (part.text !== undefined) textContent += part.text;
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${part.functionCall.name}_${Date.now()}_${toolCalls.length}`,
            type: "function",
            function: { name: part.functionCall.name, arguments: JSON.stringify(part.functionCall.args || {}) }
          });
        }
        // Handle inline image data (from image generation models)
        const inlineData = part.inlineData || part.inline_data;
        if (inlineData?.data) {
          const mimeType = inlineData.mimeType || inlineData.mime_type || "image/png";
          textContent += `\n![image](data:${mimeType};base64,${inlineData.data})\n`;
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (reasoningContent) message.reasoning_content = reasoningContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = (candidate.finishReason || "stop").toLowerCase();
    if (finishReason === "stop" && toolCalls.length > 0) finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${response.responseId || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(new Date(response.createTime || Date.now()).getTime() / 1000),
      model: response.modelVersion || "gemini",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (usage) {
      result.usage = {
        prompt_tokens: (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0),
        completion_tokens: usage.candidatesTokenCount || 0,
        total_tokens: usage.totalTokenCount || 0
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    return result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    // Always translate a Claude-format body to OpenAI, even if `content` is
    // missing/null (e.g. M3 with max_tokens:1 spends the budget on thinking
    // and returns `content: null`). Returning the raw body would leave the
    // OpenAI client without a `choices` array and surface as a UI test error.
    // Early return if the response is already in OpenAI format (has choices array)
    // or if it has content as a non-array value (likely a different non-Claude format).
    // Some providers (e.g. xiaomi-tokenplan) return OpenAI-format responses even when
    // the request was translated to Claude format — the targetFormat is Claude but the
    // actual response is OpenAI-native and needs no further translation.
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    for (const block of (responseBody.content || [])) {
      if (block.type === "text") {
        // Strip markdown code block markers (e.g. kimi wraps JSON in ```json...```)
        const raw = block.text ?? "";
        const text = raw.replace(/^\s*```\s*json\s*\n?/i, "").replace(/\n?\s*```\s*$/i, "");
        textContent += text;
      } else if (block.type === "thinking") thinkingContent += block.thinking || "";
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: JSON.stringify(block.input || {}) } });
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    let finishReason = responseBody.stop_reason || "stop";
    if (finishReason === "end_turn") finishReason = "stop";
    if (finishReason === "tool_use") finishReason = "tool_calls";

    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{ index: 0, message, finish_reason: finishReason }]
    };

    if (responseBody.usage) {
      result.usage = {
        prompt_tokens: responseBody.usage.input_tokens || 0,
        completion_tokens: responseBody.usage.output_tokens || 0,
        total_tokens: (responseBody.usage.input_tokens || 0) + (responseBody.usage.output_tokens || 0)
      };
    }
    return result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    return ollamaBodyToOpenAI(responseBody);
  }

  return responseBody;
}

/**
 * Handle non-streaming response from provider.
 */
export async function handleNonStreamingResponse({ providerResponse, provider, model, sourceFormat, targetFormat, body, stream, translatedBody, finalBody, requestStartTime, connectionId, apiKey, clientRawRequest, onRequestSuccess, reqLogger, toolNameMap, trackDone, appendLog, pxpipe, convoy, reqTag, log }) {
  trackDone();
  const contentType = providerResponse.headers.get("content-type") || "";
  let responseBody;

  if (contentType.includes("text/event-stream")) {
    const sseText = await providerResponse.text();
    const parsed = parseSSEToOpenAIResponse(sseText, model);
    if (!parsed) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
    }
    responseBody = parsed;
  } else {
    try {
      responseBody = await providerResponse.json();
    } catch (err) {
      appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
    }
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);
  if (onRequestSuccess) {
    Promise.resolve()
      .then(onRequestSuccess)
      .catch(err => {
        console.error("[ChatCore] onRequestSuccess failed:", err?.message || err);
      });
  }

  // Decloak tool_use names once on raw Claude body, before any translation (INPUT side)
  responseBody = decloakToolNames(responseBody, toolNameMap);

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, requestedModel: clientRawRequest?.body?.model, convoy, silent: true });
  if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

  const translatedResponse = needsTranslation(targetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat)
    : responseBody;
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES;

  // Fix finish_reason for tool_calls: some providers return non-standard values (e.g. "other")
  if (translatedResponse?.choices?.[0]) {
    const choice = translatedResponse.choices[0];
    const msg = choice.message;
    const hasToolCalls = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
    if (hasToolCalls && choice.finish_reason !== "tool_calls") {
      choice.finish_reason = "tool_calls";
    }
  }

  // Ensure OpenAI-required fields
  if (!isClaudeMessageResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (!isClaudeMessageResponse) {
    delete translatedResponse.prompt_filter_results;
    if (translatedResponse?.choices) {
      for (const choice of translatedResponse.choices) delete choice.content_filter_results;
    }
  }

  if (translatedResponse?.usage) {
    translatedResponse.usage = filterUsageForFormat(addBufferToUsage(translatedResponse.usage), sourceFormat);
  }

  // Strip reasoning_content only when content is non-empty.
  // When content is empty (e.g. thinking models that used all tokens for reasoning),
  // reasoning_content is the only useful output and must be preserved.
  if (!isClaudeMessageResponse && translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content) {
        delete choice.message.reasoning_content;
      }
    }
  }

  reqLogger.logConvertedResponse(translatedResponse);

  // Upstream answered 200 but produced nothing usable (null/empty content, no
  // tool_calls, no reasoning) — treat as a failure so the same fallback path as a
  // real error status kicks in: lock this account+model for EMPTY_CONTENT_COOLDOWN_MS
  // (skips it on the next request/combo attempt) and let the caller fall through to
  // the next account/combo member. The lock auto-expires, so it comes back into
  // rotation on its own once the upstream presumably recovers.
  if (!hasUsefulContent(translatedResponse, isClaudeMessageResponse, isResponsesResponse)) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY} (empty content)` });
    if (log?.warn) {
      log.warn("CHATCORE", `${provider}/${model} returned HTTP 200 with empty content (finish_reason=${translatedResponse?.choices?.[0]?.finish_reason || "unknown"}) — treating as failure, locking for ${Math.round(EMPTY_CONTENT_COOLDOWN_MS / 1000)}s`);
    }
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Empty response content from ${provider}/${model}`, Date.now() + EMPTY_CONTENT_COOLDOWN_MS);
  }

  // Echo a stable, listing-valid model name instead of the upstream id.
  // Passthrough providers (opencode free tier) return the bare resolved model
  // with the provider prefix stripped; clients that trust the echo re-send the
  // bare name, which then mis-routes on the next hop. Prefixed requests keep
  // their exact form; bare requests resolved to a connection-less catalog
  // provider get the listing form re-injected (OpenRouter-style proxy echo).
  const echoModel = canonicalEchoModel({ requestedModel: body?.model, provider, model });
  if (echoModel && translatedResponse && typeof translatedResponse === "object" && !Array.isArray(translatedResponse)) {
    translatedResponse.model = echoModel;
  }

  const totalLatency = Date.now() - requestStartTime;
  saveRequestDetail(buildRequestDetail({
    provider, model, connectionId,
    latency: { ttft: totalLatency, total: totalLatency },
    tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
    request: extractRequestConfig(body, stream),
    providerRequest: finalBody || translatedBody || null,
    providerResponse: responseBody || null,
    response: {
      content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
      thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
      finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown"
    },
    pxpipe,
    convoy,
    status: "success"
  }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
    console.error("[RequestDetail] Failed to save:", err.message);
  });

  return {
    success: true,
    response: new Response(JSON.stringify(translatedResponse), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    })
  };
}
