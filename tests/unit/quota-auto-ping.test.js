import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open-sse/index.js", () => ({}), { virtual: true });

vi.mock("@/lib/localDb", () => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: vi.fn(),
}));

vi.mock("@/shared/constants/config", () => ({
  QUOTA_AUTOPING_CONFIG: {
    tickIntervalMs: 60000,
    pingLeadMs: 5000,
    refreshAheadMs: 300000,
    failureCooldownMs: 900000,
    catchUpWindowMs: 1800000,
    providers: {
      claude: {
        settingsKey: "claudeAutoPing",
        quotaKey: "session (5h)",
        pingInactiveSession: true,
        inactiveMinPingIntervalMs: 18000000,
        pingModel: "claude-haiku-4-5-20251001",
        pingText: "hi",
        pingMaxTokens: 1,
      },
      codex: {
        settingsKey: "codexAutoPing",
        quotaKey: "session",
        pingWhenResetAtSlides: true,
        resetAtDriftMs: 30000,
        minPingIntervalMs: 600000,
        skipWhenBlockingQuotaExhausted: true,
        pingText: "hi",
        pingInstructions: "Reply with OK.",
        pingReasoningEffort: "none",
      },
    },
  },
}));

vi.mock("open-sse/providers/shared.js", () => ({
  CLAUDE_CLI_SPOOF_HEADERS: { "anthropic-version": "2023-06-01" },
}));

vi.mock("open-sse/services/usage/shared.js", () => ({
  U: () => ({ baseUrl: "https://chatgpt.com/backend-api/codex/responses" }),
}));

vi.mock("open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/services/usage/claude.js", () => ({
  getClaudeUsage: vi.fn(),
}));

vi.mock("open-sse/services/usage/codex.js", () => ({
  getCodexUsage: vi.fn(),
  getCodexModels: vi.fn(),
}));

vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(),
}));

describe("quota auto-ping", () => {
  let runQuotaAutoPingTick;
  let configureQuotaAutoPing;
  let pingAccountNow;
  let deps;
  let state;
  let getCodexUsage;
  let getCodexModels;
  let getClaudeUsage;
  let getExecutor;
  let codexResponseText;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    delete global.__quotaAutoPing;

    ({ getCodexUsage } = await import("open-sse/services/usage/codex.js"));
    ({ getCodexModels } = await import("open-sse/services/usage/codex.js"));
    ({ getClaudeUsage } = await import("open-sse/services/usage/claude.js"));
    ({ getExecutor } = await import("open-sse/executors/index.js"));
    ({ runQuotaAutoPingTick, configureQuotaAutoPing, pingAccountNow } = await import("../../src/shared/services/quotaAutoPing.js"));

    deps = {
      getSettings: vi.fn(),
      getProviderConnections: vi.fn(),
      updateProviderConnection: vi.fn(),
      resolveConnectionProxyConfig: vi.fn().mockResolvedValue({}),
      refreshAndUpdateCredentials: vi.fn(async (connection) => ({ connection: { accessToken: "test-token", ...connection }, refreshed: false })),
      proxyAwareFetch: vi.fn().mockResolvedValue({ ok: true }),
      getExecutor: vi.fn(() => ({
        execute: vi.fn().mockResolvedValue({ response: { ok: true, text: codexResponseText } }),
      })),
    };
    codexResponseText = vi.fn().mockResolvedValue("");
    getExecutor.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ response: { ok: true, text: codexResponseText } }),
    });
    getCodexModels.mockResolvedValue([{ slug: "gpt-5.6-terra", priority: 1 }]);
    state = { running: false, resetCache: {}, failureCache: {}, pingedResetCache: {} };
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
  });

  it("does not ping Codex when setting is absent", async () => {
    deps.getSettings.mockResolvedValue({});

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getProviderConnections).not.toHaveBeenCalled();
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("pings immediately without a prior reset observation or auto-ping opt-in", async () => {
    const connection = { id: "manual", provider: "codex", authType: "oauth", isActive: true };
    deps.getProviderConnections.mockResolvedValue([connection]);
    getCodexUsage.mockResolvedValue({ quotas: { session: { used: 0, total: 100, resetAt: "2026-01-01T17:00:00Z" } } });
    codexResponseText.mockResolvedValue('data: {"type":"response.completed","response":{"status":"completed"}}\n\n');
    const result = await pingAccountNow("manual", {}, deps, state);
    expect(result.status).toBe("succeeded");
    expect(deps.getSettings).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("manual", expect.objectContaining({ lastPingAt: expect.any(String) }));
  });

  it("does not report HTTP 200 with an SSE error as a successful manual ping", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "manual", provider: "codex", authType: "oauth", isActive: true }]);
    getCodexUsage.mockResolvedValue({ quotas: { session: { used: 0, total: 100 } } });
    codexResponseText.mockResolvedValue('data: {"type":"error","message":"private upstream detail"}\n\n');
    expect((await pingAccountNow("manual", {}, deps, state)).status).toBe("failed");
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("keeps blocking quota checks on manual ping", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "manual", provider: "codex", authType: "oauth", isActive: true }]);
    getCodexUsage.mockResolvedValue({ quotas: { session: { used: 0, total: 100 }, weekly: { remaining: 0 } } });
    expect((await pingAccountNow("manual", {}, deps, state)).status).toBe("skipped");
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("does not ping unsupported or inactive accounts", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "manual", provider: "codex", authType: "oauth", isActive: false }]);
    expect((await pingAccountNow("manual", {}, deps, state)).status).toBe("skipped");
    expect(getCodexUsage).not.toHaveBeenCalled();
  });

  it("rejects overlapping manual pings for the same account", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "manual", provider: "codex", authType: "oauth", isActive: true }]);
    state.inFlight = new Set(["manual"]);
    expect((await pingAccountNow("manual", {}, deps, state)).message).toContain("already");
    expect(getCodexUsage).not.toHaveBeenCalled();
  });

  it("does not treat a truncated successful stream as completed", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "manual", provider: "codex", authType: "oauth", isActive: true }]);
    getCodexUsage.mockResolvedValue({ quotas: { session: { remaining: 100 } } });
    codexResponseText.mockResolvedValue('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');
    expect((await pingAccountNow("manual", {}, deps, state)).status).toBe("failed");
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("supports an explicit Claude ping and preserves proxy configuration", async () => {
    deps.getProviderConnections.mockResolvedValue([{ id: "manual", provider: "claude", authType: "oauth", isActive: true, accessToken: "token" }]);
    getClaudeUsage.mockResolvedValue({ quotas: { "session (5h)": { remaining: 100 } } });
    deps.resolveConnectionProxyConfig.mockResolvedValue({ connectionProxyEnabled: true, connectionProxyUrl: "http://proxy.test:8080" });
    deps.proxyAwareFetch.mockResolvedValue({ ok: true, json: async () => ({ type: "message" }) });
    expect((await pingAccountNow("manual", {}, deps, state)).status).toBe("succeeded");
    expect(deps.proxyAwareFetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: expect.any(AbortSignal) }), expect.objectContaining({ connectionProxyUrl: "http://proxy.test:8080" }));
  });

  it("starts the scheduler only when an account opts in", () => {
    vi.useRealTimers();
    vi.useFakeTimers();

    configureQuotaAutoPing({ codexAutoPing: { connections: {} } });
    expect(vi.getTimerCount()).toBe(0);

    configureQuotaAutoPing({ codexAutoPing: { connections: { "codex-1": true } } });
    expect(vi.getTimerCount()).toBe(1);
  });

  it("stops the scheduler when the last account opts out", () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    configureQuotaAutoPing({ claudeAutoPing: { connections: { "claude-1": true } } });

    configureQuotaAutoPing({ claudeAutoPing: { connections: { "claude-1": false } } });

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not ping Codex on the first resetAt observation", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, resetAt: "2026-01-01T13:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T13:00:00.000Z");
  });

  it("passes Codex account data and proxy options separately when reading usage", async () => {
    const providerSpecificData = { chatgptAccountId: "ws-1" };
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", idToken: "id-token", providerSpecificData }]
        : []
    ));
    deps.resolveConnectionProxyConfig.mockResolvedValue({
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
    });
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, resetAt: "2026-01-01T13:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(getCodexUsage).toHaveBeenCalledWith("token", providerSpecificData, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://proxy.example:8080",
      connectionNoProxy: "",
      vercelRelayUrl: "",
      strictProxy: false,
    }, "id-token");
  });

  it("sends Codex ping when session resetAt slides", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      lastPingedResetKey: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("does not ping Codex when resetAt is stable", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not repeat Codex ping inside the minimum ping interval", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", lastPingAt: "2026-01-01T11:55:00.000Z" }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex just because reported usage is zero", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 0, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not ping Codex when weekly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" },
        weekly: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-03T12:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex when monthly quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: {
        session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" },
        monthly: { used: 100, total: 100, remaining: 0, resetAt: "2026-02-01T00:00:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping Codex when session quota is exhausted", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-01-01T17:01:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("uses the account's preferred supported Codex model", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", idToken: "id-token", providerSpecificData: { workspaceId: "ws-1" } }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });
    getCodexModels.mockResolvedValue([
      { slug: "gpt-5.6-terra", priority: 1 },
      { slug: "gpt-5.6-luna", priority: 10 },
    ]);

    await runQuotaAutoPingTick(deps, state);

    const executor = deps.getExecutor.mock.results[0].value;
    expect(deps.getExecutor).toHaveBeenCalledWith("codex");
    expect(getCodexModels).toHaveBeenCalledWith("token", expect.objectContaining({
      connectionProxyEnabled: false,
      strictProxy: false,
    }), { workspaceId: "ws-1" });
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-5.6-terra",
      stream: true,
      credentials: expect.objectContaining({
        accessToken: "token",
        connectionId: "codex-1",
        idToken: "id-token",
        providerSpecificData: { workspaceId: "ws-1" },
      }),
      body: {
        model: "gpt-5.6-terra",
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        }],
        instructions: "Reply with OK.",
        reasoning: { effort: "none", summary: "auto" },
        store: false,
        stream: true,
      },
    }));
    expect(codexResponseText).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:01:00.000Z",
      lastPingedResetKey: "2026-01-01T17:01:00.000Z",
    }));
  });

  it("does not ping Codex when the live model catalog is empty", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-01-01T17:01:00.000Z" } },
    });
    getCodexModels.mockResolvedValue([]);

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not ping same Codex reset twice when seconds drift", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex"
        ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", lastPingedResetAt: "2026-01-01T11:59:44.000Z" }]
        : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T11:59:44.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { used: 0, total: 100, remaining: 100, resetAt: "2026-01-01T11:59:47.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("skips non-OAuth Codex connections", async () => {
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "apikey", accessToken: "token" }] : []
    ));

    await runQuotaAutoPingTick(deps, state);

    expect(getCodexUsage).not.toHaveBeenCalled();
    expect(deps.getExecutor).not.toHaveBeenCalled();
  });

  it("keeps Claude session quota key behavior", async () => {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
    ));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { resetAt: "2026-01-01T11:59:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(deps.proxyAwareFetch.mock.calls[0][1].body)).toMatchObject({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  });

  function enableClaudeAutoPing(connection = {}) {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    const conn = { id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token", ...connection };
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude" ? [conn] : []
    ));
    deps.updateProviderConnection.mockImplementation(async (_id, patch) => Object.assign(conn, patch));
    return conn;
  }

  it("catches a Claude reset that rolls forward between scheduler ticks", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T11:59:30.000Z"));
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T12:00:00.000Z",
      lastPingedResetKey: "2026-01-01T12:00:00.000Z",
    }));

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("does not infer a missed Claude reset from the first future observation", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not catch up a Claude reset before the previously observed window expires", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T11:59:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("retries a failed Claude rollover ping after the failure cooldown", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.proxyAwareFetch.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:05:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T12:15:31.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T12:00:00.000Z",
      lastPingedResetKey: "2026-01-01T12:00:00.000Z",
    }));
  });

  it("keeps an exhausted Claude rollover pending until quota is available", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 0, resetAt: "2026-01-01T17:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T12:00:00.000Z",
    }));
  });

  it("catches consecutive Claude rollovers without marking the next reset as pinged", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T22:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    vi.setSystemTime(new Date("2026-01-01T17:00:30.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(deps.updateProviderConnection).toHaveBeenLastCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T17:00:00.000Z",
      lastPingedResetKey: "2026-01-01T17:00:00.000Z",
    }));
  });

  it("does not repeat a Claude ping when an already pinged reset rolls forward", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("does not catch up a Claude reset when the cached timestamp is invalid", async () => {
    enableClaudeAutoPing();
    state.resetCache["claude:claude-1"] = "invalid";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("stops retrying a failed Claude rollover after the catch-up window expires", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.proxyAwareFetch.mockResolvedValue({ ok: false });

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date("2026-01-01T12:30:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-01T12:31:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(getClaudeUsage).toHaveBeenCalledTimes(3);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("does not catch up a stale Claude reset after an idle gap", async () => {
    enableClaudeAutoPing();
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: null } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 99, resetAt: "2026-01-01T19:00:00.000Z" } },
    });

    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T14:00:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T19:00:00.000Z");
  });

  it("does not treat a small Claude reset timestamp change as a rollover", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:01:30.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();

    vi.setSystemTime(new Date("2026-01-01T12:01:30.000Z"));
    await runQuotaAutoPingTick(deps, state);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("does not repeat a successful Claude catch-up when persisting its marker fails", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T12:00:30.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.updateProviderConnection.mockRejectedValueOnce(new Error("write failed"));

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:30.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("preserves Codex drift detection after a failed ping", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    deps.getSettings.mockResolvedValue({ codexAutoPing: { connections: { "codex-1": true } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "codex" ? [{ id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token" }] : []
    ));
    state.resetCache["codex:codex-1"] = "2026-01-01T17:00:00.000Z";
    getCodexUsage.mockResolvedValue({
      quotas: { session: { remaining: 100, resetAt: "2026-01-01T17:01:00.000Z" } },
    });
    deps.getExecutor.mockReturnValue({
      execute: vi.fn().mockResolvedValue({ response: { ok: false } }),
    });

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.getExecutor).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
    expect(state.resetCache["codex:codex-1"]).toBe("2026-01-01T17:01:00.000Z");
  });

  it("does not repeat a direct Claude ping after its marker fails to persist and reset rolls forward", async () => {
    enableClaudeAutoPing();
    // A scheduler created before a hot reload has no successful-ping cache yet.
    delete state.pingedResetCache;
    getClaudeUsage.mockResolvedValueOnce({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T12:00:00.000Z" } },
    }).mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });
    deps.updateProviderConnection.mockRejectedValueOnce(new Error("write failed"));

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:15:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledTimes(1);
    expect(state.resetCache["claude:claude-1"]).toBe("2026-01-01T17:00:00.000Z");
  });

  it("uses the existing lead tolerance when catching up a Claude reset", async () => {
    enableClaudeAutoPing();
    vi.setSystemTime(new Date("2026-01-01T11:59:57.000Z"));
    state.resetCache["claude:claude-1"] = "2026-01-01T12:00:00.000Z";
    getClaudeUsage.mockResolvedValue({
      quotas: { "session (5h)": { remaining: 100, resetAt: "2026-01-01T17:00:00.000Z" } },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T12:00:00.000Z",
    }));
  });

  const availableSession = { used: 0, total: 100, remaining: 100, resetAt: null };
  const availableWeekly = { used: 0, total: 100, remaining: 100, resetAt: null };
  const defaultInactiveQuotas = {
    "session (5h)": availableSession,
    "weekly Fable (7d)": availableWeekly,
  };

  function arrangeInactiveClaude({ enabled = true, connection = {}, quotas = defaultInactiveQuotas, proxyConfig } = {}) {
    deps.getSettings.mockResolvedValue({ claudeAutoPing: { connections: { "claude-1": enabled } } });
    deps.getProviderConnections.mockImplementation(async ({ provider }) => (
      provider === "claude"
        ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token", ...connection }]
        : []
    ));
    if (proxyConfig) deps.resolveConnectionProxyConfig.mockResolvedValue(proxyConfig);
    getClaudeUsage.mockResolvedValue({ quotas });
  }

  it("starts an inactive Claude session and drains the response before persistence", async () => {
    const order = [];
    const responseText = vi.fn(async () => { order.push("drain"); return ""; });
    deps.proxyAwareFetch.mockResolvedValue({ ok: true, text: responseText });
    deps.updateProviderConnection.mockImplementation(async () => { order.push("db"); });
    arrangeInactiveClaude();

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(responseText).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["drain", "db"]);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingAt: "2026-01-01T12:00:00.000Z",
    }));
    const update = deps.updateProviderConnection.mock.calls[0][1];
    expect(update).not.toHaveProperty("lastPingedResetAt");
    expect(update).not.toHaveProperty("lastPingedResetKey");
  });

  it.each([
    ["weekly row is absent", { "session (5h)": availableSession }],
    ["session row is absent", { "weekly Fable (7d)": availableWeekly }],
    ["weekly quota is exhausted", {
      "session (5h)": availableSession,
      "weekly Fable (7d)": { used: 100, total: 100, remaining: 0, resetAt: null },
    }],
    ["session-named weekly quota is exhausted", {
      "session (5h)": availableSession,
      "weekly session Fable (7d)": { used: 100, total: 100, remaining: 0, resetAt: null },
    }],
    ["session quota is exhausted", {
      "session (5h)": { used: 100, total: 100, remaining: 0, resetAt: null },
      "weekly Fable (7d)": availableWeekly,
    }],
    ["another blocking quota is exhausted", {
      ...defaultInactiveQuotas,
      "monthly (30d)": { used: 100, total: 100, remaining: 0, resetAt: null },
    }],
  ])("does not start an inactive Claude session when %s", async (_case, quotas) => {
    arrangeInactiveClaude({ quotas });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("does not repeat an inactive Claude ping inside five hours", async () => {
    arrangeInactiveClaude({ connection: { lastPingAt: "2026-01-01T11:00:00.000Z" } });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("does not apply the inactive five-hour guard to an active reset ping", async () => {
    arrangeInactiveClaude({
      connection: { lastPingAt: "2026-01-01T11:00:00.000Z" },
      quotas: {
        "session (5h)": { ...availableSession, resetAt: "2026-01-01T11:59:00.000Z" },
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
      lastPingedResetAt: "2026-01-01T11:59:00.000Z",
      lastPingedResetKey: "2026-01-01T11:59:00.000Z",
    }));
  });

  it("does not start an inactive Claude session when the selected proxy is unavailable", async () => {
    arrangeInactiveClaude({
      connection: { providerSpecificData: { proxyPoolId: "pool-1" } },
      proxyConfig: { source: "none", proxyPoolId: "pool-1", proxyPool: null },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("starts an inactive Claude session through an available selected proxy", async () => {
    arrangeInactiveClaude({
      connection: { providerSpecificData: { proxyPoolId: "pool-1" } },
      proxyConfig: {
        source: "pool",
        proxyPoolId: "pool-1",
        proxyPool: { id: "pool-1" },
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://proxy.test:8080",
      },
    });

    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("cancels a failed Claude response and suppresses retries during the failure cooldown", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("synthetic cancel failure"));
    deps.proxyAwareFetch.mockResolvedValue({ ok: false, body: { cancel } });
    arrangeInactiveClaude();

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("suppresses retries when draining an accepted Claude response fails", async () => {
    const responseText = vi.fn().mockRejectedValue(new Error("synthetic body failure"));
    deps.proxyAwareFetch.mockResolvedValue({ ok: true, text: responseText });
    arrangeInactiveClaude();

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:01:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(responseText).toHaveBeenCalledTimes(1);
    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(deps.updateProviderConnection).not.toHaveBeenCalled();
  });

  it("deduplicates an accepted inactive Claude ping when DB persistence fails", async () => {
    deps.updateProviderConnection
      .mockRejectedValueOnce(new Error("synthetic DB failure"))
      .mockResolvedValueOnce(undefined);
    arrangeInactiveClaude();

    await runQuotaAutoPingTick(deps, state);
    vi.setSystemTime(new Date("2026-01-01T12:16:00.000Z"));
    await runQuotaAutoPingTick(deps, state);

    expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps inactive Claude auto-ping opt-in per connection", async () => {
    arrangeInactiveClaude({ enabled: false });

    await runQuotaAutoPingTick(deps, state);

    expect(getClaudeUsage).not.toHaveBeenCalled();
    expect(deps.proxyAwareFetch).not.toHaveBeenCalled();
  });

  describe("anchored schedule", () => {
    const schedule = {
      enabled: true,
      anchor: "09:30",
      timezone: "America/Sao_Paulo",
      windowHours: 5,
      slotsPerDay: 3,
    };

    const codexConnection = (extra = {}) => ({
      id: "codex-1", provider: "codex", authType: "oauth", accessToken: "token", ...extra,
    });

    const settingsWithSchedule = (overrides = {}) => ({
      codexAutoPing: {
        connections: { "codex-1": true },
        schedules: { "codex-1": { ...schedule, ...overrides } },
      },
    });

    let connection = codexConnection();

    beforeEach(() => {
      connection = codexConnection();
      deps.getProviderConnections.mockImplementation(async ({ provider }) => (
        provider === "codex" ? [connection] : []
      ));
    });

    it("pings on the 09:30 BRT slot even when resetAt is stable", async () => {
      // 12:31 UTC = 09:31 BRT — the reactive path alone would stay quiet here.
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
        lastPingedSlotKey: "2026-08-20#0",
      }));
    });

    it("does not repeat a slot that was already pinged", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      connection = codexConnection({ lastPingedSlotKey: "2026-08-20#0" });
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("stays quiet overnight", async () => {
      // 06:00 UTC = 03:00 BRT, outside every slot.
      vi.setSystemTime(new Date("2026-08-20T06:00:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("keeps the reactive ping working alongside the schedule", async () => {
      vi.setSystemTime(new Date("2026-08-20T06:00:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:01:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.not.objectContaining({
        lastPingedSlotKey: expect.anything(),
      }));
    });

    it("ignores a disabled schedule", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule({ enabled: false }));
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("pings Claude on a slot before its reset is due", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue({
        claudeAutoPing: {
          connections: { "claude-1": true },
          schedules: { "claude-1": schedule },
        },
      });
      deps.getProviderConnections.mockImplementation(async ({ provider }) => (
        provider === "claude" ? [{ id: "claude-1", provider: "claude", authType: "oauth", accessToken: "token" }] : []
      ));
      state.resetCache["claude:claude-1"] = "2026-08-20T23:00:00.000Z";
      getClaudeUsage.mockResolvedValue({
        quotas: { "session (5h)": { resetAt: "2026-08-20T23:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.proxyAwareFetch).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("claude-1", expect.objectContaining({
        lastPingedSlotKey: "2026-08-20#0",
      }));
    });

    it("runs a schedule on a connection with the reactive ping switched off", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue({
        codexAutoPing: {
          connections: { "codex-1": false },
          schedules: { "codex-1": schedule },
        },
      });
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).toHaveBeenCalledTimes(1);
      expect(deps.updateProviderConnection).toHaveBeenCalledWith("codex-1", expect.objectContaining({
        lastPingedSlotKey: "2026-08-20#0",
      }));
    });

    it("does not fall back to the reactive ping when only the schedule is on", async () => {
      // resetAt slides, which is exactly what the reactive Codex path pings on.
      vi.setSystemTime(new Date("2026-08-20T06:00:00.000Z"));
      deps.getSettings.mockResolvedValue({
        codexAutoPing: {
          connections: { "codex-1": false },
          schedules: { "codex-1": schedule },
        },
      });
      state.resetCache["codex:codex-1"] = "2026-08-20T20:00:00.000Z";
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 1, total: 100, remaining: 99, resetAt: "2026-08-20T20:01:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });

    it("needs the scheduler running for a schedule alone", async () => {
      const { hasAnyAutoPingEnabled } = await import("../../src/shared/services/quotaAutoPing.js");

      expect(hasAnyAutoPingEnabled({ codexAutoPing: { connections: { "codex-1": false } } })).toBe(false);
      expect(hasAnyAutoPingEnabled({
        codexAutoPing: { connections: { "codex-1": false }, schedules: { "codex-1": schedule } },
      })).toBe(true);
      expect(hasAnyAutoPingEnabled({
        codexAutoPing: { connections: {}, schedules: { "codex-1": { ...schedule, enabled: false } } },
      })).toBe(false);
    });

    it("skips the slot when the quota is exhausted", async () => {
      vi.setSystemTime(new Date("2026-08-20T12:31:00.000Z"));
      deps.getSettings.mockResolvedValue(settingsWithSchedule());
      getCodexUsage.mockResolvedValue({
        quotas: { session: { used: 100, total: 100, remaining: 0, resetAt: "2026-08-20T20:00:00.000Z" } },
      });

      await runQuotaAutoPingTick(deps, state);

      expect(deps.getExecutor).not.toHaveBeenCalled();
    });
  });
});
