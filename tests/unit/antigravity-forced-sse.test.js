import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {})
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");
const { handleNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");

describe("Antigravity forced SSE to JSON handling", () => {
  it("converts Antigravity/Gemini SSE stream to OpenAI Chat Completion JSON in handleForcedSSEToJson", async () => {
    const rawSSE = `data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "Hello world"}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 10,"candidatesTokenCount": 2,"totalTokenCount": 12},"modelVersion": "gemini-3.7-flash-tiered","responseId": "resp-123"}}\n\n`;

    const result = await handleForcedSSEToJson({
      providerResponse: new Response(rawSSE, {
        headers: { "content-type": "text/event-stream" }
      }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.ANTIGRAVITY,
      provider: "antigravity",
      model: "gemini-3.7-flash-high",
      body: { model: "ag/gemini-3.7-flash-high", messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      requestStartTime: Date.now(),
      connectionId: "test-conn",
      clientRawRequest: { endpoint: "/api/v1/chat/completions" },
      trackDone: vi.fn(),
      appendLog: vi.fn()
    });

    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.content).toBe("Hello world");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.prompt_tokens).toBe(10);
    expect(json.usage.completion_tokens).toBe(2);
  });

  it("handles fallback in handleNonStreamingResponse when upstream returns SSE text", async () => {
    const rawSSE = `data: {"response": {"candidates": [{"content": {"role": "model","parts": [{"text": "Non-streaming fallback response"}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 15,"candidatesTokenCount": 4,"totalTokenCount": 19},"modelVersion": "gemini-3.7-flash-tiered","responseId": "resp-456"}}\n\n`;

    const response = await handleNonStreamingResponse({
      body: { model: "ag/gemini-3.7-flash-high", messages: [{ role: "user", content: "test" }], stream: false },
      modelInfo: { provider: "antigravity", model: "gemini-3.7-flash-high" },
      credentials: { connectionId: "test-conn" },
      providerResponse: new Response(rawSSE, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      }),
      sourceFormat: FORMATS.OPENAI,
      targetFormat: FORMATS.ANTIGRAVITY,
      reqLogger: null,
      toolNameMap: null,
      trackDone: vi.fn(),
      appendLog: vi.fn()
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Non-streaming fallback response");
    expect(json.choices[0].finish_reason).toBe("stop");
    expect(json.usage.prompt_tokens).toBe(15);
    expect(json.usage.completion_tokens).toBe(4);
  });
});
