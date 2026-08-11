// Gemini thought-signature preservation across the OpenAI-compat bridge.
//
// Google Gemini 3 attaches a `thoughtSignature` to the functionCall part it
// returns. When a structured functionCall is converted to an OpenAI tool_call
// and replayed by the client, the signature MUST travel with the tool_call or
// the next turn is rejected with 400 INVALID_ARGUMENT ("function call is
// missing a thought_signature"). See:
//   https://ai.google.dev/gemini-api/docs/openai#thought-signatures
//   https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
//
// OpenAI-compat convention used by the official Gemini OpenAI endpoint:
//
//   tool_calls[i].extra_content.google.thought_signature = "<sig>"
//
// Rules we honor (per Google's docs):
//   - Single functionCall     : signature on the functionCall part only.
//   - Parallel functionCalls  : signature on the FIRST functionCall part only.
//   - Sequential functionCalls: every step's functionCall carries its own sig.
//
// Antigravity's internal endpoint (v1internal:...) does NOT speak the
// OpenAI-compat `extra_content` envelope — it consumes the native Gemini
// `Part.thoughtSignature` field directly. We keep both shapes in sync.
//
// This module is intentionally tiny: read/write the signature from a tool_call
// or functionCall part. It does NOT decide whether to backfill a synthetic
// default — that policy lives in the request translator where we know whether
// real history is available.

export const GOOGLE_EXTRA_CONTENT = "google";
export const THOUGHT_SIGNATURE_KEY = "thought_signature";

// Read a real thought signature from an OpenAI-compat tool_call.
// Sources (first match wins):
//   1. tool_call.extra_content.google.thought_signature
//   2. tool_call.thought_signature            (legacy / non-standard)
// Returns null when no signature is present.
export function readOpenAIToolCallSignature(toolCall) {
  if (!toolCall || typeof toolCall !== "object") return null;
  const extra = toolCall[OPENAI_TOOL_EXTRA_CONTENT_KEY];
  if (extra && typeof extra === "object") {
    const google = extra[GOOGLE_EXTRA_CONTENT];
    if (google && typeof google === "object") {
      const sig = google[THOUGHT_SIGNATURE_KEY];
      if (typeof sig === "string" && sig.length > 0) return sig;
    }
  }
  const legacy = toolCall[THOUGHT_SIGNATURE_KEY];
  if (typeof legacy === "string" && legacy.length > 0) return legacy;
  return null;
}

// Read a thought signature from a native Gemini Part (response-side).
// Gemini uses both `thoughtSignature` (newer) and `thought_signature`
// (snake-case legacy) — handle either.
export function readGeminiPartSignature(part) {
  if (!part || typeof part !== "object") return null;
  const sig = part.thoughtSignature || part.thought_signature;
  return typeof sig === "string" && sig.length > 0 ? sig : null;
}

// Attach a thought signature to an OpenAI-compat tool_call using the
// documented `extra_content.google.thought_signature` envelope. The object
// is mutated in place to keep this allocation-free in the hot path.
export function attachOpenAIToolCallSignature(toolCall, signature) {
  if (!toolCall || typeof toolCall !== "object" || !signature) return toolCall;
  const extra = toolCall[OPENAI_TOOL_EXTRA_CONTENT_KEY] || {};
  const google = extra[GOOGLE_EXTRA_CONTENT] || {};
  google[THOUGHT_SIGNATURE_KEY] = signature;
  extra[GOOGLE_EXTRA_CONTENT] = google;
  toolCall[OPENAI_TOOL_EXTRA_CONTENT_KEY] = extra;
  return toolCall;
}

// Read a thought signature from a Gemini functionCall part (response-side
// helper — equivalent to readGeminiPartSignature but explicit).
export function readGeminiFunctionCallSignature(part) {
  return readGeminiPartSignature(part);
}

const OPENAI_TOOL_EXTRA_CONTENT_KEY = "extra_content";
