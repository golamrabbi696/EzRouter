/**
 * Regression for #4808: the request logger wrote provider auth headers to disk in
 * clear text because masking was disabled ("keep full token for testing").
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { maskSensitiveHeaders, normalizeResponseHeaders } from "../../open-sse/utils/requestLogger.js";

const HEADERS = {
  "Content-Type": "application/json",
  Authorization: "Bearer sk-live-0123456789abcdefghij",
  "x-api-key": "oc_sk_abcdefghijklmnopqrstuvwxyz",
  Cookie: "session=verysecretvalue1234567890",
  "X-Client-Token": "tok_zyxwvutsrqponmlkjihgfedcba",
  "User-Agent": "opencode/1.18.31",
};

describe("maskSensitiveHeaders (#4808)", () => {
  beforeEach(() => { delete process.env.REQUEST_LOG_RAW_HEADERS; });
  afterEach(() => { delete process.env.REQUEST_LOG_RAW_HEADERS; });

  it("never writes an auth value in clear text", () => {
    const out = maskSensitiveHeaders(HEADERS);
    expect(out.Authorization).not.toContain("0123456789abcdefghij");
    expect(out["x-api-key"]).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(out.Cookie).not.toContain("verysecretvalue1234567890");
    expect(out["X-Client-Token"]).not.toContain("zyxwvutsrqponmlkjihgfedcba");
  });

  it("keeps non-sensitive headers untouched", () => {
    const out = maskSensitiveHeaders(HEADERS);
    expect(out["Content-Type"]).toBe("application/json");
    expect(out["User-Agent"]).toBe("opencode/1.18.31");
  });

  it("masks short values entirely instead of leaking a slice", () => {
    const out = maskSensitiveHeaders({ authorization: "short" });
    expect(out.authorization).toBe("***");
  });

  it("allows full headers only through the explicit debug opt-in", () => {
    process.env.REQUEST_LOG_RAW_HEADERS = "1";
    const out = maskSensitiveHeaders(HEADERS);
    expect(out.Authorization).toBe("Bearer sk-live-0123456789abcdefghij");
  });

  it("returns an empty object for missing headers", () => {
    expect(maskSensitiveHeaders(null)).toEqual({});
  });
});

describe("normalizeResponseHeaders (#4808)", () => {
  beforeEach(() => { delete process.env.REQUEST_LOG_RAW_HEADERS; });
  afterEach(() => { delete process.env.REQUEST_LOG_RAW_HEADERS; });

  it("masks credentials in a real Headers object from the provider response", () => {
    const headers = new Headers({
      "content-type": "text/event-stream",
      "set-cookie": "session=verysecretvalue1234567890",
      "x-api-key": "oc_sk_abcdefghijklmnopqrstuvwxyz",
    });
    const out = normalizeResponseHeaders(headers);
    expect(out["content-type"]).toBe("text/event-stream");
    expect(out["set-cookie"]).not.toContain("verysecretvalue1234567890");
    expect(out["x-api-key"]).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("masks credentials in a plain object and tolerates missing headers", () => {
    expect(normalizeResponseHeaders({ Authorization: "Bearer sk-live-0123456789abcdef" }).Authorization)
      .not.toContain("0123456789abcdef");
    expect(normalizeResponseHeaders(null)).toEqual({});
  });
});
