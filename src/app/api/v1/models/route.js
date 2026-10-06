import { PROVIDER_MODELS, PROVIDER_ID_TO_ALIAS, getModelKind } from "@/shared/constants/models";
import {
  ALIAS_TO_ID,
  AI_PROVIDERS,
  getProviderAlias,
  isAnthropicCompatibleProvider,
  isOpenAICompatibleProvider,
} from "@/shared/constants/providers";
import { getProviderConnections, getCombos, getCustomModels, getModelAliases, getApiKeyByValue, getSettings } from "@/lib/localDb";
import { extractApiKey } from "@/sse/services/auth.js";
import { getListedModels as getOpencodeCatalog } from "@/lib/opencodeCatalog";
import { parseModel } from "@/sse/services/model.js";
import { getDisabledModels } from "@/lib/disabledModelsDb";
import { getApiKeyScopeByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { filterModelsByScope } from "@/lib/scopeModelsFilter.js";
import { getEnabledModels } from "@/lib/enabledModelsDb";
import { getKeyAccessContext, filterModelsListForKey } from "@/sse/services/keyAccess.js";
import { resolveKiroModels } from "open-sse/services/kiroModels.js";
import { resolveKimchiModels } from "open-sse/services/kimchiModels.js";
import { resolveQoderModels, routableQoderModels } from "open-sse/services/qoderModels.js";
import { resolveCopilotModels } from "open-sse/services/copilotModels.js";
import { resolveClinepassModels, resolveClineModels } from "open-sse/services/clinepassModels.js";
import { resolveGrokCliModels } from "open-sse/services/grokCliModels.js";
import { resolveCursorModels } from "open-sse/services/cursorModels.js";
import { resolveZedModels } from "open-sse/shared/zedAuth.js";
import REGISTRY from "open-sse/providers/registry/index.js";
import { updateProviderCredentials } from "@/sse/services/tokenRefresh";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { capabilitiesFromServiceKind, getCapabilitiesForModel, withDeclaredCapabilities, aggregateComboCapabilities, DEFAULT_CAPABILITIES } from "open-sse/providers/capabilities.js";
import { FILTERS } from "@/app/api/providers/suggested-models/filters.js";
import { findCustomModelCaps } from "@/lib/customModelCaps.js";

// Qoder shares one live resolver across intl (qoder) and CN (qoder-cn); the
// credentials carry the provider id so qoderModels picks the right region's
// catalog endpoint.
async function resolveQoderLiveModels(conn, provider) {
  const result = await resolveQoderModels({
    provider,
    accessToken: conn.accessToken,
    // PAT (pt-...) connections keep the token in apiKey; without it the live
    // catalog silently fails and /v1/models falls back to the static list.
    apiKey: conn.apiKey,
    refreshToken: conn.refreshToken,
    email: conn.email,
    displayName: conn.displayName,
    providerSpecificData: conn.providerSpecificData || {}
  });
  // Visible + hidden (enable:false) catalog keys — chat routes all of them.
  const models = routableQoderModels(result);
  if (!models.length) return null;
  return { models: models.map((m) => ({ id: m.id, name: m.name })) };
}

// Combo seats use UI aliases; the model registry also has transport aliases.
// Capability overrides and catalog limits are keyed by provider id.
const ALIAS_TO_PROVIDER_ID = {
  ...Object.fromEntries(
    Object.entries(PROVIDER_ID_TO_ALIAS).map(([id, alias]) => [alias, id])
  ),
  ...ALIAS_TO_ID,
};

function comboSeatCapabilities(seat) {
  const slash = seat.indexOf("/");
  if (slash <= 0) return null;
  const alias = seat.slice(0, slash);
  return getCapabilitiesForModel(ALIAS_TO_PROVIDER_ID[alias] || alias, seat.slice(slash + 1));
}

// Per-provider live model resolvers. Each receives a connection record and
// returns { models: [{ id, name? }, ...] } | null on failure.
// Adding a provider here makes /v1/models prefer the live catalog for it.
const LIVE_MODEL_RESOLVERS = {
  kiro: async (conn) => {
    const result = await resolveKiroModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  qoder: async (conn) => resolveQoderLiveModels(conn, "qoder"),
  "qoder-cn": async (conn) => resolveQoderLiveModels(conn, "qoder-cn"),
  kimchi: async (conn) => {
    const result = await resolveKimchiModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
      providerSpecificData: conn.providerSpecificData || {}
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  },
  github: async (conn) => {
    const result = await resolveCopilotModels({
      accessToken: conn.accessToken,
      refreshToken: conn.refreshToken,
      providerSpecificData: conn.providerSpecificData || {}
    }, {
      log: console,
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          copilotToken: refreshed.copilotToken,
          copilotTokenExpiresAt: refreshed.copilotTokenExpiresAt,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  clinepass: async (conn) => {
    const result = await resolveClinepassModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cline: async (conn) => {
    const result = await resolveClineModels({
      accessToken: conn.accessToken,
      apiKey: conn.apiKey,
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  "grok-cli": async (conn) => {
    const proxy = await resolveConnectionProxyConfig(conn.providerSpecificData || {});
    const result = await resolveGrokCliModels({
      ...conn,
      connectionId: conn.id,
    }, {
      log: console,
      proxyOptions: {
        connectionProxyEnabled: proxy.connectionProxyEnabled === true,
        connectionProxyUrl: proxy.connectionProxyUrl || "",
        connectionNoProxy: proxy.connectionNoProxy || "",
        vercelRelayUrl: proxy.vercelRelayUrl || "",
        strictProxy: proxy.strictProxy === true,
      },
      onCredentialsRefreshed: async (refreshed) => {
        await updateProviderCredentials(conn.id, {
          ...refreshed,
          existingProviderSpecificData: conn.providerSpecificData || {},
        });
      },
    });
    return result?.models?.length ? { models: result.models } : null;
  },
  cursor: async (conn) => {
    const result = await resolveCursorModels({
      accessToken: conn.accessToken,
      providerSpecificData: conn.providerSpecificData || {},
    }, { log: console });
    return result?.models?.length ? { models: result.models } : null;
  }
};

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};

// Header sent by fetchCompatibleModelIds to detect cross-instance /models fetches
// and break recursive loops between 9router instances connected to each other.
const INTERNAL_MODELS_FETCH_HEADER = "x-9r-internal-models-fetch";

// LLM kind sentinel — combos/models with no explicit kind default to LLM
const LLM_KIND = "llm";

// Map per-model `type` field (in PROVIDER_MODELS) to service kind.
// Models without `type` are treated as LLM.
const MODEL_TYPE_TO_KIND = {
  image: "image",
  tts: "tts",
  embedding: "embedding",
  stt: "stt",
  imageToText: "imageToText",
  video: "video",
};

function modelKind(model) {
  const k = model?.kind || model?.type;
  if (!k) return LLM_KIND;
  return MODEL_TYPE_TO_KIND[k] || LLM_KIND;
}

// For dynamic/unknown model IDs (compatible providers, alias map, custom models)
// fall back to provider-level kind matching when per-model type is unavailable.
function inferKindFromUnknownModelId(modelId) {
  const lower = String(modelId).toLowerCase();
  if (/embed/.test(lower)) return "embedding";
  if (/tts|speech|audio|voice/.test(lower)) return "tts";
  if (/image|imagen|dall-?e|flux|sdxl|sd-|stable-diffusion/.test(lower)) return "image";
  return LLM_KIND;
}

export async function fetchCompatibleModelIds(connection) {
  if (!connection?.apiKey) return [];

  const baseUrl = typeof connection?.providerSpecificData?.baseUrl === "string"
    ? connection.providerSpecificData.baseUrl.trim().replace(/\/$/, "")
    : "";

  if (!baseUrl) return [];

  let url = `${baseUrl}/models`;
  const headers = {
    "Content-Type": "application/json",
  };

  if (isOpenAICompatibleProvider(connection.provider)) {
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else if (isAnthropicCompatibleProvider(connection.provider)) {
    if (url.endsWith("/messages/models")) {
      url = url.slice(0, -9);
    } else if (url.endsWith("/messages")) {
      url = `${url.slice(0, -9)}/models`;
    }
    headers["x-api-key"] = connection.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers.Authorization = `Bearer ${connection.apiKey}`;
  } else {
    return [];
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, {
      method: "GET",
      headers: { ...headers, [INTERNAL_MODELS_FETCH_HEADER]: "1" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) return [];

    const data = await response.json();
    const rawModels = parseOpenAIStyleModels(data);

    return Array.from(
      new Set(
        rawModels
          .map((model) => model?.id || model?.name || model?.model)
          .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "")
      )
    );
  } catch {
    return [];
  }
}

// Provider matches kindFilter when its serviceKinds intersect the requested kinds.
// LLM is the default kind for providers missing serviceKinds.
function providerMatchesKinds(providerId, kindFilter) {
  const provider = AI_PROVIDERS[providerId];
  const kinds = Array.isArray(provider?.serviceKinds) && provider.serviceKinds.length > 0
    ? provider.serviceKinds
    : [LLM_KIND];
  return kindFilter.some((k) => kinds.includes(k));
}

// Combo matches kindFilter when its `kind` field is in the list.
// Combos with no kind are treated as LLM.
function comboMatchesKinds(combo, kindFilter) {
  const kind = combo?.kind || LLM_KIND;
  return kindFilter.includes(kind);
}

// Nested combo names are valid seats — the model selector exposes them and
// chat routing resolves them recursively — but a no-slash seat is otherwise
// treated as a literal model and publishes the 200k floor. Expand nested
// names (cycle-guarded) so the published window is the true min across the
// whole chain.
export function comboSeatLimits(combo, combosByName, activeConnectionByProvider = null, visiting = new Set()) {
  const name = typeof combo?.name === "string" ? combo.name : null;
  if (name) {
    if (visiting.has(name)) return { contextWindow: undefined, maxOutput: undefined };
    visiting.add(name);
  }

  // Filter seats to active providers when connection records are available.
  // ponytail: only checks provider-level activation, not per-model enabledModels; add per-model filter if combos mix enabled/disabled models on one account.
  const seats = Array.isArray(combo?.models) ? combo.models : [];
  const hasActiveFilter = activeConnectionByProvider && activeConnectionByProvider.size > 0;
  const isSeatActive = (seat) => {
    if (!hasActiveFilter || typeof seat !== "string") return true;
    const slash = seat.indexOf("/");
    if (slash <= 0) return true;
    const alias = seat.slice(0, slash);
    const providerId = ALIAS_TO_PROVIDER_ID[alias] || alias;
    return activeConnectionByProvider.has(providerId);
  };
  const activeSeats = hasActiveFilter ? seats.filter(isSeatActive) : seats;
  const candidateSeats = activeSeats.length > 0 ? activeSeats : seats;

  let contextWindow = Infinity;
  let maxOutput = Infinity;
  try {
    for (const seat of candidateSeats) {
      if (typeof seat !== "string") continue;
      const slash = seat.indexOf("/");
      if (slash <= 0) {
        const nested = combosByName.get(seat);
        if (nested) {
          const nestedLimits = comboSeatLimits(nested, combosByName, activeConnectionByProvider, visiting);
          if (Number.isFinite(nestedLimits.contextWindow)) contextWindow = Math.min(contextWindow, nestedLimits.contextWindow);
          if (Number.isFinite(nestedLimits.maxOutput)) maxOutput = Math.min(maxOutput, nestedLimits.maxOutput);
          continue;
        }
      }
      const caps = comboSeatCapabilities(seat) || getCapabilitiesForModel(null, seat);
      if (Number.isFinite(caps?.contextWindow)) contextWindow = Math.min(contextWindow, caps.contextWindow);
      if (Number.isFinite(caps?.maxOutput)) maxOutput = Math.min(maxOutput, caps.maxOutput);
    }
  } finally {
    if (name) visiting.delete(name);
  }

  return {
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : undefined,
    maxOutput: Number.isFinite(maxOutput) ? maxOutput : undefined,
  };
}

function comboToEntry(combo, comboByName, combosByName, activeConnectionByProvider = null) {
  const entry = {
    id: combo.name,
    object: "model",
    owned_by: "combo",
  };
  if (combo.kind === "webSearch" || combo.kind === "webFetch") {
    entry.kind = combo.kind;
  } else {
    const comboCaps = aggregateComboCapabilities(combo.models, comboByName, comboSeatCapabilities);
    if (comboCaps) entry.capabilities = comboCaps;
    // Any seat can serve the request, so the only window a combo can promise is
    // its smallest. Combo entries were the only models on this endpoint that
    // published no limits at all, which leaves a client to guess from the name —
    // and it guesses high (see the snake_case note on the per-provider path).
    const { contextWindow, maxOutput } = comboSeatLimits(combo, combosByName, activeConnectionByProvider);
    if (Number.isFinite(contextWindow)) entry.context_length = contextWindow;
    if (Number.isFinite(maxOutput)) entry.max_completion_tokens = maxOutput;
  }
  return entry;
}

// Live model ids for noAuth providers (OpenCode Free, mimo-free, …). The
// browser-side helper (shared/utils/providerModelsFetcher) fetches a relative
// URL and can't run inside a route handler, so hit the provider's public
// endpoint directly, through the same FILTERS as /api/providers/suggested-models.
const noAuthIdsCache = new Map(); // url → { ids, expiresAt }
const NO_AUTH_IDS_TTL_MS = 10 * 60 * 1000;

async function fetchNoAuthModelIds(fetcher) {
  if (!fetcher?.url || !fetcher?.type) return [];
  const hit = noAuthIdsCache.get(fetcher.url);
  if (hit && Date.now() < hit.expiresAt) return hit.ids;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(fetcher.url, { cache: "no-store", signal: controller.signal });
    clearTimeout(timeoutId);
    if (!res.ok) return [];
    const json = await res.json();
    const raw = json.data ?? json.models ?? json;
    const filter = FILTERS[fetcher.type];
    if (!filter) return [];
    const ids = (filter(Array.isArray(raw) ? raw : []) || [])
      .map((m) => m?.id)
      .filter((id) => typeof id === "string" && id.trim() !== "");
    noAuthIdsCache.set(fetcher.url, { ids, expiresAt: Date.now() + NO_AUTH_IDS_TTL_MS });
    return ids;
  } catch {
    return [];
  }
}

/**
 * Build OpenAI-format models list filtered by service kinds.
 * @param {string[]} kindFilter - List of service kinds to include (e.g. ["llm"], ["webSearch","webFetch"]).
 */
export async function buildModelsList(kindFilter, options = {}) {
  // When this header is present, the /v1/models request came from another
  // 9router instance's fetchCompatibleModelIds — skip dynamic fetch to break
  // cross-instance recursive loops.
  const skipDynamicFetch = options.skipDynamicFetch === true;
  let connections = [];
  let connectionsFailed = false;
  try {
    connections = await getProviderConnections();
    connections = connections.filter(c => c.isActive !== false);
  } catch (e) {
    connectionsFailed = true;
    console.log("Could not fetch providers, returning all models");
  }

  let combos = [];
  try {
    combos = await getCombos();
  } catch (e) {
    console.log("Could not fetch combos");
  }
  // Lookup map so aggregateComboCapabilities can recursively resolve nested combos
  const comboByName = Object.fromEntries(combos.map((c) => [c.name, c.models]));

  let settings = {};
  try {
    settings = await getSettings();
  } catch (e) {
    console.log("Could not fetch settings, using defaults");
  }
  if (settings.exposeComboOnly) {
    const seenModelIds = new Set();
    const comboOnlyModels = [];
    for (const combo of combos) {
      if (!comboMatchesKinds(combo, kindFilter)) continue;
      const entry = comboToEntry(combo, comboByName);
      if (seenModelIds.has(entry.id)) continue;
      seenModelIds.add(entry.id);
      comboOnlyModels.push(entry);
    }
    return comboOnlyModels;
  }

  let customModels = [];
  try {
    customModels = await getCustomModels();
  } catch (e) {
    console.log("Could not fetch custom models");
  }

  let modelAliases = {};
  try {
    modelAliases = await getModelAliases();
  } catch (e) {
    console.log("Could not fetch model aliases");
  }

  let disabledByAlias = {};
  try {
    disabledByAlias = await getDisabledModels();
  } catch (e) {
    console.log("Could not fetch disabled models");
  }
  const isDisabled = (alias, modelId) => Array.isArray(disabledByAlias[alias]) && disabledByAlias[alias].includes(modelId);

  let enabledByAlias = {};
  try {
    enabledByAlias = await getEnabledModels();
  } catch (e) {
    console.log("Could not fetch enabled models");
  }

  // Visible-model allowlist for one provider. The provider page writes it per
  // alias (`/api/models/enabled`); a hand-set
  // `providerSpecificData.enabledModels` still wins only when the provider-level
  // allowlist is absent. Returns [] when the provider is unrestricted.
  //
  // This is what makes "only these models are visible" work for providers with a
  // live catalog (github/kiro/qoder/...): their registry list lags upstream, so a
  // blacklist can never name the catalog-only ids — only an allowlist can.
  const resolveEnabledModels = (providerId, conn) => {
    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const outputAlias = (
      conn?.providerSpecificData?.prefix
      || getProviderAlias(providerId)
      || staticAlias
    ).trim();

    const candidates = [
      enabledByAlias[outputAlias],
      enabledByAlias[staticAlias],
      enabledByAlias[providerId],
      conn?.providerSpecificData?.enabledModels,
    ];

    for (const candidate of candidates) {
      if (!Array.isArray(candidate)) continue;
      const ids = Array.from(
        new Set(candidate.filter((id) => typeof id === "string" && id.trim() !== ""))
      );
      if (ids.length > 0) return ids;
    }
    return [];
  };

  const activeConnectionByProvider = new Map();
  for (const conn of connections) {
    if (conn.isActive && !activeConnectionByProvider.has(conn.provider)) {
      activeConnectionByProvider.set(conn.provider, conn);
    }
  }

  const models = [];
  const combosByName = new Map(
    combos.filter((c) => typeof c?.name === "string").map((c) => [c.name, c]),
  );

  // Combos first (filtered by kind). Web combos expose `kind` so AI knows search vs fetch.
  for (const combo of combos) {
    if (!comboMatchesKinds(combo, kindFilter)) continue;
    const entry = comboToEntry(combo, comboByName, combosByName, activeConnectionByProvider);
    models.push(entry);
  }

  if (connections.length === 0) {
    // No configured connections. When the DB itself is unavailable we degrade
    // to the full static catalog; when the DB is healthy but empty (fresh
    // install) only connection-less noAuth providers are listed — those work
    // with zero setup — so clients auto-detecting models don't see hundreds of
    // entries that would all reject their requests.
    const noAuthProviderIds = new Set();
    if (!connectionsFailed) {
      for (const entry of REGISTRY) {
        if (entry.noAuth === true || entry.transport?.noAuth === true) {
          noAuthProviderIds.add(entry.id);
        }
      }
    }
    for (const [alias, providerModels] of Object.entries(PROVIDER_MODELS)) {
      const providerId = ALIAS_TO_PROVIDER_ID[alias] || alias;
      if (!providerMatchesKinds(providerId, kindFilter)) continue;
      if (!connectionsFailed && !noAuthProviderIds.has(providerId)) continue;
      const enabledModels = resolveEnabledModels(providerId, null);
      for (const model of providerModels) {
        if (!kindFilter.includes(modelKind(model))) continue;
        if (enabledModels.length > 0 && !enabledModels.includes(model.id)) continue;
        if (isDisabled(alias, model.id)) continue;
        models.push({
          id: `${alias}/${model.id}`,
          object: "model",
          owned_by: alias,
          capabilities: { ...getCapabilitiesForModel(providerId, model.id), ...findCustomModelCaps(customModels, [alias, providerId], model.id) },
        });
      }
    }

    for (const customModel of customModels) {
      if (!customModel?.id || (customModel.type && customModel.type !== "llm")) continue;
      // Custom models without active connection are LLM-only by current schema
      if (!kindFilter.includes(LLM_KIND)) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId) continue;

      models.push({
        id: `${providerAlias}/${modelId}`,
        object: "model",
        owned_by: providerAlias,
      });
    }
  } else {
    for (const [providerId, conn] of activeConnectionByProvider.entries()) {
      if (!providerMatchesKinds(providerId, kindFilter)) continue;

      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      const providerModels = PROVIDER_MODELS[staticAlias] || [];
      const enabledModels = resolveEnabledModels(providerId, conn);
      const hasExplicitEnabledModels = enabledModels.length > 0;
      const isCompatibleProvider =
        isOpenAICompatibleProvider(providerId) || isAnthropicCompatibleProvider(providerId);

      // Build kind lookup for static models so we can filter even when only IDs are exposed
      const staticModelKindById = new Map(
        providerModels.map((m) => [m.id, modelKind(m)])
      );
      let liveModelKindById = new Map();
      let liveCapabilitiesById = new Map();

      let rawModelIds = hasExplicitEnabledModels
        ? enabledModels
        : providerModels.map((model) => model.id);

      // Check if user has manually added custom models for this compatible provider.
      // If so, skip dynamic /models fetch — only expose user-curated models.
      const hasProviderCustomModels = isCompatibleProvider && customModels.some((m) => {
        if (!m?.id) return false;
        const a = m.providerAlias;
        return a === staticAlias || a === outputAlias || a === providerId;
      });

      if (isCompatibleProvider && rawModelIds.length === 0 && !hasProviderCustomModels && !skipDynamicFetch) {
        rawModelIds = await fetchCompatibleModelIds(conn);
      }

      // Config-driven live catalog override (e.g. Kiro returns dynamic
      // -thinking/-agentic variants per account). On failure, fall back to
      // whatever rawModelIds already holds.
      const liveResolver = LIVE_MODEL_RESOLVERS[providerId];
      if (liveResolver && !hasExplicitEnabledModels) {
        try {
          const live = await liveResolver(conn);
          if (live?.models?.length) {
            rawModelIds = live.models.map((m) => m.id);
            liveModelKindById = new Map(
              live.models
                .filter((m) => m?.id)
                .map((m) => [m.id, modelKind(m)])
            );
            liveCapabilitiesById = new Map(
              live.models
                .filter((m) => m?.id && m.capabilities)
                .map((m) => [m.id, m.capabilities])
            );
          }
        } catch (err) {
          console.log(`Live model fetch failed for ${providerId}: ${err?.message || err}`);
        }
      }

      const modelIds = rawModelIds
        .map((modelId) => {
          if (modelId.startsWith(`${outputAlias}/`)) {
            return modelId.slice(outputAlias.length + 1);
          }
          if (modelId.startsWith(`${staticAlias}/`)) {
            return modelId.slice(staticAlias.length + 1);
          }
          if (modelId.startsWith(`${providerId}/`)) {
            return modelId.slice(providerId.length + 1);
          }
          return modelId;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const customModelKindById = new Map();
      // User-declared per-model capabilities from the dashboard (kv customModels
      // "caps"). These are explicit statements about a model the operator added
      // by hand, so they must win over the pattern-matched guesses below —
      // otherwise a hand-declared "vision: true" is silently overwritten by a
      // PATTERN_CAPABILITIES match and /v1/models reports the model as text-only.
      const customModelCapsById = new Map();
      const customModelIds = customModels
        .filter((m) => {
          if (!m?.id) return false;
          const kind = getModelKind(m) || LLM_KIND;
          // imageToText custom models are vision-capable chat models: expose them
          // both in the default LLM list and in /v1/models/image-to-text.
          if (!kindFilter.includes(kind) && !(kind === "imageToText" && kindFilter.includes(LLM_KIND))) return false;
          const alias = m.providerAlias;
          return alias === staticAlias || alias === outputAlias || alias === providerId;
        })
        .map((m) => {
          const modelId = String(m.id).trim();
          if (modelId) {
            customModelKindById.set(modelId, getModelKind(m) || LLM_KIND);
            if (m.caps && typeof m.caps === "object") customModelCapsById.set(modelId, m.caps);
          }
          return modelId;
        })
        .filter((modelId) => modelId !== "");

      const aliasModelIds = Object.values(modelAliases || {})
        .filter((fullModel) => {
          if (typeof fullModel !== "string" || !fullModel.includes("/")) return false;
          return (
            fullModel.startsWith(`${outputAlias}/`) ||
            fullModel.startsWith(`${staticAlias}/`) ||
            fullModel.startsWith(`${providerId}/`)
          );
        })
        .map((fullModel) => {
          if (fullModel.startsWith(`${outputAlias}/`)) {
            return fullModel.slice(outputAlias.length + 1);
          }
          if (fullModel.startsWith(`${staticAlias}/`)) {
            return fullModel.slice(staticAlias.length + 1);
          }
          if (fullModel.startsWith(`${providerId}/`)) {
            return fullModel.slice(providerId.length + 1);
          }
          return fullModel;
        })
        .filter((modelId) => typeof modelId === "string" && modelId.trim() !== "");

      const mergedModelIds = Array.from(new Set([...modelIds, ...customModelIds, ...aliasModelIds]));

      for (const modelId of mergedModelIds) {
        // Resolve kind: prefer custom/live metadata, then static, then ID heuristics.
        const customKind = customModelKindById.get(modelId);
        const liveKind = liveModelKindById.get(modelId);
        const kind = customKind || liveKind || staticModelKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
        // imageToText custom models stay in the LLM list (vision-capable chat models)
        const allowAsLlm = kind === "imageToText" && kindFilter.includes(LLM_KIND);
        if (!kindFilter.includes(kind) && !allowAsLlm) continue;
        if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

        const model = {
          id: `${outputAlias}/${modelId}`,
          object: "model",
          owned_by: outputAlias,
        };
        // Live-catalog resolvers (kiro/qoder/github/clinepass) mostly only return
        // { id, name } — no per-model capability data. Fall back to the same
        // pattern-matched capabilities the dashboard uses (useModelCaps.js) so
        // dynamically-discovered LLM models still surface vision/reasoning/search/tools.
        // Priority: live catalog > service kind > pattern-matched guess, with any
        // operator declaration from the dashboard layered on top. The declaration
        // wins because it is first-hand knowledge about a hand-added model, while
        // everything below it is inferred from the model name.
        const inferredCaps = liveCapabilitiesById.get(modelId)
          || capabilitiesFromServiceKind(customKind || liveKind)
          || (kind === LLM_KIND ? getCapabilitiesForModel(providerId, modelId) : null);
        const caps = withDeclaredCapabilities(inferredCaps, customModelCapsById.get(modelId));
        if (caps) model.capabilities = caps;
        // Token limits under the snake_case names the OpenAI/OpenRouter
        // convention uses. `capabilities.contextWindow` is camelCase and nested,
        // so clients matching context_length find nothing, fall back to guessing
        // the window from the model name, and guess high — a 372k model read as
        // 1.05M never reaches its compaction threshold and hard-fails upstream.
        // Emitted at top level because not every client recurses into nested
        // objects; the camelCase `capabilities` block stays for compatibility.
        if (kind === LLM_KIND || allowAsLlm) {
          let contextWindow = caps?.contextWindow;
          let maxOutput = caps?.maxOutput;
          // Live-catalog and service-kind capabilities are usually partial
          // (often just { tools: true }), so fill the gaps from the static
          // table rather than emitting null and leaving clients to guess.
          if (!Number.isFinite(contextWindow) || !Number.isFinite(maxOutput)) {
            const fallback = getCapabilitiesForModel(providerId, modelId);
            if (!Number.isFinite(contextWindow)) contextWindow = fallback.contextWindow;
            if (!Number.isFinite(maxOutput)) maxOutput = fallback.maxOutput;
          }
          if (Number.isFinite(contextWindow)) model.context_length = contextWindow;
          if (Number.isFinite(maxOutput)) model.max_completion_tokens = maxOutput;
        }
        models.push(model);
      }

      // Web search/fetch — provider IS the model, expose as {alias}/search and/or {alias}/fetch with explicit kind
      const providerInfo = AI_PROVIDERS[providerId];
      if (kindFilter.includes("webSearch") && providerInfo?.searchConfig) {
        models.push({
          id: `${outputAlias}/search`,
          object: "model",
          kind: "webSearch",
          owned_by: outputAlias,
        });
      }
      if (kindFilter.includes("webFetch") && providerInfo?.fetchConfig) {
        models.push({
          id: `${outputAlias}/fetch`,
          object: "model",
          kind: "webFetch",
          owned_by: outputAlias,
        });
      }
    }
  }


  // noAuth providers never get a connection row, so the connection loop above
  // can't see them — yet their models route with zero credentials. Publish them
  // (static registry ids + the provider's public modelsFetcher, cached), or
  // OpenAI-compatible clients (Zed, ACP agents, …) see a near-empty
  // /v1/models while /v1/chat/completions works fine for the same models.
  for (const [providerId, provider] of Object.entries(AI_PROVIDERS)) {
    if (provider?.noAuth !== true) continue;
    // hidden = retired/free-ended upstreams (mimo-free, mmf, …) the registry
    // keeps only for routing legacy ids — publishing them makes pickers offer
    // models whose upstream now answers 400 "Unsupported model".
    if (provider?.hidden === true) continue;
    if (activeConnectionByProvider.has(providerId)) continue;
    if (!providerMatchesKinds(providerId, kindFilter)) continue;

    const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
    const outputAlias = (getProviderAlias(providerId) || staticAlias).trim();
    const providerModels = PROVIDER_MODELS[staticAlias] || [];

    let rawModelIds = providerModels.map((model) => model.id);
    // passthroughModels providers (OpenCode Free, …) keep only overrides in the
    // static registry — the full list lives on the public modelsFetcher endpoint.
    const needsLiveIds =
      provider.modelsFetcher &&
      (provider.passthroughModels === true || rawModelIds.length === 0);
    if (needsLiveIds && !skipDynamicFetch) {
      const liveIds = await fetchNoAuthModelIds(provider.modelsFetcher);
      rawModelIds = Array.from(new Set([...rawModelIds, ...liveIds]));
    }

    const staticKindById = new Map(providerModels.map((m) => [m.id, modelKind(m)]));
    for (const modelId of rawModelIds) {
      const kind = staticKindById.get(modelId) || inferKindFromUnknownModelId(modelId);
      if (!kindFilter.includes(kind)) continue;
      if (isDisabled(outputAlias, modelId) || isDisabled(staticAlias, modelId)) continue;

      const model = {
        id: `${outputAlias}/${modelId}`,
        object: "model",
        owned_by: outputAlias,
      };
      if (kind === LLM_KIND) {
        const caps = getCapabilitiesForModel(staticAlias, modelId);
        if (caps) model.capabilities = caps;
        if (Number.isFinite(caps?.contextWindow)) model.context_length = caps.contextWindow;
        if (Number.isFinite(caps?.maxOutput)) model.max_completion_tokens = caps.maxOutput;
      }
      models.push(model);
    }
  }
  const dedupedModels = [];
  const seenModelIds = new Set();
  for (const model of models) {
    if (!model?.id || seenModelIds.has(model.id)) continue;
    seenModelIds.add(model.id);
    dedupedModels.push(model);
  }

  // Custom models on connection-less providers (e.g. opencode's noAuth free
  // tier, bazaarlink aliases) never enter the per-connection loop above —
  // they route fine (ACC:Public / passthroughModels) but vanish from
  // /v1/models, so OpenAI-compatible clients that validate against the
  // listing reject or warn on them. Surface them here, once, after the
  // dedupe pass so connection-backed duplicates collapse naturally.
  if (kindFilter.includes(LLM_KIND)) {
    const connectedAliases = new Set();
    for (const conn of connections) {
      const providerId = conn.provider;
      const staticAlias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
      const outputAlias = (
        conn?.providerSpecificData?.prefix
        || getProviderAlias(providerId)
        || staticAlias
      ).trim();
      connectedAliases.add(outputAlias);
      connectedAliases.add(staticAlias);
      connectedAliases.add(providerId);
    }

    for (const customModel of customModels) {
      if (!customModel?.id) continue;
      const kind = getModelKind(customModel) || LLM_KIND;
      // imageToText custom models are vision-capable chat models — include
      // in the LLM list, same as the per-connection branch above.
      const allowAsLlm = kind === "imageToText";
      if (!kindFilter.includes(kind) && !allowAsLlm) continue;
      const providerAlias = customModel.providerAlias;
      if (!providerAlias) continue;
      // Skip providers already handled by the per-connection loop (their
      // custom models are merged there); only backfill the connection-less.
      if (connectedAliases.has(providerAlias)) continue;

      const modelId = String(customModel.id).trim();
      if (!modelId || isDisabled(providerAlias, modelId)) continue;

      const id = `${providerAlias}/${modelId}`;
      if (seenModelIds.has(id)) continue;
      seenModelIds.add(id);

      const model = {
        id,
        object: "model",
        owned_by: providerAlias,
      };
      const caps = getCapabilitiesForModel(providerAlias, modelId);
      if (caps) model.capabilities = caps;
      if (Number.isFinite(caps?.contextWindow)) model.context_length = caps.contextWindow;
      if (Number.isFinite(caps?.maxOutput)) model.max_completion_tokens = caps.maxOutput;
      dedupedModels.push(model);
    }

    // Connection-less providers with a live catalog (opencode free tier) don't
    // even need admin custom-model rows: the catalog IS the source of truth.
    // Without this, new upstream models stayed invisible until an admin added
    // them by hand — the failure mode where free models "work then break".
    const catalogEntries = await getOpencodeCatalog();
    for (const entry of catalogEntries) {
      if (!entry?.id) continue;
      const modelId = String(entry.id).trim();
      if (!modelId) continue;
      if (isDisabled("oc", modelId)) continue;
      const id = `oc/${modelId}`;
      if (seenModelIds.has(id)) continue;
      seenModelIds.add(id);
      const model = {
        id,
        object: "model",
        owned_by: "oc",
      };
      const caps = getCapabilitiesForModel("oc", modelId);
      if (caps) model.capabilities = caps;
      if (Number.isFinite(caps?.contextWindow)) model.context_length = caps.contextWindow;
      if (Number.isFinite(caps?.maxOutput)) model.max_completion_tokens = caps.maxOutput;
      dedupedModels.push(model);
    }
  }

  const apiKey = options.apiKey;
  const allowedModels = apiKey?.allowedModels;
  if (!Array.isArray(allowedModels) || allowedModels.length === 0) return dedupedModels;
  return dedupedModels.filter((model) => allowedModels.includes(model.id));
}

// ── Response cache ───────────────────────────────────────────────────────────
// /v1/models is fetched by CLI tools (opencode, cline, ...) on startup, but
// buildModelsList performs per-provider live catalog calls (compatible /models
// discovery with 5s timeouts each, plus the live resolvers above) sequentially,
// so a single request can block for many seconds on slow networks — clients
// abort on their own shorter timeouts and end up with an empty model picker.
// Cache the last successful build per kind filter and serve it immediately
// while a rebuild refreshes the cache in the background (stale-while-revalidate):
// after the first successful build, no client ever waits on upstream fetches.
const MODELS_CACHE_TTL_MS = 30_000;
const modelsCache = new Map(); // cacheKey -> { data, builtAt, building? }

function modelsCacheKey(kindFilter, skipDynamicFetch, apiKeyId) {
  return `${skipDynamicFetch ? "internal" : "full"}::${apiKeyId || "public"}::${kindFilter.join("|")}`;
}

/**
 * buildModelsList with a short TTL + stale-while-revalidate.
 * @param {string[]} kindFilter - forwarded to buildModelsList
 * @param {{skipDynamicFetch?: boolean, forceFresh?: boolean, apiKey?: object}} options
 *   forceFresh rebuilds synchronously and repopulates the cache instead of
 *   serving stale data (used by exact-model lookups on cache misses).
 */
export async function getCachedModelsList(kindFilter, options = {}) {
  const key = modelsCacheKey(kindFilter, options.skipDynamicFetch === true, options.apiKey?.id);
  const entry = modelsCache.get(key);

  if (options.forceFresh === true) {
    const data = await buildModelsList(kindFilter, options);
    modelsCache.set(key, { data, builtAt: Date.now() });
    return data;
  }

  if (entry?.building) {
    // A rebuild is already in flight: return the current list immediately when
    // one exists, otherwise wait for the in-flight build to finish.
    return entry.data ?? entry.building;
  }

  if (entry && Date.now() - entry.builtAt < MODELS_CACHE_TTL_MS) {
    return entry.data;
  }

  const building = buildModelsList(kindFilter, options)
    .then((data) => {
      // A failed rebuild can come back as a legitimately-parsed but empty list
      // (buildModelsList swallows per-source DB errors). Don't let a transient
      // failure blank out a non-empty cached list — keep serving stale data.
      const current = modelsCache.get(key);
      const hasUsableCache = Array.isArray(current?.data) && current.data.length > 0;
      if (data.length === 0 && hasUsableCache) {
        return current.data;
      }
      modelsCache.set(key, { data, builtAt: Date.now() });
      return data;
    })
    .catch((err) => {
      // Hard failure: keep serving the previous list and drop the in-flight
      // marker so the next request retries.
      const current = modelsCache.get(key);
      if (current?.data) modelsCache.set(key, { data: current.data, builtAt: current.builtAt });
      else modelsCache.delete(key);
      throw err;
    });

  modelsCache.set(key, entry ? { ...entry, building } : { data: null, builtAt: 0, building });

  if (entry) {
    // Stale but usable: refresh in the background, answer with the old list now.
    building.catch(() => {});
    return entry.data;
  }

  return building;
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    // Detect cross-instance recursive /models fetch (another 9router fetching our /models)
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";
    const policy = await getModelListPolicy(request);
    if (policy.error) return Response.json({ error: { message: "Invalid API key", type: "authentication_error" } }, { status: 401, headers: { "Access-Control-Allow-Origin": "*" } });
    const rawData = await getCachedModelsList([LLM_KIND], { skipDynamicFetch, apiKey: policy.key });
    const apiKey = extractApiKey(request);
    const scope = apiKey ? await getApiKeyScopeByKey(apiKey) : null;
    const scoped = filterModelsByScope(rawData, scope);
    const data = await filterModelsListForKey(
      await getKeyAccessContext(request),
      scoped
    );

    // Format models array for Codex CLI / Desktop model catalog parser
    const codexModels = [];
    const seenSlugs = new Set();
    const addCodexModel = (slug, m) => {
      if (!slug || seenSlugs.has(slug)) return;
      seenSlugs.add(slug);
      const ctx = m.context_length || m.capabilities?.contextWindow || 272000;
      // Auto-compact at 75% to keep sufficient headroom before hard provider limits
      const compactLimit = Math.floor(ctx * 0.75);
      codexModels.push({
        slug,
        id: slug,
        display_name: slug,
        description: m.description || "",
        context_window: ctx,
        max_context_window: ctx,
        auto_compact_token_limit: compactLimit,
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        shell_type: "unified_exec",
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        web_search_tool_type: "text_and_image",
        input_modalities: ["text", "image"],
        supports_image_detail_original: true,
        truncation_policy: { mode: "tokens", limit: 10000 },
        supports_parallel_tool_calls: true,
        tool_mode: "code_mode_only",
        multi_agent_version: "v2",
        multi_agent_reasoning_effort: "xhigh",
        use_responses_lite: true,
        supports_reasoning_effort_updates: true,
        supports_reasoning_summary_parameter: true,
        supports_reasoning_summaries: true,
        supports_search_tool: true,
        prefer_websockets: false,
        default_reasoning_summary: "none",
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Fast responses with lighter reasoning" },
          { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
          { effort: "high", description: "Greater reasoning depth for complex problems" },
          { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
          { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        ],
        experimental_supported_tools: ["send_user_message_async", "clock"],
        base_instructions: "You are Codex, a coding agent.",
        model_messages: {
          instructions_template: "You are Codex, a coding agent.",
        },
      });
    };

    for (const m of data) {
      addCodexModel(m.id, m);
      if (typeof m.id === "string" && m.id.includes("/")) {
        addCodexModel(m.id.slice(m.id.indexOf("/") + 1), m);
      }
    }

    return Response.json({ object: "list", data, models: codexModels }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}

async function getModelListKey(request) {
  const keyValue = extractApiKey(request);
  if (!keyValue) return { present: false, key: null };
  const key = await getApiKeyByValue(keyValue);
  const expired = key?.expiresAt && new Date(key.expiresAt).getTime() <= Date.now();
  return { present: true, key: key?.isActive && !expired ? key : null };
}

export async function getModelListPolicy(request) {
  const settings = await getSettings();
  const result = await getModelListKey(request);
  if ((settings.requireApiKey && !result.key) || (result.present && !result.key)) return { error: true };
  return { key: result.key };
}
