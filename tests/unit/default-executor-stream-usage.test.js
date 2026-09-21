import { describe, expect, it } from "vitest";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

// Provider registry: opencode is a generic OpenAI-compatible provider → DefaultExecutor.
const executor = new DefaultExecutor("opencode");

describe("DefaultExecutor stream_options injection (#3017)", () => {
  it("injects stream_options.include_usage for streaming requests", () => {
    const body = {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const out = executor.transformRequest("deepseek-v4-flash-free", body, true);
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("does not inject stream_options for non-streaming requests", () => {
    const body = {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    };
    const out = executor.transformRequest("deepseek-v4-flash-free", body, false);
    expect(out.stream_options).toBeUndefined();
  });

  it("respects an existing stream_options from the client", () => {
    const body = {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: false },
    };
    const out = executor.transformRequest("deepseek-v4-flash-free", body, true);
    expect(out.stream_options).toEqual({ include_usage: false });
  });

  it("does not inject when the body omits stream (Responses->chat path)", () => {
    // Responses-API clients convert to chat without a stream field while the
    // executor-level stream flag is true (Accept: text/event-stream). Strict
    // upstreams (deepseek) 400 on stream_options without stream: true.
    const body = {
      model: "deepseek-v4-flash-free",
      messages: [{ role: "user", content: "hi" }],
    };
    const out = executor.transformRequest("deepseek-v4-flash-free", body, true);
    expect(out.stream_options).toBeUndefined();
  });
});

// Regression: streaming requests to OpenAI-compatible providers must ask the
// upstream for usage (stream_options.include_usage). Without it, Alibaba MaaS
// omits the final usage chunk, the stream path falls back to chars/4 estimation
// (inflating prompt_tokens ~45%) and cached_tokens is lost entirely — cache hits
// get billed at the full input rate. Verified live 2026-09-21: kimi/kimi-k3
// streaming reported estimated usage; with include_usage the same request
// returns prompt_tokens 34349 with cached_tokens 32256.
const PROVIDER = "openai-compatible-chat-69218f2f-2d75-4b7e-8cb2-f220b73153b0";

describe("DefaultExecutor stream_options injection (custom openai-compatible)", () => {
  it("injects include_usage for streaming chat requests", async () => {
    const ex = new DefaultExecutor(PROVIDER);
    const body = { model: "kimi/kimi-k3", messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("kimi/kimi-k3", body, true, { providerSpecificData: { apiType: "chat" } });
    expect(out.stream_options).toEqual({ include_usage: true });
  });

  it("does not inject for non-streaming requests", async () => {
    const ex = new DefaultExecutor(PROVIDER);
    const body = { model: "kimi/kimi-k3", messages: [{ role: "user", content: "hi" }] };
    const out = ex.transformRequest("kimi/kimi-k3", body, false, null);
    expect(out.stream_options).toBeUndefined();
  });

  it("does not inject for responses-api nodes (no messages[])", async () => {
    const ex = new DefaultExecutor("openai-compatible-chat-responses-test");
    const body = { model: "x", input: "hi" };
    const out = ex.transformRequest("x", body, true, { providerSpecificData: { apiType: "responses" } });
    expect(out.stream_options).toBeUndefined();
  });

  it("keeps a caller-provided stream_options untouched", async () => {
    const ex = new DefaultExecutor(PROVIDER);
    const body = { model: "x", messages: [{ role: "user", content: "hi" }], stream_options: { include_usage: false } };
    const out = ex.transformRequest("x", body, true, null);
    expect(out.stream_options).toEqual({ include_usage: false });
  });
});
