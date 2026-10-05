import { describe, expect, it } from "vitest";
import { parseGrokCliBilling } from "../../open-sse/services/usage/grok-cli.js";

describe("Grok zero spending cap display", () => {
  it.each([0, 25])("does not invent quota from zero cap and used=%s", (used) => {
    const { quotas } = parseGrokCliBilling({ config: { onDemandCap: 0, onDemandUsed: used } });
    expect(quotas).not.toHaveProperty("On-demand");
  });
  it("retains explicitly reported prepaid promo balance", () => {
    const { quotas } = parseGrokCliBilling({ config: { onDemandCap: 0, onDemandUsed: 0, prepaidBalance: 12 } });
    expect(quotas).not.toHaveProperty("On-demand");
    expect(quotas.Prepaid.total).toBe(12);
  });
  it("keeps genuinely exhausted positive-cap usage depleted", () => {
    const { quotas } = parseGrokCliBilling({ config: { onDemandCap: 20, onDemandUsed: 20 } });
    expect(quotas["On-demand"]).toMatchObject({ used: 20, total: 20, remainingPercentage: 0, unlimited: false });
  });
});
