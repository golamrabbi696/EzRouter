import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const BALANCE_URL = "https://ollama.com/api/balance";
const ME_URL = "https://ollama.com/api/me";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// https://docs.ollama.com/api/balance
const SAMPLE_MONTHLY_BALANCE = {
  included: {
    balance_usd: 72.5,
    allowance_usd: 100,
    period: {
      from: "2026-09-15T09:30:00Z",
      until: "2026-10-15T09:30:00Z",
    },
  },
  purchased: {
    balance_usd: 25,
  },
};

const SAMPLE_LEGACY_BALANCE = {
  included: {
    session: {
      remaining_percent: 75,
      resets_at: "2026-10-01T07:00:00Z",
    },
    weekly: {
      remaining_percent: 40,
      resets_at: "2026-10-05T00:00:00Z",
    },
  },
  purchased: {
    balance_usd: 0,
  },
};

const SAMPLE_FREE_BALANCE = {
  included: {
    balance_usd: 0.08581,
    allowance_usd: 2.5,
    period: {
      from: "2026-09-22T14:45:33.799639Z",
      until: "2026-10-22T14:45:33.799639Z",
    },
  },
  purchased: {
    balance_usd: 0,
  },
};

async function fetchOllamaUsage(balance, me = { Plan: "free" }) {
  proxyAwareFetch
    .mockResolvedValueOnce(jsonResponse(balance))
    .mockResolvedValueOnce(jsonResponse(me));

  return getUsageForProvider({
    provider: "ollama",
    apiKey: "k",
    providerSpecificData: {},
  });
}

describe("ollama registry usage flags", () => {
  it("is listed for apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("ollama");
    expect(USAGE_APIKEY_PROVIDERS).toContain("ollama");
  });
});

describe("getUsageForProvider(ollama)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GETs /api/balance with Bearer apiKey and POSTs /api/me for plan", async () => {
    const usage = await fetchOllamaUsage(SAMPLE_MONTHLY_BALANCE, { Plan: "pro" });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Pro");
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);

    const [balanceUrl, balanceOpts] = proxyAwareFetch.mock.calls[0];
    expect(balanceUrl).toBe(BALANCE_URL);
    expect(balanceOpts.headers.Authorization).toBe("Bearer k");
    expect(balanceOpts.headers.Accept).toBe("application/json");

    const [meUrl, meOpts] = proxyAwareFetch.mock.calls[1];
    expect(meUrl).toBe(ME_URL);
    expect(meOpts.method).toBe("POST");
    expect(meOpts.headers.Authorization).toBe("Bearer k");
    expect(meOpts.headers["Content-Length"]).toBe("0");
  });

  it("maps the monthly allowance to a percent row resetting at period.until", async () => {
    const usage = await fetchOllamaUsage(SAMPLE_MONTHLY_BALANCE, { Plan: "pro" });

    expect(usage.quotas["Monthly"]).toEqual({
      used: 27,
      total: 100,
      remainingPercentage: 73,
      resetAt: "2026-10-15T09:30:00Z",
      unlimited: false,
    });
  });

  it("adds a purchased credit balance row when credits remain", async () => {
    const usage = await fetchOllamaUsage(SAMPLE_MONTHLY_BALANCE, { Plan: "pro" });

    expect(Object.keys(usage.quotas)).toEqual(["Monthly", "Purchased (USD)"]);
    expect(usage.quotas["Purchased (USD)"]).toMatchObject({
      used: 0,
      total: 25,
      resetAt: null,
      isCreditBalance: true,
      currency: "USD",
    });
  });

  it("maps the free plan allowance and omits an empty purchased balance", async () => {
    const usage = await fetchOllamaUsage(SAMPLE_FREE_BALANCE);

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Free");
    expect(Object.keys(usage.quotas)).toEqual(["Monthly"]);
    expect(usage.quotas["Monthly"]).toMatchObject({
      used: 97,
      total: 100,
      remainingPercentage: 3,
      resetAt: "2026-10-22T14:45:33.799639Z",
    });
    expect(usage.quotas["Monthly"].remaining).toBeUndefined();
  });

  it("maps legacy session and weekly windows from remaining_percent", async () => {
    const usage = await fetchOllamaUsage(SAMPLE_LEGACY_BALANCE, { Plan: "max" });

    expect(usage.plan).toBe("Max");
    expect(Object.keys(usage.quotas)).toEqual(["Session (5h)", "Weekly (7d)"]);
    expect(usage.quotas["Session (5h)"]).toEqual({
      used: 25,
      total: 100,
      remainingPercentage: 75,
      resetAt: "2026-10-01T07:00:00Z",
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toEqual({
      used: 60,
      total: 100,
      remainingPercentage: 40,
      resetAt: "2026-10-05T00:00:00Z",
      unlimited: false,
    });
  });

  it("clamps remaining_percent to 0..100", async () => {
    const usage = await fetchOllamaUsage({
      included: {
        session: { remaining_percent: 120 },
        weekly: { remaining_percent: -5 },
      },
    });

    expect(usage.quotas["Session (5h)"]).toMatchObject({ used: 0, remainingPercentage: 100, resetAt: null });
    expect(usage.quotas["Weekly (7d)"]).toMatchObject({ used: 100, remainingPercentage: 0, resetAt: null });
  });

  it("skips the monthly row when the allowance is zero", async () => {
    const usage = await fetchOllamaUsage({
      included: { balance_usd: 0, allowance_usd: 0 },
      purchased: { balance_usd: 5 },
    });

    expect(Object.keys(usage.quotas)).toEqual(["Purchased (USD)"]);
  });

  it("falls back to a generic plan label when /api/me fails", async () => {
    proxyAwareFetch
      .mockResolvedValueOnce(jsonResponse(SAMPLE_FREE_BALANCE))
      .mockRejectedValueOnce(new Error("network"));

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "k",
      providerSpecificData: {},
    });

    expect(usage.plan).toBe("Ollama Cloud");
    expect(usage.quotas["Monthly"]).toBeDefined();
  });

  it("reports no limits when the balance has no known shape", async () => {
    const usage = await fetchOllamaUsage({ included: {}, purchased: { balance_usd: 0 } });

    expect(usage.message).toMatch(/no usage limits/i);
    expect(usage.quotas).toEqual({});
  });

  it("surfaces invalid key message on 401", async () => {
    proxyAwareFetch.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401),
    );

    const usage = await getUsageForProvider({
      provider: "ollama",
      apiKey: "bad",
    });

    expect(usage.message).toMatch(/invalid/i);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("returns message when apiKey missing", async () => {
    const usage = await getUsageForProvider({
      provider: "ollama",
      providerSpecificData: {},
    });

    expect(usage.message).toMatch(/api key/i);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("handles legacy session and weekly windows from /api/balance", async () => {
    const usage = await fetchOllamaUsage({
      included: {
        session: {
          remaining_percent: 85.5,
          resets_at: "2026-10-19T18:00:00Z",
        },
        weekly: {
          remaining_percent: 92,
          resets_at: "2026-10-25T00:00:00Z",
        },
      },
    }, { Plan: "pro" });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Pro");
    expect(usage.quotas["Session (5h)"]).toEqual({
      used: 14,
      total: 100,
      remainingPercentage: 86,
      resetAt: "2026-10-19T18:00:00Z",
      unlimited: false,
    });
    expect(usage.quotas["Weekly (7d)"]).toEqual({
      used: 8,
      total: 100,
      remainingPercentage: 92,
      resetAt: "2026-10-25T00:00:00Z",
      unlimited: false,
    });
  });

  it("handles allowance and purchased credits from /api/balance", async () => {
    const usage = await fetchOllamaUsage({
      included: {
        allowance_usd: "2.50",
        balance_usd: "1.25",
        period: { until: "2026-11-01T00:00:00Z" },
      },
      purchased: {
        balance_usd: "10.00",
      },
    }, { Plan: "free" });

    expect(usage.message).toBeUndefined();
    expect(usage.plan).toBe("Free");
    expect(usage.quotas["Monthly"]).toEqual({
      used: 50,
      total: 100,
      remainingPercentage: 50,
      resetAt: "2026-11-01T00:00:00Z",
      unlimited: false,
    });
    expect(usage.quotas["Purchased (USD)"]).toEqual({
      used: 0,
      total: 10,
      isCreditBalance: true,
      currency: "USD",
      resetAt: null,
      unlimited: false,
    });
  });
});

describe("parseQuotaData(ollama)", () => {
  it("forwards remainingPercentage for dashboard bars", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Max",
      quotas: {
        "Session (5h)": {
          used: 0,
          total: 100,
          remainingPercentage: 100,
          resetAt: null,
        },
        "Weekly (7d)": {
          used: 100,
          total: 100,
          remainingPercentage: 0,
          resetAt: "2026-10-05T00:00:00Z",
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Session (5h)",
      used: 0,
      total: 100,
      remainingPercentage: 100,
    });
    expect(rows[1]).toMatchObject({
      name: "Weekly (7d)",
      used: 100,
      total: 100,
      remainingPercentage: 0,
      resetAt: "2026-10-05T00:00:00Z",
    });
  });

  it("forwards the purchased credit balance flag and currency", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Pro",
      quotas: {
        "Purchased (USD)": {
          used: 0,
          total: 25,
          resetAt: null,
          isCreditBalance: true,
          currency: "USD",
        },
      },
    });

    expect(rows[0]).toMatchObject({
      name: "Purchased (USD)",
      total: 25,
      isCreditBalance: true,
      currency: "USD",
    });
  });

  it("forwards isCreditBalance, currency, and unit for dashboard display", () => {
    const rows = parseQuotaData("ollama", {
      plan: "Free",
      quotas: {
        "Allowance ($)": {
          used: 1.25,
          total: 2.5,
          remainingPercentage: 50,
          resetAt: "2026-11-01T00:00:00Z",
          unlimited: false,
          unit: "USD",
        },
        "Purchased Credits": {
          used: 0,
          total: 10,
          remainingPercentage: 100,
          isCreditBalance: true,
          currency: "$",
        },
      },
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: "Allowance ($)",
      used: 1.25,
      total: 2.5,
      remainingPercentage: 50,
      unit: "USD",
    });
    expect(rows[1]).toMatchObject({
      name: "Purchased Credits",
      used: 0,
      total: 10,
      remainingPercentage: 100,
      isCreditBalance: true,
      currency: "$",
    });
  });
});
