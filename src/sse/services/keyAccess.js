// Per-API-key access control for the /v1/* inference keys.
//
// Two modes per key: UNRESTRICTED (default — exactly today's behaviour) or
// RESTRICTED, where the key may call ONLY the combos and models in its allow
// list. No wildcards, no deny mode. Matching is exact and case-insensitive, on
// RESOLVED identities, so every spelling that routes to the same target is
// treated the same and no spelling can route somewhere the list does not name:
//
//   * a request that routes as a combo (getComboModels — the lookup routing
//     itself uses) is allowed iff that combo's name is listed;
//   * a request that routes to a model is allowed iff its resolved
//     `providerId/model` equals the resolved `providerId/model` of a listed
//     model entry. So `cx/gpt-5`, `codex/gpt-5` and an alias that points there
//     are one target; a raw string that merely looks like a listed entry but
//     routes elsewhere (e.g. `MAIN` when the combo is `Main`, which routes to
//     `openai/MAIN`) is not;
//   * search/fetch (provider IS the model) are allowed iff the resolved
//     provider id is listed, or the request is a listed combo.
//
// An allowed combo grants its members when they are reached THROUGH that combo
// (the check runs once, on the requested target, before combo expansion). It
// does not grant calling a member directly by name — that needs its own entry.
// The check runs before any credential lookup, so a denied request never
// touches a provider account.
//
// Identity: a request may present several credentials (Claude Code sends a
// foreign Bearer alongside its x-api-key, and the request is authenticated if
// ANY of them is a valid key). Access follows the same rule:
// only presented keys that are known AND active count; none → unrestricted
// (no-key behaviour, gated by the middleware / requireApiKey); any unrestricted
// → unrestricted; otherwise restricted to the UNION of their allow lists.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getAdapter } from "@/lib/db/driver.js";
import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getModelInfo, getComboModels } from "./model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import {
  KEY_ACCESS_COMBO_OWNER,
  KEY_ACCESS_PROVIDER_AS_MODEL_KINDS,
  keyAccessDeniedMessage,
  keyAccessWildcardProvider,
} from "@/shared/constants/keyAccess.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { extractApiKeyCandidates } from "@/shared/utils/apiKeyCandidates.js";
import { normalizeAllowList } from "@/shared/utils/keyAccess.js";
import * as log from "../utils/logger.js";

const lower = (s) => String(s).toLowerCase();
const canonicalModel = (provider, model) => lower(`${provider}/${model}`);

/**
 * The first client credential, read by the shared helper the middleware and the
 * handlers use (src/shared/utils/apiKeyCandidates.js). Kept for callers that
 * only log; access decisions use every candidate (getKeyAccessContext).
 */
export function extractClientApiKey(request) {
  return extractApiKeyCandidates(request)[0] || null;
}

/**
 * Access context for the request, or null when the request is unrestricted.
 *
 * Every presented credential is a candidate (Bearer, x-api-key, x-goog-api-key,
 * ?key=); only those that are known, ACTIVE keys count:
 *   - none            → null (unrestricted, exactly the no-key behaviour; whether
 *                       such a request may run at all is the middleware's and
 *                       requireApiKey's decision, not this one)
 *   - any unrestricted → null
 *   - otherwise        → restricted to the UNION of their allow lists.
 * So a junk or foreign Bearer in front of a restricted x-api-key can never make
 * the request unrestricted, and an inactive key never contributes.
 * Keys are only authenticated elsewhere; this only decides what may be called.
 */
export async function getKeyAccessContext(request) {
  const records = [];
  for (const candidate of extractApiKeyCandidates(request)) {
    const record = await getApiKeyByKey(candidate);
    if (record?.isActive === true) records.push(record);
  }
  if (records.length === 0) return null;
  const haAdapter = process.env.NINEROUTER_HA_CONFIG ? (await getAdapter()).ha : null;
  const policies = haAdapter
    ? records.flatMap((r) => haAdapter.policies(r.id)?.filter((p) => p.restricted) || [])
    : [];
  if (records.some((r) => !r.access?.restricted) && !policies.length) return null;
  return {
    keyId: records.map((r) => r.id).join(","),
    keyName: records.map((r) => r.name || r.id).join(","),
    allow: normalizeAllowList(records.flatMap((r) => r.access?.allow || [])),
    haPolicies: policies,
    endpoint: requestPathname(request),
    _sets: null,
  };
}

function requestPathname(request) {
  try {
    return request?.nextUrl?.pathname || new URL(request.url).pathname;
  } catch {
    return null;
  }
}

// Resolve the allow list once per request: combo names, resolved model ids,
// resolved provider ids (for provider-as-model kinds) and "provider/*" grants.
async function getAllowSets(ctx) {
  if (ctx._sets) return ctx._sets;
  if (ctx.haPolicies?.length) {
    const policies = await Promise.all(ctx.haPolicies.map(p => getAllowSets({ allow: p.allow })));
    ctx._sets = Object.fromEntries(['combos', 'models', 'providers'].map(kind => [kind,
      new Set([...policies[0][kind]].filter(value => policies.every(p => p[kind].has(value))))]));
    return ctx._sets;
  }
  const comboNames = new Set((await getCombos()).map((c) => lower(c.name)));
  const combos = new Set();
  const models = new Set();
  const providers = new Set();
  const wholeProviders = new Set();
  for (const entry of ctx.allow) {
    const key = lower(entry);
    if (comboNames.has(key)) {
      combos.add(key);
      continue;
    }
    const wildcard = keyAccessWildcardProvider(entry);
    if (wildcard) {
      // Resolve the prefix the same way a request's "prefix/model" is resolved.
      const info = await getModelInfo(`${wildcard}/_`);
      for (const id of [info?.provider, resolveProviderId(wildcard)]) {
        if (!id) continue;
        wholeProviders.add(lower(id));
        providers.add(lower(id));
      }
      continue;
    }
    const info = await getModelInfo(entry);
    if (info?.provider && info.model) models.add(canonicalModel(info.provider, info.model));
    if (!entry.includes("/")) providers.add(lower(resolveProviderId(entry)));
  }
  ctx._sets = { combos, models, providers, wholeProviders };
  return ctx._sets;
}

function isResolvedModelAllowed(sets, provider, model) {
  return sets.models.has(canonicalModel(provider, model)) || sets.wholeProviders.has(lower(provider));
}

async function isModelStringAllowed(ctx, requested) {
  const sets = await getAllowSets(ctx);
  const info = await getModelInfo(requested);
  // provider null ⇔ an existing combo with no members (routes nowhere).
  if (!info?.provider) return sets.combos.has(lower(requested));
  return isResolvedModelAllowed(sets, info.provider, info.model);
}

// On the Anthropic Messages API the 403 uses Anthropic's error envelope (as the
// 401s do, see authErrorResponse), so Claude Code and the anthropic SDKs
// surface the message. Every other endpoint keeps the OpenAI shape.
export function keyAccessDeniedResponse(ctx, requested) {
  log.warn("AUTH", `key-access: key "${ctx.keyName}" denied "${requested}"`);
  const message = keyAccessDeniedMessage(requested);
  if (ctx.endpoint?.includes("/v1/messages")) {
    return new Response(
      JSON.stringify({ type: "error", error: { type: "permission_error", message } }),
      { status: HTTP_STATUS.FORBIDDEN, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }
  return errorResponse(HTTP_STATUS.FORBIDDEN, message);
}

/**
 * Gate for endpoints whose `model` may be a combo or a model (chat, image, tts).
 * Call with the requested string BEFORE combo expansion.
 * @returns {Promise<Response|null>} a 403 Response, or null when allowed.
 */
export async function enforceKeyAccess(ctx, requested) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const comboModels = await getComboModels(requested);
  const allowed = comboModels
    ? sets.combos.has(lower(requested))
    : await isModelStringAllowed(ctx, requested);
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Gate for endpoints that resolve a single provider/model themselves
 * (embeddings, stt, systemone, video, Gemini-native TTS). A missing model
 * (e.g. a multipart video body we do not parse) is denied for restricted keys:
 * an unverifiable target is not an allowed one.
 */
export async function enforceKeyAccessResolved(ctx, requested, provider, model) {
  if (!ctx) return null;
  const label = requested || (provider ? `${provider}/${model ?? ""}` : "");
  if (!provider || !model) return keyAccessDeniedResponse(ctx, label);
  const sets = await getAllowSets(ctx);
  return isResolvedModelAllowed(sets, provider, model) ? null : keyAccessDeniedResponse(ctx, label);
}

/**
 * Gate for search/fetch, where the provider IS the model.
 * @param {string[]|null} comboModels - routing's own combo resolution for `requested`
 */
export async function enforceKeyAccessProvider(ctx, requested, comboModels) {
  if (!ctx) return null;
  if (typeof requested !== "string" || !requested) return keyAccessDeniedResponse(ctx, String(requested ?? ""));
  const sets = await getAllowSets(ctx);
  const allowed = comboModels
    ? sets.combos.has(lower(requested))
    : sets.providers.has(lower(resolveProviderId(requested)));
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Capacity-adapter models are appended by the gateway, not chosen by the
 * client. For a restricted key keep only the adapter models the key may call
 * directly; the original targets (already gated) are always kept. Dropping a
 * model just shortens the fallback list, so combo failover is unaffected.
 */
export async function filterAdapterModels(ctx, augmented, original) {
  if (!ctx || !Array.isArray(augmented)) return augmented;
  const keep = new Set(original || []);
  const out = [];
  for (const m of augmented) {
    if (keep.has(m) || await isModelStringAllowed(ctx, m)) out.push(m);
    else log.info("AUTH", `key-access: key "${ctx.keyName}" skips adapter model "${m}" (not allowed)`);
  }
  return out;
}

/** /v1/models: a restricted key sees only the combos and models it may call. */
export async function filterModelsListForKey(ctx, list) {
  if (!ctx || !Array.isArray(list)) return list;
  const sets = await getAllowSets(ctx);
  const out = [];
  for (const entry of list) {
    if (!entry?.id) continue;
    if (entry.owned_by === KEY_ACCESS_COMBO_OWNER) {
      if (sets.combos.has(lower(entry.id))) out.push(entry);
      continue;
    }
    const info = await getModelInfo(entry.id);
    if (!info?.provider) continue;
    if (KEY_ACCESS_PROVIDER_AS_MODEL_KINDS.includes(entry.kind)) {
      if (sets.providers.has(lower(info.provider))) out.push(entry);
      continue;
    }
    if (isResolvedModelAllowed(sets, info.provider, info.model)) out.push(entry);
  }
  return out;
}
