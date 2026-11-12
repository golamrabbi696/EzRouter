import { describe, it, expect } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { OpenCodeExecutor } from "../../open-sse/executors/opencode.js";
import { getExecutor } from "../../open-sse/executors/index.js";

const TRANSPORTS = [
  { format: "openai", baseUrl: "https://opencode.ai/inference/go/openai/v1/chat/completions", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  { format: "claude", baseUrl: "https://opencode.ai/inference/go/anthropic/v1/messages", auth: { combined: true, header: "x-api-key", scheme: "raw", anthropicVersion: true } },
  { format: "openai-responses", baseUrl: "https://opencode.ai/inference/go/openai/v1/responses", auth: { combined: true, header: "Authorization", scheme: "bearer" } },
  { format: "gemini", baseUrl: "https://opencode.ai/inference/go/v1/models" },
];

function request(executor, {
  session = "conversation-a",
  connectionId = "connection-a",
  transport = TRANSPORTS[0],
  rawHeaders = { "x-session-id": session },
} = {}) {
  const credentials = { apiKey: "test-key", connectionId, rawHeaders, runtimeTransport: transport };
  executor.transformRequest(
    "muse-spark-1.3-contributor",
    { messages: [{ role: "user", content: "hello" }] },
    true,
    credentials,
  );
  return { credentials, headers: executor.buildHeaders(credentials, true) };
}

function makeCredentials(overrides = {}) {
  return {
    apiKey: "test-key",
    connectionId: "connection-a",
    rawHeaders: {},
    runtimeTransport: TRANSPORTS[0],
    ...overrides,
  };
}

describe("OpenCode Go x-opencode-session", () => {
  it("sends the same opaque session on Chat, Messages, and Responses transports", () => {
    const executor = new DefaultExecutor("opencode-go");
    const values = TRANSPORTS.map((transport) => request(executor, { transport }).headers["x-opencode-session"]);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(values[0]).not.toContain("conversation-a");
  });

  it("keeps one explicit conversation stable and separates different conversations", () => {
    const executor = new DefaultExecutor("opencode-go");
    const a1 = request(executor, { session: "conversation-a" }).headers["x-opencode-session"];
    const a2 = request(executor, { session: "conversation-a" }).headers["x-opencode-session"];
    const b = request(executor, { session: "conversation-b" }).headers["x-opencode-session"];
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  it("ignores inbound x-opencode-session (caller cannot influence provider-owned output)", () => {
    const executor = new DefaultExecutor("opencode-go");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const connectionId = "conn-ignore-x-header";
    const baseHeaders = { "x-session-id": "conversation-a" };
    const injectedHeaders = { "x-session-id": "conversation-a", "x-opencode-session": "caller-controlled-session", "X-OpenCode-Session": "ATTACKER" };
    // baseline: without injected header
    const baseCreds = { apiKey: "test-key", connectionId, rawHeaders: baseHeaders, runtimeTransport: TRANSPORTS[0] };
    executor.transformRequest("muse-spark-1.3-contributor", body, true, baseCreds);
    const baseline = executor.buildHeaders(baseCreds, true)["x-opencode-session"];
    // with injected header: must produce same provider-owned output
    const injectedCreds = { apiKey: "test-key", connectionId, rawHeaders: injectedHeaders, runtimeTransport: TRANSPORTS[0] };
    executor.transformRequest("muse-spark-1.3-contributor", body, true, injectedCreds);
    const withInjected = executor.buildHeaders(injectedCreds, true)["x-opencode-session"];
    expect(baseline).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(withInjected).toBe(baseline);
    expect(withInjected).not.toContain("caller-controlled-session");
    expect(withInjected).not.toContain("ATTACKER");
    // also case-insensitive variant alone must be ignored
    const lowerCreds = { apiKey: "test-key", connectionId, rawHeaders: { "x-session-id": "conversation-a", "X-OPENCODE-SESSION": "lowercase-attack" }, runtimeTransport: TRANSPORTS[0] };
    executor.transformRequest("muse-spark-1.3-contributor", body, true, lowerCreds);
    expect(executor.buildHeaders(lowerCreds, true)["x-opencode-session"]).toBe(baseline);
  });

  it("ignores _clientSessionId (target-format scoped, violates provider isolation)", () => {
    const executor = new DefaultExecutor("opencode-go");
    const body = { messages: [{ role: "user", content: "hello" }] };
    const connectionId = "conn-ignore-client-session";
    const rawHeaders = { "x-session-id": "conversation-a" };
    const baseCreds = { apiKey: "test-key", connectionId, rawHeaders, runtimeTransport: TRANSPORTS[0] };
    executor.transformRequest("muse-spark-1.3-contributor", body, true, baseCreds);
    const baseline = executor.buildHeaders(baseCreds, true)["x-opencode-session"];
    // same connection/body but with target-format scoped _clientSessionId
    const poisonedCreds = { apiKey: "test-key", connectionId, rawHeaders, runtimeTransport: TRANSPORTS[0], _clientSessionId: "format-scoped-session-leak" };
    executor.transformRequest("muse-spark-1.3-contributor", body, true, poisonedCreds);
    const poisoned = executor.buildHeaders(poisonedCreds, true)["x-opencode-session"];
    expect(baseline).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(poisoned).toBe(baseline);
    expect(poisoned).not.toContain("format-scoped-session-leak");
  });

  it("uses a stable opaque per-connection fallback when the client has no session", () => {
    const executor = new DefaultExecutor("opencode-go");
    const first = request(executor, { rawHeaders: {}, connectionId: "connection-fallback" }).headers["x-opencode-session"];
    const second = request(executor, { rawHeaders: {}, connectionId: "connection-fallback" }).headers["x-opencode-session"];
    expect(first).toBe(second);
    expect(first).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(first).not.toContain("connection-fallback");
  });

  it("keeps session state on request credentials without singleton bleed", () => {
    const executor = new DefaultExecutor("opencode-go");
    const a = request(executor, { session: "conversation-a" });
    const b = request(executor, { session: "conversation-b" });
    expect(executor.buildHeaders(a.credentials, true)["x-opencode-session"]).toBe(a.headers["x-opencode-session"]);
    expect(a.headers["x-opencode-session"]).not.toBe(b.headers["x-opencode-session"]);
  });

  it("does not add the header to another DefaultExecutor provider", () => {
    expect(request(new DefaultExecutor("openai")).headers["x-opencode-session"]).toBeUndefined();
  });

  it("leaves OpenCode Free specialized session behavior intact", () => {
    const executor = new OpenCodeExecutor();
    const credentials = { rawHeaders: { "x-session-id": "free-conversation" }, connectionId: "free" };
    executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] },
      true,
      credentials,
    );
    const header = executor.buildHeaders(credentials)["x-opencode-session"];
    // Upstream Free executor forwards the inbound session id verbatim-ish
    // (lower["x-opencode-session"] || derived) — not an opaque hash.
    expect(typeof header).toBe("string");
    expect(header.length).toBeGreaterThan(0);
  });
});

describe("OpenCode Go GPT temperature", () => {
  it("drops temperature from the /responses body for gpt-6-luna", () => {
    const executor = getExecutor("opencode-go");
    const out = executor.transformRequest("gpt-6-luna", {
      model: "gpt-6-luna",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      temperature: 0.2,
    }, true, makeCredentials({ runtimeTransport: TRANSPORTS[2] }));

    expect(out.temperature).toBeUndefined();
    expect(out.input).toHaveLength(1);
  });

  it("keeps temperature on chat models", () => {
    const executor = getExecutor("opencode-go");
    const out = executor.transformRequest("glm-5.3-flash", {
      model: "glm-5.3-flash",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.2,
    }, true, makeCredentials());

    expect(out.temperature).toBe(0.2);
  });
});
