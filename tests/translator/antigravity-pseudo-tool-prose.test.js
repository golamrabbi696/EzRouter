// Regression: a structured Gemini functionCall part MUST reach OpenCode as an
// OpenAI `tool_calls` SSE chunk, never as literal assistant prose. The brief
// documented a real OpenCode Build failure where the UI displayed
// `{# call:default_api:read{filePath:...,limit:50,offset:160}}` instead of
// executing a real Read tool call. We do not (and must not) convert prose
// into tool calls; the correct fix is protocol-level correctness: a real
// structured functionCall part always becomes a structured tool_call.
//
// Companion to bugs-antigravity.test.js — that file covers the openai->
// gemini direction; this file covers the gemini -> openai direction and
// guards specifically against the pseudo-tool-prose symptom.
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const wrap = (response) => ({ response });
const dataEvents = (events) => events.flatMap((e) => (e.choices?.[0]?.delta?.tool_calls ? [e] : []));

describe("Antigravity → OpenAI: pseudo-tool-prose regression", () => {
  // 1. A single structured functionCall surfaces as tool_calls, never as
  //    assistant content delta.
  it("structured functionCall becomes tool_calls, not assistant prose", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, wrap({
      responseId: "r1", modelVersion: "gemini-3-flash",
      candidates: [{
        content: {
          role: "model",
          parts: [{
            thoughtSignature: "REAL_SIG",
            functionCall: { id: "call_read_1", name: "default_api:read", args: { filePath: "/a", limit: 50, offset: 160 } },
          }],
        },
        finishReason: "STOP", index: 0,
      }],
    }), state);

    const toolChunks = dataEvents(events);
    expect(toolChunks).toHaveLength(1);
    const tool = toolChunks[0].choices[0].delta.tool_calls[0];
    expect(tool.function.name).toBe("default_api:read");
    expect(JSON.parse(tool.function.arguments)).toEqual({ filePath: "/a", limit: 50, offset: 160 });
    expect(tool.extra_content.google.thought_signature).toBe("REAL_SIG");

    // No content delta ever carries literal pseudo-tool prose.
    for (const e of events) {
      const content = e.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        expect(content).not.toMatch(/^call:[a-zA-Z_]+:/);
        expect(content).not.toContain("default_api:read{");
      }
    }
  });

  // 2. Multiple parallel functionCalls — all become tool_calls, never prose.
  it("parallel functionCalls become tool_calls, never assistant prose", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, wrap({
      responseId: "r2", modelVersion: "gemini-3-flash",
      candidates: [{
        content: {
          role: "model",
          parts: [
            { thoughtSignature: "PAR_SIG", functionCall: { id: "call_a", name: "read", args: { filePath: "/x" } } },
            { functionCall: { id: "call_b", name: "grep", args: { pattern: "y" } } },
          ],
        },
        finishReason: "STOP", index: 0,
      }],
    }), state);

    const toolChunks = dataEvents(events);
    expect(toolChunks).toHaveLength(2);
    const names = toolChunks.map((c) => c.choices[0].delta.tool_calls[0].function.name);
    expect(names).toEqual(["read", "grep"]);
    for (const e of events) {
      const content = e.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        expect(content).not.toMatch(/^call:[a-zA-Z_]+:/);
      }
    }
  });

  // 3. Text + functionCall: text is fine, functionCall is a tool_call, no prose.
  it("text + functionCall: text stays text, functionCall stays tool_call", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, wrap({
      responseId: "r3", modelVersion: "gemini-3-flash",
      candidates: [{
        content: {
          role: "model",
          parts: [
            { text: "Let me read that file." },
            { thoughtSignature: "MIX_SIG", functionCall: { id: "call_m", name: "read", args: { filePath: "/m" } } },
          ],
        },
        finishReason: "STOP", index: 0,
      }],
    }), state);

    const toolChunks = dataEvents(events);
    expect(toolChunks).toHaveLength(1);
    expect(toolChunks[0].choices[0].delta.tool_calls[0].function.name).toBe("read");
    // Text content present but no pseudo-tool prose.
    const contentChunks = events.filter((e) => typeof e.choices?.[0]?.delta?.content === "string");
    expect(contentChunks.map((e) => e.choices[0].delta.content)).toContain("Let me read that file.");
    for (const e of events) {
      const content = e.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        expect(content).not.toMatch(/^call:[a-zA-Z_]+:/);
      }
    }
  });

  // 4. A real functionCall part with signature produces a tool_call whose
  //    id round-trips byte-for-byte (no Date.now() regeneration when the
  //    upstream provided an id).
  it("upstream functionCall.id is preserved so the next request matches", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, wrap({
      responseId: "r4", modelVersion: "gemini-3-flash",
      candidates: [{
        content: {
          role: "model",
          parts: [{ thoughtSignature: "ID_SIG", functionCall: { id: "call_abc123", name: "read", args: {} } }],
        },
        finishReason: "STOP", index: 0,
      }],
    }), state);
    const toolChunks = dataEvents(events);
    expect(toolChunks[0].choices[0].delta.tool_calls[0].id).toBe("call_abc123");
  });
});
