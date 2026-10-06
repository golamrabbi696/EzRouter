import { describe, expect, it, vi } from "vitest";
import { setCatalogSource } from "../../open-sse/providers/capabilities.js";

const db = {
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
  getSettings: vi.fn(async () => ({ requireApiKey: false })),
  getApiKeyByValue: vi.fn(async () => null),
};

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { GET } = await import("../../src/app/api/v1/models/route.js");

describe("GET /v1/models dual-envelope for Codex", () => {
  it("returns validated Codex model records with context and compaction limits", async () => {
    db.getProviderConnections.mockResolvedValue([
      {
        id: 1,
        provider: "openai",
        isActive: true,
        providerSpecificData: { enabledModels: ["test-model-1m"] },
      },
    ]);
    setCatalogSource({
      getModalities: () => null,
      getLimits: (provider, model) =>
        provider === "openai" && model === "test-model-1m"
          ? { contextWindow: 1048576, maxOutput: 64000 }
          : null,
    });

    try {
      const response = await GET(new Request("http://localhost:20126/v1/models"));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.object).toBe("list");
      expect(Array.isArray(body.data)).toBe(true);
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models.length).toBeGreaterThan(0);

      // Verify prefixed entry (openai/test-model-1m)
      const prefixed = body.models.find((m) => m.slug === "openai/test-model-1m");
      expect(prefixed).toBeDefined();
      expect(prefixed.context_window).toBe(1048576);
      expect(prefixed.max_context_window).toBe(1048576);
      expect(prefixed.auto_compact_token_limit).toBe(786432); // exactly 75%
      expect(prefixed.shell_type).toBe("unified_exec");
      expect(prefixed.support_verbosity).toBe(true);
      expect(Array.isArray(prefixed.supported_reasoning_levels)).toBe(true);
      expect(prefixed.truncation_policy).toEqual({ mode: "tokens", limit: 10000 });
      expect(Array.isArray(prefixed.experimental_supported_tools)).toBe(true);
      expect(typeof prefixed.base_instructions).toBe("string");
      expect(prefixed.base_instructions.length).toBeGreaterThan(0);
      expect(prefixed.model_messages?.instructions_template).toBe("You are Codex, a coding agent.");

      // Verify unprefixed entry (test-model-1m)
      const unprefixed = body.models.find((m) => m.slug === "test-model-1m");
      expect(unprefixed).toBeDefined();
      expect(unprefixed.context_window).toBe(1048576);
      expect(unprefixed.max_context_window).toBe(1048576);
      expect(unprefixed.auto_compact_token_limit).toBe(786432);
      expect(unprefixed.shell_type).toBe("unified_exec");
    } finally {
      setCatalogSource(null);
    }
  });
});
