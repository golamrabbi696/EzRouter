import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";

describe("Kira AI provider", () => {
  const entry = REGISTRY.find((e) => e.id === "kira");

  it("is registered as an OpenAI-compatible apikey provider", () => {
    expect(entry).toBeDefined();
    expect(entry.category).toBe("apikey");
    expect(entry.authType).toBe("apikey");
    expect(entry.alias).toBe("kira");
    expect(entry.aliases).toContain("kiraai");
  });

  it("points at the verified OpenAI-compatible base URL", () => {
    expect(PROVIDERS.kira.baseUrl).toBe("https://kiraai.vn/api/v1/chat/completions");
    expect(PROVIDERS.kira.validateUrl).toBe("https://kiraai.vn/api/v1/models");
    expect(PROVIDERS.kira.format).toBe("openai");
  });

  it("enables dynamic model discovery and passthrough", () => {
    expect(entry.passthroughModels).toBe(true);
    expect(entry.modelsFetcher).toMatchObject({
      url: "https://kiraai.vn/api/v1/models",
      type: "openai",
    });
  });

  it("exposes curated native seed models", () => {
    const ids = (PROVIDER_MODELS.kira || []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain("kira-3.5-flash");
    expect(ids).toContain("kira-3.5-pro");
    expect(ids).toContain("kira-mini-1.0");
    expect(ids).toContain("kira-3.0-image");
    expect(ids).toContain("kira-3.0-flash-tts");
  });

  it("routes through the shared DefaultExecutor (no custom adapter)", () => {
    expect(getExecutor("kira")).toBeInstanceOf(DefaultExecutor);
  });

  it("resolves capabilities for Kira AI model families", () => {
    expect(getCapabilitiesForModel("kira", "kira-3.5-pro")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "openai",
    });
    expect(getCapabilitiesForModel("kira", "kira-3.5-flash")).toMatchObject({
      vision: true,
      reasoning: false,
    });
    expect(getCapabilitiesForModel("kira", "kira-3.0-image")).toMatchObject({
      imageOutput: true,
      tools: false,
    });
    expect(getCapabilitiesForModel("kira", "kira-3.0-flash-tts")).toMatchObject({
      audioOutput: true,
      tools: false,
    });
  });

  it("keeps every registry id unique after adding kira", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
