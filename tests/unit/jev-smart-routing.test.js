import { describe, it, expect, vi, beforeEach } from "vitest";

import { inferSmartTierMap, reorderModelsForTier } from "../../open-sse/services/combo.js";
import { classifyTier, buildJevState, resetJevBreaker } from "../../open-sse/services/jevClassifier.js";
import { JEV_DEFAULT_CLASSIFIER_MODEL, JEV_TIERS } from "../../open-sse/config/jev.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

function systemoneOk({ choice, confidence = 1, probabilities, model = "jev-1.13", usage = { input_tokens: 400, output_tokens: 50 } }) {
  const json = {
    model,
    answers: { tier: { type: "choice", choice, confidence, probabilities: probabilities || { [choice]: confidence } } },
    usage,
  };
  return new Response(JSON.stringify(json), { status: 200, headers: { "Content-Type": "application/json" } });
}

const TIER_MAP = {
  SIMPLE: "glm/glm-4.7",
  MEDIUM: "kr/claude-sonnet-4.5",
  COMPLEX: "cc/claude-opus-4-5",
  REASONING: "cc/claude-opus-4-5",
};

describe("smart tier policy", () => {
  it("infers strong-to-cheap tiers from combo order", () => {
    expect(inferSmartTierMap(["p/strong", "p/mid", "p/cheap"])).toEqual({
      REASONING: "p/strong", COMPLEX: "p/strong", MEDIUM: "p/mid", SIMPLE: "p/cheap",
    });
  });

  it("handles one- and two-model combos", () => {
    expect(inferSmartTierMap(["p/only"])).toEqual({
      REASONING: "p/only", COMPLEX: "p/only", MEDIUM: "p/only", SIMPLE: "p/only",
    });
    expect(inferSmartTierMap(["p/strong", "p/cheap"])).toEqual({
      REASONING: "p/strong", COMPLEX: "p/strong", MEDIUM: "p/cheap", SIMPLE: "p/cheap",
    });
  });

  it("moves the selected model to the front and preserves fallback", () => {
    const models = ["cc/claude-opus-4-5", "glm/glm-4.7", "kr/claude-sonnet-4.5"];
    expect(reorderModelsForTier(models, "SIMPLE", TIER_MAP)).toEqual([
      "glm/glm-4.7", "cc/claude-opus-4-5", "kr/claude-sonnet-4.5",
    ]);
  });

  it("works without hidden smartTiers config", () => {
    const models = ["p/strong", "p/mid", "p/cheap"];
    expect(reorderModelsForTier(models, "SIMPLE")).toEqual(["p/cheap", "p/strong", "p/mid"]);
    expect(reorderModelsForTier(models, "MEDIUM")).toEqual(["p/mid", "p/strong", "p/cheap"]);
    expect(reorderModelsForTier(models, "REASONING")).toBe(models);
  });

  it("allows an explicit tier map override", () => {
    const models = ["p/a", "p/b", "p/c"];
    expect(reorderModelsForTier(models, "SIMPLE", { SIMPLE: "p/b" })).toEqual(["p/b", "p/a", "p/c"]);
  });

  it("prepends an explicit model outside the combo", () => {
    const models = ["glm/glm-4.7", "kr/claude-sonnet-4.5"];
    expect(reorderModelsForTier(models, "COMPLEX", TIER_MAP)).toEqual([
      "cc/claude-opus-4-5", "glm/glm-4.7", "kr/claude-sonnet-4.5",
    ]);
  });

  it("never drops models and fails open for unknown tier", () => {
    const models = ["a/1", "b/2", "c/3"];
    expect(new Set(reorderModelsForTier(models, "MEDIUM", { MEDIUM: "b/2" }))).toEqual(new Set(models));
    expect(reorderModelsForTier(models, "UNKNOWN")).toBe(models);
  });
});

describe("buildJevState", () => {
  it("uses the trailing user turn only", () => {
    const body = { messages: [
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "current ask" },
    ] };
    expect(buildJevState(body)).toBe("current ask");
  });

  it("extracts Claude text and ignores media", () => {
    const body = { messages: [{ role: "user", content: [
      { type: "text", text: "fix the race" }, { type: "image", source: {} },
    ] }] };
    expect(buildJevState(body)).toBe("fix the race");
  });

  it("reads Gemini parts and bounds state", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "x".repeat(5000) }] }] };
    expect(buildJevState(body, 4000)).toHaveLength(4000);
  });

  it("returns empty state without a current ask", () => {
    expect(buildJevState({ messages: [] })).toBe("");
    expect(buildJevState({})).toBe("");
  });

  it("skips trailing tool results and uses the latest real user ask", () => {
    const openai = { messages: [
      { role: "user", content: "fix the race in queue.js" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", tool_call_id: "1", content: "grep output: 3 matches" },
    ] };
    expect(buildJevState(openai)).toBe("fix the race in queue.js");

    const claude = { messages: [
      { role: "user", content: "refactor the parser" },
      { role: "assistant", content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "file body" }] },
    ] };
    expect(buildJevState(claude)).toBe("refactor the parser");

    const gemini = { contents: [
      { role: "user", parts: [{ text: "explain the cache" }] },
      { role: "model", parts: [{ functionCall: { name: "read" } }] },
      { role: "user", parts: [{ functionResponse: { name: "read", response: {} } }] },
    ] };
    expect(buildJevState(gemini)).toBe("explain the cache");

    const responses = { input: [
      { role: "user", content: "add retries" },
      { type: "function_call_output", call_id: "1", output: "ok" },
    ] };
    expect(buildJevState(responses)).toBe("add retries");
  });

  it("prefers the newest user ask over earlier ones", () => {
    const body = { messages: [
      { role: "user", content: "old" },
      { role: "assistant", content: "a" },
      { role: "user", content: "new" },
      { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
      { role: "tool", tool_call_id: "1", content: "out" },
    ] };
    expect(buildJevState(body)).toBe("new");
  });
});

describe("classifyTier", () => {
  beforeEach(() => resetJevBreaker());
  const body = { messages: [{ role: "user", content: "write a function" }] };

  it("uses the free OpenCode System One lane by default", async () => {
    const evaluateSystemone = vi.fn(async () => systemoneOk({ choice: "MEDIUM", confidence: 0.99 }));
    const result = await classifyTier({ body, log, evaluateSystemone });
    expect(result).toMatchObject({ tier: "MEDIUM", confidence: 0.99, source: "systemone", model: "jev-1.13" });
    expect(JEV_TIERS).toContain(result.tier);
    const [payload, classifierModel] = evaluateSystemone.mock.calls[0];
    expect(classifierModel).toBe(JEV_DEFAULT_CLASSIFIER_MODEL);
    expect(payload.state).toBe("write a function");
    expect(payload.questions.tier.type).toBe("choice");
    expect(payload.model).toBeUndefined();
  });

  it.each(["openrouter/typesafe/jev-1.13", "vercel/typesafe-ai/jev", "oc/jev-1.13-free"])(
    "passes configured provider model %s to evaluator", async (classifierModel) => {
      const evaluateSystemone = vi.fn(async () => systemoneOk({ choice: "SIMPLE" }));
      await classifyTier({ body, log, classifierModel, evaluateSystemone });
      expect(evaluateSystemone).toHaveBeenCalledWith(expect.any(Object), classifierModel);
    }
  );

  it("fails open without evaluator", async () => {
    expect(await classifyTier({ body, log })).toBeNull();
  });

  it("fails open on empty state without invoking evaluator", async () => {
    const evaluateSystemone = vi.fn();
    expect(await classifyTier({ body: { messages: [] }, log, evaluateSystemone })).toBeNull();
    expect(evaluateSystemone).not.toHaveBeenCalled();
  });

  it("fails open across bad responses", async () => {
    expect(await classifyTier({ body, log, evaluateSystemone: async () => new Response("bad", { status: 503 }) })).toBeNull();
    expect(await classifyTier({ body, log, evaluateSystemone: async () => { throw new Error("boom"); } })).toBeNull();
    expect(await classifyTier({ body, log, evaluateSystemone: async () => new Response("not-json") })).toBeNull();
    expect(await classifyTier({ body, log, evaluateSystemone: async () => systemoneOk({ choice: "GALACTIC" }) })).toBeNull();
    expect(await classifyTier({ body, log, minConfidence: 0.5, evaluateSystemone: async () => systemoneOk({ choice: "MEDIUM", confidence: 0.2 }) })).toBeNull();
  });

  it("honours custom confidence threshold", async () => {
    const result = await classifyTier({ body, log, minConfidence: 0.1, evaluateSystemone: async () => systemoneOk({ choice: "SIMPLE", confidence: 0.2 }) });
    expect(result?.tier).toBe("SIMPLE");
  });

  it("treats an empty-string threshold/timeout (UI reset) as default", async () => {
    const reasons = [];
    const evaluateSystemone = async () => systemoneOk({ choice: "SIMPLE", confidence: 0.4 });
    expect(await classifyTier({ body, log, minConfidence: "", timeoutMs: "", evaluateSystemone, onSkip: (r) => reasons.push(r) })).toBeNull();
    expect(reasons).toEqual(["low-confidence"]);
    expect((await classifyTier({ body, log, minConfidence: "0.3", evaluateSystemone }))?.tier).toBe("SIMPLE");
  });

  it("reports why it skipped", async () => {
    const skip = async (opts) => {
      const seen = [];
      await classifyTier({ log, body, ...opts, onSkip: (reason, message) => seen.push([reason, message]) });
      return seen;
    };
    expect((await skip({ evaluateSystemone: undefined }))[0][0]).toBe("no-evaluator");
    expect((await skip({ body: { messages: [] }, evaluateSystemone: vi.fn() }))[0][0]).toBe("empty-state");
    expect((await skip({ evaluateSystemone: async () => new Response("x", { status: 503 }) }))[0]).toEqual(["http", expect.stringContaining("503")]);
    expect((await skip({ evaluateSystemone: async () => { throw new Error("boom"); } }))[0]).toEqual(["error", "boom"]);
    expect((await skip({ evaluateSystemone: async () => systemoneOk({ choice: "COMPLEX", confidence: 0.343 }) }))[0])
      .toEqual(["low-confidence", "COMPLEX confidence 0.343 < min 0.5"]);
    expect((await skip({ timeoutMs: 5, evaluateSystemone: () => new Promise(() => {}) }))[0]).toEqual(["timeout", expect.stringContaining("5ms")]);
    expect((await skip({ evaluateSystemone: vi.fn() }))[0][0]).toBe("breaker-open");
  });

  it("times out, opens breaker, and allows recovery probe", async () => {
    let clock = 0;
    const hanging = vi.fn(() => new Promise(() => {}));
    expect(await classifyTier({ body, log, classifierModel: "openrouter/typesafe/jev-1.13", evaluateSystemone: hanging, timeoutMs: 5, now: () => clock })).toBeNull();
    const blocked = vi.fn();
    expect(await classifyTier({ body, log, classifierModel: "openrouter/typesafe/jev-1.13", evaluateSystemone: blocked, timeoutMs: 5, now: () => clock + 1000 })).toBeNull();
    expect(blocked).not.toHaveBeenCalled();
    clock += 31000;
    const recovery = vi.fn(async () => systemoneOk({ choice: "COMPLEX", confidence: 0.9 }));
    expect((await classifyTier({ body, log, classifierModel: "openrouter/typesafe/jev-1.13", evaluateSystemone: recovery, now: () => clock }))?.tier).toBe("COMPLEX");
  });

  it("isolates breakers by provider model", async () => {
    await classifyTier({ body, log, classifierModel: "openrouter/typesafe/jev-1.13", evaluateSystemone: () => new Promise(() => {}), timeoutMs: 5, now: () => 0 });
    const vercel = vi.fn(async () => systemoneOk({ choice: "SIMPLE" }));
    const result = await classifyTier({ body, log, classifierModel: "vercel/typesafe-ai/jev", evaluateSystemone: vercel, now: () => 1000 });
    expect(result?.tier).toBe("SIMPLE");
    expect(vercel).toHaveBeenCalledTimes(1);
  });

  it("never receives or logs provider credentials", async () => {
    const lines = [];
    const spyLog = { info: (_t, m) => lines.push(String(m)), warn: (_t, m) => lines.push(String(m)), debug: (_t, m) => lines.push(String(m)) };
    const result = await classifyTier({ body, log: spyLog, evaluateSystemone: async () => systemoneOk({ choice: "MEDIUM" }) });
    expect(JSON.stringify(result)).not.toMatch(/api[_-]?key|bearer/i);
    expect(lines.join("\n")).not.toMatch(/api[_-]?key|bearer/i);
  });
});
