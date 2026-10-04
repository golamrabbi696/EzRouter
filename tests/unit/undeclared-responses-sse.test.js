import { beforeEach, describe, expect, it, vi } from "vitest";
import "../translator/registerAll.js";

const {
  proxyAwareFetchMock,
  handleNonStreamingResponseMock,
  handleStreamingResponseMock,
} = vi.hoisted(() => ({
  proxyAwareFetchMock: vi.fn(),
  handleNonStreamingResponseMock: vi.fn(),
  handleStreamingResponseMock: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: proxyAwareFetchMock,
  proxyAwareFetch: proxyAwareFetchMock,
}));
vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));
vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: handleNonStreamingResponseMock,
}));
vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  buildOnStreamComplete: vi.fn(() => ({ onStreamComplete: vi.fn(), streamDetailId: "test-stream" })),
  handleStreamingResponse: handleStreamingResponseMock,
}));
vi.mock("../../open-sse/services/tokenRefresh.js", () => ({ refreshWithRetry: vi.fn() }));
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
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => ""),
}));
vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const PROVIDER = "muse";
const MODEL = "muse-spark-1.3-contributor";

function sseResponse(events, headers = {}) {
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function chatOptions({ stream = false, sourceFormat = FORMATS.OPENAI, endpoint = "/v1/chat/completions" } = {}) {
  const body = sourceFormat === FORMATS.OPENAI_RESPONSES
    ? { model: MODEL, stream, input: "hello", store: false, include: ["reasoning.encrypted_content"] }
    : { model: MODEL, stream, messages: [{ role: "user", content: "hello" }] };
  return {
    body,
    modelInfo: { provider: PROVIDER, model: MODEL },
    credentials: { accessToken: "test-token", connectionId: "test-connection", providerSpecificData: {} },
    clientRawRequest: {
      endpoint,
      body,
      headers: { accept: stream ? "text/event-stream" : "application/json" },
    },
    sourceFormatOverride: sourceFormat,
    connectionId: "test-connection",
    log: {},
  };
}

function completedResponsesEvents(output) {
  return [
    ["response.created", { response: { id: "resp_test", created_at: 1700000000 } }],
    ...output.map((item, output_index) => ["response.output_item.done", { output_index, item }]),
    ["response.completed", { response: { usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } }],
  ];
}

describe("Responses upstream SSE for clients that requested JSON", () => {
  beforeEach(() => {
    proxyAwareFetchMock.mockReset();
    handleNonStreamingResponseMock.mockReset().mockResolvedValue({
      success: true,
      response: new Response('{"handled":"nonstream"}', { headers: { "content-type": "application/json" } }),
    });
    handleStreamingResponseMock.mockReset().mockResolvedValue({ success: true, responseMode: "sse" });
  });

  it("collects Responses SSE into a chat completion with tools, usage, and safe headers", async () => {
    proxyAwareFetchMock.mockResolvedValue(sseResponse(completedResponsesEvents([
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Found it." }] },
      { type: "function_call", call_id: "call_lookup_7", name: "lookup", arguments: "{\"item\":7}" },
    ]), { "retry-after": "3" }));

    const result = await handleChatCore(chatOptions());
    const body = await result.response.json();

    expect(result.success).toBe(true);
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0]).toMatchObject({
      message: {
        content: "Found it.",
        tool_calls: [{
          id: "call_lookup_7",
          function: { name: "lookup", arguments: "{\"item\":7}" },
        }],
      },
      finish_reason: "tool_calls",
    });
    expect(body.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
    expect(result.response.headers.get("content-type")).toBe("application/json");
    expect(result.response.headers.get("retry-after")).toBe("3");
    expect(result.response.headers.get("access-control-allow-origin")).toBe("*");
    expect(result.response.headers.get("content-length")).toBeNull();
    expect(handleNonStreamingResponseMock).not.toHaveBeenCalled();
  });

  it("returns native Responses JSON, including encrypted reasoning output", async () => {
    proxyAwareFetchMock.mockResolvedValue(sseResponse(completedResponsesEvents([
      {
        type: "reasoning",
        encrypted_content: "opaque-reasoning",
        summary: [{ type: "summary_text", text: "private" }],
      },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
    ])));

    const result = await handleChatCore(chatOptions({
      sourceFormat: FORMATS.OPENAI_RESPONSES,
      endpoint: "/v1/responses",
    }));
    const body = await result.response.json();

    expect(result.success).toBe(true);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output[0]).toMatchObject({
      type: "reasoning",
      encrypted_content: "opaque-reasoning",
    });
    expect(body.usage).toMatchObject({ input_tokens: 11, output_tokens: 5, total_tokens: 16 });
    expect(handleNonStreamingResponseMock).not.toHaveBeenCalled();
  });

  it("leaves streaming requests on the streaming path", async () => {
    proxyAwareFetchMock.mockResolvedValue(sseResponse([]));
    const result = await handleChatCore(chatOptions({ stream: true }));

    expect(result).toMatchObject({ success: true, responseMode: "sse" });
    expect(handleStreamingResponseMock).toHaveBeenCalledTimes(1);
    expect(handleNonStreamingResponseMock).not.toHaveBeenCalled();
  });

  it("lets an actual JSON upstream body fall through untouched", async () => {
    const upstream = new Response('{"id":"resp_json","object":"response","status":"completed","output":[]}', {
      headers: { "content-type": "application/json" },
    });
    proxyAwareFetchMock.mockResolvedValue(upstream);

    await handleChatCore(chatOptions());

    expect(handleNonStreamingResponseMock).toHaveBeenCalledTimes(1);
    const call = handleNonStreamingResponseMock.mock.calls[0][0];
    expect(call.providerResponse).toBe(upstream);
    expect(call.providerResponse.bodyUsed).toBe(false);
  });

  it("propagates an upstream HTTP 400 without trying SSE conversion", async () => {
    proxyAwareFetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "unknown parameter `input`" } }),
      { status: 400, headers: { "content-type": "application/json" } },
    ));

    const result = await handleChatCore(chatOptions());

    expect(result.success).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toContain("unknown parameter `input`");
    expect(handleNonStreamingResponseMock).not.toHaveBeenCalled();
  });
});
