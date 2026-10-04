import { describe, expect, it } from "vitest";
import { updateComboStrategy } from "../../src/shared/utils/comboStrategy.js";

describe("combo strategy override", () => {
  it("persists explicit fallback instead of inheriting global round robin", () => {
    const original = { demo: { fallbackStrategy: "round-robin", judgeModel: "cx/gpt-6-sol" } };
    const updated = updateComboStrategy(original, "demo", { fallbackStrategy: "fallback" });
    expect(updated.demo).toEqual({ fallbackStrategy: "fallback", judgeModel: "cx/gpt-6-sol" });
    expect(original.demo.fallbackStrategy).toBe("round-robin");
  });

  it("only removes the override when inherit is explicitly selected", () => {
    expect(updateComboStrategy({ demo: { fallbackStrategy: "fallback" } }, "demo", { fallbackStrategy: "inherit" })).toEqual({});
  });
});
