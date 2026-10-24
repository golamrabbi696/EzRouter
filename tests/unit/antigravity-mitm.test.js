import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

// config.js is the CJS MITM bundle module (dependency-isolated for the runtime copy).
const require = createRequire(import.meta.url);
const { MODEL_NO_MAP, MODEL_PATTERNS, MODEL_SYNONYMS } = require("../../src/mitm/config.js");

// All assertions below are grounded in a live MITM dump capture of Antigravity's
// streamGenerateContent requests (see AI_JOURNAL): the agent loop sends
// `gemini-3.5-flash-low`, tab-autocomplete sends `tab_jump_flash_lite_preview` /
// `tab_flash_lite_preview`.
describe("Antigravity MITM model handling", () => {
  const ag = MITM_TOOLS.antigravity;

  it("flags the out-of-box agent/Default model mandatory", () => {
    expect(ag.defaultModels.find((m) => m.id === "gemini-3.8-flash-medium")?.mandatory).toBe(true);
  });

  it("leaves models not proven auto-sent optional", () => {
    for (const id of ["gemini-3.1-pro-low", "claude-sonnet-4-6", "gpt-oss-120b-medium"]) {
      expect(ag.defaultModels.find((m) => m.id === id)?.mandatory).toBeFalsy();
    }
  });

  // Tab-autocomplete is latency-critical inline completion — it must passthrough natively,
  // never get re-routed onto a chat-model mapping by the broad `flash` pattern.
  it.each(["tab_jump_flash_lite_preview", "tab_flash_lite_preview"])(
    "excludes tab-autocomplete model '%s' from re-routing",
    (id) => {
      expect((MODEL_NO_MAP.antigravity || []).some((re) => re.test(id))).toBe(true);
    }
  );

  it("does not exclude real agent models from re-routing", () => {
    for (const id of ["gemini-3.8-flash-medium", "gemini-3.8-flash-high", "gemini-4-argon-high", "gemini-4-argon-medium", "claude-sonnet-4-6"]) {
      expect((MODEL_NO_MAP.antigravity || []).some((re) => re.test(id))).toBe(false);
    }
  });

  it("includes Gemini 4 Argon models in Antigravity MITM configuration", () => {
    expect(ag.modelAliases).toContain("gemini-4-argon-high");
    expect(ag.modelAliases).toContain("gemini-4-argon-medium");
    expect(ag.modelAliases).toContain("gemini-4-argon-low");
    expect(ag.modelAliases).toContain("gemini-4-argon");

    const argonHigh = ag.defaultModels.find((m) => m.id === "gemini-4-argon-high");
    expect(argonHigh).toBeTruthy();
    expect(argonHigh.alias).toBe("gemini-4-argon-high");

    const argonMed = ag.defaultModels.find((m) => m.id === "gemini-4-argon-medium");
    expect(argonMed).toBeTruthy();
    expect(argonMed.alias).toBe("gemini-4-argon-medium");

    const argonLow = ag.defaultModels.find((m) => m.id === "gemini-4-argon-low");
    expect(argonLow).toBeTruthy();
    expect(argonLow.alias).toBe("gemini-4-argon-low");

    const argon = ag.defaultModels.find((m) => m.id === "gemini-4-argon");
    expect(argon).toBeTruthy();
    expect(argon.alias).toBe("gemini-4-argon");
  });

  it("matches Gemini 4 Argon variants via MITM patterns", () => {
    const patterns = MODEL_PATTERNS.antigravity;
    const matchModel = (raw) => {
      for (const { match, alias } of patterns) {
        if (match.test(raw)) return alias;
      }
      return null;
    };

    expect(matchModel("gemini-4-argon-high")).toBe("gemini-4-argon-high");
    expect(matchModel("argon-high")).toBe("gemini-4-argon-high");
    expect(matchModel("gemini-4-argon-low")).toBe("gemini-4-argon-low");
    expect(matchModel("argon-low")).toBe("gemini-4-argon-low");
    expect(matchModel("gemini-4-argon-medium")).toBe("gemini-4-argon-medium");
    expect(matchModel("argon")).toBe("gemini-4-argon-medium");
  });
});
