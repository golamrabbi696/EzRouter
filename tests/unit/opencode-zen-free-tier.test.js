import { describe, expect, it } from "vitest";
import { OpenCodeZenExecutor } from "../../open-sse/executors/opencode-zen.js";
import {
  OPENCODE_SESSION_RE,
  stableFreeTierSessionId,
} from "../../open-sse/executors/opencode-zen.js";
import { isOpencodeFreeTierModel } from "../../open-sse/providers/models/helpers.js";

// Upstream 403s free-tier models on the keyed lane when the request carries a
// real oc_sk_* key (FreeTierError: "can only be used from within OpenCode").
// The executor must switch those to the attested `Bearer public` identity.

function preparedCredentials(executor, overrides = {}) {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const credentials = {
    apiKey: "oc_sk_test_key",
    rawHeaders: {},
    connectionId: "conn_test",
    ...overrides,
  };
  return executor.prepareRequestCredentials({
    body,
    credentials,
    providerSessionId: "conversation-a",
    clientTool: "test",
  });
}

function headersFor(model, overrides) {
  const executor = new OpenCodeZenExecutor();
  const credentials = preparedCredentials(executor, overrides);
  return executor.buildHeaders(credentials, true, "https://opencode.ai/zen/v1/chat/completions", model);
}

describe("isOpencodeFreeTierModel", () => {
  it("detects -free suffixed ids", () => {
    for (const m of [
      "mimo-v2.6-flash-free",
      "muse-spark-1.3-contributor-free",
      "big-pickle-free",
      "deepseek-v4-flash-free",
      "jev-1.13-free",
    ]) {
      expect(isOpencodeFreeTierModel(m)).toBe(true);
    }
  });

  it("ignores paid models", () => {
    for (const m of ["big-pickle", "muse-spark-1.3", "gpt-5.5", "claude-opus-5", "kimi-k3"]) {
      expect(isOpencodeFreeTierModel(m)).toBe(false);
    }
  });

  it("strips thinking suffixes and provider prefixes before matching", () => {
    expect(isOpencodeFreeTierModel("mimo-v2.6-flash-free(xhigh)")).toBe(true);
    expect(isOpencodeFreeTierModel("muse-spark-1.3-contributor-free(1m)")).toBe(true);
    expect(isOpencodeFreeTierModel("ocfree/mimo-v2.6-flash-free")).toBe(true);
    expect(isOpencodeFreeTierModel("big-pickle(max)")).toBe(false);
    expect(isOpencodeFreeTierModel("")).toBe(false);
    expect(isOpencodeFreeTierModel(null)).toBe(false);
  });
});

describe("OpenCodeZenExecutor free-tier auth", () => {
  it("sends Bearer public + session + request ids for free-tier models", () => {
    const headers = headersFor("mimo-v2.6-flash-free");
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
    expect(headers["x-opencode-client"]).toBe("desktop");
    expect(headers["User-Agent"]).toMatch(/opencode\/\d+\.\d+/i);
  });

  it("does the same for responses-endpoint free models", () => {
    const headers = headersFor(
      "muse-spark-1.3-contributor-free",
      {},
    );
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-request"]).toMatch(/^msg_/);
  });

  it("keeps the connection key for paid models", () => {
    const headers = headersFor("big-pickle");
    expect(headers["Authorization"]).toBe("Bearer oc_sk_test_key");
    expect(headers["x-opencode-request"]).toBeUndefined();
    expect(headers["x-opencode-session"]).toMatch(OPENCODE_SESSION_RE);
  });

  it("reuses one time-based session per identity (fresh hash-translated sessions 403 upstream)", () => {
    const executor = new OpenCodeZenExecutor();
    const a = preparedCredentials(executor, { connectionId: "conn_a" });
    const b = preparedCredentials(executor, { connectionId: "conn_b" });
    const s1 = stableFreeTierSessionId(a);
    const s2 = stableFreeTierSessionId(a);
    expect(s2).toBe(s1);
    expect(stableFreeTierSessionId(b)).not.toBe(s1);
    // The 12-hex prefix must decode to a recent timestamp (~(now*0x1000+1)).
    // Only the low 48 bits survive, so compare modularly with wrap handling.
    const mask = 0xffffffffffffn;
    const actual = (~BigInt(`0x${s1.slice(4, 16)}`)) & mask;
    const expected = (BigInt(Date.now()) * 0x1000n + 1n) & mask;
    let diff = (expected - actual) % (mask + 1n);
    if (diff > mask / 2n) diff -= mask + 1n;
    if (diff < -(mask / 2n)) diff += mask + 1n;
    expect(Number(diff < 0n ? -diff : diff) / 0x1000).toBeLessThan(120_000);
  });

  it("emits the stable time-based session on free-tier requests", () => {
    const executor = new OpenCodeZenExecutor();
    const credentials = preparedCredentials(executor, { connectionId: "conn_live" });
    const expected = stableFreeTierSessionId(credentials);
    const headers = executor.buildHeaders(
      credentials, true, "https://opencode.ai/zen/v1/chat/completions", "mimo-v2.6-flash-free",
    );
    expect(headers["x-opencode-session"]).toBe(expected);
  });
});
