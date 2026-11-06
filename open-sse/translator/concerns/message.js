import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse an OpenAI content-part array: a text-only array becomes a plain string,
// otherwise the array is returned as-is (multimodal content must stay a part list).
// Cache-aware targets retain marked blocks when preserveCacheControl is enabled.
export function collapseTextParts(parts, opts = {}) {
  if (parts.length === 1 && parts[0].type === OPENAI_BLOCK.TEXT) {
    if (opts.preserveCacheControl && parts[0].cache_control) return parts;
    return parts[0].text;
  }
  // A text-only part array carries no multimodal content, but providers that check
  // `typeof content === "string"` either reject it or parse it wrong. Join with a
  // newline so the split between parts survives, unless preserving cache_control.
  if (parts.length > 0 && parts.every((p) => p && p.type === OPENAI_BLOCK.TEXT)) {
    if (opts.preserveCacheControl && parts.some((p) => p.cache_control)) return parts;
    return parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("\n");
  }
  return parts;
}
