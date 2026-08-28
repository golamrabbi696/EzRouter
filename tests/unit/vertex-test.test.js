import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usageDb.js", () => ({
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(() => {})
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
const { getExecutor } = await import("../../open-sse/executors/index.js");

describe("Vertex AI execution", () => {
  it("handles non-streaming Vertex response correctly", async () => {
    const rawVertexResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Hello from Vertex Gemini!" }]
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 6,
        totalTokenCount: 11
      },
      modelVersion: "gemini-3.7-flash"
    };

    const executor = getExecutor("vertex");
    expect(executor).toBeDefined();

    // Mock executor.execute
    const origExecute = executor.execute.bind(executor);
    executor.execute = vi.fn(async () => ({
      response: new Response(JSON.stringify(rawVertexResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }),
      url: "https://aiplatform.googleapis.com",
      headers: {},
      transformedBody: {}
    }));

    try {
      const result = await handleChatCore({
        modelInfo: { provider: "vertex", model: "gemini-3.7-flash" },
        body: {
          model: "vx/gemini-3.7-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: false
        },
        stream: false,
        credentials: { apiKey: "AQ.testKey", connectionId: "test-conn" }
      });

      expect(result.status).toBe(200);
      const json = await result.json();
      expect(json.choices[0].message.content).toBe("Hello from Vertex Gemini!");
      expect(json.choices[0].finish_reason).toBe("stop");
      expect(json.usage.prompt_tokens).toBe(5);
      expect(json.usage.completion_tokens).toBe(6);
    } finally {
      executor.execute = origExecute;
    }
  });

  it("handles SSE stream fallback for Vertex non-streaming request", async () => {
    const rawVertexSSE = `data: {"candidates": [{"content": {"role": "model","parts": [{"text": "Streamed Vertex Gemini"}]},"finishReason": "STOP"}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 4,"totalTokenCount": 12},"modelVersion": "gemini-3.7-flash"}\n\n`;

    const executor = getExecutor("vertex");
    const origExecute = executor.execute.bind(executor);
    executor.execute = vi.fn(async () => ({
      response: new Response(rawVertexSSE, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" }
      }),
      url: "https://aiplatform.googleapis.com",
      headers: {},
      transformedBody: {}
    }));

    try {
      const result = await handleChatCore({
        modelInfo: { provider: "vertex", model: "gemini-3.7-flash" },
        body: {
          model: "vx/gemini-3.7-flash",
          messages: [{ role: "user", content: "hi" }],
          stream: false
        },
        stream: false,
        credentials: { apiKey: "AQ.testKey", connectionId: "test-conn" }
      });

      expect(result.status).toBe(200);
      const json = await result.json();
      expect(json.choices[0].message.content).toBe("Streamed Vertex Gemini");
      expect(json.choices[0].finish_reason).toBe("stop");
    } finally {
      executor.execute = origExecute;
    }
  });
});
