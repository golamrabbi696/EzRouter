import { proxyAwareFetch } from "../../utils/proxyFetch.js";
import { getClineAuthorizationHeader } from "../../shared/clineAuth.js";
import { U, parseResetTime, toFiniteNumber } from "./shared.js";

const USAGE_LIMITS_URL = U("clinepass").url;
const KNOWN_TYPES = {
  five_hour: "Session (5h)",
  weekly: "Weekly (7d)",
  monthly: "Monthly (30d)",
};

export async function getClinepassUsage(token, proxyOptions = null) {
  const authorization = getClineAuthorizationHeader(token);
  if (!authorization) {
    return { message: "ClinePass credentials not available. Reconnect to view usage." };
  }

  try {
    const response = await proxyAwareFetch(USAGE_LIMITS_URL, {
      headers: { Authorization: authorization, Accept: "application/json" },
    }, proxyOptions);
    const json = await response.json().catch(() => null);
    const error = typeof json?.error === "string" ? json.error : json?.error?.message;
    const detail = typeof error === "string" && error ? `: ${error.slice(0, 120)}` : ".";
    if (response.status === 401 || response.status === 403) {
      return { plan: "ClinePass", message: `ClinePass authentication failed${detail}` };
    }
    if (!response.ok) {
      return { plan: "ClinePass", message: `ClinePass quota API error (${response.status})${detail}` };
    }
    if (!json || json.success === false) {
      return { plan: "ClinePass", message: `ClinePass quota API error${detail}` };
    }
    if (!json.data) {
      return { plan: "ClinePass", message: "No active ClinePass subscription on this account." };
    }

    const quotas = {};
    for (const limit of Array.isArray(json.data.limits) ? json.data.limits : []) {
      const key = Object.hasOwn(KNOWN_TYPES, limit?.type) ? KNOWN_TYPES[limit.type] : null;
      if (!key) continue;
      const used = Math.min(100, Math.max(0, toFiniteNumber(limit.percentUsed, 0)));
      quotas[key] = {
        used,
        total: 100,
        remainingPercentage: 100 - used,
        resetAt: parseResetTime(limit.resetsAt),
        unlimited: false,
      };
    }
    if (!Object.keys(quotas).length) {
      return { plan: "ClinePass", message: "ClinePass connected. No quota data returned." };
    }
    return { plan: "ClinePass", quotas };
  } catch (error) {
    return { message: `ClinePass error: ${error.message}` };
  }
}
