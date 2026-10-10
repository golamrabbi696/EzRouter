import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const credentials = {
  projectId: "synthetic-project",
  connectionId: "synthetic-connection",
};

describe("AntigravityExecutor image generation contents preservation", () => {
  it("preserves text-only parts for image generation requests", () => {
    const executor = new AntigravityExecutor();
    const body = {
      request: {
        contents: [
          {
            role: "user",
            parts: [{ text: "Generate a scenic mountain" }],
          },
        ],
      },
    };

    const output = executor.transformRequest(
      "gemini-3.1-flash-image",
      body,
      false,
      credentials
    );

    expect(output.requestType).toBe("image_gen");
    expect(output.request.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Generate a scenic mountain" }],
      },
    ]);
  });

  it("preserves inlineData alongside text parts for image-to-image editing", () => {
    const executor = new AntigravityExecutor();
    const imagePayload = {
      mimeType: "image/jpeg",
      data: "base64encodedbytes...",
    };
    const body = {
      request: {
        contents: [
          {
            role: "user",
            parts: [
              { inlineData: imagePayload },
              { text: "Change outfit to high school uniform" },
            ],
          },
        ],
      },
    };

    const output = executor.transformRequest(
      "gemini-3.1-flash-image",
      body,
      false,
      credentials
    );

    expect(output.requestType).toBe("image_gen");
    expect(output.request.contents[0].parts).toHaveLength(2);
    expect(output.request.contents[0].parts[0]).toEqual({
      inlineData: imagePayload,
    });
    expect(output.request.contents[0].parts[1]).toEqual({
      text: "Change outfit to high school uniform",
    });
  });

  it("normalizes snake_case inline_data to inlineData", () => {
    const executor = new AntigravityExecutor();
    const snakeInline = {
      mime_type: "image/png",
      data: "snakebytes...",
    };
    const body = {
      contents: [
        {
          parts: [
            { inline_data: snakeInline },
            { text: "Edit image" },
          ],
        },
      ],
    };

    const output = executor.transformRequest(
      "gemini-3.1-flash-image",
      body,
      false,
      credentials
    );

    expect(output.request.contents[0].parts[0]).toEqual({
      inlineData: snakeInline,
    });
  });
});
