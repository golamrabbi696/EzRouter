/**
 * Qoder model catalog — re-exports protocol catalog (single source of truth).
 */

import {
  getQoderModelConfig,
  resolveQoderModels as protocolResolveQoderModels,
  invalidateQoderCatalog,
  clearQoderCatalog,
  isQoderPat,
  resolvePatCredential,
} from "../protocol/qoder/index.js";
import { qoderRegionOf } from "../protocol/qoder/constants.js";

export {
  getQoderModelConfig,
  invalidateQoderCatalog,
  clearQoderCatalog,
  isQoderPat,
};

export async function resolveQoderCredentials(credentials, proxyOptions = null, signal = null, region = null) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  if (!isQoderPat(raw)) {
    return {
      ...credentials,
      accessToken: raw,
      apiKey: raw,
    };
  }

  const profile = region || qoderRegionOf(credentials?.provider);
  try {
    const exchanged = await resolvePatCredential(raw, {
      profile,
      proxyOptions,
      signal,
    });
    return {
      ...credentials,
      accessToken: exchanged.accessToken,
      providerSpecificData: {
        ...(credentials?.providerSpecificData || {}),
        userId: exchanged.userId || credentials?.providerSpecificData?.userId || "",
      },
    };
  } catch (err) {
    return {
      ...credentials,
      accessToken: raw,
      apiKey: raw,
    };
  }
}

export async function resolveQoderModels(credentials, options = {}) {
  const region = options.region || qoderRegionOf(credentials?.provider);
  const resolved = await resolveQoderCredentials(credentials, options.proxyOptions, options.signal, region);
  const profile = options.profile || region;
  return protocolResolveQoderModels(resolved, { ...options, profile });
}

export function routableQoderModels(catalog) {
  if (!catalog) return [];
  const out = [];
  const seen = new Set();
  for (const m of catalog.models || []) {
    if (!m?.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({ id: m.id, name: m.name || m.id, hidden: false });
  }
  for (const [key, cfg] of catalog.rawConfigs || []) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: key, name: cfg?.display_name || key, hidden: true });
  }
  return out;
}
