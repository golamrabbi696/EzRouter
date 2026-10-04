import { FORMATS } from "../../translator/formats.js";
import { needsTranslation } from "../../translator/index.js";
import { ollamaBodyToOpenAI } from "../../translator/response/ollama-to-openai.js";
import { addBufferToUsage, filterUsageForFormat, enrichUsageCost } from "../../utils/usageTracking.js";
import { createErrorResult } from "../../utils/error.js";
import { canonicalEchoModel } from "../../services/model.js";
import { upstreamResponseHeaders } from "../../utils/upstreamHeaders.js";
import { HTTP_STATUS } from "../../config/runtimeConfig.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "../../config/errorConfig.js";
import { parseSSEToOpenAIResponse, parseGeminiSSEToOpenAIResponse, pickAssistantMessageForChatCompletion } from "./sseToJsonHandler.js";
import { PROVIDERS } from "../../config/providers.js";
import { convertResponsesStreamToJson } from "../../transformer/streamToJsonConverter.js";
import { unwrapClineEnvelope } from "../../shared/clineEnvelope.js";
import { buildRequestDetail, extractRequestConfig, extractUsageFromResponse, saveUsageStats, formatDoneLine } from "./requestDetail.js";
import { appendRequestLog, saveRequestDetail } from "@/lib/usageDb.js";
import { decloakToolNames } from "../../utils/claudeCloaking.js";
import { restoreToolNames } from "../../utils/opencodeFingerprint.js";
import { ROLE, RESPONSES_ITEM } from "../../translator/schema/index.js";
import { openAICompletionToClaudeMessage, chatCompletionToClaudeMessage, openAICompletionToResponses } from "./completionConverters.js";

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
  if (!responseBody || typeof responseBody !== "object") return responseBody;
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
    if (sourceFormat === FORMATS.CLAUDE) return chatCompletionToClaudeMessage(chatBody);
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
      const promptTokens = (usage.promptTokenCount || 0) + (usage.thoughtsTokenCount || 0);
      const completionTokens = usage.candidatesTokenCount || 0;
      result.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        // Sum the derived parts when upstream omits totalTokenCount. The other
        // branches in this file (and the streaming normaliser) all do this, and
        // a usage block claiming prompt 10 + completion 20 + total 0 is simply
        // self-contradictory for callers that bill or display from it. #3789
        total_tokens: usage.totalTokenCount || promptTokens + completionTokens
      };
      if (usage.thoughtsTokenCount > 0) {
        result.usage.completion_tokens_details = { reasoning_tokens: usage.thoughtsTokenCount };
      }
    }
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
      return openAICompletionToResponses(result, customToolNames);
    }
    if (sourceFormat === FORMATS.CLAUDE) {
      return chatCompletionToClaudeMessage(result);
    }
    return result;
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
    if (sourceFormat === FORMATS.OPENAI_RESPONSES) {
      return openAICompletionToResponses(result, customToolNames);
    }
    if (sourceFormat === FORMATS.CLAUDE) {
      return chatCompletionToClaudeMessage(result);
    }
    return result;
  }

  return responseBody;
}

export async function handleNonStreamingResponse({
  body,
  modelInfo,
  provider: pProp,
  model: mProp,
  connectionId,
  apiKey,
  clientRawRequest,
  credentials,
  providerResponse,
  sourceFormat,
  targetFormat,
  reqLogger,
  toolNameMap,
  trackDone,
  appendLog,
  reqTag = "",
  log = null,
  customToolNames = null,
  stream = false,
  finalBody = null,
  translatedBody = null,
  pxpipe = null,
  onRequestSuccess = null,
  pricingMultiplier = 1,
  statisticsModel = null,
}) {
  const provider = modelInfo?.provider || pProp;
  const model = modelInfo?.model || mProp;
  const recordedModel = statisticsModel || model;
  const effectiveConnId = credentials?.connectionId || connectionId;
  const effectiveApiKey = credentials?.apiKey || apiKey;
  const requestStartTime = Date.now();

  try {
    let responseBody;
    const isSSE = providerResponse?.headers?.get?.("content-type")?.includes("text/event-stream");

    if (isSSE) {
      if (targetFormat === FORMATS.OPENAI_RESPONSES) {
        const jsonResponse = await convertResponsesStreamToJson(providerResponse.body);
        const { textContent } = pickAssistantMessageForChatCompletion(jsonResponse.output);
        const rUsage = jsonResponse.usage || {};
        const rStatus = jsonResponse.status || "stop";
        const done = rStatus === "completed" || rStatus === "done";
        const finishReason = done ? "stop" : (rStatus === "incomplete" ? "length" : rStatus);
        responseBody = {
          id: jsonResponse.id || `chatcmpl-${Date.now()}`,
          object: "chat.completion",
          created: jsonResponse.created_at || Math.floor(Date.now() / 1000),
          model: jsonResponse.model || model,
          choices: [{ index: 0, message: { role: "assistant", content: textContent || "" }, finish_reason: finishReason }],
          usage: {
            prompt_tokens: rUsage.input_tokens || 0,
            completion_tokens: rUsage.output_tokens || 0,
            total_tokens: rUsage.total_tokens || (rUsage.input_tokens || 0) + (rUsage.output_tokens || 0)
          }
        };
      } else {
        const sseText = await providerResponse.text();
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

        const parsed = isGeminiSse
          ? parseGeminiSSEToOpenAIResponse(sseText, model)
          : parseSSEToOpenAIResponse(sseText, model);

        if (!parsed) {
          trackDone?.();
          appendLog?.({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
          return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid SSE response for non-streaming request");
        }
        if (parsed.error) {
          trackDone?.();
          appendLog?.({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
          return createErrorResult(HTTP_STATUS.BAD_GATEWAY, parsed.error.message || "Upstream SSE stream failed");
        }
        responseBody = parsed;
      }
    } else {
      try {
        responseBody = await providerResponse.json();
      } catch (err) {
        trackDone?.();
        appendLog?.({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
        console.error(`[ChatCore] Failed to parse JSON from ${provider}:`, err.message);
        return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Invalid JSON response from ${provider}`);
      }
    }

    // Unwrap before any consumer reads choices/usage so non-stream clients get a
    // bare OpenAI body and usage tracking sees data.usage. No-op unless the
    // provider opts in via transport.quirks.clineEnvelope.
    responseBody = unwrapClineEnvelope(responseBody, provider);

    reqLogger?.logProviderResponse?.(providerResponse?.status, providerResponse?.statusText, providerResponse?.headers, responseBody);

    // Detect upstream gateway errors masked as HTTP 200 (e.g. OpenRouter
    // sending choices[0].native_finish_reason:"network_error" with empty content).
    const rawChoice = responseBody?.choices?.[0];
    const nativeReason = rawChoice?.native_finish_reason;
    const rawMsg = rawChoice?.message || {};
    const hasContent = (typeof rawMsg.content === "string" && rawMsg.content.length > 0)
      || (Array.isArray(rawMsg.tool_calls) && rawMsg.tool_calls.length > 0);
    if (nativeReason && ["network_error", "error", "server_error", "timeout"].includes(nativeReason) && !hasContent) {
      trackDone?.();
      appendLog?.({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Upstream provider error: ${nativeReason}`);
    }

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
    appendLog?.({ tokens: usage, status: "200 OK" });
    saveUsageStats({ provider, model: recordedModel, tokens: usage, connectionId: effectiveConnId, apiKey: effectiveApiKey, endpoint: clientRawRequest?.endpoint, pricingMultiplier, silent: true });
    if (log?.line) log.line(reqTag, "📊", formatDoneLine({ usage, latency: { total: Date.now() - requestStartTime } }));

    const translatedResponse = needsTranslation(targetFormat, sourceFormat)
      ? translateNonStreamingResponse(responseBody, targetFormat, sourceFormat, customToolNames)
      : responseBody;

    if (!translatedResponse || typeof translatedResponse !== "object") {
      trackDone?.();
      appendLog?.({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
      return createErrorResult(HTTP_STATUS.BAD_GATEWAY, "Invalid response from upstream provider");
    }

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
      if (Array.isArray(translatedResponse?.choices)) {
        for (const choice of translatedResponse.choices) {
          if (choice) delete choice.content_filter_results;
        }
      }
    }

    if (translatedResponse?.usage) {
      translatedResponse.usage = enrichUsageCost(
        filterUsageForFormat(translatedResponse.usage, sourceFormat),
        provider,
        model
      );
    }

    // Strip reasoning_content only when content is non-empty.
    // When content is empty (e.g. thinking models that used all tokens for reasoning),
    // reasoning_content is the only useful output and must be preserved.
    if (!isClaudeMessageResponse && !isResponsesResponse && Array.isArray(translatedResponse?.choices)) {
      for (const choice of translatedResponse.choices) {
        if (choice?.message?.reasoning_content && choice.message.content) {
          delete choice.message.reasoning_content;
        }
      }
    }

    reqLogger?.logConvertedResponse?.(translatedResponse);

    const totalLatency = Date.now() - requestStartTime;
    saveRequestDetail(buildRequestDetail({
      provider,
      model: recordedModel,
      connectionId: effectiveConnId,
      latency: { ttft: totalLatency, total: totalLatency },
      tokens: usage || { prompt_tokens: 0, completion_tokens: 0 },
      request: extractRequestConfig(body, stream),
      providerRequest: finalBody || translatedBody || null,
      providerResponse: responseBody || null,
      response: {
        content: translatedResponse?.choices?.[0]?.message?.content || translatedResponse?.content || null,
        thinking: translatedResponse?.choices?.[0]?.message?.reasoning_content || translatedResponse?.reasoning_content || null,
        finish_reason: translatedResponse?.choices?.[0]?.finish_reason || "unknown",
      },
      pxpipe,
      status: "success",
    }, { endpoint: clientRawRequest?.endpoint || null })).catch(err => {
      console.error("[RequestDetail] Failed to save:", err.message);
    });

    trackDone?.();

    const res = new Response(JSON.stringify(restoreToolNames(translatedResponse, toolNameMap)), {
      status: HTTP_STATUS.OK,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...upstreamResponseHeaders(providerResponse?.headers) },
    });
    res.success = true;
    res.response = res;
    return res;
  } catch (err) {
    trackDone?.();
    appendLog?.({ status: `FAILED ${HTTP_STATUS.BAD_GATEWAY}` });
    console.error(`[ChatCore] Error in handleNonStreamingResponse (${provider}/${model}):`, err?.message || err);
    return createErrorResult(HTTP_STATUS.BAD_GATEWAY, `Failed to process non-streaming response: ${err?.message || "unknown"}`);
  }
}
