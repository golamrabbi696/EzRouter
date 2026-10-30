// A4 (case #10): malformed tool_calls args must not throw -> safeParseJSON returns {}.
import { describe, it, expect } from "vitest";
import { openaiToOllamaRequest } from "../../open-sse/translator/request/openai-to-ollama.js";

function reqWith(args) {
  return {
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "get_weather", arguments: args } }],
      },
    ],
  };
}

describe("openaiToOllamaRequest - tool_calls arguments parsing", () => {
  it("malformed JSON args -> {} (no throw)", () => {
    let out;
    expect(() => {
      out = openaiToOllamaRequest("m", reqWith("{invalid json"), true);
    }).not.toThrow();
    expect(out.messages[0].tool_calls[0].function.arguments).toEqual({});
  });

  it("valid JSON args -> parsed object", () => {
    const out = openaiToOllamaRequest("m", reqWith('{"a":1}'), true);
    expect(out.messages[0].tool_calls[0].function.arguments).toEqual({ a: 1 });
  });

  it("preserves image-only messages without text blocks in openaiToOllamaRequest", () => {
    const fakeBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const bodyOnlyImage = {
      model: "gemma4:cloud",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${fakeBase64}` } },
          ],
        },
      ],
    };

    const ollamaReq = openaiToOllamaRequest("gemma4:cloud", bodyOnlyImage, false);
    expect(ollamaReq.messages.length).toBe(1);
    expect(ollamaReq.messages[0].role).toBe("user");
    expect(ollamaReq.messages[0].content).toBe("");
    expect(ollamaReq.messages[0].images).toEqual([fakeBase64]);
  });
});
