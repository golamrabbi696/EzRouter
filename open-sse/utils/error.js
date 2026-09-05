import { ERROR_TYPES, DEFAULT_ERROR_MESSAGES } from "../config/errorConfig.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";

/**
 * Build OpenAI-compatible error response body
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string|object} [overrides] - Upstream error code string or { type, code } overrides
 * @returns {object} Error response object
 */
export function buildErrorBody(statusCode, message, overrides = null) {
  const opts = typeof overrides === "string" ? { code: overrides } : (overrides || {});
  const errorInfo = ERROR_TYPES[statusCode] || 
    (statusCode >= 500 
      ? { type: "server_error", code: "internal_server_error" }
      : { type: "invalid_request_error", code: "" });

  return {
    error: {
      message: message || DEFAULT_ERROR_MESSAGES[statusCode] || "An error occurred",
      type: opts.type || errorInfo.type,
      code: opts.code !== undefined ? opts.code : errorInfo.code
    }
  };
}

/**
 * Create error Response object (for non-streaming)
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {string|object} [overrides] - Upstream error code or { type, code } overrides
 * @returns {Response} HTTP Response object
 */
export function errorResponse(statusCode, message, overrides = null) {
  return new Response(JSON.stringify(buildErrorBody(statusCode, message, overrides)), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    }
  });
}

/**
 * Write error to SSE stream (for streaming)
 * @param {WritableStreamDefaultWriter} writer - Stream writer
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 */
export async function writeStreamError(writer, statusCode, message) {
  const errorBody = buildErrorBody(statusCode, message);
  const encoder = new TextEncoder();
  await writer.write(encoder.encode(`data: ${JSON.stringify(errorBody)}\n\n`));
}

/**
 * Parse upstream provider error response
 * @param {Response} response - Fetch response from provider
 * @param {object} [executor] - Optional executor with parseError() override for provider-specific parsing
 * @returns {Promise<{statusCode: number, message: string, resetsAtMs?: number, code?: string}>}
 */
export async function parseUpstreamError(response, executor = null) {
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  let structuredMessage = "";
  let structuredCode;
  let providerName = null;
  let invalidUrlEmpty = false;
  try {
    const json = JSON.parse(bodyText);
    structuredMessage = json.error?.message || json.message || json.error || bodyText;
    structuredCode = json.error?.code || json.code;
    providerName = json.error?.metadata?.provider_name || null;
    if (typeof structuredMessage === "string") {
      const m = /^Invalid URL:\s*(.*)$/.exec(structuredMessage);
      if (m) invalidUrlEmpty = m[1].trim() === "";
    }
  } catch {
    structuredMessage = bodyText;
  }
  let messageStr = typeof structuredMessage === "string"
    ? structuredMessage
    : JSON.stringify(structuredMessage);

  if ((providerName || invalidUrlEmpty) && (response.status === HTTP_STATUS.BAD_GATEWAY || response.status === HTTP_STATUS.SERVER_ERROR || response.status === 502 || response.status === 500)) {
    const hint = providerName
      ? `OpenRouter upstream "${providerName}" returned an invalid routing URL — its endpoint is misconfigured on OpenRouter's side`
      : "Upstream returned an invalid (empty) routing URL";
    messageStr = `${messageStr} — ${hint}. Try a different model, or set \`provider: { allow_fallbacks: true }\` to opt into OpenRouter's automatic upstream fallback.`;
  }

  const fallbackMessage = messageStr || DEFAULT_ERROR_MESSAGES[response.status] || `Upstream error: ${response.status}`;

  // Let executor-specific parser extract provider-specific fields (e.g. codex resetsAtMs)
  if (executor && typeof executor.parseError === "function") {
    try {
      const parsed = executor.parseError(response, bodyText);
      if (parsed && typeof parsed === "object") {
        const message = parsed.message && parsed.message !== bodyText
          ? parsed.message
          : fallbackMessage;
        const resetsAtMs = parsed.resetsAtMs ?? (response.status === 429 ? extractResetsAtMs(response, message) : null);
        return {
          statusCode: parsed.status || response.status,
          message,
          resetsAtMs,
          code: parsed.code ?? structuredCode,
        };
      }
    } catch { /* fall through to default parsing */ }
  }

  return { statusCode: response.status, message: fallbackMessage, code: structuredCode };
}

/**
 * Create error result for chatCore handler
 * @param {number} statusCode - HTTP status code
 * @param {string} message - Error message
 * @param {number} [resetsAtMs] - Optional precise cooldown expiry (ms epoch) for provider-specific quota errors
 * @param {string} [code] - Upstream error code
 * @returns {{ success: false, status: number, error: string, response: Response, resetsAtMs?: number }}
 */
export function createErrorResult(statusCode, message, resetsAtMs, code) {
  return {
    success: false,
    status: statusCode,
    error: message,
    resetsAtMs,
    response: errorResponse(statusCode, message, code)
  };
}

/**
 * Create unavailable response when all accounts are rate limited
 * @param {number} statusCode - Original error status code
 * @param {string} message - Error message (without retry info)
 * @param {string} retryAfter - ISO timestamp when earliest account becomes available
 * @param {string} retryAfterHuman - Human-readable retry info e.g. "reset after 30s"
 * @returns {Response}
 */
export function unavailableResponse(statusCode, message, retryAfter, retryAfterHuman) {
  const retryAfterSec = Math.max(Math.ceil((new Date(retryAfter).getTime() - Date.now()) / 1000), 1);
  const msg = `${message} (${retryAfterHuman})`;
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    {
      status: statusCode,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSec)
      }
    }
  );
}

/**
 * Format provider error with context
 * @param {Error} error - Original error
 * @param {string} provider - Provider name
 * @param {string} model - Model name
 * @param {number|string} statusCode - HTTP status code or error code
 * @returns {string} Formatted error message
 */
export function formatProviderError(error, provider, model, statusCode) {
  const code = statusCode || error.code || "FETCH_FAILED";
  const message = error.message || "Unknown error";
  // Expose low-level cause (e.g. UND_ERR_SOCKET, ECONNRESET, ETIMEDOUT) for diagnosing fetch failures
  const causeCode = error.cause?.code;
  const causeMsg = error.cause?.message;
  const causeStr = causeCode || causeMsg ? ` (cause: ${[causeCode, causeMsg].filter(Boolean).join(": ")})` : "";
  return `[${code}]: ${message}${causeStr}`;
}
