import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("getCapabilitiesForModel", () => {
  const claudeSonnet5Expected = {
    contextWindow: 1000000,
    maxOutput: 128000,
    thinkingFormat: "claude-adaptive",
    reasoning: true,
    vision: true,
    search: true,
  };

  const kiroGpt56Expected = {
    contextWindow: 272000,
    maxOutput: 128000,
    thinkingFormat: "openai",
    reasoning: true,
    vision: true,
    search: true,
  };

  it("reports Kiro Claude Opus 5 variants as 1M adaptive-thinking models", () => {
    for (const model of [
      "claude-opus-5",
      "anthropic/claude-opus-5",
      "claude-opus-5-thinking",
      "claude-opus-5-agentic",
      "claude-opus-5-thinking-agentic",
    ]) {
      expect(getCapabilitiesForModel("kiro", model)).toMatchObject(claudeSonnet5Expected);
    }
  });

  it("reports Kiro Claude Opus 4.8 as a 1M context model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-opus-4.8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4.8-thinking").contextWindow).toBe(1000000);
    expect(getCapabilitiesForModel("kiro", "claude-opus-4-8-thinking").contextWindow).toBe(1000000);
  });

  it("reports Kiro Claude Sonnet 5 as a 1M adaptive-thinking model", () => {
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "anthropic/claude-sonnet-5")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-agentic")).toMatchObject(claudeSonnet5Expected);
    expect(getCapabilitiesForModel("kiro", "claude-sonnet-5-thinking-agentic")).toMatchObject(claudeSonnet5Expected);
  });

  // Opus 5 shipped after the 4.8 patterns were written and fell through to the generic
  // "*claude*opus*" entry, so every thinking request 400'd on the budget shape and
  // max_tokens was clamped to the 64k floor.
  it("reports Claude Opus 5 as a 1M adaptive-thinking model", () => {
    for (const model of [
      "claude-opus-5", "anthropic/claude-opus-5", "claude-opus-5-thinking",
      "claude-opus-5-agentic", "claude-opus-5-20260724",
    ]) {
      expect(getCapabilitiesForModel("github", model)).toMatchObject(claudeSonnet5Expected);
    }
  });

  it("reports Kiro GPT 5.6 models with the Kiro 272k context window", () => {
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "openai/gpt-5.6-sol")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-terra-thinking")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-luna-agentic")).toMatchObject(kiroGpt56Expected);
    expect(getCapabilitiesForModel("kiro", "gpt-5.6-sol-thinking-agentic")).toMatchObject(kiroGpt56Expected);
  });

  // Anthropic rejects thinking.type "enabled" on 4.6+ generation models outright, so a
  // budget format turns every thinking request into a 400. Fable/Mythos are newer than
  // 4.6 and must follow the adaptive rule.
  it("reports Claude Fable / Mythos as adaptive-thinking models", () => {
    for (const provider of ["github", "claude"]) {
      expect(getCapabilitiesForModel(provider, "claude-fable-5").thinkingFormat).toBe("claude-adaptive");
      expect(getCapabilitiesForModel(provider, "claude-mythos-1").thinkingFormat).toBe("claude-adaptive");
    }
  });

  // Live provider catalogs ship claude-* variants ahead of the static model lists;
  // anything falling through to the generic "*claude*sonnet*" pattern gets the 4.5-era
  // budget format and breaks.
  it("keeps unlisted Sonnet 5 variants on the adaptive format", () => {
    expect(getCapabilitiesForModel("github", "claude-sonnet-5.1").thinkingFormat).toBe("claude-adaptive");
    expect(getCapabilitiesForModel("github", "claude-sonnet-5-preview").thinkingFormat).toBe("claude-adaptive");
  });

  // 4.5 and older stay on the budget format — they reject output_config.effort.
  it("keeps pre-4.6 Claude models on the budget format", () => {
    expect(getCapabilitiesForModel("github", "claude-haiku-4.5").thinkingFormat).toBe("claude-budget");
    expect(getCapabilitiesForModel("github", "claude-sonnet-4.5").thinkingFormat).toBe("claude-budget");
    expect(getCapabilitiesForModel("github", "claude-opus-4.5").thinkingFormat).toBe("claude-budget");
  });
});

// maxOutput is a clamp ceiling (translator/formats/claude.js, openai-to-claude.js), and
// contextWindow drives context accounting — a variant that drops to the 200k/64k floor
// is silently capped at half its real output budget. Limits verified upstream:
// "max_tokens: 999999 > 128000" / "prompt is too long: ... > 1000000 maximum".
describe("4.6+ Claude limits reach unlisted variants", () => {
  const family = { contextWindow: 1000000, maxOutput: 128000, thinkingFormat: "claude-adaptive" };

  it("gives claude-opus-4.8-fast the same limits as claude-opus-4.8", () => {
    expect(getCapabilitiesForModel("github", "claude-opus-4.8-fast")).toMatchObject(family);
    expect(getCapabilitiesForModel("github", "claude-opus-4.8")).toMatchObject(family);
  });

  it("covers variants of every 4.6+ family", () => {
    for (const model of [
      "claude-sonnet-5.1", "claude-sonnet-4.6-preview", "claude-opus-4.7-fast",
      "anthropic/claude-opus-4.6", "claude-fable-5-preview", "claude-opus-5-fast",
    ]) {
      expect(getCapabilitiesForModel("github", model)).toMatchObject(family);
    }
  });

  it("leaves 4.5 and older on the conservative floor", () => {
    for (const model of ["claude-haiku-4.5", "claude-sonnet-4.5", "claude-opus-4.5"]) {
      const caps = getCapabilitiesForModel("github", model);
      expect(caps.contextWindow).toBe(200000);
      expect(caps.maxOutput).toBe(64000);
    }
  });

  it("does not let the shared caps object leak mutations between lookups", () => {
    const first = getCapabilitiesForModel("github", "claude-opus-4.8-fast");
    first.maxOutput = 1;
    expect(getCapabilitiesForModel("github", "claude-opus-4.8").maxOutput).toBe(128000);
  });
});

describe("Gemini 3.x capability pattern (regression for *gemini-3.6* addition)", () => {
  // Locks in the new *gemini-3.6* PATTERN_CAPABILITIES entry added in
  // fix/gemini-3.6-capabilities. The literal name "gemini-3.6" is a
  // defensive pre-recognition; the actual registered model ids end in
  // "-flash" / "-flash-high" / "-flash-medium" / "-flash-low" and would
  // also match the broader *gemini-3* pattern. The new pattern must
  // match the literal name anyway so a future "gemini-3.6" id (no
  // suffix) is classified as a Gemini-3-class multimodal model.
  it("matches the literal gemini-3.6 model id with full multimodal caps", () => {
    const caps = getCapabilitiesForModel("antigravity", "gemini-3.6");
    expect(caps.contextWindow).toBe(1048576);
    expect(caps.maxOutput).toBe(65536);
    expect(caps.vision).toBe(true);
    expect(caps.audioInput).toBe(true);
    expect(caps.videoInput).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.search).toBe(true);
    expect(caps.thinkingFormat).toBe("gemini-level");
    expect(caps.thinkingCanDisable).toBe(false);
  });

  it("matches gemini-3.6-flash and tiered variants (provider-prefixed too)", () => {
    for (const model of [
      "gemini-3.6-flash",
      "gemini-3.6-flash-high",
      "gemini-3.6-flash-medium",
      "gemini-3.6-flash-low",
      "google/gemini-3.6-flash",
    ]) {
      const caps = getCapabilitiesForModel("antigravity", model);
      expect(caps.contextWindow, model).toBe(1048576);
      expect(caps.maxOutput, model).toBe(65536);
      expect(caps.thinkingFormat, model).toBe("gemini-level");
    }
  });
});
