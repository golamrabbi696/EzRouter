import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseProviderResetMs, resolveCooldownMs, getQuotaCooldown } from "../../open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "../../open-sse/config/errorConfig.js";
import { _reset as resetRpmLimiter } from "../../src/sse/services/rpmLimiter.js";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
  getSettings: vi.fn(),
  getProxyPools: vi.fn(),
  resolveConnectionProxyConfig: vi.fn(),
  pickProxyPoolId: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  validateApiKey: mocks.validateApiKey,
  updateProviderConnection: mocks.updateProviderConnection,
  getSettings: mocks.getSettings,
  getProxyPools: mocks.getProxyPools,
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: mocks.resolveConnectionProxyConfig,
  pickProxyPoolId: mocks.pickProxyPoolId,
}));

vi.mock("@/shared/constants/providers.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    resolveProviderId: (p) => p,
  };
});

vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { getProviderCredentials, markAccountUnavailable } = await import("../../src/sse/services/auth.js");

function createConn(id, priority = 1, provider = "nvidia") {
  return {
    id,
    provider,
    email: `${id}@example.com`,
    priority,
    isActive: true,
    apiKey: `${id}-key`,
    accessToken: `${id}-token`,
    providerSpecificData: {},
  };
}

describe("parseProviderResetMs", () => {
  it("parses Google/Antigravity retryDelay (relative seconds)", () => {
    const body = JSON.stringify({
      error: { details: [{ retryDelay: "1976.365s" }] }
    });
    expect(parseProviderResetMs(body)).toBe(1976365);
  });

  it("parses OpenAI/Codex resets_at (epoch seconds)", () => {
    const now = 1786211647000;
    const resetsAtSec = Math.floor((now + 45000) / 1000);
    const body = JSON.stringify({ error: { resets_at: resetsAtSec } });
    expect(parseProviderResetMs(body, now)).toBe(resetsAtSec * 1000 - now);
  });

  it("parses OpenRouter X-RateLimit-Reset (epoch ms)", () => {
    const now = 1786211647000;
    const body = JSON.stringify({ "X-RateLimit-Reset": now + 60000 });
    expect(parseProviderResetMs(body, now)).toBe(60000);
  });

  it("parses Retry-After header format", () => {
    const body = "Error 429: Retry-After: 45";
    expect(parseProviderResetMs(body)).toBe(45000);
  });

  it("returns null for non-reset errors", () => {
    expect(parseProviderResetMs("Invalid API key")).toBeNull();
    expect(parseProviderResetMs(null)).toBeNull();
  });
});

describe("resolveCooldownMs", () => {
  it("floors cooldown at static backoff", () => {
    const staticCooldown = getQuotaCooldown(3);
    const fastReset = JSON.stringify({ retryDelay: "0.5s" }); // 500ms
    const resolved = resolveCooldownMs(3, fastReset);
    expect(resolved).toBe(staticCooldown);
  });

  it("uses provider reset when larger than static backoff", () => {
    const resetBody = JSON.stringify({ retryDelay: "120s" }); // 120s > static level 1 (2s)
    const resolved = resolveCooldownMs(1, resetBody);
    expect(resolved).toBe(120000);
  });

  it("caps provider reset at MAX_RATE_LIMIT_COOLDOWN_MS", () => {
    const hugeReset = JSON.stringify({ retryDelay: "999999999s" });
    const resolved = resolveCooldownMs(1, hugeReset);
    expect(resolved).toBe(MAX_RATE_LIMIT_COOLDOWN_MS);
  });
});

describe("per-provider retryDelayByProvider and free-tier cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRpmLimiter();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: null,
      vercelRelayUrl: "",
    });
  });

  it("uses configured numeric retryDelay when provider reports no reset", async () => {
    mocks.getSettings.mockResolvedValue({
      retryDelayByProvider: { custom_prov: 120 }
    });
    mocks.getProviderConnections.mockResolvedValue([createConn("conn1", 1, "custom_prov")]);

    const res = await markAccountUnavailable("conn1", 429, "Rate limit exceeded", "custom_prov", "gpt-4");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(120000);
  });

  it("caps free-tier static fallback cooldown at 60s on auto", async () => {
    mocks.getSettings.mockResolvedValue({
      retryDelayByProvider: {}
    });
    mocks.getProviderConnections.mockResolvedValue([createConn("conn1", 1, "nvidia")]);

    // High backoff level (level 10 -> would normally be max 30m, but nvidia is freeTier -> capped at 60s)
    const conn = { ...createConn("conn1", 1, "nvidia"), backoffLevel: 10 };
    mocks.getProviderConnections.mockResolvedValue([conn]);

    const res = await markAccountUnavailable("conn1", 429, "Rate limit exceeded", "nvidia", "meta/llama-3");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(60000);
  });

  it("does not override provider-reported reset even if retryDelay is set", async () => {
    mocks.getSettings.mockResolvedValue({
      retryDelayByProvider: { custom_prov: 30 }
    });
    mocks.getProviderConnections.mockResolvedValue([createConn("conn1", 1, "custom_prov")]);

    const bodyWithReset = JSON.stringify({ retryDelay: "180s" });
    const res = await markAccountUnavailable("conn1", 429, bodyWithReset, "custom_prov", "gpt-4");
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBe(180000);
  });
});

describe("per-account RPM limiter in auth.js", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRpmLimiter();
    mocks.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",
      proxyPoolId: null,
      vercelRelayUrl: "",
    });
  });

  it("rotates to next account when first account reaches its RPM limit", async () => {
    const connA = createConn("connA", 1, "nvidia");
    const connB = createConn("connB", 2, "nvidia");
    mocks.getProviderConnections.mockResolvedValue([connA, connB]);
    mocks.getSettings.mockResolvedValue({
      rpmByProvider: { nvidia: 2 },
      fallbackStrategy: "fill-first",
    });

    // Request 1 -> connA
    const req1 = await getProviderCredentials("nvidia", new Set(), "meta/llama-3");
    expect(req1.connectionId).toBe("connA");

    // Request 2 -> connA (connA has now reached 2 RPM)
    const req2 = await getProviderCredentials("nvidia", new Set(), "meta/llama-3");
    expect(req2.connectionId).toBe("connA");

    // Request 3 -> connA is capped (2/2), rotates to connB!
    const req3 = await getProviderCredentials("nvidia", new Set(), "meta/llama-3");
    expect(req3.connectionId).toBe("connB");
  });

  it("returns allRateLimited when all accounts reach their RPM cap", async () => {
    const connA = createConn("connA", 1, "nvidia");
    mocks.getProviderConnections.mockResolvedValue([connA]);
    mocks.getSettings.mockResolvedValue({
      rpmByProvider: { nvidia: 1 },
      fallbackStrategy: "fill-first",
    });

    // Request 1 -> connA (1/1 reached)
    const req1 = await getProviderCredentials("nvidia", new Set(), "meta/llama-3");
    expect(req1.connectionId).toBe("connA");

    // Request 2 -> all accounts capped!
    const req2 = await getProviderCredentials("nvidia", new Set(), "meta/llama-3");
    expect(req2.allRateLimited).toBe(true);
    expect(req2.lastError).toContain("Local 1 RPM cap reached for every nvidia account");
    expect(req2.retryAfter).toBeDefined();
  });
});
