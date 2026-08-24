import { ERROR_RULES, BACKOFF_CONFIG, TRANSIENT_COOLDOWN_MS, MAX_RATE_LIMIT_COOLDOWN_MS } from "../config/errorConfig.js";

/**
 * Calculate exponential backoff cooldown for rate limits (429)
 * Level 1: 1s, Level 2: 2s, Level 3: 4s... → max 4 min
 * @param {number} backoffLevel - Current backoff level
 * @returns {number} Cooldown in milliseconds
 */
export function getQuotaCooldown(backoffLevel = 0) {
  const level = Math.max(0, backoffLevel - 1);
  const cooldown = BACKOFF_CONFIG.base * Math.pow(2, level);
  return Math.min(cooldown, BACKOFF_CONFIG.max);
}

/**
 * Parse the provider's ACTUAL rate-limit reset window from a 429 body/headers,
 * so an account is locked for the real duration instead of a fixed cooldown.
 * Supports: Google/Antigravity RetryInfo ("retryDelay": "1976.3s"),
 * OpenAI/Codex absolute reset ("resets_at"/"reset_at" epoch s|ms),
 * OpenRouter/RateLimit ("X-RateLimit-Reset" epoch s|ms) and "Retry-After: N".
 * @param {string|object} errorText - 429 body/headers, string or object.
 * @param {number} now - reference epoch ms (defaults to Date.now()).
 * @returns {number|null} ms until reset, or null when none is present.
 */
export function parseProviderResetMs(errorText, now = Date.now()) {
  if (!errorText) return null;
  const s = typeof errorText === "string" ? errorText : JSON.stringify(errorText);
  let m;
  // Relative seconds (Google/Antigravity RetryInfo): "retryDelay": "1976.365s"
  if ((m = s.match(/"?retry[_-]?delay"?\s*[:=]\s*"?\s*([0-9]+(?:\.[0-9]+)?)\s*s/i))) {
    return Math.round(parseFloat(m[1]) * 1000);
  }
  // Absolute reset epoch (s or ms): resets_at / reset_at / X-RateLimit-Reset
  if ((m = s.match(/"?(?:resets?_at|x-?ratelimit-?reset|ratelimit-?reset)"?\s*[:=]\s*"?\s*([0-9]{9,})/i))) {
    let v = parseInt(m[1], 10);
    if (v < 1e12) v *= 1000; // seconds -> ms
    const ms = v - now;
    return ms > 0 ? ms : null;
  }
  // Retry-After: N seconds (header echoed into the body)
  if ((m = s.match(/"?retry[_-]?after"?\s*[:=]\s*"?\s*([0-9]+)\b/i))) {
    return parseInt(m[1], 10) * 1000;
  }
  return null;
}

/**
 * Resolve the 429 account cooldown: prefer the provider's own reset window over
 * the static exponential backoff, floored at the static value and capped at
 * MAX_RATE_LIMIT_COOLDOWN_MS so a bogus huge value can't lock an account forever.
 */
export function resolveCooldownMs(newLevel, errorText) {
  const staticMs = getQuotaCooldown(newLevel);
  const providerMs = parseProviderResetMs(errorText);
  if (providerMs == null || !(providerMs > 0)) return staticMs;
  return Math.min(Math.max(providerMs, staticMs), MAX_RATE_LIMIT_COOLDOWN_MS);
}

/**
 * Check if error should trigger account fallback (switch to next account)
 * Config-driven: matches ERROR_RULES top-to-bottom (text rules first, then status)
 * @param {number} status - HTTP status code
 * @param {string} errorText - Error message text
 * @param {number} backoffLevel - Current backoff level for exponential backoff
 * @returns {{ shouldFallback: boolean, cooldownMs: number, newBackoffLevel?: number }}
 */
export function checkFallbackError(status, errorText, backoffLevel = 0) {
  const lowerError = errorText
    ? (typeof errorText === "string" ? errorText : JSON.stringify(errorText)).toLowerCase()
    : "";

  const invalidEncryptedContent = lowerError.includes("invalid_encrypted_content") ||
    (lowerError.includes("encrypted content") &&
      (lowerError.includes("could not be verified") || lowerError.includes("could not be decrypted or parsed")));
  if (status === 400 && invalidEncryptedContent) {
    return { shouldFallback: false, cooldownMs: 0 };
  }

  const terminalStatusRule = ERROR_RULES.find(rule => rule.status === status && rule.fallback === false);
  if (terminalStatusRule) {
    return { shouldFallback: false, cooldownMs: 0, newBackoffLevel: backoffLevel };
  }

  for (const rule of ERROR_RULES) {
    // Regex rule: for phrases the model name sits inside, which a substring
    // cannot span ("Model does-not-exist-xyz is not supported").
    if (rule.pattern && lowerError && rule.pattern.test(lowerError)) {
      if (rule.permanent || rule.fallback === false) return { shouldFallback: false, cooldownMs: 0 };
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: resolveCooldownMs(newLevel, errorText), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Text-based rule: match substring in error message
    if (rule.text && lowerError && lowerError.includes(rule.text)) {
      if (rule.permanent || rule.fallback === false) return { shouldFallback: false, cooldownMs: 0 };
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: resolveCooldownMs(newLevel, errorText), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }

    // Status-based rule: match HTTP status code
    if (rule.status && rule.status === status) {
      if (rule.permanent || rule.fallback === false) return { shouldFallback: false, cooldownMs: 0 };
      if (rule.backoff) {
        const newLevel = Math.min(backoffLevel + 1, BACKOFF_CONFIG.maxLevel);
        return { shouldFallback: true, cooldownMs: resolveCooldownMs(newLevel, errorText), newBackoffLevel: newLevel };
      }
      return { shouldFallback: true, cooldownMs: rule.cooldownMs };
    }
  }

  return { shouldFallback: false, cooldownMs: 0 };
}

export function isAccountUnavailable(unavailableUntil) {
  if (!unavailableUntil) return false;
  return new Date(unavailableUntil).getTime() > Date.now();
}

export function getUnavailableUntil(cooldownMs) {
  return new Date(Date.now() + cooldownMs).toISOString();
}

export function getEarliestRateLimitedUntil(accounts) {
  let earliest = null;
  const now = Date.now();
  for (const acc of accounts) {
    if (!acc.rateLimitedUntil) continue;
    const until = new Date(acc.rateLimitedUntil).getTime();
    if (until <= now) continue;
    if (!earliest || until < earliest) earliest = until;
  }
  if (!earliest) return null;
  return new Date(earliest).toISOString();
}

export function formatRetryAfter(rateLimitedUntil) {
  if (!rateLimitedUntil) return "";
  const diffMs = new Date(rateLimitedUntil).getTime() - Date.now();
  if (diffMs <= 0) return "reset after 0s";
  const totalSec = Math.ceil(diffMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return `reset after ${parts.join(" ")}`;
}

/** Prefix for model lock flat fields on connection record */
export const MODEL_LOCK_PREFIX = "modelLock_";

/** Special key used when no model is known (account-level lock) */
export const MODEL_LOCK_ALL = `${MODEL_LOCK_PREFIX}__all`;

/** Build the flat field key for a model lock */
export function getModelLockKey(model) {
  return model ? `${MODEL_LOCK_PREFIX}${model}` : MODEL_LOCK_ALL;
}

/**
 * Get the active lock expiry for a specific model on one connection.
 */
export function getModelLockUntil(connection, model) {
  if (!connection) return null;
  const key = getModelLockKey(model);
  const expiry = connection[key] || connection[MODEL_LOCK_ALL];
  const expiryMs = expiry ? new Date(expiry).getTime() : NaN;
  if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return null;
  return new Date(expiryMs).toISOString();
}

/**
 * Check if a model lock on a connection is still active.
 * Reads flat field `modelLock_${model}` (or `modelLock___all` when model=null).
 */
export function isModelLockActive(connection, model) {
export function isModelLockActive(connection, model) {
  const now = Date.now();
  const stillLocked = (value) => {
    if (!value) return false;
    const until = new Date(value).getTime();
    return Number.isFinite(until) && until > now;
  };
  return stillLocked(connection[getModelLockKey(model)]) || stillLocked(connection[MODEL_LOCK_ALL]);
}
}

/**
 * Get earliest active model lock expiry across all modelLock_* fields.
 * Used for UI cooldown display.
 */
export function getEarliestModelLockUntil(connection) {
  if (!connection) return null;
  let earliest = null;
  const now = Date.now();
  for (const [key, val] of Object.entries(connection)) {
    if (!key.startsWith(MODEL_LOCK_PREFIX) || !val) continue;
    const t = new Date(val).getTime();
    if (t <= now) continue;
    if (!earliest || t < earliest) earliest = t;
  }
  return earliest ? new Date(earliest).toISOString() : null;
}

/**
 * Build update object to set a model lock on a connection.
 */
export function buildModelLockUpdate(model, cooldownMs) {
  const key = getModelLockKey(model);
  return { [key]: new Date(Date.now() + cooldownMs).toISOString() };
}

/**
 * Build update object to clear all model locks on a connection.
 */
export function buildClearModelLocksUpdate(connection) {
  const cleared = {};
  for (const key of Object.keys(connection)) {
    if (key.startsWith(MODEL_LOCK_PREFIX)) cleared[key] = null;
  }
  return cleared;
}

export function filterAvailableAccounts(accounts, excludeId = null) {
  const now = Date.now();
  return accounts.filter(acc => {
    if (excludeId && acc.id === excludeId) return false;
    if (acc.rateLimitedUntil) {
      const until = new Date(acc.rateLimitedUntil).getTime();
      if (until > now) return false;
    }
    return true;
  });
}

export function resetAccountState(account) {
  if (!account) return account;
  return {
    ...account,
    rateLimitedUntil: null,
    backoffLevel: 0,
    lastError: null,
    status: "active"
  };
}

export function applyErrorState(account, status, errorText) {
  if (!account) return account;
  const backoffLevel = account.backoffLevel || 0;
  const { cooldownMs, newBackoffLevel } = checkFallbackError(status, errorText, backoffLevel);
  return {
    ...account,
    rateLimitedUntil: cooldownMs > 0 ? getUnavailableUntil(cooldownMs) : null,
    backoffLevel: newBackoffLevel ?? backoffLevel,
    lastError: { status, message: errorText, timestamp: new Date().toISOString() },
    status: "error"
  };
}
