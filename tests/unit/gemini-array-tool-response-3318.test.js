import { describe, it, expect } from "vitest";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.js";

describe("Gemini array tool outputs wrapping (#3318)", () => {
  it("wraps JSON array tool response in an object { result: [...] }", () => {
    const body = {
      model: "gemini-2.5-pro",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_read_file_123",
              type: "function",
              function: {
                name: "read_files",
                arguments: JSON.stringify({ paths: ["a.txt", "b.txt"] })
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_read_file_123",
          content: JSON.stringify([{ file: "a.txt", content: "hello" }, { file: "b.txt", content: "world" }])
        }
      ]
    };

    const transformed = openaiToGeminiRequest("gemini-2.5-pro", body, false, {});

    // Find user message with functionResponse
    const toolMsg = transformed.contents.find(c => c.parts.some(p => p.functionResponse));
    expect(toolMsg).toBeDefined();

    const part = toolMsg.parts.find(p => p.functionResponse);
    expect(part.functionResponse.name).toBe("read_files");
    expect(part.functionResponse.response).toEqual({
      result: [
        { file: "a.txt", content: "hello" },
        { file: "b.txt", content: "world" }
      ]
    });
  });

  it("leaves JSON object tool response as is without extra wrapping", () => {
    const body = {
      model: "gemini-2.5-pro",
      messages: [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_lookup_1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{}"
              }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_lookup_1",
          content: JSON.stringify({ status: "success", count: 42 })
        }
      ]
    };

    const transformed = openaiToGeminiRequest("gemini-2.5-pro", body, false, {});
    const toolMsg = transformed.contents.find(c => c.parts.some(p => p.functionResponse));
    const part = toolMsg.parts.find(p => p.functionResponse);
    expect(part.functionResponse.response).toEqual({
      status: "success",
      count: 42
    });
  });
});
