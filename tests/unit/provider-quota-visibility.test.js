import { describe, expect, it } from "vitest";
import {
  filterQuotasByVisibility,
  getHiddenQuotaRows,
  parseQuotaData,
  trimHiddenQuotaKeys,
  setQuotaHidden,
} from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

describe("provider quota visibility", () => {
  const data = {
    quotas: {
      "gemini-pro-agent": {
        displayName: "Gemini 3.1 Pro (High)",
        used: 200,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 80,
      },
      "claude-opus-4-6-thinking": {
        displayName: "Claude Opus 4.6 (Thinking)",
        used: 100,
        total: 1000,
        resetAt: "2026-07-04T00:00:00Z",
        remainingPercentage: 90,
      },
    },
  };

  it("groups Antigravity model quotas into Gemini and Claude families", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(quotas.map((q) => q.modelKey)).toEqual([
      "gemini",
      "claude",
    ]);
    expect(quotas[0].name).toBe("Gemini (Flash / Pro)");
    expect(quotas[1].name).toBe("Claude (Sonnet / Opus)");
  });

  it("shows all quotas by default and hides configured provider rows", () => {
    const quotas = parseQuotaData("antigravity", data);
    expect(filterQuotasByVisibility("antigravity", quotas, {})).toHaveLength(2);

    const visibility = {
      antigravity: { hidden: ["claude"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("trims stale or obsolete model keys", () => {
    const quotas = parseQuotaData("antigravity", data);
    const trimmed = trimHiddenQuotaKeys(["claude", "stale-model-xyz", "gemini-3.8-flash-low"], quotas);
    expect(trimmed).toEqual(["claude"]);

    const visibility = {
      antigravity: { hidden: ["claude", "stale-model-xyz"] },
    };
    const visible = filterQuotasByVisibility("antigravity", quotas, visibility);
    const hidden = getHiddenQuotaRows("antigravity", quotas, visibility);

    expect(visible.map((q) => q.modelKey)).toEqual(["gemini"]);
    expect(hidden.map((q) => q.modelKey)).toEqual(["claude"]);
  });

  it("does not apply one provider hidden list to another provider", () => {
    const quotas = parseQuotaData("antigravity", data);
    const visibility = {
      codex: { hidden: ["gemini"] },
    };
    expect(filterQuotasByVisibility("antigravity", quotas, visibility)).toHaveLength(2);
  });

  it("applies hidden rows only to the selected connection", () => {
    const quotas = [{ name: "Bonus Pack 1" }, { name: "Bonus Pack 2" }];
    const visibility = {
      "codebuddy-cn": { connections: { "account-a": { hidden: ["Bonus Pack 1"] } } },
    };

    expect(filterQuotasByVisibility("codebuddy-cn", quotas, visibility, "account-a"))
      .toEqual([{ name: "Bonus Pack 2" }]);
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, visibility, "account-a"))
      .toEqual([{ name: "Bonus Pack 1" }]);
    expect(filterQuotasByVisibility("codebuddy-cn", quotas, visibility, "account-b")).toEqual(quotas);
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, visibility, "account-b")).toEqual([]);
  });

  it("preserves legacy provider preferences until an account changes them", () => {
    const quotas = [{ name: "Bonus Pack 1" }, { name: "Bonus Pack 2" }];
    const visibility = { "codebuddy-cn": { hidden: ["Bonus Pack 1"] } };
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, visibility, "account-a")).toEqual([quotas[0]]);

    const next = setQuotaHidden("codebuddy-cn", "account-a", quotas[0], visibility, false);
    const saved = JSON.parse(JSON.stringify(next));

    expect(filterQuotasByVisibility("codebuddy-cn", quotas, saved, "account-a")).toEqual(quotas);
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, saved, "account-b")).toEqual([quotas[0]]);
    expect(visibility).toEqual({ "codebuddy-cn": { hidden: ["Bonus Pack 1"] } });
  });

  it("hides and restores account rows without replacing other preferences", () => {
    const quotas = [{ name: "Bonus Pack 1" }, { name: "Bonus Pack 2" }];
    const visibility = {
      codex: { hidden: ["session"] },
      "codebuddy-cn": { connections: { "account-b": { hidden: ["Bonus Pack 2"] } } },
    };
    const next = setQuotaHidden("codebuddy-cn", "account-a", quotas[0], visibility, true);

    expect(getHiddenQuotaRows("codebuddy-cn", quotas, next, "account-a")).toEqual([quotas[0]]);
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, next, "account-b")).toEqual([quotas[1]]);
    expect(next.codex).toEqual(visibility.codex);
    expect(visibility["codebuddy-cn"].connections["account-a"]).toBeUndefined();

    const restored = setQuotaHidden("codebuddy-cn", "account-a", quotas[0], next, false);
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, restored, "account-a")).toEqual([]);
    expect(getHiddenQuotaRows("codebuddy-cn", quotas, restored, "account-b")).toEqual([quotas[1]]);
  });

  it("cleans up legacy Antigravity family keys for only the selected account", () => {
    const visibility = {
      antigravity: { hidden: ["gemini-3.8-flash", "gemini-image", "claude-opus-4-6-thinking"] },
    };
    const next = setQuotaHidden("antigravity", "account-a", { modelKey: "gemini" }, visibility, true);

    expect(next.antigravity.connections["account-a"].hidden)
      .toEqual(["gemini-image", "claude-opus-4-6-thinking", "gemini"]);
    expect(next.antigravity.hidden).toEqual(visibility.antigravity.hidden);
  });
});
