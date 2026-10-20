// Regression: the unmatched-4xx catch-all in checkFallbackError treated every
// status in [400..499] as a request-scoped client error, which included the
// transient gateway statuses. 408 Request Timeout, 425 Too Early and 499 Client
// Closed Request are emitted by load balancers and edge proxies when an
// upstream node stalls or resets — the payload is fine, the node is not. A
// fallback combo aborted on the first such error and never tried its backup
// members. (#4911)
import { describe, expect, it } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

// Mirrors the combo loop's condition in services/combo.js.
const comboFallsBack = (status, errorText) =>
  checkFallbackError(status, errorText).shouldFallback;

describe("checkFallbackError — transient gateway statuses fall back", () => {
  it.each([408, 425, 499])("falls back on %d", (status) => {
    const result = checkFallbackError(status, "upstream stalled");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });

  it.each([408, 425, 499])("lets a combo move on to the next member on %d", (status) => {
    expect(comboFallsBack(status, "upstream stalled")).toBe(true);
  });
});

describe("checkFallbackError — request-scoped errors still abort", () => {
  it.each([400, 405, 406, 415, 422])("does not fall back on %d", (status) => {
    expect(checkFallbackError(status, "malformed request")).toMatchObject({
      shouldFallback: false,
      cooldownMs: 0,
    });
  });

  it("keeps the context-overflow behaviour pinned", () => {
    const result = checkFallbackError(400, JSON.stringify({
      error: {
        message: "This model's maximum context length is 1048576 tokens. However, you requested 1186139 tokens",
        type: "invalid_request_error",
      },
    }));

    expect(result).toMatchObject({ shouldFallback: true, cooldownMs: 0 });
  });

  it("still honours rate-limit / quota wording on any 4xx", () => {
    expect(checkFallbackError(400, "rate limit reached").shouldFallback).toBe(true);
    expect(checkFallbackError(422, "quota exceeded").shouldFallback).toBe(true);
  });
});

describe("checkFallbackError — account-scoped and server errors are unchanged", () => {
  it("still falls back for account-scoped statuses", () => {
    for (const status of [401, 402, 403, 404, 429]) {
      expect(checkFallbackError(status, "nope").shouldFallback).toBe(true);
    }
  });

  it("keeps the transient cooldown for unmatched server errors", () => {
    const result = checkFallbackError(503, "upstream exploded");

    expect(result.shouldFallback).toBe(true);
    expect(result.cooldownMs).toBeGreaterThan(0);
  });
});