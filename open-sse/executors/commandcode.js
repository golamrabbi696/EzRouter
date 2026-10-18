import { createHash, randomUUID } from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { FORMATS } from "../translator/formats.js";
import { openaiToCommandCodeRequest } from "../translator/request/openai-to-commandcode.js";
import { commandCodeToOpenAIResponse } from "../translator/response/commandcode-to-openai.js";
import { modelLevelError } from "../services/accountFallback.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { SSE_DONE } from "../utils/sseConstants.js";
import { commandCodeThreadId, isCommandCodeThreadId } from "../utils/commandCodeSession.js";

/**
 * CommandCodeExecutor — talks to https://api.commandcode.ai
 *
 * Auth: Bearer <user_xxx> API key (stored as the connection's apiKey).
 * Adds the per-conversation `x-session-id` header expected by CommandCode
 * upstream — the same id the envelope carries as `threadId`, because the
 * upstream prompt cache is keyed on it (see utils/commandCodeSession.js).
 *
 * Two surfaces, same gateway:
 *  - Provider API (`/provider/v1/chat/completions`) — documented, OpenAI-shaped
 *    request. This is the default: the CLI-only `/alpha/generate` surface
 *    version-gates and region-gates external callers.
 *  - CLI (`/alpha/generate`) — reached only when the provider surface answers
 *    403/404 (Go plans without Provider API access, or ids served only on the
 *    CLI lane). The OpenAI body is converted to the CLI envelope on the way.
 *
 * Both surfaces return AI SDK v5 NDJSON (one JSON event per line, no `data:`
 * prefix), so `responseFormat` is pinned to COMMANDCODE and each event is
 * translated to an OpenAI chat.completion.chunk and emitted as SSE.
 */

// muse-spark (Meta) runs a hidden reasoning phase that can consume the whole
// output budget, leaving HTTP 200 with empty content. Floor only budgets the
// caller actually set; never fabricate one.
const MUSE_SPARK_PATTERN = /(?:^|\/|\b)muse-spark/i;
const MUSE_SPARK_MIN_OUTPUT_TOKENS = 512;
const OUTPUT_BUDGET_FIELDS = ["max_tokens", "max_output_tokens", "max_completion_tokens"];

function floorMuseSparkBudget(model, body) {
  if (!MUSE_SPARK_PATTERN.test(String(model || ""))) return;
  for (const field of OUTPUT_BUDGET_FIELDS) {
    const value = body[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < MUSE_SPARK_MIN_OUTPUT_TOKENS) {
      body[field] = MUSE_SPARK_MIN_OUTPUT_TOKENS;
    }
  }
}

/** The CLI surface identifies callers with its own environment label. */
const CLI_ONLY_HEADERS = {
  "x-cli-environment": "external",
  "x-project-slug": "9router",
  "x-taste-learning": "false",
  "x-co-flag": "false",
  "User-Agent": "cli",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Command Code validates `threadId` (and the CLI surface's session id) as UUIDs,
 * but the gateway's session seed is an arbitrary string — a hashed connection id.
 * Derive a stable UUID from that seed so one conversation keeps one wire thread
 * and the envelope never trips the upstream "Invalid UUID at threadId" 400.
 */
function toUuid(seed) {
  if (typeof seed === "string" && UUID_RE.test(seed)) return seed;
  const bytes = createHash("sha256").update(String(seed ?? randomUUID())).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function sessionIdFor(credentials) {
  return toUuid(credentials?._ccSessionId || credentials?._clientSessionId || credentials?.connectionId);
}
export class CommandCodeExecutor extends BaseExecutor {
  constructor() {
    super("commandcode", PROVIDERS.commandcode);
  }

  transformRequest(model, body, stream, credentials) {
    body.stream = true;
    if (body?.params && typeof body.params.max_tokens === "number" && body.params.max_tokens > 200000) {
      body.params.max_tokens = 200000;
    }
    floorMuseSparkBudget(model, body);
    return body;
  }

  buildHeaders(credentials, stream = true, _url = null, _model = null, body = null) {
    // The header must carry the SAME identity as the envelope `threadId` (which
    // arrives here as the transformed body) — one conversation, one id, so the
    // upstream prefix cache can be reused across turns. Never randomize per
    // request: that is what kept CommandCode cache reads at 0.
    const sessionId =
      body && isCommandCodeThreadId(body.threadId) ? body.threadId : commandCodeThreadId(body);

    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      "x-session-id": sessionId,
    };

    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;

    if (stream) headers["Accept"] = "text/event-stream";
    return headers;
  }

  /** Carry the resolved session id on a credentials copy for this request. */
  prepareRequestCredentials({ providerSessionId, credentials } = {}) {
    const source = credentials || {};
    if (source._ccSessionId) return source;
    // Normalized here so both the header and the CLI envelope threadId are UUIDs.
    return { ...source, _ccSessionId: toUuid(providerSessionId || source._clientSessionId || source.connectionId) };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    const maxRetries = 2;
    let result;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      result = await super.execute({ ...args, credentials });
      if (!result?.response) return result;

      if (!result.response.ok) {
        // Provider surface denied (no Provider API access, or a CLI-only id):
        // replay the same turn against the CLI endpoint before giving up — unless
        // the body already states a serving restriction on the model. The CLI
        // surface is the region-gated one (see the class comment), so replaying a
        // geographic verdict there only swaps the truthful answer for the gated
        // lane's copy of it, and pays for a second upstream call to do so.
        if (result.response.status === 403 || result.response.status === 404) {
          if (!(await statesModelLevelVerdict(result.response))) {
            const fallback = await this.executeCliFallback({ ...args, credentials });
            if (fallback) return fallback;
          }
        }
        return result;
      }
      if (!result.response.body) return result;

      const wrappedResponse = await inspectAndWrapCommandCodeResponse(result.response, args.model);
      if (!wrappedResponse.ok && attempt < maxRetries) {
        const isRetryableStatus = wrappedResponse.status === 502 || wrappedResponse.status === 503 || wrappedResponse.status === 504;
        if (isRetryableStatus) {
          args.log?.debug?.("RETRY", `CommandCode upstream returned status ${wrappedResponse.status}, retrying ${attempt + 1}/${maxRetries}...`);
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
      }

      result.response = wrappedResponse;
      result.responseFormat = FORMATS.COMMANDCODE;
      return result;
    }
    return result;
  }

  /**
   * CLI-surface replay. Returns null when the executor has no CLI URL configured
   * so the caller falls back to surfacing the provider-surface response.
   */
  async executeCliFallback({ model, body, credentials, signal, log, proxyOptions = null, providerOverrides = null }) {
    const cliUrl = this.config.cliUrl;
    if (!cliUrl) return null;

    const transformedBody = openaiToCommandCodeRequest(model, body, true, credentials);
    const sessionId =
      transformedBody && isCommandCodeThreadId(transformedBody.threadId)
        ? transformedBody.threadId
        : commandCodeThreadId(transformedBody);
    const headers = {
      "Content-Type": "application/json",
      ...(this.config.headers || {}),
      ...CLI_ONLY_HEADERS,
      "x-session-id": sessionId,
      "Accept": "text/event-stream",
    };
    const token = credentials?.apiKey || credentials?.accessToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (providerOverrides?.headers) Object.assign(headers, providerOverrides.headers);

    // Mirror BaseExecutor's connect-only guard: abort when headers do not arrive
    // in time, but never abort a stream that already started.
    const connectCtrl = new AbortController();
    const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
    const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
    const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

    log?.debug?.("FETCH", `COMMANDCODE → ${cliUrl} (cli fallback) | body=${JSON.stringify(transformedBody).length}B`);
    let response;
    try {
      response = await proxyAwareFetch(cliUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(transformedBody),
        signal: mergedSignal,
      }, proxyOptions);
    } finally {
      clearTimeout(connectTimer);
    }

    if (!response.ok) {
      return { response, url: cliUrl, headers, transformedBody, responseFormat: FORMATS.COMMANDCODE };
    }

    const wrapped = await inspectAndWrapCommandCodeResponse(response, model);
    return { response: wrapped, url: cliUrl, headers, transformedBody, responseFormat: FORMATS.COMMANDCODE };
  }

  parseError(response, bodyText) {
    let parsed = null;
    try {
      parsed = JSON.parse(bodyText || "{}");
    } catch {
      parsed = null;
    }
    const errObj = parsed?.error || parsed;
    const msg = errObj?.message || parsed?.message || bodyText || response.statusText;
    const status = Number(errObj?.code || errObj?.statusCode || response.status) || response.status;
    return {
      status,
      message: msg || `CommandCode upstream error: ${response.status}`,
    };
  }
}

/**
 * True when a rejected response states a serving restriction on the model
 * (geography, policy) rather than a denial of the surface itself. Read from a
 * clone: the caller still needs the body to report the upstream message.
 */
async function statesModelLevelVerdict(response) {
  try {
    const text = await response.clone().text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || parsed?.message || text;
    } catch {
      /* not JSON: match the raw body text */
    }
    return modelLevelError(response.status, message) !== null;
  } catch {
    return false;
  }
}

/** Truthful status text for the error Response the router reads onward. */
function statusTextFor(statusCode) {
  const known = { 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests" };
  return known[statusCode] || (statusCode >= 500 ? "Service Unavailable" : "Bad Gateway");
}

export function parseCommandCodeError(event) {
  if (!event || typeof event !== "object") {
    return {
      statusCode: 503,
      message: "CommandCode upstream error",
      type: "server_error",
    };
  }

  const errVal = event.error ?? event.message ?? "unknown";
  let message = "";
  let statusCode = null;
  let type = "server_error";

  if (typeof errVal === "object" && errVal !== null) {
    message = errVal.message || errVal.error || JSON.stringify(errVal);
    if (errVal.statusCode && Number.isInteger(Number(errVal.statusCode))) {
      statusCode = Number(errVal.statusCode);
    } else if (errVal.status && Number.isInteger(Number(errVal.status))) {
      statusCode = Number(errVal.status);
    }
    if (errVal.type) type = errVal.type;
  } else if (typeof errVal === "string") {
    message = errVal;
  } else {
    message = JSON.stringify(errVal);
  }

  if (event.statusCode && Number.isInteger(Number(event.statusCode))) {
    statusCode = Number(event.statusCode);
  }

  if (!statusCode || statusCode < 400 || statusCode > 599) {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      statusCode = 429;
      type = "rate_limit_error";
    } else if (lower.includes("unauthorized") || lower.includes("invalid api key") || lower.includes("authentication")) {
      statusCode = 401;
      type = "authentication_error";
    } else if (lower.includes("payment required") || lower.includes("billing")) {
      statusCode = 402;
      type = "billing_error";
    } else if (lower.includes("geographic use policy") || lower.includes("not available in your region")) {
      // A model the caller's plan has but the gateway refuses to serve here is a
      // permission verdict, not an upstream outage: reporting 503 made the
      // router cool the connection down and retry a call that cannot succeed.
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("quota") || lower.includes("forbidden") || lower.includes("permission")) {
      statusCode = 403;
      type = "permission_error";
    } else if (lower.includes("not found")) {
      statusCode = 404;
      type = "invalid_request_error";
    } else if (lower.includes("unavailable") || lower.includes("overloaded") || lower.includes("server error")) {
      statusCode = 503;
      type = "server_error";
    } else {
      statusCode = 503;
    }
  }

  return { statusCode, message, type };
}

export async function inspectAndWrapCommandCodeResponse(originalResponse, model) {
  const reader = originalResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const rawChunks = [];
  let detectedError = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        const trimmed = buffer.trim();
        if (trimmed) {
          try {
            const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
            const parsed = JSON.parse(jsonStr);
            if (parsed?.type === "error") {
              detectedError = parsed;
            }
          } catch {
            /* ignore */
          }
        }
        break;
      }

      rawChunks.push(value);
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let stopLoop = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const jsonStr = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
        if (!jsonStr || jsonStr === "[DONE]") {
          stopLoop = true;
          break;
        }

        let event;
        try {
          event = JSON.parse(jsonStr);
        } catch {
          continue;
        }

        if (event?.type === "error") {
          detectedError = event;
          stopLoop = true;
          break;
        }

        if (
          event?.type === "text-delta" ||
          event?.type === "reasoning-delta" ||
          event?.type === "tool-input-start" ||
          event?.type === "tool-call" ||
          event?.type === "finish" ||
          event?.type === "finish-step"
        ) {
          stopLoop = true;
          break;
        }
      }

      if (stopLoop) break;
    }
  } catch {
    try { reader.releaseLock(); } catch { /* ignore */ }
    return originalResponse;
  }

  if (detectedError) {
    try { await reader.cancel(); } catch { /* ignore */ }
    const { statusCode, message, type } = parseCommandCodeError(detectedError);
    return new Response(
      JSON.stringify({
        error: {
          message: `[CommandCode error: ${message}]`,
          type,
          code: statusCode,
        },
      }),
      {
        status: statusCode,
        // Keep the wire text truthful: the router reports this status onward.
        statusText: statusTextFor(statusCode),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  const combinedStream = createRawReplayedStream(rawChunks, reader);
  return wrapNdjsonAsOpenAISse(combinedStream, model, originalResponse);
}

function createRawReplayedStream(rawChunks, reader) {
  let chunkIndex = 0;

  return new ReadableStream({
    async pull(controller) {
      if (chunkIndex < rawChunks.length) {
        controller.enqueue(rawChunks[chunkIndex++]);
        return;
      }

      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {
        /* ignore */
      }
    },
  });
}

function wrapNdjsonAsOpenAISse(streamBody, model, originalResponse = null) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const state = { model };

  const emitChunks = (chunks, controller) => {
    if (!chunks) return;
    const list = Array.isArray(chunks) ? chunks : [chunks];
    for (const c of list) {
      if (c == null) continue;
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
    }
  };

  const transform = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
    },
    flush(controller) {
      const trimmed = buffer.trim();
      if (trimmed) {
        emitChunks(commandCodeToOpenAIResponse(trimmed, state), controller);
      }
      controller.enqueue(encoder.encode(SSE_DONE));
    },
  });

  const newBody = streamBody.pipeThrough(transform);
  return new Response(newBody, {
    status: originalResponse?.status || 200,
    statusText: originalResponse?.statusText || "OK",
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...(originalResponse?.headers ? Object.fromEntries(originalResponse.headers.entries()) : {}),
      "content-type": "text/event-stream",
    },
  });
}

export default CommandCodeExecutor;

export const __test__ = { parseCommandCodeError, inspectAndWrapCommandCodeResponse, createRawReplayedStream, wrapNdjsonAsOpenAISse };
