import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const api = require("../../cli/src/cli/api/client.js");
const input = require("../../cli/src/cli/utils/input.js");
const display = require("../../cli/src/cli/utils/display.js");
const selectorPath = require.resolve("../../cli/src/cli/utils/modelSelector.js");

beforeEach(() => {
  vi.spyOn(api, "getProviders").mockResolvedValue({ success: true, data: { connections: [] } });
  vi.spyOn(api, "getAvailableModels").mockResolvedValue({ success: true, data: { data: [] } });
  vi.spyOn(input, "prompt").mockResolvedValue("1");
  vi.spyOn(display, "clearScreen").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  delete require.cache[selectorPath];
});

afterEach(() => {
  delete require.cache[selectorPath];
  vi.restoreAllMocks();
});

function customProvider(prefix, isActive = true) {
  api.getProviders.mockResolvedValue({
    success: true,
    data: { connections: [{ provider: "openai-compatible-chat-test", isActive, providerSpecificData: { prefix } }] },
  });
  api.getAvailableModels.mockResolvedValue({
    success: true,
    data: { data: [
      { id: `${prefix}/first`, owned_by: prefix },
      { id: `${prefix}/second`, owned_by: prefix },
    ] },
  });
}

describe("TUI custom provider prefixes", () => {
  it.each(["constructor", "toString", "__proto__"])("groups models under %s", async (prefix) => {
    customProvider(prefix);
    const { groups, combos } = await require(selectorPath).getAvailableModelsGrouped();
    expect(Object.keys(groups)).toEqual([prefix]);
    expect(groups[prefix]).toEqual([`${prefix}/first`, `${prefix}/second`]);
    expect(combos).toEqual([]);
  });

  it.each(["constructor", "toString", "__proto__"])("selects a model under %s", async (prefix) => {
    customProvider(prefix);
    expect(await require(selectorPath).selectModelFromList("Choose model")).toBe(`${prefix}/first`);
    expect(console.log).toHaveBeenCalledWith(`[${prefix}]`);
  });

  it("keeps ordinary custom prefixes", async () => {
    customProvider("custom");
    const { groups } = await require(selectorPath).getAvailableModelsGrouped();
    expect(groups).toEqual({ custom: ["custom/first", "custom/second"] });
  });

  it("excludes inactive custom providers", async () => {
    customProvider("constructor", false);
    const { groups } = await require(selectorPath).getAvailableModelsGrouped();
    expect(Object.keys(groups)).toEqual([]);
  });

  it("keeps combos and credential-free providers but excludes disconnected providers", async () => {
    api.getAvailableModels.mockResolvedValue({
      success: true,
      data: { data: [
        { id: "combo-name", owned_by: "combo" },
        { id: "oc/free", owned_by: "oc" },
        { id: "openai/disconnected", owned_by: "openai" },
      ] },
    });
    const result = await require(selectorPath).getAvailableModelsGrouped();
    expect(result.combos).toEqual(["combo-name"]);
    expect(result.groups).toEqual({ oc: ["oc/free"] });
  });
});
