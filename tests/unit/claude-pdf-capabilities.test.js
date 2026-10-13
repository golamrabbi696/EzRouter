import { afterEach, describe, expect, it } from "vitest";
import {
  aggregateComboCapabilities,
  getCapabilitiesForModel,
  setCatalogSource,
} from "../../open-sse/providers/capabilities.js";

afterEach(() => setCatalogSource(null));

describe("Claude PDF capabilities", () => {
  it.each([
    ["anthropic", "claude-opus-5-5"],
    ["claude", "claude-sonnet-5-5"],
    ["anthropic", "claude-haiku-5-5"],
    ["anthropic", "claude-fable-5-1"],
    ["anthropic", "claude-sonnet-4-20250514"],
    ["anthropic", "claude-opus-4-20250514"],
    ["anthropic", "claude-haiku-4-5-20251001"],
    ["openrouter", "anthropic/claude-opus-4.8-thinking"],
    ["openai-compatible-chat-custom", "anthropic/claude-sonnet-5"],
  ])("reports PDF input for %s/%s without a synced catalog", (provider, model) => {
    setCatalogSource(null);
    expect(getCapabilitiesForModel(provider, model)).toMatchObject({
      vision: true,
      pdf: true,
    });
  });

  it("preserves reasoning, context and tool-choice constraints", () => {
    expect(getCapabilitiesForModel("anthropic", "claude-opus-5-5")).toMatchObject({
      pdf: true,
      reasoning: true,
      thinkingFormat: "claude-adaptive",
      thinkingCanDisable: false,
      forcedToolChoice: false,
      contextWindow: 1000000,
      maxOutput: 128000,
    });
  });

  it("advertises PDF input on a Claude-backed combo", () => {
    expect(aggregateComboCapabilities(["anthropic/claude-sonnet-5-5"])).toMatchObject({ pdf: true });
  });

  it.each(["gpt-4o", "deepseek-chat", "unknown-model", "claude-3-haiku-20240307"])(
    "does not grant PDF input to unrelated or legacy models (%s)",
    (model) => {
      setCatalogSource(null);
      expect(getCapabilitiesForModel(undefined, model).pdf).toBe(false);
    }
  );
});
