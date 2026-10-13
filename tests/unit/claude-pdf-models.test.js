import { afterEach, describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => [{
    id: "test-anthropic",
    provider: "anthropic",
    isActive: true,
    providerSpecificData: { enabledModels: ["claude-sonnet-4-20250514"] },
  }]),
  getCombos: vi.fn(async () => [{
    name: "pdf-combo",
    models: ["anthropic/claude-sonnet-4-20250514"],
  }]),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

afterEach(() => setCatalogSource(null));

describe("/v1/models Claude PDF metadata", () => {
  it("publishes PDF support for the provider model and its combo without catalog sync", async () => {
    setCatalogSource(null);
    const models = await buildModelsList(["llm"]);

    for (const id of ["anthropic/claude-sonnet-4-20250514", "pdf-combo"]) {
      expect(models.find((model) => model.id === id)).toMatchObject({
        capabilities: { pdf: true, vision: true },
      });
    }
  });
});
