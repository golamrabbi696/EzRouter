import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

// Regression guard for #4795.
//
// Qoder exposes opaque internal ids (dfmodel, kmodel, …), so its capabilities
// live in a hand-written PROVIDER_CAPABILITIES table. That table was dropped
// while refactoring capabilities (5c217d3) but the qoder-cn alias added right
// after it (402745dc) kept referencing it, so PROVIDER_CAPABILITIES["qoder"]
// resolved to undefined for every request:
//   • /v1/models published vision:false for all qd/* models, and
//   • the chat pipeline replaced image parts with
//     "[image omitted: model has no vision support]" before they reached the
//     executor, even though Qoder accepts images (the executor uploads inlined
//     images to /api/v2/image/upload).
// Vision was verified live 2026-10-13 (image in, random code read back) for
// every id below, including the four the old is_vl flag called text-only.
const VISION_IDS = [
  "ultimate",
  "performance",
  "dmodel",
  "dfmodel",
  "gmodel",
  "gfmodel",
  "mmodel",
  "kmodel",
  "kmodel_latest",
  "qmodel",
  "qmodel_latest",
  "qmodel_38max",
  "qfmodel",
];

describe("qoder capabilities", () => {
  it("publishes vision for every concrete Qoder model", () => {
    for (const id of VISION_IDS) {
      expect(getCapabilitiesForModel("qoder", id).vision, id).toBe(true);
    }
  });

  it("serves the same table through the qoder-cn alias", () => {
    for (const id of VISION_IDS) {
      expect(getCapabilitiesForModel("qoder-cn", id), id).toMatchObject(getCapabilitiesForModel("qoder", id));
    }
  });

  it("keeps the thinking/limit metadata that opaque ids cannot infer", () => {
    expect(getCapabilitiesForModel("qoder", "dfmodel")).toMatchObject({
      vision: true,
      reasoning: true,
      thinkingFormat: "deepseek",
      contextWindow: 1000000,
      maxOutput: 65536,
    });
    expect(getCapabilitiesForModel("qoder", "kmodel").contextWindow).toBe(256000);
  });

  it("leaves the tier aliases on the text-only default (lite rejects image parts)", () => {
    for (const id of ["auto", "efficient", "lite"]) {
      expect(getCapabilitiesForModel("qoder", id).vision, id).toBe(false);
    }
  });
});
