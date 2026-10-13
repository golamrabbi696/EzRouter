import { describe, expect, it } from "vitest";
import { isZeroContentResponse } from "../../open-sse/services/combo.js";

describe("isZeroContentResponse", () => {
  it("detects empty OpenAI chat choices with in_progress or incomplete finish reasons", () => {
    expect(isZeroContentResponse({ choices: [] })).toBe(true);
    expect(isZeroContentResponse({ choices: [{ message: { content: "" }, finish_reason: "in_progress" }] })).toBe(true);
    expect(isZeroContentResponse({ choices: [{ message: { content: "   " }, finish_reason: "incomplete" }] })).toBe(true);
  });

  it("recognizes valid OpenAI content, tool calls, or reasoning", () => {
    expect(isZeroContentResponse({ choices: [{ message: { content: "hello" }, finish_reason: "stop" }] })).toBe(false);
    expect(isZeroContentResponse({ choices: [{ message: { content: "", tool_calls: [{ id: "call_1" }] }, finish_reason: "tool_calls" }] })).toBe(false);
    expect(isZeroContentResponse({ choices: [{ message: { content: "", reasoning_content: "thinking" }, finish_reason: "stop" }] })).toBe(false);
  });

  it("detects empty Anthropic message content with in_progress or incomplete stop reasons", () => {
    expect(isZeroContentResponse({ content: [], stop_reason: "in_progress" })).toBe(true);
    expect(isZeroContentResponse({ content: [{ type: "text", text: "" }], stop_reason: "incomplete" })).toBe(true);
  });

  it("recognizes valid Anthropic text or tool_use", () => {
    expect(isZeroContentResponse({ content: [{ type: "text", text: "answer" }], stop_reason: "end_turn" })).toBe(false);
    expect(isZeroContentResponse({ content: [{ type: "tool_use", id: "t1" }], stop_reason: "tool_use" })).toBe(false);
  });
});
