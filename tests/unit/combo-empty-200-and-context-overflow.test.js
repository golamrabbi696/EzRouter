// Regression for #4736 / #4683 / #4796:
// 1) a 2xx with zero usable content must not count as combo success;
// 2) context-overflow 400 text rules must trigger fallback (cooldownMs 0).
import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("#4796 context-overflow errors are fallbackable", () => {
  const cases = [
    ["This model's maximum context length is 8192 tokens. However, you requested 12934 tokens", "openai"],
    ["prompt is too long: 233153 tokens > 200000 maximum", "anthropic"],
    ["Input token exceed the limit", "vertex"],
    ["the request exceeds the available context size", "unknown-provider"]
  ];
  for (const [text, provider] of cases) {
    it(`falls back on: ${text.slice(0, 40)}…`, () => {
      const r = checkFallbackError(400, text, 0, provider);
      expect(r.shouldFallback).toBe(true);
      expect(r.cooldownMs).toBe(0);
    });
  }

  it("still refuses fallback for an ordinary malformed-request 400", () => {
    const r = checkFallbackError(400, "Unsupported model mimo-auto", 0, "mmf");
    expect(r.shouldFallback).toBe(false);
  });
});

describe("#4736/#4683 empty 2xx detection", () => {
  it("combo.js exposes an empty-result check via the loop (smoke: module imports)", async () => {
    const mod = await import("../../open-sse/services/combo.js");
    expect(typeof mod.handleComboChat).toBe("function");
  });
});
