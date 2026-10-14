import { describe, it, expect } from "vitest";
import { canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";

// CodeBuddy / WorkBuddy report the billing-authoritative `credit` on the final
// usage chunk: how many credits the request actually deducted. A free-allowance
// request deducts nothing and reports exactly 0, so the field's presence — not
// its truthiness — is the signal. canonicalizeUsage() is the single funnel that
// every usage object passes through before storage, and it rebuilds the result
// from a fixed key list, so an unmapped field is silently dropped. These tests
// pin `credit` at that funnel.
describe("canonicalizeUsage preserves the billing credit", () => {
  it("keeps credit: 0 rather than dropping it", () => {
    // 0 is the free-allowance case, which is the one worth telling apart from
    // "the upstream did not report a credit at all".
    const out = canonicalizeUsage({
      prompt_tokens: 12,
      completion_tokens: 5,
      credit: 0,
    });
    expect(out.credit).toBe(0);
    expect(Object.hasOwn(out, "credit")).toBe(true);
  });

  it("keeps a non-zero credit", () => {
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      credit: 0.03,
    });
    expect(out.credit).toBe(0.03);
  });

  it("omits credit when the upstream did not report it", () => {
    // Providers other than CodeBuddy/WorkBuddy never send this field; the
    // canonical object must not invent one.
    const out = canonicalizeUsage({ prompt_tokens: 10, completion_tokens: 2 });
    expect(Object.hasOwn(out, "credit")).toBe(false);
  });

  it("omits credit for null / undefined / unparseable values", () => {
    for (const value of [null, undefined, "n/a", {}]) {
      const out = canonicalizeUsage({ prompt_tokens: 10, completion_tokens: 2, credit: value });
      expect(Object.hasOwn(out, "credit")).toBe(false);
    }
  });

  it("does not let credit leak into the token totals", () => {
    // `credit` rides in the same object as the token counts; if a future change
    // summed the object generically it would corrupt every total.
    const out = canonicalizeUsage({
      prompt_tokens: 12,
      completion_tokens: 5,
      credit: 7,
    });
    expect(out.prompt_tokens).toBe(12);
    expect(out.completion_tokens).toBe(5);
    expect(out.total_tokens).toBe(17);
    expect(out.total_tokens).not.toBe(24);
  });

  it("preserves credit through the Claude cache-folding branch", () => {
    // The fold branch rewrites prompt/total; the credit must survive it too.
    const out = canonicalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 30,
      credit: 0,
    });
    expect(out.prompt_tokens).toBe(330);
    expect(out.credit).toBe(0);
  });

  it("is idempotent for credit", () => {
    const once = canonicalizeUsage({ prompt_tokens: 10, completion_tokens: 2, credit: 0 });
    const twice = canonicalizeUsage(once);
    expect(twice.credit).toBe(0);
    expect(twice.prompt_tokens).toBe(10);
  });
});
