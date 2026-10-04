import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";
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
  saveRequestUsage: vi.fn(() => Promise.resolve()),
}));

const PROVIDER = "muse";
const MODEL = "muse-spark-1.3-contributor";
const RESPONSE_ERROR = {
  error: {
    message: "[400]: {\"error\":{\"code\":null,\"message\":\"unknown parameter `input`\",\"param\":\"input\",\"type\":\"invalid_request_error\"}}",
    type: "invalid_request_error",
    code: "bad_request",
  },
};

function makeOptions(body, endpoint) {
  const streaming = body.stream === true;
  return {
    body,
    modelInfo: { provider: PROVIDER, model: MODEL },
    credentials: {
      accessToken: "test-only-muse-oauth-token",
      connectionId: "test-muse-connection",
      connectionName: "test Muse",
      providerSpecificData: {},
    },
    clientRawRequest: {
      endpoint,
      body,
      headers: { accept: streaming ? "text/event-stream" : "application/json" },
    },
    connectionId: "test-muse-connection",
    log: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      errorLine: vi.fn(),
    },
  };
}

function chatBody(stream) {
  return {
    model: `${PROVIDER}/${MODEL}`,
    stream,
    messages: [
      { role: "system", content: "Keep the lookup result intact." },
      { role: "user", content: "Look up item 7." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_preserve_7",
          type: "function",
          function: { name: "lookup", arguments: "{\"item\":7}" },
        }],
      },
      { role: "tool", tool_call_id: "call_preserve_7", content: "{\"value\":\"seven\"}" },
      { role: "user", content: "Summarize the result." },
    ],
    tools: [{
      type: "function",
      function: {
        name: "lookup",
        description: "Look up an item.",
        parameters: { type: "object", properties: { item: { type: "integer" } } },
      },
    }],
  };
}

function responsesBody(stream) {
  return {
    model: `${PROVIDER}/${MODEL}`,
    stream,
    instructions: "Preserve the native Responses request.",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Say hello." }],
    }],
    include: ["reasoning.encrypted_content"],
    store: false,
  };
}

describe("model target-format transport selection", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
    proxyAwareFetchMock.mockImplementation(async () => new Response(
      JSON.stringify(RESPONSE_ERROR),
      { status: 400, headers: { "content-type": "application/json" } },
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
    "sends chat messages translated to Muse Responses through /responses (stream=%s)",
    async (stream) => {
      const body = chatBody(stream);
      const result = await handleChatCore(makeOptions(body, "/v1/chat/completions"));

      expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = proxyAwareFetchMock.mock.calls[0];
      expect(url).toBe("https://api.meta.ai/v1/responses");
      expect(init.headers.Authorization).toBe("Bearer test-only-muse-oauth-token");
      expect(init.headers["x-api-version"]).toBe("1.0.0");

      const sent = JSON.parse(init.body);
      expect(sent.model).toBe(MODEL);
      expect(sent.instructions).toBe("Keep the lookup result intact.");
      expect(sent.input).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "function_call", call_id: "call_preserve_7", name: "lookup" }),
        expect.objectContaining({ type: "function_call_output", call_id: "call_preserve_7" }),
      ]));
      expect(result).toMatchObject({ success: false, status: 400 });
      expect(result.error).toContain("unknown parameter `input`");
    },
  );

  it.each([true, false])(
    "keeps native Responses input and provider fields on /responses (stream=%s)",
    async (stream) => {
      const body = responsesBody(stream);
      const result = await handleChatCore(makeOptions(body, "/v1/responses"));

      expect(proxyAwareFetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = proxyAwareFetchMock.mock.calls[0];
      expect(url).toBe("https://api.meta.ai/v1/responses");
      const sent = JSON.parse(init.body);
      expect(sent.input).toEqual(body.input);
      expect(sent.instructions).toBe(body.instructions);
      expect(sent.include).toEqual(body.include);
      expect(sent.store).toBe(false);
      expect(result).toMatchObject({ success: false, status: 400 });
      expect(result.error).toContain("unknown parameter `input`");
    },
  );

  it.each([
    {
      label: "chat messages",
      body: chatBody,
      endpoint: "/v1/chat/completions",
      sourceFormat: "openai",
    },
    {
      label: "native Responses input",
      body: responsesBody,
      endpoint: "/v1/responses",
      sourceFormat: "openai-responses",
    },
  ])("$label receives a valid upstream response (stream=true)", async ({
    body: makeBody,
    endpoint,
    sourceFormat,
  }) => {
    proxyAwareFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ id: "resp_synthetic_success" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await handleChatCore(makeOptions(makeBody(true), endpoint));

    expect(proxyAwareFetchMock.mock.calls[0][0]).toBe("https://api.meta.ai/v1/responses");
    expect(handleStreamingResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceFormat,
      targetFormat: "openai-responses",
      stream: true,
    }));
    expect(result).toEqual({ success: true, responseMode: "sse" });
  });

  it.each([
    {
      label: "chat messages",
      body: chatBody,
      endpoint: "/v1/chat/completions",
      sourceFormat: "openai",
    },
    {
      label: "native Responses input",
      body: responsesBody,
      endpoint: "/v1/responses",
      sourceFormat: "openai-responses",
    },
  ])("$label receives a valid upstream response (stream=false)", async ({
    body: makeBody,
    endpoint,
    sourceFormat,
  }) => {
    proxyAwareFetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ id: "resp_synthetic_success" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const result = await handleChatCore(makeOptions(makeBody(false), endpoint));

    expect(proxyAwareFetchMock.mock.calls[0][0]).toBe("https://api.meta.ai/v1/responses");
    expect(handleNonStreamingResponseMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceFormat,
      targetFormat: "openai-responses",
      stream: false,
    }));
    expect(result).toEqual({ success: true, responseMode: "json" });
  });
});
