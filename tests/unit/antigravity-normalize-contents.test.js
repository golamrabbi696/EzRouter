// Regression: normalizeAntigravityContents() in open-sse/executors/antigravity.js
// was introduced to remove empty contents that survived thought-only filtering
// and to merge adjacent same-role messages. After thought-only filtering the
// payload must remain structurally valid:
//
// - no content object has an empty/missing parts array
// - adjacent same-role contents are merged
// - valid text remains
// - valid functionCall remains
// - valid functionResponse remains
// - thoughtSignature handling remains valid
//
// Drift in either direction breaks the Antigravity upstream (400 from the
// server) or alternately — if the prior buggy copy is reinstated — leaves
// adjacent model messages in history and the empty-parts object that Gemini
// rejects.
import { describe, it, expect } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";

const wrap = (contents) => ({ request: { contents }, stream: true });

describe("Antigravity normalizeAntigravityContents (via transformRequest)", () => {
  it("removes content entries that have empty parts after thought-only filtering", () => {
    // The upstream transformRequest strips thought-only parts (line 233-238 of
    // antigravity.js). If a model's reasoning-only message loses its only part,
    // the resulting contents array would have an empty parts[] — Gemini rejects
    // that. The normalize step must drop it.
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "gemini-2.5-pro",
      wrap([
        { role: "user", parts: [{ text: "hi" }] },
        // thought-only entry — its only part is dropped, leaving parts: []
        { role: "model", parts: [{ thought: true, text: "internal monologue" }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    // The reasoning-only "model" entry was dropped; only the user entry remains.
    expect(out.request.contents).toHaveLength(1);
    expect(out.request.contents[0].parts[0].text).toBe("hi");
  });

  it("merges adjacent same-role contents", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "gemini-2.5-pro",
      wrap([
        { role: "user", parts: [{ text: "first" }] },
        { role: "user", parts: [{ text: "second" }] },
        { role: "model", parts: [{ text: "answer" }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    expect(out.request.contents).toHaveLength(2);
    expect(out.request.contents[0].parts).toHaveLength(2);
    expect(out.request.contents[0].parts[0].text).toBe("first");
    expect(out.request.contents[0].parts[1].text).toBe("second");
    expect(out.request.contents[1].parts[0].text).toBe("answer");
  });

  it("preserves valid text content", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "gemini-2.5-pro",
      wrap([
        { role: "user", parts: [{ text: "question" }] },
        { role: "model", parts: [{ text: "answer" }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    expect(out.request.contents).toHaveLength(2);
    expect(out.request.contents[0].parts[0].text).toBe("question");
    expect(out.request.contents[1].parts[0].text).toBe("answer");
  });

  it("preserves valid functionCall content", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "gemini-2.5-pro",
      wrap([
        { role: "user", parts: [{ text: "run it" }] },
        { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    expect(out.request.contents).toHaveLength(2);
    expect(out.request.contents[1].parts[0].functionCall.name).toBe("bash");
    expect(out.request.contents[1].parts[0].functionCall.args).toEqual({ command: "ls" });
  });

  it("preserves valid functionResponse with role normalized to user (Claude models)", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "claude-opus-4-6",
      wrap([
        { role: "user", parts: [{ text: "run it" }] },
        { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] },
        // functionResponse must be role "user" for Claude models via Antigravity
        { role: "function", parts: [{ functionResponse: { name: "bash", response: { result: "ok" } } }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    expect(out.request.contents).toHaveLength(3);
    expect(out.request.contents[2].role).toBe("user");
    expect(out.request.contents[2].parts[0].functionResponse.name).toBe("bash");
  });

  it("keeps thoughtSignature on functionCall parts (Gemini 3+ requires it) and backfills default when missing", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "gemini-3-pro",
      wrap([
        { role: "user", parts: [{ text: "do it" }] },
        // functionCall without thoughtSignature — must be backfilled
        { role: "model", parts: [{ functionCall: { name: "bash", args: { command: "ls" } } }] },
        // functionCall WITH thoughtSignature — must be preserved
        { role: "model", parts: [{ functionCall: { name: "grep", args: {} }, thoughtSignature: "sig-123" }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    // After merging adjacent same-role model contents
    const modelContent = out.request.contents.find((c) => c.role === "model");
    expect(modelContent.parts).toHaveLength(2);

    const fcBash = modelContent.parts.find((p) => p.functionCall?.name === "bash");
    expect(fcBash.thoughtSignature).toBeTruthy(); // backfilled

    const fcGrep = modelContent.parts.find((p) => p.functionCall?.name === "grep");
    expect(fcGrep.thoughtSignature).toBe("sig-123"); // preserved
  });

  it("drops a content entry that becomes empty after thought-only filter AND merges adjacent same-role", () => {
    const ex = new AntigravityExecutor();
    const out = ex.transformRequest(
      "gemini-2.5-pro",
      wrap([
        { role: "user", parts: [{ text: "hi" }] },
        // thought-only model → empty parts after filter
        { role: "model", parts: [{ thought: true, text: "thinking..." }] },
        // adjacent same-role model → should merge
        { role: "model", parts: [{ text: "answer" }] },
      ]),
      true,
      { projectId: "p", connectionId: "c" },
    );

    expect(out.request.contents).toHaveLength(2);
    expect(out.request.contents[0].parts[0].text).toBe("hi");
    expect(out.request.contents[1].parts[0].text).toBe("answer");
  });
});
