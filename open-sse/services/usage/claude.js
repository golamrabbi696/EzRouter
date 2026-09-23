/**
 * Claude usage handler (Anthropic OAuth & API key)
 * Supports:
 * 1. OAuth usage endpoint (Claude Code consumer OAuth tokens)
 * 2. Organization settings/usage API (API key / org admin users)
 */

import { createHash } from "crypto";
import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { ANTHROPIC_API_VERSION, CLAUDE_CLI_VERSION } from "../../providers/shared.js";
import { U, parseResetTime } from "./shared.js";

const CLAUDE_CONFIG = {
  oauthUsageUrl: U("claude").oauthUrl,
  usageUrl: U("claude").orgUrl,
  settingsUrl: U("claude").settingsUrl,
  profileUrl: U("claude").profileUrl,
  resetUrl: U("claude").resetUrl,
  apiVersion: ANTHROPIC_API_VERSION,
  // Reset grants are gated by surface: only "(external, cli)" UA is eligible
  userAgent: `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
};

const SUCCESS_TTL_MS = 65_000;
const RETRY_MIN_MS = 3 * 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const CACHE_MAX = 128;
const usageCache = new Map();
const inFlight = new Map();

function credentialKey(accessToken) {
  return createHash("sha256").update(String(accessToken ?? "")).digest("hex");
}

function setCache(key, entry) {
  usageCache.delete(key);
  usageCache.set(key, entry);
  while (usageCache.size > CACHE_MAX) usageCache.delete(usageCache.keys().next().value);
}

function createQuota(used, resetsAt) {
  const normalizedUsed = Math.min(100, Math.max(0, used));
  const remaining = 100 - normalizedUsed;
  return {
    used: normalizedUsed,
    total: 100,
    remaining,
    remainingPercentage: remaining,
    resetAt: parseResetTime(resetsAt),
    unlimited: false,
  };
}

function addQuota(quotas, name, used, resetsAt) {
  if (typeof used !== "number" || !Number.isFinite(used)) return;
  if (Object.keys(quotas).some((key) => key.toLowerCase() === name.toLowerCase())) return;
  quotas[name] = createQuota(used, resetsAt);
}

function normalizeClaudeUsage(data) {
  const quotas = {};

  addQuota(quotas, "session (5h)", data?.five_hour?.utilization, data?.five_hour?.resets_at);
  addQuota(quotas, "weekly (7d)", data?.seven_day?.utilization, data?.seven_day?.resets_at);

  for (const [key, value] of Object.entries(data || {})) {
    if (key.startsWith("seven_day_") && value && typeof value === "object") {
      addQuota(
        quotas,
        `weekly ${key.slice("seven_day_".length)} (7d)`,
        value.utilization,
        value.resets_at,
      );
    }
  }

  const limits = [
    ...(Array.isArray(data?.limits) ? data.limits : []),
    ...(Array.isArray(data?.rate_limits) ? data.rate_limits : []),
  ];
  for (const limit of limits) {
    const group = String(limit?.group || "").toLowerCase();
    const kind = String(limit?.kind || "").toLowerCase();
    if (kind === "session" || group === "session") {
      addQuota(quotas, "session (5h)", limit.percent, limit.resets_at);
      continue;
    }
    if (kind === "weekly_scoped" || group === "weekly") {
      const scopeName = limit?.scope?.model?.display_name || limit?.scope?.surface?.display_name;
      addQuota(
        quotas,
        scopeName ? `weekly ${scopeName} (7d)` : "weekly (7d)",
        limit.percent,
        limit.resets_at,
      );
    }
  }

  return {
    plan: "Claude Code",
    extraUsage: data?.extra_usage ?? null,
    resetCredits: parseClaudeResetGrants(data?.cedar_ember),
    quotas,
  };
}

function parseRetryAfterMs(value, now) {
  const text = String(value || "").trim();
  if (!text) return null;
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const resetAt = Date.parse(text);
  return Number.isFinite(resetAt) ? Math.max(0, resetAt - now) : null;
}

function parseResetHeaderMs(value, now) {
  const text = String(value || "").trim();
  if (!text) return null;
  const numeric = Number(text);
  const resetAt = Number.isFinite(numeric)
    ? (numeric < 1e12 ? numeric * 1000 : numeric)
    : Date.parse(text);
  return Number.isFinite(resetAt) && resetAt > now && resetAt <= 8.64e15
    ? resetAt - now
    : null;
}

function retryAfterMs(response, now) {
  let parsed = parseRetryAfterMs(response.headers.get("retry-after"), now);
  if (parsed === null) {
    response.headers.forEach((value, name) => {
      if (!/^anthropic-ratelimit-.+-reset$/i.test(name)) return;
      const candidate = parseResetHeaderMs(value, now);
      if (candidate !== null && (parsed === null || candidate > parsed)) parsed = candidate;
    });
  }
  return Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, parsed ?? RETRY_MIN_MS));
}

async function fetchClaudeUsage(accessToken, proxyOptions, key) {
  try {
    // Primary: OAuth usage endpoint (Claude Code consumer OAuth tokens)
    // cedar_ember=1 adds the "limit reset" grant block (same flag Claude Code sends)
    const oauthResponse = await proxyAwareFetch(`${CLAUDE_CONFIG.oauthUsageUrl}?cedar_ember=1`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
        "User-Agent": CLAUDE_CONFIG.userAgent,
      },
      signal: AbortSignal.timeout(5_000),
    }, proxyOptions);

    if (oauthResponse.ok) {
      const value = normalizeClaudeUsage(await oauthResponse.json());
      setCache(key, { value, expiresAt: Date.now() + SUCCESS_TTL_MS, retryAt: 0 });
      return value;
    }

    if (oauthResponse.status === 429) {
      const now = Date.now();
      const cached = usageCache.get(key);
      const value = cached?.value || { message: "Claude usage is rate limited. Retry later." };
      setCache(key, {
        value,
        expiresAt: cached?.expiresAt || 0,
        retryAt: now + retryAfterMs(oauthResponse, now),
      });
      return value;
    }

    if (oauthResponse.status === 401) {
      return { message: "Claude authentication expired (401). Re-authorize or refresh the connection." };
    }

    if (oauthResponse.status === 404 || oauthResponse.status === 405) {
      const legacy = await getClaudeUsageLegacy(accessToken, proxyOptions);
      if (legacy.cacheable) {
        setCache(key, { value: legacy.value, expiresAt: Date.now() + SUCCESS_TTL_MS, retryAt: 0 });
      }
      return legacy.value;
    }

    return { message: `Claude connected. Usage endpoint returned HTTP ${oauthResponse.status}.` };
  } catch {
    return { message: "Claude connected. Unable to fetch usage." };
  }
}

export function getClaudeUsage(accessToken, proxyOptions = null, options = {}) {
  const force = options?.force === true;
  const key = credentialKey(accessToken);
  const cached = usageCache.get(key);
  const now = Date.now();
  if (!force && cached && (now < cached.expiresAt || now < cached.retryAt)) {
    return Promise.resolve(cached.value);
  }
  if (!force && inFlight.has(key)) return inFlight.get(key);
  if (inFlight.size >= CACHE_MAX) {
    return Promise.resolve({ message: "Claude usage refresh is busy. Retry shortly." });
  }

  let request;
  request = fetchClaudeUsage(accessToken, proxyOptions, key).finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

// Free "limit reset" grants (Anthropic program id "cedar_ember").
// Shape: { eligible, next_grant_id, grants: [{ id, resets_left, ends_at, paused, clears }] }
export function parseClaudeResetGrants(block) {
  if (!block?.eligible || !Array.isArray(block.grants)) return null;
  const grants = block.grants.filter((g) => g?.id && !g.paused && Number(g.resets_left) > 0);
  const next = grants.find((g) => g.id === block.next_grant_id) || grants[0] || null;
  return {
    availableCount: grants.reduce((sum, g) => sum + Number(g.resets_left), 0),
    nextGrantId: next?.id || null,
    expiresAt: next?.ends_at || null,
    clears: next?.clears || [],
    cooldownUntil: block.cooldown_until || null,
    weeklyResetsAt: block.weekly_resets_at || null,
    grants: block.grants.filter((g) => g?.id).map((g) => ({
      id: g.id,
      label: g.label || "",
      resetsLeft: Number(g.resets_left) || 0,
      resetsTotal: Number(g.resets_total) || 0,
      startsAt: g.starts_at || null,
      endsAt: g.ends_at || null,
      clears: Array.isArray(g.clears) ? g.clears : [],
      paused: g.paused === true,
      usableNow: g.usable_now === true,
      useRequiresLimit: g.use_requires_limit !== false,
    })),
  };
}

// Spend one reset grant: refills the limits listed in grant.clears. Irreversible.
export async function consumeClaudeResetGrant(accessToken, grantId, proxyOptions = null) {
  if (!accessToken) throw new Error("No Claude access token available. Please re-authorize the connection.");
  if (!/^[a-z0-9_-]{1,40}$/.test(grantId || "")) throw new Error("Invalid reset grant id.");

  const headers = {
    "Authorization": `Bearer ${accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
    "anthropic-version": CLAUDE_CONFIG.apiVersion,
    "User-Agent": CLAUDE_CONFIG.userAgent,
    "Content-Type": "application/json",
  };

  const profileRes = await proxyAwareFetch(CLAUDE_CONFIG.profileUrl, { method: "GET", headers }, proxyOptions);
  const profile = await profileRes.json().catch(() => null);
  const orgId = profile?.organization?.uuid;
  if (!profileRes.ok || !orgId) throw new Error(`Cannot resolve Claude organization (${profileRes.status}).`);

  const res = await proxyAwareFetch(CLAUDE_CONFIG.resetUrl.replace("{org_id}", orgId), {
    method: "POST",
    headers,
    body: JSON.stringify({ program: "cedar_ember", grant_id: grantId, request_id: crypto.randomUUID() }),
  }, proxyOptions);
  const data = await res.json().catch(() => null);

  const key = credentialKey(accessToken);
  usageCache.delete(key);
  usageCache.delete(accessToken); // next read must show refilled limits
  inFlight.delete(key);
  return {
    ok: res.ok && data?.result === "reset",
    status: res.status,
    result: data?.result || null,
    reason: data?.reason || null,
    resetsLeft: data?.resets_left ?? null,
    message: data?.error?.message || null,
  };
}

/**
 * Legacy Claude usage for API key / org admin users
 */
async function getClaudeUsageLegacy(accessToken, proxyOptions = null) {
  try {
    const settingsResponse = await proxyAwareFetch(CLAUDE_CONFIG.settingsUrl, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "anthropic-version": CLAUDE_CONFIG.apiVersion,
      },
    }, proxyOptions);

    if (settingsResponse.ok) {
      const settings = await settingsResponse.json();

      if (settings.organization_id) {
        const usageResponse = await proxyAwareFetch(
          CLAUDE_CONFIG.usageUrl.replace("{org_id}", settings.organization_id),
          {
            method: "GET",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "anthropic-version": CLAUDE_CONFIG.apiVersion,
            },
          },
          proxyOptions
        );

        if (usageResponse.ok) {
          const usage = await usageResponse.json();
          return {
            cacheable: true,
            value: {
              plan: settings.plan || "Unknown",
              organization: settings.organization_name,
              quotas: usage,
            },
          };
        }

        return {
          cacheable: false,
          value: {
            plan: settings.plan || "Unknown",
            organization: settings.organization_name,
            message: "Claude connected. Usage details require admin access.",
          },
        };
      }

      return {
        cacheable: true,
        value: {
          plan: settings.plan || "Unknown",
          organization: settings.organization_name,
          message: "Claude connected. Usage details require admin access.",
        },
      };
    }

    return {
      cacheable: false,
      value: { message: "Claude connected. Usage endpoint requires OAuth." },
    };
  } catch (error) {
    return {
      cacheable: false,
      value: { message: `Claude connected. Error checking usage: ${error.message}` },
    };
  }
}
