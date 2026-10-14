import { describe, it, expect } from "vitest";
import {
  prepareRequestDetailsResponse,
  shouldShowRequestPayloads,
} from "../../src/lib/requestDetailsVisibility.js";

// Mirror the redaction logic from src/app/api/usage/request-details/route.js
// so we can test it in isolation.
function redactDetails(details, promptLoggingEnabled = false) {
  return prepareRequestDetailsResponse(
    { details: details || [] },
    { ENABLE_PROMPT_LOGGING: String(promptLoggingEnabled) }
  ).details;
}

describe("request-details redaction", () => {
  it("removes conversation payloads but keeps metadata by default", () => {
    const details = [{
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    }];
    const out = prepareRequestDetailsResponse({ details }, {}).details[0];
    expect(out.id).toBe("abc");
    expect(out.provider).toBe("opencode");
    expect(out.model).toBe("deepseek-v4-flash-free");
    expect(out.tokens).toEqual({ prompt_tokens: 10, completion_tokens: 5 });
    expect(out.request).toEqual({ redacted: true });
    expect(out.providerRequest).toEqual({ redacted: true });
    expect(out.providerResponse).toEqual({ redacted: true });
    expect(out.response).toEqual({ redacted: true });
  });

  it("handles empty details", () => {
    expect(prepareRequestDetailsResponse({ details: [] }, {}).details).toEqual([]);
    expect(prepareRequestDetailsResponse({ details: null }, {}).details).toEqual([]);
  });

  it("keeps non-sensitive fields untouched", () => {
    const details = [{ id: "x", status: "error", latency: { total: 100 } }];
    const out = prepareRequestDetailsResponse({ details }, {}).details[0];
    expect(out.id).toBe("x");
    expect(out.status).toBe("error");
    expect(out.latency).toEqual({ total: 100 });
  });

  it("returns payloads only when SHOW_REQUEST_PAYLOADS is true", () => {
    const result = {
      details: [{
        id: "abc",
        request: { messages: [{ role: "user", content: "secret prompt" }] },
        response: { content: "secret answer" },
      }],
      pagination: { page: 1 },
    };

    expect(prepareRequestDetailsResponse(result, { SHOW_REQUEST_PAYLOADS: "false" }))
      .not.toBe(result);
    expect(prepareRequestDetailsResponse(result, { SHOW_REQUEST_PAYLOADS: "true" }))
      .toBe(result);
    expect(prepareRequestDetailsResponse(result, { SHOW_REQUEST_PAYLOADS: "TRUE" }))
      .toBe(result);
  });

  it("keeps payload display independent from ENABLE_REQUEST_LOGS", () => {
    expect(shouldShowRequestPayloads({
      ENABLE_REQUEST_LOGS: "false",
      SHOW_REQUEST_PAYLOADS: "true",
    })).toBe(true);
    expect(shouldShowRequestPayloads({
      ENABLE_REQUEST_LOGS: "true",
      SHOW_REQUEST_PAYLOADS: "false",
    })).toBe(false);
  });

  // ENABLE_PROMPT_LOGGING=true escape hatch (#4728, #4812)
  it("returns payloads verbatim when prompt logging is enabled", () => {
    const details = [{
      id: "abc",
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
    }];
    const out = redactDetails(details, true)[0];
    expect(out.request).toEqual({ messages: [{ role: "user", content: "secret prompt" }] });
    expect(out.providerResponse).toEqual({ choices: [{ message: { content: "secret answer" } }] });
  });

  it("prompt logging enabled still tolerates empty details", () => {
    expect(redactDetails([], true)).toEqual([]);
    expect(redactDetails(null, true)).toEqual([]);
  });
});
