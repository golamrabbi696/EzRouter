// Gemini 3 thought-signature round-trip preservation across the OpenAI-compat
// bridge. See https://ai.google.dev/gemini-api/docs/openai and
// https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures.
//
// Gemini 3 mandates that every functionCall part in the current turn's first
// step carry the exact `thought_signature` Google returned for it on the
// previous turn. The official OpenAI-compat envelope is:
//
//   tool_calls[i].extra_content.google.thought_signature = "<sig>"
//
// Without it the next request returns 400 INVALID_ARGUMENT
// ("function call is missing a thought_signature"). The previous 9router
// code discarded the real signature on response and backfilled a static
// default on the next request — multi-step tool loops silently corrupted
// the model's reasoning state and the tool call eventually failed or
// degenerated into prose ("call:default_api:read{...}").
//
// These tests cover:
//   - Round-trip preservation of the real signature byte-for-byte
//   - Parallel function calls (signature on FIRST call only)
//   - Sequential function calls (every step carries its own signature)
//   - Synthetic history fallback (no real signature → static default)
//   - Normalization preserves signature Part order (no semantic merge)
//   - Read/grep/bash/edit name sanitization round-trip
//   - Colon/namespace-style names (e.g. "default_api:read") preserved
//   - Response-side functionCall + signature always becomes a tool_call
//     (never assistant prose)
import { describe, it, expect } from "vitest";
import "./registerAll.js";
import { translateRequest, translateResponse, initState } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import {
  readOpenAIToolCallSignature,
  attachOpenAIToolCallSignature,
  readGeminiPartSignature,
} from "../../open-sse/translator/concerns/thoughtSignature.js";

// Tiny helpers
const O2G = (messages) =>
  translateRequest(FORMATS.OPENAI, FORMATS.GEMINI, "gemini-3-flash", { messages }, true, null, null);
const O2AG = (messages) =>
  openaiToAntigravityRequest("gemini-3-flash", { messages }, true, { projectId: "p", connectionId: "c" });

const findFunctionCallParts = (contents) => {
  const out = [];
  for (const c of contents) {
    for (const p of c.parts || []) {
      if (p.functionCall) out.push({ role: c.role, part: p });
    }
  }
  return out;
};

describe("thought-signature helpers", () => {
  it("reads the canonical extra_content.google.thought_signature envelope", () => {
    const tc = { id: "call_1", type: "function", function: { name: "read", arguments: "{}" }, extra_content: { google: { thought_signature: "REAL_SIG_A" } } };
    expect(readOpenAIToolCallSignature(tc)).toBe("REAL_SIG_A");
  });

  it("falls back to legacy tool_call.thought_signature when extra_content is absent", () => {
    const tc = { id: "call_1", type: "function", function: { name: "read", arguments: "{}" }, thought_signature: "LEGACY_SIG" };
    expect(readOpenAIToolCallSignature(tc)).toBe("LEGACY_SIG");
  });

  it("attaches signature via extra_content.google.thought_signature (mutates in place)", () => {
    const tc = { id: "call_1", type: "function", function: { name: "read", arguments: "{}" } };
    attachOpenAIToolCallSignature(tc, "REAL_SIG_A");
    expect(tc.extra_content.google.thought_signature).toBe("REAL_SIG_A");
  });

  it("reads Gemini part signatures from both camelCase and snake_case", () => {
    expect(readGeminiPartSignature({ thoughtSignature: "C" })).toBe("C");
    expect(readGeminiPartSignature({ thought_signature: "S" })).toBe("S");
    expect(readGeminiPartSignature({})).toBe(null);
  });
});

describe("Gemini 3 thought-signature round-trip (response → OpenAI → next request → Gemini)", () => {
  // 1. Gemini functionCall with REAL thoughtSignature → OpenAI tool_call
  //    retains the exact signature metadata.
  it("emits extra_content.google.thought_signature on the OpenAI tool_call", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, {
      response: {
        responseId: "r-sig", modelVersion: "gemini-3-flash",
        candidates: [{
          content: {
            role: "model",
            parts: [{ thoughtSignature: "REAL_SIG_A", functionCall: { id: "call_x", name: "read", args: { filePath: "/a" } } }],
          },
          finishReason: "STOP", index: 0,
        }],
      },
    }, state);
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].id).toBe("call_x");
    expect(toolChunk.choices[0].delta.tool_calls[0].extra_content.google.thought_signature).toBe("REAL_SIG_A");
  });

  // 2. Same OpenAI assistant tool_call on the next request → Gemini functionCall
  //    receives the exact ORIGINAL signature.
  it("preserves the real signature byte-for-byte on next request", () => {
    const out = O2G([
      { role: "user", content: "read /a" },
      { role: "assistant", tool_calls: [{
        id: "call_x", type: "function",
        function: { name: "read", arguments: JSON.stringify({ filePath: "/a" }) },
        extra_content: { google: { thought_signature: "REAL_SIG_A" } },
      }] },
    ]);
    const fc = out.contents[1].parts[0];
    expect(fc.functionCall.name).toBe("read");
    expect(fc.thoughtSignature).toBe("REAL_SIG_A");
  });

  // 3. Signature equality is byte-for-byte (no truncation, no re-encoding).
  it("preserves very long signatures without mutation", () => {
    const longSig = "A".repeat(4000);
    const out = O2G([
      { role: "user", content: "x" },
      { role: "assistant", tool_calls: [{
        id: "call_x", type: "function",
        function: { name: "read", arguments: "{}" },
        extra_content: { google: { thought_signature: longSig } },
      }] },
    ]);
    expect(out.contents[1].parts[0].thoughtSignature).toBe(longSig);
  });

  // 4. Sequential FC1+A → FR1 → FC2+B → FR2. Each step's signature survives.
  it("sequential multi-step tool loop preserves each step's signature", () => {
    const out = O2G([
      { role: "user", content: "step1 then step2" },
      { role: "assistant", tool_calls: [{
        id: "call_a", type: "function",
        function: { name: "read", arguments: "{}" },
        extra_content: { google: { thought_signature: "SIG_A" } },
      }] },
      { role: "tool", tool_call_id: "call_a", content: '{"content":"A"}' },
      { role: "assistant", tool_calls: [{
        id: "call_b", type: "function",
        function: { name: "grep", arguments: "{}" },
        extra_content: { google: { thought_signature: "SIG_B" } },
      }] },
      { role: "tool", tool_call_id: "call_b", content: '{"matches":[]}' },
    ]);
    const fcParts = findFunctionCallParts(out.contents);
    expect(fcParts).toHaveLength(2);
    expect(fcParts[0].part.thoughtSignature).toBe("SIG_A");
    expect(fcParts[1].part.thoughtSignature).toBe("SIG_B");
  });

  // 5. Parallel FC1+A + FC2(no signature). Sibling parallel parts carry no sig.
  it("parallel function calls: first carries sig, siblings do not", () => {
    const out = O2G([
      { role: "user", content: "parallel" },
      { role: "assistant", tool_calls: [
        { id: "call_a", type: "function", function: { name: "read", arguments: "{}" },
          extra_content: { google: { thought_signature: "SIG_PARALLEL" } } },
        { id: "call_b", type: "function", function: { name: "grep", arguments: "{}" } },
      ] },
    ]);
    const fcParts = findFunctionCallParts(out.contents);
    // Parallel siblings get merged into a single model turn by openai-to-gemini;
    // the first carries the real signature, siblings fall back to the default.
    expect(fcParts).toHaveLength(2);
    expect(fcParts[0].part.functionCall.name).toBe("read");
    // Real signature on the FIRST parallel tool_call is preserved exactly.
    expect(fcParts[0].part.thoughtSignature).toBe("SIG_PARALLEL");
    // The sibling parallel call has no extra_content.google.thought_signature
    // (per Google's protocol: only the first parallel FC carries one) and
    // therefore falls back to the synthetic default — the Antigravity
    // validator-skip behavior. The default is non-empty so Gemini accepts
    // the request, and the loop continues.
    expect(typeof fcParts[1].part.thoughtSignature).toBe("string");
    expect(fcParts[1].part.thoughtSignature.length).toBeGreaterThan(0);
  });

  // 6. Synthetic / legacy history without a real signature → synthetic default.
  //    This covers: another model/provider, an older client, manual history.
  it("falls back to the synthetic default signature when no real signature is present", () => {
    const out = O2G([
      { role: "user", content: "x" },
      { role: "assistant", tool_calls: [{
        id: "call_x", type: "function",
        function: { name: "read", arguments: "{}" },
      }] },
    ]);
    const sig = out.contents[1].parts[0].thoughtSignature;
    expect(sig).toBeTruthy();
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(50); // default is a long opaque blob
  });

  // 7. Valid text + tool call together — sig still emitted on tool_call.
  it("text + functionCall: signature attaches only to functionCall", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, {
      response: {
        responseId: "r-mix", modelVersion: "gemini-3-flash",
        candidates: [{
          content: {
            role: "model",
            parts: [
              { text: "I'll read the file now." },
              { thoughtSignature: "REAL_SIG_MIX", functionCall: { id: "call_mix", name: "read", args: { filePath: "/b" } } },
            ],
          },
          finishReason: "STOP", index: 0,
        }],
      },
    }, state);
    const textChunk = events.find((e) => e.choices?.[0]?.delta?.content === "I'll read the file now.");
    expect(textChunk).toBeTruthy();
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].extra_content.google.thought_signature).toBe("REAL_SIG_MIX");
  });

  // 8. Tool-only response (no text): still a proper tool_call.
  it("tool-only response: structured functionCall surfaces as tool_call", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, {
      response: {
        responseId: "r-tool", modelVersion: "gemini-3-flash",
        candidates: [{
          content: {
            role: "model",
            parts: [{ thoughtSignature: "SIG_TOOL_ONLY", functionCall: { id: "call_t", name: "bash", args: { command: "ls" } } }],
          },
          finishReason: "STOP", index: 0,
        }],
      },
    }, state);
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("bash");
    expect(toolChunk.choices[0].delta.tool_calls[0].extra_content.google.thought_signature).toBe("SIG_TOOL_ONLY");
    // No assistant content delta should be emitted alongside the tool_call
    // (a tool-only model turn is exactly that — no prose narration).
    const textChunks = events.filter((e) => typeof e.choices?.[0]?.delta?.content === "string");
    expect(textChunks).toHaveLength(0);
  });

  // 9. Signature-containing empty-text Part: must NOT surface as empty content.
  //    Gemini sometimes emits { thoughtSignature, text: "" } alone; the translator
  //    must drop the empty text but preserve the part's signature association
  //    for any sibling functionCall in the same content.
  it("empty-text + thoughtSignature Part: empty text is dropped, signature is retained for sibling FC", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, {
      response: {
        responseId: "r-empty-sig", modelVersion: "gemini-3-flash",
        candidates: [{
          content: {
            role: "model",
            parts: [
              { thoughtSignature: "SIG_X", text: "" },
              { thoughtSignature: "SIG_X", functionCall: { id: "call_e", name: "read", args: { filePath: "/c" } } },
            ],
          },
          finishReason: "STOP", index: 0,
        }],
      },
    }, state);
    // No empty-text content delta should be emitted.
    const textChunks = events.filter((e) => typeof e.choices?.[0]?.delta?.content === "string");
    expect(textChunks).toHaveLength(0);
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk.choices[0].delta.tool_calls[0].id).toBe("call_e");
  });

  // 10. Common OpenCode tool names round-trip cleanly.
  it.each(["read", "grep", "bash", "edit", "glob", "list", "write"])(
    "name %s round-trips through Gemini function call without mutation",
    (name) => {
      const out = O2G([
        { role: "user", content: "x" },
        { role: "assistant", tool_calls: [{
          id: `call_${name}`, type: "function",
          function: { name, arguments: "{}" },
          extra_content: { google: { thought_signature: `SIG_${name}` } },
        }] },
      ]);
      expect(out.contents[1].parts[0].functionCall.name).toBe(name);
      expect(out.contents[1].parts[0].thoughtSignature).toBe(`SIG_${name}`);
    },
  );

  // 11. Colon/namespace-style names (e.g. "default_api:read") preserved.
  it("colon/namespace-style tool names survive sanitization", () => {
    const out = O2G([
      { role: "user", content: "x" },
      { role: "assistant", tool_calls: [{
        id: "call_ns", type: "function",
        function: { name: "default_api:read", arguments: JSON.stringify({ filePath: "/d" }) },
        extra_content: { google: { thought_signature: "SIG_NS" } },
      }] },
    ]);
    expect(out.contents[1].parts[0].functionCall.name).toBe("default_api:read");
    expect(out.contents[1].parts[0].thoughtSignature).toBe("SIG_NS");
  });

  // 12. functionResponse.name maps back to the correct functionCall (round-trip).
  it("functionResponse recovers the original functionCall name when history carries the call", () => {
    const out = O2G([
      { role: "user", content: "read it" },
      { role: "assistant", tool_calls: [{
        id: "read_1736000000000_0", type: "function",
        function: { name: "read", arguments: "{}" },
        extra_content: { google: { thought_signature: "SIG" } },
      }] },
      { role: "tool", tool_call_id: "read_1736000000000_0", content: '{"content":"data"}' },
    ]);
    const fr = out.contents.find((c) => c.parts?.[0]?.functionResponse)?.parts[0].functionResponse;
    expect(fr.name).toBe("read");
  });

  // 13. Normalization does not reorder signed Parts. Two adjacent model
  //     contents must merge without dropping/reordering signature-bearing
  //     functionCall Parts (the empty-parts filter is upstream of normalize).
  it("normalizeGeminiContents preserves positional order of signed Parts when merging adjacent model turns", () => {
    // Force the merge: two model turns in a row (e.g. when a client emits
    // a separate assistant message per parallel tool call). The merged
    // content must keep Parts in original order with their signatures.
    const out = O2AG([
      { role: "user", content: "step" },
      { role: "assistant", tool_calls: [{
        id: "call_1", type: "function",
        function: { name: "read", arguments: "{}" },
        extra_content: { google: { thought_signature: "FIRST_SIG" } },
      }] },
      { role: "assistant", content: "thinking..." },
      { role: "assistant", tool_calls: [{
        id: "call_2", type: "function",
        function: { name: "grep", arguments: "{}" },
        extra_content: { google: { thought_signature: "SECOND_SIG" } },
      }] },
    ]);
    const modelContent = out.request.contents.find((c) => c.role === "model");
    expect(modelContent).toBeTruthy();
    // First functionCall part must carry FIRST_SIG, second must carry SECOND_SIG.
    const fcParts = modelContent.parts.filter((p) => p.functionCall);
    expect(fcParts).toHaveLength(2);
    expect(fcParts[0].functionCall.name).toBe("read");
    expect(fcParts[0].thoughtSignature).toBe("FIRST_SIG");
    expect(fcParts[1].functionCall.name).toBe("grep");
    expect(fcParts[1].thoughtSignature).toBe("SECOND_SIG");
  });

  // 14. Structured functionCall must translate to a tool_calls SSE chunk,
  //     NEVER to literal assistant prose ("call:default_api:read{...}").
  //     Regression guard for the OpenCode "pseudo-tool prose" symptom: if
  //     the upstream emits a structured functionCall, the OpenAI-facing SSE
  //     contains tool_calls, not content.
  it("structured functionCall becomes tool_calls SSE, not assistant prose", () => {
    const state = initState(FORMATS.OPENAI);
    const events = translateResponse(FORMATS.ANTIGRAVITY, FORMATS.OPENAI, {
      response: {
        responseId: "r-no-prose", modelVersion: "gemini-3-flash",
        candidates: [{
          content: {
            role: "model",
            parts: [{
              thoughtSignature: "SIG_NO_PROSE",
              functionCall: { id: "call_real", name: "default_api:read", args: { filePath: "/e" } },
            }],
          },
          finishReason: "STOP", index: 0,
        }],
      },
    }, state);
    // tool_calls chunk exists with the upstream function name.
    const toolChunk = events.find((e) => e.choices?.[0]?.delta?.tool_calls);
    expect(toolChunk).toBeTruthy();
    expect(toolChunk.choices[0].delta.tool_calls[0].function.name).toBe("default_api:read");
    // No content delta carries literal pseudo-tool prose.
    for (const e of events) {
      const content = e.choices?.[0]?.delta?.content;
      if (typeof content === "string") {
        expect(content).not.toMatch(/^call:[a-z_]+:/);
      }
    }
  });
});
