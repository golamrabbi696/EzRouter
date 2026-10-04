import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { handleChatCore } from "../../open-sse/handlers/chatCore.js";

const {
  proxyAwareFetchMock,
  createRequestLoggerMock,
  handleNonStreamingResponseMock,
  buildOnStreamCompleteMock,
  handleStreamingResponseMock,
} = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
  createRequestLoggerMock: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
  handleNonStreamingResponseMock: vi.fn(),
  buildOnStreamCompleteMock: vi.fn(),
  handleStreamingResponseMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: proxyAwareFetchMock,
  proxyAwareFetch: proxyAwareFetchMock,
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: createRequestLoggerMock,
}));

vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: handleNonStreamingResponseMock,
}));

vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  buildOnStreamComplete: buildOnStreamCompleteMock,
  handleStreamingResponse: handleStreamingResponseMock,
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async () => ({ body: null, summary: null })),
}));
vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

const MUSE = "muse";
const MUSE_SPARK = "muse-spark-1.3-contributor";
const RESPONSE_SUCCESS = { id: "resp_test", object: "response", status: "completed", output: [] };

function chatMessages(stream, extra = {}) {
  return {
    model: `${MUSE}/${MUSE_SPARK}`,
    stream,
    messages: [
      { role: "system", content: "Use the existing lookup tool." },
      { role: "user", content: "Find item 7." },
      {
        role: "assistant",
        content: null,
        reasoning_content: "The item should be looked up.",
        encrypted_content: "encrypted-prior-reasoning",
        tool_calls: [{
          id: "call_lookup_7",
          type: "function",
          function: { name: "lookup", arguments: "{\"item\":7}" },
        }],
      },
      { role: "tool", tool_call_id: "call_lookup_7", content: "{\"value\":\"seven\"}" },
      { role: "user", content: "Summarize it." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look up an item.",
        parameters: { type: "object", properties: { item: { type: "integer" } } },
      },
    }],
    ...extra,
  };
}

function museCredentials() {
  return {
    apiKey: "test-only-muse-api-key",
    connectionId: "test-muse-connection",
    connectionName: "test Muse",
    providerSpecificData: {},
  };
}

function chatCoreOptions(body, providerThinking = null) {
  const streaming = body.stream === true;
  return {
    body,
    modelInfo: { provider: MUSE, model: MUSE_SPARK },
    credentials: museCredentials(),
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body,
      headers: { accept: streaming ? "text/event-stream" : "application/json" },
    },
    connectionId: "test-muse-connection",
    providerThinking,
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      errorLine: vi.fn(),
    },
  };
}

function transformMuseResponse(body, credentials = { runtimeTransport: { format: "openai-responses" } }) {
  return new DefaultExecutor(MUSE).transformRequest(MUSE_SPARK, structuredClone(body), true, credentials);
}

describe("Responses reasoning wire format", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset().mockImplementation(async () => new Response(
      JSON.stringify(RESPONSE_SUCCESS),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    handleNonStreamingResponseMock.mockReset().mockResolvedValue({
      success: true,
      responseMode: "json",
    });
    buildOnStreamCompleteMock.mockReset().mockReturnValue({
      onStreamComplete: vi.fn(),
      streamDetailId: "test-stream-detail",
    });
    handleStreamingResponseMock.mockReset().mockResolvedValue({
      success: true,
      responseMode: "sse",
    });
  });

  it.each([true, false])(
    "sends Muse xhigh as Responses reasoning.effort and returns HTTP 200 (stream=%s)",
    async (stream) => {
      const result = await handleChatCore(
        chatCoreOptions(chatMessages(stream), { mode: "xhigh" }),
      );

      expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = proxyAwareFetchMock.mock.calls[0];
      expect(url).toBe("https://api.meta.ai/v1/responses");
      expect(init.headers.Authorization).toBe("Bearer test-only-muse-api-key");

      const sent = JSON.parse(init.body);
      expect(sent.reasoning).toEqual({ effort: "xhigh" });
      expect(sent).not.toHaveProperty("reasoning_effort");
      expect(sent.input).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "encrypted-prior-reasoning",
        }),
        expect.objectContaining({
          type: "function_call",
          call_id: "call_lookup_7",
          name: "lookup",
        }),
        expect.objectContaining({
          type: "function_call_output",
          call_id: "call_lookup_7",
        }),
      ]));
      expect(result).toEqual({
        success: true,
        responseMode: stream ? "sse" : "json",
      });
    },
  );

  it("preserves an explicit medium effort over provider-level xhigh", async () => {
    const result = await handleChatCore(
      chatCoreOptions(chatMessages(false, { reasoning_effort: "medium" }), { mode: "xhigh" }),
    );
    const sent = JSON.parse(proxyAwareFetchMock.mock.calls[0][1].body);

    expect(sent.reasoning).toEqual({ effort: "medium" });
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(result.success).toBe(true);
  });

  it("preserves native Responses reasoning keys, input continuity, include, and other fields", () => {
    const input = [
      {
        type: "reasoning",
        encrypted_content: "native-encrypted-reasoning",
        summary: [{ type: "summary_text", text: "prior thought" }],
      },
      {
        type: "function_call",
        call_id: "call_native_1",
        name: "lookup",
        arguments: "{\"item\":1}",
      },
      { type: "function_call_output", call_id: "call_native_1", output: "one" },
    ];
    const body = {
      model: MUSE_SPARK,
      input,
      include: ["reasoning.encrypted_content"],
      reasoning: { summary: "detailed", context: "all_turns", vendor_extension: "preserve" },
      reasoning_effort: "medium",
      metadata: { trace: "keep" },
      store: false,
    };

    const out = transformMuseResponse(body);

    expect(out.reasoning).toEqual({
      summary: "detailed",
      context: "all_turns",
      vendor_extension: "preserve",
      effort: "medium",
    });
    expect(out).not.toHaveProperty("reasoning_effort");
    expect(out.input).toEqual(input);
    expect(out.include).toEqual(["reasoning.encrypted_content"]);
    expect(out.metadata).toEqual({ trace: "keep" });
    expect(out.store).toBe(false);
  });

  it.each([
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "none",
    "off",
    "auto",
    "future-level",
  ])("moves Muse effort %s to Responses without changing its value", (effort) => {
    const out = transformMuseResponse({ model: MUSE_SPARK, input: [], reasoning_effort: effort });
    expect(out.reasoning.effort).toBe(effort);
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("does not inject reasoning when no intent is present", () => {
    const out = transformMuseResponse({
      model: MUSE_SPARK,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      include: ["reasoning.encrypted_content"],
    });

    expect(out).not.toHaveProperty("reasoning");
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("preserves max for the standard Muse Spark model that advertises it", () => {
    const out = new DefaultExecutor(MUSE).transformRequest("muse-spark-1.3", {
      model: "muse-spark-1.3",
      input: [],
      reasoning_effort: "max",
    }, true, { runtimeTransport: { format: "openai-responses" } });

    expect(out.reasoning).toEqual({ effort: "max" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("forwards explicit none unchanged and returns the upstream 400", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        error: {
          message: "Unsupported reasoning effort: none",
          type: "invalid_request_error",
          code: "bad_request",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    const result = await handleChatCore(
      chatCoreOptions(chatMessages(false, { reasoning_effort: "none" })),
    );

    expect(proxyAwareFetchMock.mock.calls[0][0]).toBe("https://api.meta.ai/v1/responses");
    const sent = JSON.parse(proxyAwareFetchMock.mock.calls[0][1].body);
    expect(sent.reasoning).toEqual({ effort: "none" });
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(result).toMatchObject({ success: false, status: 400 });
    expect(result.error).toContain("Unsupported reasoning effort: none");
  });

  it("keeps contributor max intact at the executor boundary and propagates its upstream 400", async () => {
    proxyAwareFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        error: {
          message: "Unsupported reasoning effort: max",
          type: "invalid_request_error",
          code: "bad_request",
        },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    const result = await new DefaultExecutor(MUSE).execute({
      model: MUSE_SPARK,
      body: { model: MUSE_SPARK, input: [], reasoning_effort: "max" },
      stream: false,
      credentials: {
        apiKey: "test-only-muse-api-key",
        runtimeTransport: {
          format: "openai-responses",
          baseUrl: "https://api.meta.ai/v1/responses",
        },
      },
      log: { debug: vi.fn() },
    });

    expect(proxyAwareFetchMock.mock.calls[0][0]).toBe("https://api.meta.ai/v1/responses");
    const sent = JSON.parse(proxyAwareFetchMock.mock.calls[0][1].body);
    expect(sent.reasoning).toEqual({ effort: "max" });
    expect(sent).not.toHaveProperty("reasoning_effort");
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toContain("Unsupported reasoning effort: max");
  });

  it("uses provider config Responses format when there is no runtime transport", () => {
    const executor = new DefaultExecutor("codex");
    const out = executor.transformRequest("gpt-5.6-sol", {
      model: "gpt-5.6-sol",
      input: [],
      reasoning_effort: "xhigh",
    }, true, { accessToken: "test-only-codex-token" });

    expect(out.reasoning).toEqual({ effort: "xhigh" });
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("lets runtime transport format override provider config format", () => {
    const executor = new DefaultExecutor("codex");
    const out = executor.transformRequest("gpt-5.6-sol", {
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "hi" }],
      reasoning_effort: "xhigh",
    }, true, { runtimeTransport: { format: "openai" } });

    expect(out.reasoning_effort).toBe("xhigh");
    expect(out.reasoning).toBeUndefined();
  });

  it.each([
    ["chat", "xhigh"],
    ["chat", "none"],
    ["responses", "xhigh"],
    ["responses", "none"],
  ])("uses the configured OpenAI-compatible %s wire for effort %s", (apiType, effort) => {
    const provider = "openai-compatible-chat-test";
    const executor = new DefaultExecutor(provider);
    const credentials = {
      apiKey: "test-only-compatible-key",
      providerSpecificData: {
        apiType,
        baseUrl: "https://compatible.example/v1",
      },
    };
    const body = {
      model: "reasoning-model",
      messages: [{ role: "user", content: "hi" }],
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      reasoning_effort: effort,
    };

    const out = executor.transformRequest("reasoning-model", structuredClone(body), true, credentials);

    if (apiType === "chat") {
      expect(out.reasoning_effort).toBe(effort);
      expect(out.reasoning).toBeUndefined();
      expect(executor.buildUrl("reasoning-model", true, 0, credentials))
        .toBe("https://compatible.example/v1/chat/completions");
    } else {
      expect(out.reasoning).toEqual({ effort });
      expect(out.reasoning_effort).toBeUndefined();
      expect(executor.buildUrl("reasoning-model", true, 0, credentials))
        .toBe("https://compatible.example/v1/responses");
    }
  });
});
