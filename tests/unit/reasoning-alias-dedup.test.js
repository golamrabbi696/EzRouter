import { describe, it, expect } from "vitest";
import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("reasoning and reasoning_content alias deduplication (#4841)", () => {
  it("drops reasoning when reasoning_content is already present on assistant message", () => {
    const body = {
      model: "glm-4-plus",
      messages: [
        { role: "user", content: "Hello" },
        {
          role: "assistant",
          content: "Hi there",
          reasoning_content: "Thinking step 1",
          reasoning: "Thinking step 1 (duplicate alias)",
        },
      ],
    };

    const result = stripUnsupportedParams("z-ai", "glm-4-plus", body);
    expect(result.messages[1].reasoning_content).toBe("Thinking step 1");
    expect(result.messages[1].reasoning).toBeUndefined();
  });

  it("preserves reasoning when reasoning_content is absent", () => {
    const body = {
      model: "glm-4-plus",
      messages: [
        {
          role: "assistant",
          content: "Thinking only via reasoning field",
          reasoning: "Thinking step",
        },
      ],
    };

    const result = stripUnsupportedParams("z-ai", "glm-4-plus", body);
    expect(result.messages[0].reasoning).toBe("Thinking step");
    expect(result.messages[0].reasoning_content).toBeUndefined();
  });

  it("preserves reasoning_content when reasoning is absent", () => {
    const body = {
      model: "glm-4-plus",
      messages: [
        {
          role: "assistant",
          content: "Standard DeepSeek style",
          reasoning_content: "Thinking step",
        },
      ],
    };

    const result = stripUnsupportedParams("z-ai", "glm-4-plus", body);
    expect(result.messages[0].reasoning_content).toBe("Thinking step");
    expect(result.messages[0].reasoning).toBeUndefined();
  });

  it("leaves user and system messages untouched", () => {
    const body = {
      model: "kimi-k2",
      messages: [
        {
          role: "user",
          content: "Hello",
          reasoning: "User reasoning notes",
          reasoning_content: "User notes duplicate",
        },
      ],
    };

    const result = stripUnsupportedParams("moonshot", "kimi-k2", body);
    expect(result.messages[0].reasoning).toBe("User reasoning notes");
    expect(result.messages[0].reasoning_content).toBe("User notes duplicate");
  });
});
