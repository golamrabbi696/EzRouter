import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { applyThinking, stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import gemini from "../../open-sse/providers/registry/gemini.js";
import { MODEL_PRICING } from "../../open-sse/providers/pricing.js";
import { MITM_TOOLS } from "../../src/shared/constants/cliTools.js";

const require = createRequire(import.meta.url);
const mitmConfig = require("../../src/mitm/config.js");
const here = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Gemini 3.7 MITM tools and catalog", () => {
  it("includes gemini-3.7-flash tiers in MITM_TOOLS defaultModels", () => {
    const defaultModelIds = MITM_TOOLS.antigravity.defaultModels.map((m) => m.id);
    expect(defaultModelIds).toContain("gemini-3.7-flash-high");
    expect(defaultModelIds).toContain("gemini-3.7-flash-medium");
    expect(defaultModelIds).toContain("gemini-3.7-flash-low");
  });
});
