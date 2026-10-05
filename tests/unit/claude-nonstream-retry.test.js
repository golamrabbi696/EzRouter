import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
}));

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { handleForcedSSEToJson } = await import("../../open-sse/handlers/chatCore/sseToJsonHandler.js");

const completion = {
  id: "chatcmpl-abc",
  model: "gpt-x",
  choices: [{ message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 8, completion_tokens: 2 },
};

describe("Claude non-streaming retry response", () => {
  it("converts ordinary JSON Chat Completions into a Claude Message", () => {
    const result = translateNonStreamingResponse(completion, FORMATS.OPENAI, FORMATS.CLAUDE);
    expect(result).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 8, output_tokens: 2 } });
    expect(result).not.toHaveProperty("choices");
  });

  it("converts forced Responses SSE into a Claude Message", async () => {
    const encoder = new TextEncoder();
    const events = [
      'event: response.created\ndata: {"response":{"id":"resp_123","model":"gpt-x","status":"in_progress","output":[]}}',
      'event: response.output_item.done\ndata: {"output_index":0,"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}}',
      'event: response.completed\ndata: {"response":{"id":"resp_123","model":"gpt-x","status":"completed","usage":{"input_tokens":8,"output_tokens":2}}}',
      "data: [DONE]", "",
    ].join("\n\n");
    const result = await handleForcedSSEToJson({
      providerResponse: new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(events)); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }),
      sourceFormat: FORMATS.CLAUDE, targetFormat: FORMATS.OPENAI_RESPONSES,
      provider: "codex", model: "gpt-x", body: { messages: [] }, stream: false,
      requestStartTime: Date.now(), connectionId: "test", clientRawRequest: { endpoint: "/v1/messages" },
      trackDone: vi.fn(), appendLog: vi.fn(),
    });
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json).toMatchObject({ type: "message", role: "assistant", content: [{ type: "text", text: "Hello" }], usage: { input_tokens: 8, output_tokens: 2 } });
    expect(json).not.toHaveProperty("choices");
  });
});
