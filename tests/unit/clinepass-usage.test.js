import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { U } from "../../open-sse/services/usage/shared.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const USAGE_URL = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";
const FIXTURE = {"data":{"limits":[{"type":"five_hour","percentUsed":0,"resetsAt":"2026-10-08T22:21:02.325900562Z"},{"type":"weekly","percentUsed":0,"resetsAt":"2026-10-15T17:21:02.327830971Z"},{"type":"monthly","percentUsed":61,"resetsAt":"2026-10-17T01:23:57.329802003Z"}]},"success":true};
const UNAUTHORIZED = "Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account.";
const getUsage = (credentials = {}) => getUsageForProvider({ provider: "clinepass", ...credentials });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

beforeEach(() => vi.resetAllMocks());

describe("ClinePass usage wiring", () => {
  it("enables both OAuth and API-key quota listings with the registry endpoint", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("clinepass");
    expect(USAGE_APIKEY_PROVIDERS).toContain("clinepass");
    expect(U("clinepass").url).toBe(USAGE_URL);
  });

  it.each([
    [{ accessToken: "eyJx.y.z" }, "Bearer workos:eyJx.y.z"],
    [{ apiKey: "clp_test" }, "Bearer clp_test"],
    [{ apiKey: "clp_test", accessToken: "eyJx.y.z" }, "Bearer clp_test"],
  ])("uses the correct authorization header for %j", async (credentials, authorization) => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(FIXTURE));
    const proxyOptions = { connectionProxyEnabled: false };
    await getUsageForProvider({ provider: "clinepass", ...credentials }, proxyOptions);
    expect(proxyAwareFetch).toHaveBeenCalledExactlyOnceWith(USAGE_URL, {
      headers: { Authorization: authorization, Accept: "application/json" },
    }, proxyOptions);
  });

  it("maps the live fixture to three percentage quotas and ISO resets", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse(FIXTURE));
    const usage = await getUsage({ apiKey: "clp_test" });
    expect(usage).toEqual({
      plan: "ClinePass",
      quotas: {
        "Session (5h)": { used: 0, total: 100, remainingPercentage: 100, resetAt: "2026-10-08T22:21:02.325Z", unlimited: false },
        "Weekly (7d)": { used: 0, total: 100, remainingPercentage: 100, resetAt: "2026-10-15T17:21:02.327Z", unlimited: false },
        "Monthly (30d)": { used: 61, total: 100, remainingPercentage: 39, resetAt: "2026-10-17T01:23:57.329Z", unlimited: false },
      },
    });
    expect(parseQuotaData("clinepass", usage)[2]).toMatchObject({
      name: "Monthly (30d)", used: 61, total: 100, remainingPercentage: 39,
    });
  });

  it("skips unknown types, including inherited object keys", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { limits: [...FIXTURE.data.limits, { type: "experimental_pool" }, { type: "toString" }, null] },
    }));
    expect(Object.keys((await getUsage({ apiKey: "clp_test" })).quotas)).toHaveLength(3);
  });

  it("returns a subscription message for data:null", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: true, data: null }));
    expect((await getUsage({ apiKey: "clp_test" })).message).toMatch(/No active ClinePass subscription/);
  });

  it.each(["Unavailable", { message: "Unavailable" }])("handles success:false with error %j", async (error) => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ success: false, error }));
    expect((await getUsage({ apiKey: "clp_test" })).message).toBe("ClinePass quota API error: Unavailable");
  });

  it("handles a 401 string error with a refresh-detectable authentication message", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: UNAUTHORIZED }, 401));
    expect((await getUsage({ accessToken: "eyJx.y.z" })).message).toBe(`ClinePass authentication failed: ${UNAUTHORIZED}`);
  });

  it("handles a 403, a 5xx with a non-JSON body, and a network failure", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ error: "Forbidden" }, 403));
    expect((await getUsage({ apiKey: "clp_test" })).message).toBe("ClinePass authentication failed: Forbidden");
    proxyAwareFetch.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 502 }));
    expect((await getUsage({ apiKey: "clp_test" })).message).toBe("ClinePass quota API error (502).");
    proxyAwareFetch.mockRejectedValueOnce(new Error("fetch failed"));
    expect((await getUsage({ apiKey: "clp_test" })).message).toBe("ClinePass error: fetch failed");
  });

  it("clamps out-of-range and non-numeric percentUsed", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      data: { limits: [{ type: "five_hour", percentUsed: 140 }, { type: "weekly", percentUsed: -5 }, { type: "monthly", percentUsed: "n/a" }] },
    }));
    const { quotas } = await getUsage({ apiKey: "clp_test" });
    expect([quotas["Session (5h)"].used, quotas["Weekly (7d)"].used, quotas["Monthly (30d)"].used]).toEqual([100, 0, 0]);
  });

  it.each([undefined, null, "", "  ", 42])("rejects missing or invalid credentials %j without fetching", async (accessToken) => {
    expect(await getUsage({ accessToken })).toEqual({
      message: "ClinePass credentials not available. Reconnect to view usage.",
    });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("preserves resetsAt:null and fractional remainingPercentage in the UI", async () => {
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({
      success: true, data: { limits: [{ type: "monthly", percentUsed: 61.25, resetsAt: null }] },
    }));
    const usage = await getUsage({ apiKey: "clp_test" });
    expect(usage.quotas["Monthly (30d)"].resetAt).toBeNull();
    expect(parseQuotaData("clinepass", usage)[0].remainingPercentage).toBe(38.75);
  });

  it("implements expiry detection and OAuth refresh in the ClinePass executor", async () => {
    const executor = getExecutor("clinepass");
    expect(executor.needsRefresh({ expiresAt: "2000-01-01T00:00:00Z" })).toBe(true);
    expect(executor.needsRefresh({ expiresAt: "2999-01-01T00:00:00Z" })).toBe(false);
    proxyAwareFetch.mockResolvedValueOnce(jsonResponse({ data: { accessToken: "eyJnew.y.z", refreshToken: "new-refresh", expiresAt: "2999-01-01T00:00:00Z" } }));
    const refreshed = await executor.refreshCredentials({ refreshToken: "test-refresh" }, null);
    expect(refreshed).toMatchObject({ accessToken: "workos:eyJnew.y.z", refreshToken: "new-refresh" });
    expect(refreshed.expiresIn).toBeGreaterThan(0);
    expect(proxyAwareFetch.mock.calls[0][0]).toBe("https://api.cline.bot/api/v1/auth/refresh");
  });
});
