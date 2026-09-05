import { getProviderConnections, validateApiKey, updateProviderConnection, getSettings, getProxyPools } from "@/lib/localDb";
import { resolveConnectionProxyConfig, pickProxyPoolId } from "@/lib/network/connectionProxy";
import { formatRetryAfter, checkFallbackError, parseProviderResetMs, isModelLockActive, buildModelLockUpdate, getEarliestModelLockUntil } from "open-sse/services/accountFallback.js";
import { MAX_RATE_LIMIT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { LATENCY_AWARE_STRATEGY } from "open-sse/config/healthConfig.js";
import { selectHealthiestConnection } from "open-sse/services/healthTracker.js";
import { resolveProviderId, resolveProviderRpm, FREE_PROVIDERS, FREE_TIER_PROVIDERS } from "@/shared/constants/providers.js";
import { isOverLimit, recordRequest, retryAfterMs } from "./rpmLimiter.js";
import { evaluateQuota } from "./quotaGuard.js";
import { getAntigravityQuotaCache } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

// Mutex to prevent race conditions during account selection
let selectionMutex = Promise.resolve();

// Community/free tiers (NVIDIA NIM, opencode-free, …) rate-limit on a short,
// roughly per-minute window. The generic exponential backoff can bench a 429'd
// account for up to 5 min — and with only a handful of free accounts that locks
// the entire pool at once, so the gateway runs out of accounts and returns a 500.
// Cap the STATIC fallback cooldown for these providers to one recovery window so
// accounts come back quickly and keep rotating. Only the static backoff is
// capped: a provider that reports an explicit reset (resetsAtMs / Retry-After /
// retryDelay / X-RateLimit-Reset) still takes precedence and is never shortened.
const FREE_TIER_STATIC_COOLDOWN_CAP_MS = 60 * 1000;
const SHORT_COOLDOWN_PROVIDERS = new Set([
  ...Object.keys(FREE_PROVIDERS),
  ...Object.keys(FREE_TIER_PROVIDERS),
]);

/**
 * Get provider credentials from localDb
 * Filters out unavailable accounts and returns the selected account based on strategy
 * @param {string} provider - Provider name
 * @param {Set<string>|string|null} excludeConnectionIds - Connection ID(s) to exclude (for retry with next account)
 * @param {string|null} model - Model name for per-model rate limit filtering
 */
export async function getProviderCredentials(provider, excludeConnectionIds = null, model = null, options = {}) {
  // Normalize to Set for consistent handling
  const excludeSet = excludeConnectionIds instanceof Set
    ? excludeConnectionIds
    : (excludeConnectionIds ? new Set([excludeConnectionIds]) : new Set());
  const preferredConnectionId = options?.preferredConnectionId || null;
  // Acquire mutex to prevent race conditions
  const currentMutex = selectionMutex;
  let resolveMutex;
  selectionMutex = new Promise(resolve => { resolveMutex = resolve; });

  try {
    await currentMutex;

    // Resolve alias to provider ID (e.g., "kc" -> "kilocode")
    const providerId = resolveProviderId(provider);

    // Inject a virtual connection for no-auth free providers (with optional proxy pool from settings)
    if (FREE_PROVIDERS[providerId]?.noAuth) {
      const settings = await getSettings();
      const override = (settings.providerStrategies || {})[providerId] || {};
      const strategy = override.rotateStrategy || "none";
      let pickedId = override.proxyPoolId || null;
      if (strategy !== "none") {
        const allPools = await getProxyPools({ isActive: true });
        const poolIds = allPools.filter(p => p.proxyUrl).map(p => p.id);
        pickedId = pickProxyPoolId(poolIds, strategy, providerId);
      }
      const resolvedProxy = await resolveConnectionProxyConfig({ proxyPoolId: pickedId || "" });
      return {
        id: "noauth",
        connectionName: "Public",
        isActive: true,
        accessToken: "public",
        providerSpecificData: {
          connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
          connectionProxyUrl: resolvedProxy.connectionProxyUrl,
          connectionNoProxy: resolvedProxy.connectionNoProxy,
          connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
          vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
        },
      };
    }

    const connections = await getProviderConnections({ provider: providerId, isActive: true });
    log.debug("AUTH", `${provider} | total connections: ${connections.length}, excludeIds: ${excludeSet.size > 0 ? [...excludeSet].join(",") : "none"}, model: ${model || "any"}`);

    if (connections.length === 0) {
      log.warn("AUTH", `No credentials for ${provider}`);
      return null;
    }

    const settings = await getSettings();
    // Per-account requests-per-minute cap. Skipping an account that has used
    // its budget keeps us inside the provider's limit instead of collecting a
    // 429 and parking the account on a cooldown.
    const rpmLimit = resolveProviderRpm(settings, providerId);

    // Antigravity quota cache is lazy: only populated after that account returns 409/429.
    const isAntigravity = providerId === "antigravity";
    const antigravityQuotaCache = isAntigravity && model ? getAntigravityQuotaCache() : null;

    // Filter out model-locked, excluded, rate-capped, and Antigravity quota-exhausted connections
    const availableConnections = connections.filter(c => {
      if (excludeSet.has(c.id)) return false;
      if (isModelLockActive(c, model)) return false;
      if (isOverLimit(c.id, rpmLimit)) return false;
      // Antigravity: skip if live quota exhausted for this model
      if (isAntigravity && model && antigravityQuotaCache) {
        const quota = antigravityQuotaCache.get(c.id)?.[model];
        if (quota && quota.remainingPercentage <= 0 && quota.resetAt && new Date(quota.resetAt).getTime() > Date.now()) {
          const account = c.id?.slice(0, 8) || "unknown";
          log.info("AG_QUOTA", `${account} | CACHE_BLOCK ${model} — skip upstream until ${quota.resetAt}`);
          return false;
        }
      }
      return true;
    });

    // Filter out accounts paused due to low remaining quota (safety buffer).
    // evaluateQuota is fail-open: a missing/erroring quota read never pauses an
    // account, so this only drops accounts we can actually confirm are below threshold.
    const quotaChecked = await Promise.all(
      availableConnections.map(async (c) => {
        const q = await evaluateQuota(c);
        if (q.paused) {
          log.info("AUTH", `${provider} | ${c.id?.slice(0, 8)} skipped: quota paused (window below per-window threshold)`);
          return null;
        }
        return c;
      })
    );
    const routedConnections = quotaChecked.filter(Boolean);

    log.debug("AUTH", `${provider} | available: ${routedConnections.length}/${connections.length}`);
    connections.forEach(c => {
      const excluded = excludeSet.has(c.id);
      const locked = isModelLockActive(c, model);
      if (excluded || locked) {
        const lockUntil = getEarliestModelLockUntil(c);
        log.debug("AUTH", `  → ${c.id?.slice(0, 8)} | ${excluded ? "excluded" : ""} ${locked ? `modelLocked(${model}) until ${lockUntil}` : ""}`);
      }
    });

    if (routedConnections.length === 0) {
      // Find earliest persistent lock or lazy Antigravity quota-cache reset for retry timing.
      const lockedConns = connections.filter(c => isModelLockActive(c, model));
      const expiries = lockedConns.map(c => getEarliestModelLockUntil(c)).filter(Boolean);
      if (isAntigravity && model && antigravityQuotaCache) {
        connections.forEach((c) => {
          const resetAt = antigravityQuotaCache.get(c.id)?.[model]?.resetAt;
          if (resetAt && new Date(resetAt).getTime() > Date.now()) expiries.push(resetAt);
        });
      }
      const earliest = expiries.sort()[0] || null;
      if (earliest) {
        // Pick the connection that actually owns `earliest`, not just the first
        // locked one — otherwise the countdown and the error came from different
        // accounts.
        const earliestConn = lockedConns.find((c) => getEarliestModelLockUntil(c) === earliest) || lockedConns[0];

        // lastError/errorCode are per-CONNECTION, while locks are per-model, so
        // the stored error belongs to whichever model failed on this connection
        // most recently — not necessarily the one being requested. Serving it
        // regardless leaked one request's error into an unrelated one: a probe
        // for a bogus model produced a 401 ModelError that was then replayed to
        // a live conversation on a different model for the whole backoff window,
        // making good credentials look broken. Only surface it when it provably
        // belongs to this model.
        const errorMatchesModel = earliestConn?.lastErrorModel
          ? earliestConn.lastErrorModel === (model || null)
          : false;
        const lastError = errorMatchesModel ? earliestConn?.lastError || null : null;
        const lastErrorCode = errorMatchesModel ? earliestConn?.errorCode || null : null;

        log.warn("AUTH", `${provider} | all ${connections.length} accounts locked for ${model || "all"} (${formatRetryAfter(earliest)}) | lastError=${errorMatchesModel ? earliestConn?.lastError?.slice(0, 50) : `<withheld: belongs to ${earliestConn?.lastErrorModel || "unknown"}>`}`);
        return {
          allRateLimited: true,
          retryAfter: earliest,
          retryAfterHuman: formatRetryAfter(earliest),
          lastError,
          lastErrorCode
        };
      }
      const capped = connections
        .map(c => retryAfterMs(c.id, rpmLimit))
        .filter(ms => ms !== null && ms !== undefined);
      if (capped.length === connections.length && capped.length > 0) {
        const waitMs = Math.min(...capped);
        const until = new Date(Date.now() + waitMs).toISOString();
        log.warn("AUTH", `${provider} | all ${connections.length} accounts at the ${rpmLimit} RPM cap (${Math.ceil(waitMs / 1000)}s)`);
        return {
          allRateLimited: true,
          retryAfter: until,
          retryAfterHuman: formatRetryAfter(until),
          lastError: `Local ${rpmLimit} RPM cap reached for every ${provider} account`,
          lastErrorCode: null
        };
      }
      log.warn("AUTH", `${provider} | all ${connections.length} accounts unavailable`);
      return null;
    }

    // Per-provider strategy overrides global setting
    const providerOverride = (settings.providerStrategies || {})[providerId] || {};
    const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";

    let connection;
    // Pin to preferred connection if specified and available
    if (preferredConnectionId) {
      connection = routedConnections.find((c) => c.id === preferredConnectionId);
      if (connection) {
        log.info("AUTH", `${provider} | pinned to ${connection.id?.slice(0, 8)} (${connection.name || connection.email || "unnamed"})`);
      }
    }
    if (connection) {
      // skip strategy
    } else if (strategy === LATENCY_AWARE_STRATEGY) {
      // Score live latency + error rate instead of walking a static order
      const { connection: picked, reason } = selectHealthiestConnection(availableConnections, {
        model,
        config: settings.latencyAwareConfig,
      });
      connection = picked || availableConnections[0];
      log.debug("AUTH", `${provider} | latency-aware → ${connection.id?.slice(0, 8)} (${reason})`);
      await updateProviderConnection(connection.id, {
        lastUsedAt: new Date().toISOString(),
        consecutiveUseCount: 1
      });
    } else if (strategy === "round-robin") {
      const stickyLimit = providerOverride.stickyRoundRobinLimit || settings.stickyRoundRobinLimit || 3;

      // Sort by lastUsed (most recent first) to find current candidate
      const byRecency = [...routedConnections].sort((a, b) => {
        if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
        if (!a.lastUsedAt) return 1;
        if (!b.lastUsedAt) return -1;
        return new Date(b.lastUsedAt) - new Date(a.lastUsedAt);
      });

      const current = byRecency[0];
      const currentCount = current?.consecutiveUseCount || 0;

      if (current && current.lastUsedAt && currentCount < stickyLimit) {
        // Stay with current account
        connection = current;
        // Update lastUsedAt and increment count (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: (connection.consecutiveUseCount || 0) + 1
        });
      } else {
        // Pick the least recently used (excluding current if possible)
        const sortedByOldest = [...routedConnections].sort((a, b) => {
          if (!a.lastUsedAt && !b.lastUsedAt) return (a.priority || 999) - (b.priority || 999);
          if (!a.lastUsedAt) return -1;
          if (!b.lastUsedAt) return 1;
          return new Date(a.lastUsedAt) - new Date(b.lastUsedAt);
        });

        connection = sortedByOldest[0];

        // Update lastUsedAt and reset count to 1 (await to ensure persistence)
        await updateProviderConnection(connection.id, {
          lastUsedAt: new Date().toISOString(),
          consecutiveUseCount: 1
        });
      }
    } else {
      // Default: fill-first (already sorted by priority in getProviderConnections)
      connection = routedConnections[0];
    }

    if (rpmLimit > 0) {
      recordRequest(connection.id);
    }

    const resolvedProxy = await resolveConnectionProxyConfig(connection.providerSpecificData || {});

    return {
      authType: connection.authType,
      apiKey: connection.apiKey,
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      idToken: connection.idToken,
      expiresAt: connection.expiresAt,
      expiresIn: connection.expiresIn,
      lastRefreshAt: connection.lastRefreshAt,
      projectId: connection.projectId,
      connectionName: connection.displayName || connection.name || connection.email || connection.id,
      copilotToken: connection.providerSpecificData?.copilotToken,
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        connectionProxyEnabled: resolvedProxy.connectionProxyEnabled,
        connectionProxyUrl: resolvedProxy.connectionProxyUrl,
        connectionNoProxy: resolvedProxy.connectionNoProxy,
        connectionProxyPoolId: resolvedProxy.proxyPoolId || null,
        vercelRelayUrl: resolvedProxy.vercelRelayUrl || "",
      },
      connectionId: connection.id,
      // Include current status for optimization check
      testStatus: connection.testStatus,
      lastError: connection.lastError,
      // Pass full connection for clearAccountError to read modelLock_* keys
      _connection: connection
    };
  } finally {
    if (resolveMutex) resolveMutex();
  }
}

/**
 * Mark account+model as unavailable — locks modelLock_${model} in DB.
 * All errors (429, 401, 5xx, etc.) lock per model, not per account.
 * @param {string} connectionId
 * @param {number} status - HTTP status code from upstream
 * @param {string} errorText
 * @param {string|null} provider
 * @param {string|null} model - The specific model that triggered the error
 * @returns {{ shouldFallback: boolean, cooldownMs: number }}
 */
/**
 * Human-readable reason for the connection's `lastError`.
 *
 * A non-string error used to collapse to the bare string "Provider error", which
 * is what an operator then sees in the dashboard and in the console line below —
 * no status, no code, nothing to act on. A failed `fetch` is exactly that case:
 * Node reports `TypeError: fetch failed` and puts the useful part
 * (ECONNREFUSED, ENOTFOUND, ETIMEDOUT) on `error.cause.code`.
 *
 * Only message-shaped fields and error codes are read. The error object is never
 * serialized wholesale, so a request body or header that happens to be attached
 * to it cannot leak into the stored reason.
 */
export function describeProviderError(errorText) {
  const clamp = (value) => String(value).replace(/\s+/g, " ").trim().slice(0, 100);

  if (typeof errorText === "string") return errorText.slice(0, 100);
  if (!errorText || typeof errorText !== "object") return "Provider error";

  const code = typeof errorText.code === "string" ? errorText.code
    : typeof errorText.cause?.code === "string" ? errorText.cause.code
      : null;

  if (errorText instanceof Error) {
    const message = errorText.message ? clamp(errorText.message) : errorText.name || "Provider error";
    return code && !message.includes(code) ? clamp(`${message} (${code})`) : message;
  }

  const candidates = [
    errorText.error?.message,
    errorText.message,
    typeof errorText.error === "string" ? errorText.error : null,
    errorText.detail,
    errorText.reason,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return code && !candidate.includes(code) ? clamp(`${candidate} (${code})`) : clamp(candidate);
    }
  }

  return code ? clamp(`Provider error (${code})`) : "Provider error";
}

export async function markAccountUnavailable(connectionId, status, errorText, provider = null, model = null, resetsAtMs = null) {
  if (!connectionId || connectionId === "noauth") return { shouldFallback: false, cooldownMs: 0 };
  const connections = await getProviderConnections({ provider });
  const conn = connections.find(c => c.id === connectionId);
  const backoffLevel = conn?.backoffLevel || 0;
  const providerKey = resolveProviderId(provider);

  // Per-provider retry-delay fallback (dashboard: Providers → Retry delay).
  // "auto"/unset keeps the built-in behavior; a numeric value (seconds) is used
  // as the lock duration ONLY when the provider itself reports no reset window.
  // A provider-reported reset is always honored and never shortened by this.
  let fallbackOverrideMs = null;
  try {
    const settings = await getSettings();
    const sel = settings?.retryDelayByProvider?.[providerKey];
    if (sel != null && sel !== "auto") {
      const secs = Number(sel);
      if (Number.isFinite(secs) && secs > 0) {
        fallbackOverrideMs = Math.min(secs * 1000, MAX_RATE_LIMIT_COOLDOWN_MS);
      }
    }
  } catch { /* settings unavailable → fall through to auto behavior */ }

  // Provider-specific precise cooldown (e.g. codex usage_limit_reached resets_at) overrides backoff
  // Classify first: a request-scoped failure (fallback:false, e.g.
  // context_length_exceeded) is a property of the body, not of the account, so it
  // must win over any provider-supplied reset hint riding along on the same
  // response — otherwise the precise-cooldown branches would lock a healthy
  // account for a request that no account could serve.
  const classified = checkFallbackError(status, errorText, backoffLevel);
  let shouldFallback, cooldownMs, newBackoffLevel;
  if (classified.shouldFallback && resetsAtMs && resetsAtMs > Date.now()) {
    shouldFallback = true;
    // Antigravity quota API provides exact per-model resetAt. Do not truncate it.
    cooldownMs = resolveProviderId(provider) === "antigravity"
      ? resetsAtMs - Date.now()
      : Math.min(resetsAtMs - Date.now(), MAX_RATE_LIMIT_COOLDOWN_MS);
    newBackoffLevel = 0;
  } else {
    ({ shouldFallback, cooldownMs, newBackoffLevel } = classified);
    // Only reshape the STATIC backoff — when the provider reported no reset of its own.
    if (shouldFallback && parseProviderResetMs(errorText) == null) {
      if (fallbackOverrideMs != null) {
        // User pinned a fixed retry delay for this provider.
        cooldownMs = fallbackOverrideMs;
        newBackoffLevel = 0;
      } else if (
        // Default for free/free-tier pools: cap the static backoff so the small
        // account set recovers within its real per-minute window and keeps rotating.
        cooldownMs > FREE_TIER_STATIC_COOLDOWN_CAP_MS &&
        SHORT_COOLDOWN_PROVIDERS.has(providerKey)
      ) {
        cooldownMs = FREE_TIER_STATIC_COOLDOWN_CAP_MS;
      }
    }
  }
  if (!shouldFallback) return { shouldFallback: false, cooldownMs: 0 };

  const reason = describeProviderError(errorText);
  const lockUpdate = buildModelLockUpdate(model, cooldownMs);

  await updateProviderConnection(connectionId, {
    ...lockUpdate,
    testStatus: "unavailable",
    lastError: reason,
    errorCode: status,
    // Which model produced this error. Locks are per-model but lastError is a
    // single per-connection field, so without this the reader cannot tell
    // whether the stored error belongs to the model being asked about.
    lastErrorModel: model || null,
    lastErrorAt: new Date().toISOString(),
    backoffLevel: newBackoffLevel ?? backoffLevel
  });

  const lockKey = Object.keys(lockUpdate)[0];
  const connName = conn?.displayName || conn?.name || conn?.email || connectionId.slice(0, 8);
  log.warn("AUTH", `${connName} locked ${lockKey} for ${Math.round(cooldownMs / 1000)}s [${status}]`);

  if (provider && status && reason) {
    console.error(`❌ ${provider} [${status}]: ${reason}`);
  }

  return { shouldFallback: true, cooldownMs };
}

/**
 * Clear account error status on successful request.
 * - Clears modelLock_${model} (the model that just succeeded)
 * - Lazy-cleans any other expired modelLock_* keys
 * - Resets error state only if no active locks remain
 * @param {string} connectionId
 * @param {object} currentConnection - credentials object (has _connection) or raw connection
 * @param {string|null} model - model that succeeded
 */
export async function clearAccountError(connectionId, currentConnection, model = null) {
  if (!connectionId || connectionId === "noauth") return;
  const conn = currentConnection._connection || currentConnection;
  const now = Date.now();
  const allLockKeys = Object.keys(conn).filter(k => k.startsWith("modelLock_"));

  if (!conn.testStatus && !conn.lastError && allLockKeys.length === 0) return;

  // Keys to clear: current model's lock + all expired locks
  const keysToClear = allLockKeys.filter(k => {
    if (model && k === `modelLock_${model}`) return true; // succeeded model
    if (model && k === "modelLock___all") return true;    // account-level lock
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() <= now;   // expired
  });

  if (keysToClear.length === 0 && conn.testStatus !== "unavailable" && !conn.lastError) return;

  // Check if any active locks remain after clearing
  const remainingActiveLocks = allLockKeys.filter(k => {
    if (keysToClear.includes(k)) return false;
    const expiry = conn[k];
    return expiry && new Date(expiry).getTime() > now;
  });

  const clearObj = Object.fromEntries(keysToClear.map(k => [k, null]));

  // Only reset error state if no active locks remain
  if (remainingActiveLocks.length === 0) {
    Object.assign(clearObj, {
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorModel: null,
      lastErrorAt: null,
      backoffLevel: 0
    });
  }

  await updateProviderConnection(connectionId, clearObj);
}

/**
 * Clear project-resolution error state on connection when a valid project ID is set
 */
export async function clearProjectResolutionError(connectionId) {
  if (!connectionId || connectionId === "noauth") return;
  await updateProviderConnection(connectionId, {
    testStatus: "active",
    lastError: null,
    errorCode: null,
    lastErrorAt: null,
    backoffLevel: 0
  });
}

/**
 * Extract API key from request headers (first presented credential).
 */
export function extractApiKey(request) {
  return extractApiKeyCandidates(request)[0] || null;
}

/**
 * All credentials the client presented, in precedence order.
 * Anthropic clients (e.g. Claude Code with an active claude.ai session or
 * ANTHROPIC_AUTH_TOKEN set) can send an unrelated Authorization header
 * ALONGSIDE a valid x-api-key — api.anthropic.com still authenticates on
 * x-api-key, so every presented credential must be checked.
 */
export function extractApiKeyCandidates(request) {
  const candidates = [];
  const push = (v) => { if (v && !candidates.includes(v)) candidates.push(v); };
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) push(authHeader.slice(7));
  push(request.headers.get("x-api-key"));
  return candidates;
}

/**
 * Resolve the client's API key against the apiKeys table.
 * Returns { apiKey, valid }: when valid, apiKey is the credential that
 * actually validated (use it for usage attribution); otherwise apiKey is the
 * first presented credential (or null if none).
 */
export async function resolveClientApiKey(request) {
  const candidates = extractApiKeyCandidates(request);
  for (const key of candidates) {
    if (await validateApiKey(key)) return { apiKey: key, valid: true };
  }
  return { apiKey: candidates[0] || null, valid: false };
}

/**
 * Validate API key (optional - for local use can skip)
 */
export async function isValidApiKey(apiKey) {
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}
