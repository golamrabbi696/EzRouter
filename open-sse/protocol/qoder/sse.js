/**
 * Unwrap Qoder `{ statusCodeValue, body }` SSE into plain OpenAI SSE.
 *
 * Special tokens: [DONE] | [NOT_EXCEED_QUOTA] | [EXCEED_QUOTA]* | [NOTIFICATIONS]*
 *
 * Non-200 envelopes become an OpenAI-shaped **error** event (not fake content).
 */

import { SSE_DONE } from "../../utils/sseConstants.js";

function truncate(s, n) {
  return s && s.length > n ? `${s.slice(0, n)}...` : s || "";
}

/** Official special body tokens (Bun EPA). */
function isSpecialToken(data) {
  return (
    data === "[DONE]" ||
    data === "[NOT_EXCEED_QUOTA]" ||
    data.startsWith("[EXCEED_QUOTA]") ||
    data.startsWith("[NOTIFICATIONS]")
  );
}

function emitDone(controller, state) {
  if (state.doneEmitted) return;
  controller.enqueue(new TextEncoder().encode(SSE_DONE));
  state.doneEmitted = true;
}

/**
 * Emit a standard OpenAI streaming error (top-level {error:{...}} without
 * chunk scaffolding) so OpenAI SDKs surface it instead of ignoring it.
 */
function emitOpenAIError(controller, state, { model, message, statusVal, type, code }) {
  const errPayload = JSON.stringify({
    error: {
      message: stripHtml(truncate(message, 500)) || `qoder upstream status ${statusVal}`,
      type: type || "qoder_upstream_error",
      code: code ?? statusVal,
    },
  });
  controller.enqueue(new TextEncoder().encode(`data: ${errPayload}\n\n`));
  emitDone(controller, state);
}

/** finish_reason values that are NOT real terminal signals. */
const NULL_FINISH = new Set(["null", ""]);

/**
 * Inspect an inner OpenAI chunk for finish_reason issues:
 *  - "null" string → strip (server means "not finished yet")  [S1]
 *  - "model_context_window_exceeded" → emit 413 error          [S2]
 * Returns the (possibly modified) chunk OBJECT, or null if an error was emitted.
 */
function handleFinishReasonObj(chunk, controller, state, model) {
  if (!chunk || typeof chunk !== "object" || !Array.isArray(chunk.choices)) return chunk;

  for (const choice of chunk.choices) {
    const fr = choice?.finish_reason;
    if (fr == null) continue;

    // S2: context window exceeded → 413 error, not a successful finish
    if (fr === "model_context_window_exceeded") {
      emitOpenAIError(controller, state, {
        model,
        message: "Model context window exceeded",
        statusVal: 413,
        type: "context_length_exceeded",
        code: "context_length_exceeded",
      });
      return null;
    }

    // S1: "null" string means "not finished" — strip it
    if (NULL_FINISH.has(fr)) {
      choice.finish_reason = null;
    }
  }

  return chunk;
}

/** Check if a chunk is a usage-only final chunk (choices:[] + usage). */
function isUsageOnlyChunk(chunk) {
  return chunk && typeof chunk === "object" &&
    Array.isArray(chunk.choices) && chunk.choices.length === 0 &&
    chunk.usage && typeof chunk.usage === "object";
}

/** Check if a chunk has a real (non-null) finish_reason. */
function hasRealFinish(chunk) {
  if (!chunk?.choices) return false;
  return chunk.choices.some((c) => c?.finish_reason != null && !NULL_FINISH.has(c.finish_reason));
}

/** Emit a chunk object as SSE data. */
function emitChunk(controller, encoder, state, chunk) {
  normalizeReasoningItem(chunk); // S9: reasoning_item → reasoning_content
  const sanitized = JSON.stringify(chunk).replace(/\r?\n/g, "");
  state.contentEmitted = true;
  controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
}

/** S13: Strip HTML tags from error messages (e.g. 504 pages). */
function stripHtml(s) {
  if (!s || typeof s !== "string") return s;
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim() || s;
}

/** S9: Normalize delta.reasoning_item → delta.reasoning_content for downstream. */
function normalizeReasoningItem(chunk) {
  if (!chunk?.choices) return chunk;
  for (const choice of chunk.choices) {
    const delta = choice?.delta;
    if (!delta) continue;
    if (delta.reasoning_item && !delta.reasoning_content) {
      // reasoning_item: {summary:[{text:"..."}], encrypted_content:"..."}
      const item = delta.reasoning_item;
      const text = Array.isArray(item.summary)
        ? item.summary.map((s) => s?.text || "").join("")
        : typeof item === "string" ? item : "";
      if (text) delta.reasoning_content = text;
      delete delta.reasoning_item;
    }
  }
  return chunk;
}

export function isBillingBlock(inner) {
  if (!inner) return false;
  const str = typeof inner === "string" ? inner : JSON.stringify(inner);
  const lowerMsg = str.toLowerCase();
  if (lowerMsg.includes("pricingurl")) return true;
  try {
    const parsed = typeof inner === "object" ? inner : JSON.parse(str);
    const code = String(parsed?.code ?? "");
    if (code === "110" || code === "112" || code === "10605") return true;
  } catch { /* not JSON */ }
  return /"code"\s*:\s*"(110|112|10605)"/.test(str);
}

async function peekFirstQoderFrame(reader, decoder) {
  let consumed = "";
  let offset = 0;
  let upstreamDone = false;
  while (true) {
    let nl = consumed.indexOf("\n", offset);
    if (nl === -1 && !upstreamDone) {
      const { done, value } = await reader.read();
      upstreamDone = done;
      consumed += done ? decoder.decode() : decoder.decode(value, { stream: true });
      continue;
    }
    if (offset >= consumed.length) return { isError: false, isBilling: false, statusVal: 200, message: "", consumed, upstreamDone };
    if (nl === -1) nl = consumed.length;

    const line = consumed.slice(offset, nl).replace(/\r$/, "").trim();
    offset = nl + 1;
    if (!line.startsWith("data:")) continue;

    const data = line.slice(5).trimStart();
    if (data === "[DONE]") return { isError: false, isBilling: false, statusVal: 200, message: "", consumed, upstreamDone };

    let envelope;
    try { envelope = JSON.parse(data); } catch { return { isError: false, isBilling: false, statusVal: 200, message: "", consumed, upstreamDone }; }

    const raw = Number(envelope?.statusCodeValue);
    const statusVal = Number.isNaN(raw) ? 200 : raw;
    const inner = typeof envelope?.body === "string"
      ? envelope.body
      : envelope?.body != null ? JSON.stringify(envelope.body) : "";

    if (statusVal !== 200) {
      return { isError: true, isBilling: isBillingBlock(inner), statusVal, message: inner || `upstream status ${statusVal}`, consumed, upstreamDone };
    }
    return { isError: false, isBilling: false, statusVal: 200, message: "", consumed, upstreamDone };
  }
}

/**
 * @param {Response} response
 * @param {string} model - label for error chunks
 * @param {any} [log]
 */
async function wrapQoderSSE(response, model, log = null) {
  if (!response.ok || !response.body) return response;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = response.body.getReader();

  const peek = await peekFirstQoderFrame(reader, decoder);
  if (peek.isError) {
    await reader.cancel().catch(() => {});
    const status = peek.isBilling
      ? 403
      : Number.isInteger(peek.statusVal) && peek.statusVal >= 400 && peek.statusVal <= 599
        ? peek.statusVal : 502;
    return new Response(
      JSON.stringify({ error: { message: peek.message, code: peek.statusVal } }),
      { status, headers: { "Content-Type": "application/json" } }
    );
  }

  let buffer = "";
  const state = { doneEmitted: false, lastEvent: "", contentEmitted: false };

  const processLine = (line, controller) => {
    const trimmed = line.replace(/\r$/, "").trim();
    if (!trimmed) return;
    if (trimmed.startsWith("event:")) {
      state.lastEvent = trimmed.slice(6).trim();
      return;
    }
    if (!trimmed.startsWith("data:")) return;
    if (state.doneEmitted) return;

    const data = trimmed.slice(5).trimStart();

    if (data === "[DONE]") {
      emitDone(controller, state);
      return;
    }
    if (data === "[NOT_EXCEED_QUOTA]" || data.startsWith("[NOTIFICATIONS]")) {
      return;
    }
    if (data.startsWith("[EXCEED_QUOTA]")) {
      emitOpenAIError(controller, state, {
        model,
        message: data,
        statusVal: 429,
      });
      return;
    }

    let envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }

    if (envelope == null || typeof envelope !== "object") return;

    const raw = Number(envelope?.statusCodeValue);
    const statusVal = Number.isNaN(raw) ? 200 : raw;
    const inner = typeof envelope?.body === "string"
      ? envelope.body
      : envelope?.body != null ? JSON.stringify(envelope.body) : "";

    if (statusVal !== 200) {
      if (state.lastEvent === "finish") {
        emitDone(controller, state);
        return;
      }
      if (isBillingBlock(inner)) {
        const errObj = JSON.stringify({
          error: {
            message: inner || `qoder billing block (${statusVal})`,
            code: "qoder_billing_block",
            status: 403,
            type: "quota_error",
          },
        });
        controller.enqueue(encoder.encode(`data: ${errObj}\n\n`));
        emitDone(controller, state);
        return;
      }
      const isAuth = statusVal === 103 || statusVal === 105 ||
        /login expired|login timeout|token.*expired|auth/i.test(inner);
      const isQueue = statusVal === 10605 || /queue|isQueued|retry_after/i.test(inner);
      emitOpenAIError(controller, state, {
        model,
        message: inner || `upstream status ${statusVal}`,
        statusVal: isAuth ? 401 : isQueue ? 429 : statusVal,
        type: isAuth ? "authentication_error" : isQueue ? "model_queued" : "qoder_upstream_error",
        code: isAuth ? "token_expired" : isQueue ? "model_queued" : statusVal,
      });
      return;
    }

    if (!inner) return;

    if (isSpecialToken(inner)) {
      if (inner === "[DONE]") {
        emitDone(controller, state);
        return;
      }
      if (inner.startsWith("[EXCEED_QUOTA]")) {
        emitOpenAIError(controller, state, { model, message: inner, statusVal: 429 });
        return;
      }
      return;
    }

    let chunk;
    try {
      chunk = JSON.parse(inner);
    } catch {
      const sanitized = inner.replace(/\r?\n/g, "");
      state.contentEmitted = true;
      controller.enqueue(encoder.encode(`data: ${sanitized}\n\n`));
      return;
    }

    const handled = handleFinishReasonObj(chunk, controller, state, model);
    if (handled === null) return;

    if (isUsageOnlyChunk(handled)) {
      if (state.pendingFinish) {
        state.pendingFinish.usage = handled.usage;
        emitChunk(controller, encoder, state, state.pendingFinish);
        state.pendingFinish = null;
      }
      return;
    }

    if (hasRealFinish(handled) && !(handled.usage && typeof handled.usage === "object")) {
      state.pendingFinish = handled;
      return;
    }

    if (state.pendingFinish) {
      emitChunk(controller, encoder, state, state.pendingFinish);
      state.pendingFinish = null;
    }

    emitChunk(controller, encoder, state, handled);
  };

  const flush = (controller) => {
    buffer += decoder.decode();
    if (buffer.length > 0) {
      processLine(buffer, controller);
      buffer = "";
    }
    if (state.pendingFinish) {
      emitChunk(controller, encoder, state, state.pendingFinish);
      state.pendingFinish = null;
    }
    if (!state.contentEmitted && !state.doneEmitted) {
      emitOpenAIError(controller, state, {
        model,
        message: "Empty response: stream ended without any content",
        statusVal: 502,
        type: "empty_response",
        code: "empty_response",
      });
      return;
    }
    emitDone(controller, state);
  };

  const stream = new ReadableStream({
    async start(controller) {
      if (peek.consumed) {
        buffer += peek.consumed;
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          processLine(line, controller);
        }
      }
      if (peek.upstreamDone) {
        flush(controller);
        try { controller.close(); } catch {}
        return;
      }
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            processLine(line, controller);
          }
        }
        flush(controller);
      } catch (err) {
        // Stream aborted or reader cancelled
      } finally {
        try { controller.close(); } catch {}
        await reader.cancel().catch(() => {});
      }
    },
    cancel() {
      return reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

export { wrapQoderSSE, isSpecialToken };
