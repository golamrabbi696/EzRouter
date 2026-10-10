// A replayed assistant turn can carry a thinking block whose text is empty or
// whitespace-only while its signature is still valid — e.g. a thought that was
// stripped upstream, or a provider that streamed whitespace as reasoning. The
// signature check in normalizeClaudePassthrough keeps such a block, and Anthropic
// then rejects the whole request:
//   400 messages.N.content.0.thinking: each thinking block must contain non-whitespace thinking
// Empty *text* blocks are already dropped for the same class of upstream 400;
// thinking blocks need the same treatment.
//
// The signature must be a REAL E-form one: an invalid signature is dropped earlier
// by the signature check, which would mask the text check under test.
import { describe, it, expect } from "vitest";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { DEFAULT_THINKING_CLAUDE_SIGNATURE } from "../../open-sse/config/defaultThinkingSignature.js";

const assistant = (blocks) => ({ role: "assistant", content: blocks });
const thinking = (text) => ({ type: "thinking", thinking: text, signature: DEFAULT_THINKING_CLAUDE_SIGNATURE });

describe("normalizeClaudePassthrough — blank thinking blocks", () => {
  it("drops an empty thinking block and keeps its sibling text block", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        assistant([thinking(""), { type: "text", text: "kept" }]),
      ],
    });

    expect(out.messages[1].content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("drops a whitespace-only thinking block", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        assistant([thinking("  \n\t "), { type: "text", text: "kept" }]),
      ],
    });

    expect(out.messages[1].content).toEqual([{ type: "text", text: "kept" }]);
  });

  it("drops the whole message when the blank thinking block was its only content", () => {
    const out = normalizeClaudePassthrough({
      messages: [
        { role: "user", content: "hi" },
        assistant([thinking("   ")]),
      ],
    });

    expect(out.messages.some(m => m.role === "assistant")).toBe(false);
  });

  it("keeps a thinking block that has visible text", () => {
    const block = thinking("considered it");
    const out = normalizeClaudePassthrough({
      messages: [{ role: "user", content: "hi" }, assistant([block, { type: "text", text: "kept" }])],
    });

    expect(out.messages[1].content).toEqual([block, { type: "text", text: "kept" }]);
  });
});
