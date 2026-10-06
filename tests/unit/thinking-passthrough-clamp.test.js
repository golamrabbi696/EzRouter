// Regression: Claude Code passthrough sends output_config.effort "xhigh" for
// non-Claude model ids; GLM-5.3 backends accept exactly low|high|max and 400
// otherwise (verified live 2026-09-21 on Alibaba MaaS). clampNativeThinking must
// map the level for zai-format models and leave everything else untouched.
import { describe, expect, it } from "vitest";

const mk = () => ({ model: "glm-5.3", output_config: { effort: "xhigh" } });

describe("clampNativeThinking (passthrough guard)", () => {
  it("clamps xhigh to max for glm-5.3 on Alibaba nodes", async () => {
    const { clampNativeThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");
    const body = mk();
    clampNativeThinking(body, "anthropic-compatible-alibaba-sg", "glm-5.3");
    expect(body.output_config.effort).toBe("max");
  });

  it("keeps supported levels as-is", async () => {
    const { clampNativeThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");
    const body = { output_config: { effort: "high" } };
    clampNativeThinking(body, "anthropic-compatible-alibaba-sg", "glm-5.3");
    expect(body.output_config.effort).toBe("high");
  });

  it("does not touch non-zai models (native Anthropic, qwen)", async () => {
    const { clampNativeThinking } = await import("../../open-sse/translator/concerns/thinkingUnified.js");
    for (const [provider, model] of [
      ["anthropic", "claude-sonnet-4-5"],
      ["some-node", "qwen3.8-flash"],
    ]) {
      const body = mk();
      clampNativeThinking(body, provider, model);
      expect(body.output_config.effort, `${provider}/${model}`).toBe("xhigh");
    }
  });

  it("exact-suffix pattern does not catch glm-5.3-prime", async () => {
    const { getThinkingLevels } = await import("../../open-sse/providers/thinkingLevels.js");
    expect(getThinkingLevels("anthropic-compatible-alibaba-sg", "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("anthropic-compatible-alibaba-sg", "glm-5.3-prime")).not.toEqual(["low", "high", "max"]);
  });
});
