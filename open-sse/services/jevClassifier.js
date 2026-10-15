/**
 * Jev / System One routing classifier.
 *
 * Provider-neutral: the caller injects `evaluateSystemone(payload, model)`. In
 * the app this invokes 9router's existing handleSystemone() path in-process, so
 * OpenCode, OpenRouter, Vercel, and future System One providers reuse normal
 * credential fallback and usage accounting.
 *
 * Fail-open: any error, timeout, malformed response, unknown tier, or low
 * confidence returns null and preserves the combo's existing order.
 */

import { trailingUserItems } from "./combo.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import {
  JEV_DEFAULT_CLASSIFIER_MODEL,
  JEV_TIERS,
  JEV_DEFAULT_CRITERIA,
  JEV_DEFAULT_INSTRUCTIONS,
  JEV_STATE_CHAR_BUDGET,
  JEV_TIMEOUT_MS,
  JEV_TIMEOUT_MAX_MS,
  JEV_BREAKER_COOLDOWN_MS,
  JEV_MIN_CONFIDENCE,
} from "../config/jev.js";

// Per-model breaker: a bad OpenRouter lane must not suppress healthy OpenCode
// or Vercel lanes.
const breakers = new Map();

/** Test/reset hook: clear one classifier breaker, or all when omitted. */
export function resetJevBreaker(classifierModel) {
  if (classifierModel) breakers.delete(classifierModel);
  else breakers.clear();
}

function breakerOpen(classifierModel, now) {
  const state = breakers.get(classifierModel);
  if (!state) return false;
  if (now < state.openUntil) return true;
  if (!state.halfOpen) {
    state.halfOpen = true;
    return false;
  }
  return true;
}

function tripBreaker(classifierModel, now, cooldownMs) {
  breakers.set(classifierModel, { openUntil: now + cooldownMs, halfOpen: false });
}

// Tool-result carriers are not user asks: OpenAI role:"tool", Responses
// function_call_output, Claude user turns made only of tool_result blocks, and
// Gemini turns made only of functionResponse parts.
function isToolTurn(item) {
  if (!item || typeof item !== "object") return false;
  if (item.role === "tool" || item.type === "function_call_output") return true;
  if (Array.isArray(item.content) && item.content.length > 0) return item.content.every((b) => b?.type === "tool_result");
  if (Array.isArray(item.parts) && item.parts.length > 0) return item.parts.every((p) => p?.functionResponse);
  return false;
}

/**
 * Latest real user ask: walk back past assistant turns and tool results, then
 * take the nearest run of user turns that carries text (a run may span several
 * blocks, e.g. text + image).
 */
function latestAskText(arr, textOf) {
  if (!Array.isArray(arr)) return "";
  const isUser = (item) => item?.role === "user" && !isToolTurn(item);
  let i = arr.length - 1;
  while (i >= 0) {
    if (!isUser(arr[i])) { i--; continue; }
    const parts = [];
    for (; i >= 0 && isUser(arr[i]); i--) {
      const text = textOf(arr[i]);
      if (text) parts.unshift(text);
    }
    if (parts.length) return parts.join("\n");
  }
  return "";
}

const textOfContent = (item) => {
  const text = extractTextContent(item?.content);
  return typeof text === "string" ? text.trim() : "";
};
const textOfParts = (item) =>
  Array.isArray(item?.parts)
    ? item.parts.map((p) => (typeof p?.text === "string" ? p.text.trim() : "")).filter(Boolean).join("\n")
    : "";

/** Build a bounded state from the latest real user ask only. */
export function buildJevState(body, charBudget = JEV_STATE_CHAR_BUDGET) {
  if (!body || typeof body !== "object") return "";
  const text = latestAskText(body.messages, textOfContent)
    || latestAskText(body.input, textOfContent)
    || latestAskText(body.contents || body.request?.contents, textOfParts);
  return text.slice(0, charBudget);
}

function evaluateWithTimeout(evaluateSystemone, payload, classifierModel, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ __timeout: true }), timeoutMs);
    Promise.resolve(evaluateSystemone(payload, classifierModel))
      .then((value) => { clearTimeout(timer); resolve({ value }); })
      .catch((error) => { clearTimeout(timer); resolve({ error }); });
  });
}

// Settings may hold "" (UI reset), strings, or out-of-range numbers: coerce to a
// finite value inside [lo, hi], else fall back to the default.
function boundedNumber(value, fallback, lo, hi) {
  const n = value === "" || value == null ? NaN : Number(value);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/**
 * Classify a chat request into SIMPLE / MEDIUM / COMPLEX / REASONING.
 * Returns null on any skip (fail-open); `onSkip(reason, message)` reports why:
 * no-evaluator | empty-state | breaker-open | timeout | error | http |
 * invalid-json | unknown-tier | low-confidence.
 */
export async function classifyTier(opts = {}) {
  const {
    body,
    evaluateSystemone,
    classifierModel = JEV_DEFAULT_CLASSIFIER_MODEL,
    log = { info() {}, warn() {}, debug() {} },
    criteria = JEV_DEFAULT_CRITERIA,
    instructions = JEV_DEFAULT_INSTRUCTIONS,
    breakerEnabled = true,
    now = () => Date.now(),
    onSkip,
  } = opts;
  const timeoutMs = boundedNumber(opts.timeoutMs, JEV_TIMEOUT_MS, 1, JEV_TIMEOUT_MAX_MS);
  const minConfidence = boundedNumber(opts.minConfidence, JEV_MIN_CONFIDENCE, 0, 1);
  const skip = (reason, message) => { onSkip?.(reason, message); return null; };

  const t0 = now();
  if (typeof evaluateSystemone !== "function") {
    log.debug?.("JEV", "no System One evaluator — skipping classifier (fail-open)");
    return skip("no-evaluator", "no System One evaluator");
  }

  const state = buildJevState(body);
  if (!state) {
    log.debug?.("JEV", "empty state — skipping classifier (fail-open)");
    return skip("empty-state", "no user text found in request");
  }

  if (breakerEnabled && breakerOpen(classifierModel, t0)) {
    log.debug?.("JEV", `circuit breaker open for ${classifierModel} — skipping classifier`);
    return skip("breaker-open", `${classifierModel} paused after a recent failure (cooldown ${JEV_BREAKER_COOLDOWN_MS}ms)`);
  }

  const payload = {
    state,
    questions: { tier: { type: "choice", instructions, criteria } },
  };

  let response;
  try {
    const result = await evaluateWithTimeout(
      evaluateSystemone,
      payload,
      classifierModel,
      timeoutMs
    );
    if (result?.__timeout) {
      if (breakerEnabled) tripBreaker(classifierModel, now(), JEV_BREAKER_COOLDOWN_MS);
      log.warn?.("JEV", `${classifierModel} classifier timed out — fail-open`);
      return skip("timeout", `${classifierModel} no answer within ${timeoutMs}ms`);
    }
    if (result?.error) {
      const message = result.error?.message || String(result.error);
      log.warn?.("JEV", `${classifierModel} classifier error — fail-open: ${message}`);
      return skip("error", message);
    }
    response = result?.value;
  } catch (error) {
    const message = error?.message || String(error);
    log.warn?.("JEV", `${classifierModel} classifier error — fail-open: ${message}`);
    return skip("error", message);
  }

  if (!response?.ok) {
    log.warn?.("JEV", `${classifierModel} classifier HTTP ${response?.status} — fail-open`);
    return skip("http", `${classifierModel} returned HTTP ${response?.status}`);
  }

  let json;
  try {
    json = await response.json();
  } catch (error) {
    const message = error?.message || String(error);
    log.warn?.("JEV", `${classifierModel} returned invalid JSON — fail-open: ${message}`);
    return skip("invalid-json", message);
  }

  const answer = json?.answers?.tier;
  const tier = answer?.choice;
  const confidence = typeof answer?.confidence === "number" ? answer.confidence : null;
  const probabilities = answer?.probabilities && typeof answer.probabilities === "object"
    ? answer.probabilities
    : null;

  if (!tier || !JEV_TIERS.includes(tier)) {
    log.warn?.("JEV", `${classifierModel} returned unknown tier "${tier}" — fail-open`);
    return skip("unknown-tier", `${classifierModel} returned tier "${tier}"`);
  }
  if (confidence == null || confidence < minConfidence) {
    log.info?.("JEV", `${classifierModel} low confidence (${confidence}) for ${tier} — keeping order`);
    return skip("low-confidence", `${tier} confidence ${confidence == null ? "missing" : confidence.toFixed(3)} < min ${minConfidence}`);
  }

  if (breakerEnabled) breakers.delete(classifierModel);
  const elapsed = now() - t0;
  log.info?.("JEV", `${classifierModel} tier=${tier} conf=${confidence.toFixed(3)} in ${elapsed}ms`);

  return {
    tier,
    confidence,
    probabilities,
    model: json?.model || classifierModel,
    usage: json?.usage || null,
    source: "systemone",
  };
}
