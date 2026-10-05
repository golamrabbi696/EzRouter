import { describe, expect, it } from "vitest";
import { requestLineThinkingIntent } from "../../open-sse/handlers/chatCore.js";
import { fmtThink } from "../../src/sse/utils/logger.js";

describe("Codex request line effort", () => {
  it("shows a model suffix even when the translated request has no effort", () => {
    const intent = requestLineThinkingIntent({}, "codex", "gpt-6.1-sol(high)", {});
    expect(fmtThink(intent)).toBe("high");
  });

  it("shows the client effort and keeps explicit translated effort first", () => {
    expect(fmtThink(requestLineThinkingIntent({}, "codex", "gpt-6.1-sol", { reasoning_effort: "low" }))).toBe("low");
    expect(fmtThink(requestLineThinkingIntent({ reasoning: { effort: "medium" } }, "codex", "gpt-6.1-sol(high)", {}))).toBe("medium");
  });

  it("does not infer a level for unrelated providers", () => {
    expect(requestLineThinkingIntent({}, "openai", "gpt-6.1-sol(high)", { reasoning_effort: "low" })).toBeNull();
  });
});
