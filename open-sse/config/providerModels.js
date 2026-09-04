import { PROVIDERS } from "./providers.js";
import REGISTRY from "../providers/registry/index.js";
// PROVIDER_MODELS now built from providers/registry (transport + models co-located)
import { PROVIDER_MODELS } from "../providers/index.js";
import { modelQuotaFamily, modelStrip, modelTargetFormat, modelSupportedFormats, normalizeModelId } from "../providers/models/schema.js";
import { CODEX_REVIEW_SUFFIX, isMuseSparkModel } from "../providers/models/helpers.js";
import { FORMATS } from "../translator/formats.js";
export { PROVIDER_MODELS };


// Helper functions
export function getProviderModels(aliasOrId) {
  return PROVIDER_MODELS[aliasOrId] || [];
}

export function getDefaultModel(aliasOrId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return models?.[0]?.id || null;
}

// Providers whose registry uses dots in version numbers (e.g. "claude-sonnet-4.5").
// For these, we tolerate clients sending dashes ("claude-sonnet-4-5") by normalizing
// digit-hyphen-digit to digit-dot-digit before lookup. Other providers are left untouched.
const DOT_VERSION_PROVIDERS = new Set(["kr", "kiro"]);

// Fast lookup index: per-provider Map<modelId, modelEntry>, plus a secondary
// Map for the normalized (dash/dot) ids used by DOT_VERSION_PROVIDERS.
// Built once at module load from PROVIDER_MODELS. Replaces the per-request
// linear `.find()` over a provider's model array (called up to 4× per request
// via getModelTargetFormat/getModelStrip/getModelType/getModelUpstreamId),
// turning model resolution from O(models-per-provider) into O(1).
const _modelIndex = new Map();
for (const [aliasOrId, models] of Object.entries(PROVIDER_MODELS)) {
  if (!Array.isArray(models)) continue;
  const exact = new Map();
  const normalized = new Map();
  for (const m of models) {
    if (m?.id == null) continue;
    exact.set(m.id, m);
    if (DOT_VERSION_PROVIDERS.has(aliasOrId)) {
      const n = normalizeModelId(m.id);
      if (n !== m.id) normalized.set(n, m);
    }
  }
  _modelIndex.set(aliasOrId, { exact, normalized });
}

// "model(level)" is an EzRouter thinking override, not part of the upstream id.
// Find a registry entry by id. For Kiro models, tolerates dash/dot version separators
// ("claude-sonnet-4-5" ~= "claude-sonnet-4.5"). Other providers use exact match only.
function findModel(models, modelId, aliasOrId) {
  if (!models) return undefined;
  const baseId = typeof modelId === "string" ? modelId.replace(/\([^()]+\)\s*$/, "").trim() : modelId;
  const idx = _modelIndex.get(aliasOrId);
  if (idx) {
    const found = idx.exact.get(baseId);
    if (found) return found;
    if (idx.normalized.size) return idx.normalized.get(baseId);
    return undefined;
  }
  // Fallback for callers passing a raw models array not yet indexed (defensive).
  const found = models.find((m) => m.id === baseId);
  if (found) return found;
  if (!DOT_VERSION_PROVIDERS.has(aliasOrId)) return undefined;
  const normalized = normalizeModelId(baseId);
  if (normalized === baseId) return undefined;
  return models.find((m) => m.id === normalized);
}

export function isValidModel(aliasOrId, modelId, passthroughProviders = new Set()) {
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  if (passthroughProviders.has(alias) || passthroughProviders.has(aliasOrId)) return true;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  if (!models) return false;
  return !!findModel(models, modelId, alias);
}

export function findModelName(aliasOrId, modelId) {
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  if (!models) return modelId;
  const found = findModel(models, modelId, alias);
  return found?.name || modelId;
}

export function getModelTargetFormat(aliasOrId, modelId) {
  if ((!aliasOrId || aliasOrId === "oc" || aliasOrId === "opencode") && isMuseSparkModel(modelId)) {
    return FORMATS.OPENAI_RESPONSES;
  }
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  return modelTargetFormat(findModel(models, modelId, alias));
}

// Declared upstream formats for a model (registry `supportedFormats`). Drives the
// per-model guard on the sourceFormat-matched transport; null when undeclared.
export function getModelSupportedFormats(aliasOrId, modelId) {
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  return modelSupportedFormats(findModel(models, modelId, alias));
}

export function getModelType(aliasOrId, modelId) {
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, alias);
  return found?.kind || found?.type || null;
}

export function getModelUpstreamId(aliasOrId, modelId) {
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  // Split off thinking suffix "(level)" so lookup hits the base id; re-append it to
  // the result so downstream applyThinking still sees the suffix (body.model is stripped separately).
  const sufMatch = typeof modelId === "string" ? modelId.match(/\([^()]+\)\s*$/) : null;
  const suffix = sufMatch ? sufMatch[0] : "";
  const baseId = suffix ? modelId.slice(0, sufMatch.index).trim() : modelId;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  const found = findModel(models, baseId, alias);
  const resolvedId = found?.upstreamModelId || found?.id;
  if (resolvedId) {
    const presetMatch = resolvedId.match(/\([^()]+\)\s*$/);
    const presetSuffix = presetMatch?.[0] || "";
    const resolvedBase = presetSuffix ? resolvedId.slice(0, presetMatch.index).trim() : resolvedId;
    return resolvedBase + (suffix || presetSuffix);
  }
  if (alias === "cx" && typeof baseId === "string" && baseId.endsWith(CODEX_REVIEW_SUFFIX)) {
    return baseId.slice(0, -CODEX_REVIEW_SUFFIX.length) + suffix;
  }
  return baseId + suffix;
}

export function getModelQuotaFamily(aliasOrId, modelId) {
  const alias = PROVIDER_ID_TO_ALIAS[aliasOrId] || aliasOrId;
  const models = PROVIDER_MODELS[alias] || PROVIDER_MODELS[aliasOrId];
  return modelQuotaFamily(findModel(models, modelId, alias));
}

// OAuth short aliases — derived from registry `alias` (single source). everything else: alias = id.
// vertex/vertex-partner keep alias=id (kept via the `|| id` fallback in consumers).
export const OAUTH_ALIASES = Object.fromEntries(
  REGISTRY.filter(r => r.alias && r.alias !== r.id).map(r => [r.id, r.alias])
);

// Derived from PROVIDERS — no need to maintain manually
export const PROVIDER_ID_TO_ALIAS = Object.fromEntries(
  Object.keys(PROVIDERS).map(id => [id, OAUTH_ALIASES[id] || id])
);

export function getModelsByProviderId(providerId) {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return PROVIDER_MODELS[alias] || [];
}

// Get strip list for a model entry (explicit opt-in only)
// Returns array of content types to strip, e.g. ["image", "audio"]
export function getModelStrip(alias, modelId) {
  return modelStrip(findModel(PROVIDER_MODELS[alias], modelId, alias));
}
