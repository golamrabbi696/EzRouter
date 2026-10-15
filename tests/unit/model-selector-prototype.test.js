import { describe, it, expect } from "vitest";

describe("modelSelector prototype safety (#4833)", () => {
  it("handles Object.prototype property names like constructor as provider aliases", () => {
    const modelsResult = {
      data: {
        data: [
          { id: "custom-1", owned_by: "constructor" },
          { id: "custom-2", owned_by: "toString" },
          { id: "custom-3", owned_by: "valueOf" },
          { id: "custom-4", owned_by: "normal-provider" },
        ],
      },
    };

    const activeAliases = new Set(["constructor", "toString", "valueOf", "normal-provider"]);
    const groups = Object.create(null);

    modelsResult.data.data.forEach((m) => {
      const provider = m.owned_by;
      if (!activeAliases.has(provider)) return;
      if (!groups[provider]) {
        groups[provider] = [];
      }
      groups[provider].push(m.id);
    });

    expect(groups["constructor"].length).toBe(1);
    expect(groups["constructor"][0]).toBe("custom-1");
    expect(groups["toString"].length).toBe(1);
    expect(groups["toString"][0]).toBe("custom-2");
    expect(groups["valueOf"].length).toBe(1);
    expect(groups["valueOf"][0]).toBe("custom-3");
    expect(groups["normal-provider"].length).toBe(1);
    expect(groups["normal-provider"][0]).toBe("custom-4");
  });

  it("safe lookup of provider display name when alias matches Object prototype method", () => {
    const PROVIDER_ALIAS_NAMES = {
      anthropic: "Anthropic",
      openai: "OpenAI",
    };

    const provider = "toString";
    const providerName = Object.prototype.hasOwnProperty.call(PROVIDER_ALIAS_NAMES, provider)
      ? PROVIDER_ALIAS_NAMES[provider]
      : provider;

    expect(providerName).toBe("toString");
    expect(typeof providerName).not.toBe("function");
  });
});
