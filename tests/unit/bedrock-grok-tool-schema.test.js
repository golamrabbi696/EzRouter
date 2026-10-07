import { describe, expect, it } from "vitest";
import { sanitizeBedrockGrokTools } from "../../open-sse/executors/bedrock.js";

describe("Bedrock Grok tool schema", () => {
  it("strips schema keywords Bedrock Grok rejects", () => {
    const body = sanitizeBedrockGrokTools({
      tools: [{
        type: "function",
        function: {
          name: "exec_command",
          parameters: {
            type: "object",
            properties: {
              cmd: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z]+$", format: "uri" },
            },
            patternProperties: { "^x-": { type: "string" } },
          },
        },
      }],
    });
    expect(body.tools[0].function.parameters).toEqual({
      type: "object",
      properties: { cmd: { type: "string" } },
    });
  });
});
