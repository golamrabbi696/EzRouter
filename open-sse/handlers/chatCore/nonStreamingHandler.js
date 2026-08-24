import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { fromOpenAIFinish } from "../../translator/concerns/finishReason.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { canonicalEchoModel } from "../../services/model.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "../../config/errorConfig.js";
import { parseSSEToOpenAIResponse, parseGeminiSSEToOpenAIResponse } from "./sseToJsonHandler.js";
import { PROVIDERS } from "../../config/providers.js";
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
 * Convert an OpenAI Chat Completions non-streaming response body into the
 * OpenAI Responses API shape.
 */
function extractCustomToolInput(argumentsValue) {
  const argumentsText = typeof argumentsValue === "string" ? argumentsValue : JSON.stringify(argumentsValue || {});
  try {
    const parsed = JSON.parse(argumentsText);
    if (parsed && typeof parsed === "object" && typeof parsed.input === "string") return parsed.input;
  } catch { /* raw freeform input */ }
  return argumentsText;
}

function openAICompletionToResponses(responseBody, customToolNames = null) {
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

  const usage = responseBody?.usage || {};
  return {
    id: String(responseBody?.id || `resp_${Date.now()}`).replace(/^chatcmpl-/, "resp_"),
    object: "response",
    created_at: responseBody?.created || Math.floor(Date.now() / 1000),
    model: responseBody?.model || "unknown",
    status: "completed",
    output,
    usage: {
      input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
      output_tokens: usage.completion_tokens || usage.output_tokens || 0,
      total_tokens: usage.total_tokens || (usage.prompt_tokens || usage.input_tokens || 0) + (usage.completion_tokens || usage.output_tokens || 0),
    },
  };
}

/**
 * Convert a non-streaming OpenAI Responses API body (`output: [...]`) into an
 * OpenAI Chat Completions shape (`choices: [{ message, finish_reason }]`).
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
export function translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames = null) {
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

  if (targetFormat === FORMATS.OPENAI_RESPONSES && sourceFormat !== FORMATS.OPENAI_RESPONSES) {
    const chatBody = openAIResponsesBodyToChatCompletion(responseBody);
    if (sourceFormat === FORMATS.OPENAI) return chatBody;
    if (sourceFormat === FORMATS.CLAUDE) return openAICompletionToClaudeMessage(chatBody);
  }

  if (targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES) {
    return openAICompletionToResponses(responseBody, customToolNames);
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
    return sourceFormat === FORMATS.OPENAI_RESPONSES
      ? openAICompletionToResponses(result, customToolNames)
      : result;
  }

  // Claude
  if (targetFormat === FORMATS.CLAUDE) {
    if (responseBody.choices || (responseBody.content && !Array.isArray(responseBody.content))) return responseBody;

    let textContent = "", thinkingContent = "";
    const toolCalls = [];

    if (Array.isArray(responseBody.content)) {
      for (const block of responseBody.content) {
        if (block.type === "text") textContent += block.text || "";
        else if (block.type === "thinking") thinkingContent += block.thinking || "";
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
          });
        }
      }
    }

    const message = { role: "assistant" };
    if (textContent) message.content = textContent;
    if (thinkingContent) message.reasoning_content = thinkingContent;
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    if (!message.content && !message.tool_calls) message.content = "";

    const usage = responseBody.usage || {};
    const result = {
      id: `chatcmpl-${responseBody.id || Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseBody.model || "claude",
      choices: [{
        index: 0,
        message,
        finish_reason: fromOpenAIFinish(responseBody.stop_reason, FORMATS.OPENAI) || "stop"
      }],
      usage: {
        prompt_tokens: usage.input_tokens || 0,
        completion_tokens: usage.output_tokens || 0,
        total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0)
      }
    };
    return sourceFormat === FORMATS.OPENAI_RESPONSES
      ? openAICompletionToResponses(result, customToolNames)
      : result;
  }

  // Ollama
  if (targetFormat === FORMATS.OLLAMA) {
    const result = ollamaBodyToOpenAI(responseBody);
    return sourceFormat === FORMATS.OPENAI_RESPONSES
      ? openAICompletionToResponses(result, customToolNames)
      : (sourceFormat === FORMATS.CLAUDE ? openAICompletionToClaudeMessage(result) : result);
  }

  return responseBody;
}

export async function handleNonStreamingResponse({ body, modelInfo, provider: pProp, model: mProp, connectionId, apiKey, clientRawRequest, credentials, providerResponse, sourceFormat, targetFormat, reqLogger, toolNameMap, trackDone, appendLog, reqTag = "", log = null, customToolNames = null }) {
  const provider = modelInfo?.provider || pProp;
  const model = modelInfo?.model || mProp;
  const effectiveConnId = credentials?.connectionId || connectionId;
  const effectiveApiKey = credentials?.apiKey || apiKey;
  const requestStartTime = Date.now();

  try {
    const rawText = await providerResponse.text();
    let rawResponseBody;
    if (rawText.trimStart().startsWith("data:")) {
      const isGeminiSse = [
        FORMATS.ANTIGRAVITY,
        FORMATS.GEMINI,
        FORMATS.GEMINI_CLI,
        FORMATS.VERTEX,
      ].includes(targetFormat) || [
        FORMATS.ANTIGRAVITY,
        FORMATS.GEMINI,
        FORMATS.GEMINI_CLI,
        FORMATS.VERTEX,
      ].includes(PROVIDERS[provider]?.format);

      if (isGeminiSse) {
        rawResponseBody = parseGeminiSSEToOpenAIResponse(rawText, model);
      } else {
        rawResponseBody = parseSSEToOpenAIResponse(rawText, model);
      }
    } else {
      rawResponseBody = JSON.parse(rawText);
    }
    responseBody = normalizeResponseBody(rawResponseBody, targetFormat, model, sourceFormat, customToolNames);
  } catch (parseError) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Failed to parse response: ${parseError.message}`);
  }

  reqLogger.logProviderResponse(providerResponse.status, providerResponse.statusText, providerResponse.headers, responseBody);

  // Detect upstream gateway errors masked as HTTP 200 (e.g. OpenRouter
  // sending choices[0].native_finish_reason:"network_error" with empty content).
  const rawChoice = responseBody?.choices?.[0];
  const nativeReason = rawChoice?.native_finish_reason;
  const rawMsg = rawChoice?.message || {};
  const hasContent = (typeof rawMsg.content === "string" && rawMsg.content.length > 0)
    || (Array.isArray(rawMsg.tool_calls) && rawMsg.tool_calls.length > 0);
  if (nativeReason && ["network_error", "error", "server_error", "timeout"].includes(nativeReason) && !hasContent) {
    appendLog({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Upstream provider error: ${nativeReason}`);
  }

  const usage = extractUsageFromResponse(responseBody);
  appendLog({ tokens: usage, status: "200 OK" });
  saveUsageStats({ provider, model, tokens: usage, connectionId, apiKey, endpoint: clientRawRequest?.endpoint, silent: true });
  if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

  const translatedResponse = needsTranslation(targetFormat, sourceFormat)
    ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames)
    : responseBody;
  const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE && translatedResponse?.type === "message";
  // Responses-format translation produces a `object:"response"` body with no
  // `choices`; skip the Chat-Completions-specific post-processing below for it.
  const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES && translatedResponse?.object === "response";

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
  if (!isClaudeMessageResponse && !isResponsesResponse) {
    if (!translatedResponse.object) translatedResponse.object = "chat.completion";
    if (!translatedResponse.created) translatedResponse.created = Math.floor(Date.now() / 1000);
  }

  // Strip Azure-specific fields
  if (!isClaudeMessageResponse && !isResponsesResponse) {
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
  if (!isClaudeMessageResponse && !isResponsesResponse && translatedResponse?.choices) {
    for (const choice of translatedResponse.choices) {
      if (choice?.message?.reasoning_content && choice.message.content) {
        delete choice.message.reasoning_content;
>>>>>>> 9b24277de (fix(stream): abort and fallback when upstream returns native_finish_reason error with empty content)
      }
      if (!rawResponseBody) {
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
      }
      if (rawResponseBody.error) {
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, rawResponseBody.error.message || "Upstream SSE stream failed");
      }
      targetFormat = FORMATS.OPENAI;
    } else {
      rawResponseBody = JSON.parse(rawText);
    }
    const isClaudeMessageResponse = sourceFormat === FORMATS.CLAUDE;
    const isResponsesResponse = sourceFormat === FORMATS.OPENAI_RESPONSES;

    let translatedResponse = translateNonStreamingResponse(rawResponseBody, targetFormat, sourceFormat, customToolNames);

    if (needsTranslation(targetFormat, sourceFormat)) {
      reqLogger?.appendConvertedChunk?.(JSON.stringify(translatedResponse));
    }

    if (isClaudeMessageResponse && toolNameMap) {
      translatedResponse = decloakToolNames(translatedResponse, toolNameMap);
    }

    if (!hasUsefulContent(translatedResponse, isClaudeMessageResponse, isResponsesResponse)) {
      if (log?.warn) {
        log.warn("CHATCORE", `${provider}/${model} returned HTTP 200 with empty content — locking for ${EMPTY_CONTENT_COOLDOWN_MS / 1000}s`);
      }
      return createErrorResult(
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        `[${provider}/${model}] Provider returned empty response content (cooldown: ${EMPTY_CONTENT_COOLDOWN_MS / 1000}s)`
      );
    }

    trackDone();

    const usage = extractUsageFromResponse(translatedResponse);
    appendLog({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model, tokens: usage, connectionId: effectiveConnId, apiKey: effectiveApiKey, endpoint: credentials?.endpoint || clientRawRequest?.endpoint, silent: true });
    if (log?.line) {
      log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));
    }

    const contentForLog = isClaudeMessageResponse
      ? (Array.isArray(translatedResponse.content)
        ? translatedResponse.content.map(b => b.text || (b.type === "tool_use" ? `[tool: ${b.name}]` : "")).filter(Boolean).join(" ")
        : "")
      : (translatedResponse.choices?.[0]?.message?.content || "");

    const thinkingForLog = isClaudeMessageResponse
      ? (Array.isArray(translatedResponse.content) ? translatedResponse.content.find(b => b.type === "thinking")?.thinking || null : null)
      : (translatedResponse.choices?.[0]?.message?.reasoning_content || null);

    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      provider, model, connectionId: effectiveConnId, apiKey: effectiveApiKey,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage,
      request: extractRequestConfig(body, false),
      response: { content: contentForLog, thinking: thinkingForLog, finish_reason: translatedResponse.choices?.[0]?.finish_reason || translatedResponse.stop_reason || "stop" },
      status: "success"
    }, { endpoint: credentials?.endpoint || clientRawRequest?.endpoint || null })).catch(() => {});

    translatedResponse.model = canonicalEchoModel({ requestedModel: body.model, provider, model });
    return new Response(JSON.stringify(translatedResponse), {
      status: HTTP_STATUS.OK,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (error) {
    if (log?.error) log.error("NON_STREAMING", `Error parsing response: ${error.message}`);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid upstream response format: ${error.message}`);
  }
}
