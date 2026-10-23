import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  resolveClientApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { buildCacheAffinityKey } from "../services/cacheAffinity.js";
import { getDisabledByProvider } from "@/lib/db";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { isRoutableProvider } from "@/shared/constants/providers.js";
import { getModelInfo, getComboModels, getComboConfig } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse, createErrorResult, clientStatusForUpstream, clientStatusForBreakerOpen, authErrorResponse } from "open-sse/utils/error.js";
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import { handleComboChat, handleFusionChat, detectRequiredCapabilities, reorderModelsForTier } from "open-sse/services/combo.js";
import { classifyTier } from "open-sse/services/jevClassifier.js";
import { handleSystemone } from "./systemone.js";
import { getSpeedMode } from "open-sse/services/modelSpeed.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { annotateDirectResponse } from "open-sse/services/routeAttribution.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { AutoRouterConfigurationError, selectAutoRoute } from "../services/autoRouterSelection.js";
import { resolveSessionIdentity } from "open-sse/utils/sessionManager.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
import { parseJsonBody } from "@/shared/utils/parseJsonBody.js";

async function handleAutoRouterCombo({ body, comboName, models, settings, autoRouterPath = new Set(), handleSelectedTarget }) {
  let decision;
  try {
    if (autoRouterPath.size > 0) {
      throw new AutoRouterConfigurationError(`Auto Router chaining is not supported (encountered "${comboName}").`);
    }
    decision = selectAutoRoute({
      body,
      comboName,
      models,
      comboStrategies: settings.comboStrategies || {},
    });
  } catch (error) {
    if (!(error instanceof AutoRouterConfigurationError)) throw error;
    log.warn("AUTO-ROUTER", `combo=${comboName} selection failed: ${error.message}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Auto Router configuration error: ${error.message}`);
  }

  const { target, classification, index, candidates } = decision;
  const targetModels = await getComboModels(target);
  if (targetModels && settings.comboStrategies?.[target]?.fallbackStrategy === "auto") {
    const message = `Auto Router target "${target}" is configured as an Auto Router combo; Auto Router chaining is not supported.`;
    log.warn("AUTO-ROUTER", `combo=${comboName} selection failed: ${message}`);
    return errorResponse(HTTP_STATUS.BAD_REQUEST, `Auto Router configuration error: ${message}`);
  }
  log.info("AUTO-ROUTER", `combo=${comboName} rank=${index + 1}/${candidates.length} score=${classification.score} target=${target} reasons=${classification.reasons.join(",") || "none"}`);
  log.debug("AUTO-ROUTER", `combo=${comboName} structural metadata`, classification.metadata);
  return handleSelectedTarget(target, targetModels);
}

async function handleSingleTargetWithCapacityAdapter({ body, modelStr, clientRawRequest, request, apiKey, settings, keyAccess, requiredCapabilities, translationCache = null, requestedModel = null, autoRouterPath = new Set() }) {
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((model) => model !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (candidateBody, candidate) => handleSingleModelChat(candidateBody, candidate, clientRawRequest, request, apiKey, translationCache, null, autoRouterPath),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings)
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, translationCache, requestedModel, autoRouterPath);
}

function comboStrategyFor(settings, comboName, comboConfig = null) {
  const dbPolicy = comboConfig?.policy || {};
  const settingsStrategy = settings.comboStrategies?.[comboName] || {};
  const specific = dbPolicy.strategy || settingsStrategy.fallbackStrategy;
  if (specific === "auto") return { comboStrategy: "auto", isAutoRouter: true };
  return { comboStrategy: specific || (settings.comboStrategy === "auto" ? "fallback" : settings.comboStrategy) || "fallback", isAutoRouter: false };
}

export function applyCodexFastMode(body, provider, model, settings, credentials = null) {
  const isFastEnabled =
    settings?.codexFastMode === true ||
    credentials?.providerSpecificData?.codexFastMode === true ||
    credentials?.providerSpecificData?.fastMode === true;

  if (
    provider !== "codex" ||
    !isFastEnabled ||
    body.service_tier
  ) return body;

  return { ...body, service_tier: "priority" };
}
/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, translationCache = null) {
  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  cacheClaudeHeaders(clientRawRequest.headers);

  if (clientRawRequest?.headers) {
    clientRawRequest = { ...clientRawRequest, headers: Object.fromEntries(
      Object.entries(clientRawRequest.headers).filter(([name]) => !['x-9router-ha-proof', 'x-ez-ha-proof'].includes(name.toLowerCase()))
    ) };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const session = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
  const sessionId = session?.sessionId || null;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Resolve the client API key across all presented credentials
  // (Authorization + x-api-key + …) — attribution uses the credential that
  // actually validated. 401s on /v1/messages are Anthropic-shaped.
  const { apiKey, valid: apiKeyValid } = await resolveClientApiKey(request);
  if (apiKey) {
    log.debug("AUTH", `API Key: ${log.maskKey(apiKey)}${apiKeyValid ? "" : " (not recognized)"}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return authErrorResponse(clientRawRequest.endpoint, "Missing API key");
    }
    if (!apiKeyValid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return authErrorResponse(clientRawRequest.endpoint, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return keyAccessDenied;

  if (process.env.NINEROUTER_HA_CONFIG) {
    const { forwardedTarget } = await import('@/lib/ha/routing.js');
    try {
      const target = await forwardedTarget(request, body);
      if (target) return handleSingleModelChat(body, target, clientRawRequest, request, apiKey, modelStr);
    } catch { return errorResponse(HTTP_STATUS.FORBIDDEN, 'Forwarded target is not authorized'); }
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  // Per-request translation cache: evita re-translasi full body pada setiap retry fallback
  if (!translationCache) translationCache = new Map();
  const requiredCapabilities = detectRequiredCapabilities(body);

  // Check if model is a combo (has multiple models with fallback)
  const comboConfig = await getComboConfig(modelStr);
  if (comboConfig && comboConfig.models.length > 0) {
    const comboModels = comboConfig.models;
    // Merge DB config policy with settings-level comboStrategies (settings wins for backward compat)
    const comboStrategies = settings.comboStrategies || {};
    const { comboStrategy, isAutoRouter } = comboStrategyFor(settings, modelStr, comboConfig);
    if (isAutoRouter) {
      return handleAutoRouterCombo({
        body,
        comboName: modelStr,
        models: comboModels,
        settings,
        handleSelectedTarget: (target, selectedComboModels) => selectedComboModels
          ? handleSingleModelChat(body, target, clientRawRequest, request, apiKey, translationCache, null, new Set([modelStr]))
          : handleSingleTargetWithCapacityAdapter({
            body,
            modelStr: target,
            clientRawRequest,
            request,
            apiKey,
            settings,
            keyAccess,
            requiredCapabilities,
            translationCache,
            autoRouterPath: new Set([modelStr]),
          }),
      });
    }
    const dbPolicy = comboConfig.policy || {};
    const settingsStrategy = comboStrategies[modelStr] || {};
    const policy = { ...dbPolicy, strategy: comboStrategy, sticky: dbPolicy.sticky ?? settings.comboStickyRoundRobinLimit ?? 1 };
    // For weighted strategy, derive members from DB config; otherwise use models
    const members = comboConfig.members || comboModels.map((id) => ({ id, weight: 1 }));
    let augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
    // Re-derive augmented members for weighted case
    const augmentedMembers = comboStrategy === "weighted"
      ? augmentModelsWithCapacityAdapter(members.map((m) => m.id), requiredCapabilities, settings).map((id) => members.find((m) => m.id === id) || { id, weight: 1 })
      : null;

    if (comboStrategy === "fusion") {
      const fusionCfg = comboConfig.fusion || settingsStrategy;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, translationCache);
        },
        log,
        comboName: modelStr,
        judgeModel: fusionCfg?.judgeModel || comboConfig.fusion?.judge,
        tuning: fusionCfg?.fusionTuning || fusionCfg?.tuning || comboConfig.fusion?.tuning,
      });
    }

    const comboStickyLimit = policy.sticky ?? settings.comboStickyRoundRobinLimit;

    // Smart routing: classify task complexity with Jev (TypeSafe) and reorder the
    // combo so the tier-appropriate model leads. Fail-open — on any classifier
    // miss we keep `augmentedModels` as-is and fall through to normal fallback.
    // The availability/quota ladder + capability auto-switch below are untouched.
    const comboCfg = comboStrategies[modelStr] || {};
    let effectiveStrategy = comboStrategy;
    if (comboStrategy === "smart") {
      const smartCfg = comboCfg;
      const tierMap = smartCfg.smartTiers;
      if (tierMap) {
        const classifierModel = smartCfg.smartClassifierModel;
        let skipped = null;
        const classified = await classifyTier({
          body,
          log,
          classifierModel: classifierModel || undefined,
          criteria: smartCfg.smartCriteria,
          instructions: smartCfg.smartInstructions,
          minConfidence: smartCfg.smartMinConfidence,
          timeoutMs: smartCfg.smartTimeoutMs,
          onSkip: (reason, message) => { skipped = { reason, message }; },
          evaluateSystemone: (payload, model) => {
            const headers = new Headers({ "Content-Type": "application/json" });
            // Clients may authenticate with x-api-key instead of Authorization.
            const authorization = request.headers.get("Authorization")
              || (request.headers.get("x-api-key") ? `Bearer ${request.headers.get("x-api-key")}` : null);
            if (authorization) headers.set("Authorization", authorization);
            return handleSystemone(new Request(new URL("/api/v1/systemone", request.url), {
              method: "POST",
              headers,
              body: JSON.stringify({ ...payload, model }),
            }));
          },
        });
        if (classified) {
          const reordered = reorderModelsForTier(augmentedModels, classified.tier, tierMap);
          if (reordered[0] !== augmentedModels[0]) {
            log.info("CHAT", `Combo "${modelStr}" smart-routing tier=${classified.tier} → ${reordered[0]}`);
          }
          augmentedModels = reordered;
        } else {
          log.info("CHAT", `Combo "${modelStr}" smart-routing skipped (${skipped?.reason || "unknown"}: ${skipped?.message || "no detail"}) — using default order`);
        }
        // Run the reordered chain through the normal fallback ladder.
        effectiveStrategy = "fallback";
      }
    }

    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}${effectiveStrategy !== comboStrategy ? `→${effectiveStrategy}` : ""}, sticky: ${comboStickyLimit})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      members: augmentedMembers || members,
      policy,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, translationCache),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: effectiveStrategy,
      comboStickyLimit,
      sessionId,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      resolveSmartChoice: effectiveStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
          })
        : null,
      resolveModel: getModelInfo,
      speedMode: getSpeedMode(body, clientRawRequest?.headers)
    });
  }

  return handleSingleTargetWithCapacityAdapter({
    body,
    modelStr,
    clientRawRequest,
    request,
    apiKey,
    settings,
    keyAccess,
    requiredCapabilities,
    translationCache,
    requestedModel: contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null,
  });
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, translationCache = null, requestedModel = null, autoRouterPath = new Set()) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboCfg = await getComboConfig(modelStr);
    if (comboCfg && comboCfg.models.length > 0) {
      const comboModels = comboCfg.models;
      const chatSettings = await getSettings();
      const comboStrategies = chatSettings.comboStrategies || {};
      const { comboStrategy, isAutoRouter } = comboStrategyFor(chatSettings, modelStr, comboCfg);
      if (isAutoRouter) {
        return handleAutoRouterCombo({
          body,
          comboName: modelStr,
          models: comboModels,
          settings: chatSettings,
          autoRouterPath,
          handleSelectedTarget: async (target, selectedComboModels) => selectedComboModels
            ? handleSingleModelChat(body, target, clientRawRequest, request, apiKey, translationCache, null, new Set([...autoRouterPath, modelStr]))
            : handleSingleTargetWithCapacityAdapter({
              body,
              modelStr: target,
              clientRawRequest,
              request,
              apiKey,
              settings: chatSettings,
              keyAccess: await getKeyAccessContext(request),
              requiredCapabilities: detectRequiredCapabilities(body),
              translationCache,
              autoRouterPath: new Set([...autoRouterPath, modelStr]),
            }),
        });
      }
      const dbPolicy = comboCfg.policy || {};
      const settingsStrategy = comboStrategies[modelStr] || {};
      const policy = { ...dbPolicy, strategy: comboStrategy, sticky: dbPolicy.sticky ?? chatSettings.comboStickyRoundRobinLimit ?? 1 };
      const members = comboCfg.members || comboModels.map((id) => ({ id, weight: 1 }));
      const requiredCapabilities = detectRequiredCapabilities(body);
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
      const augmentedMembers = comboStrategy === "weighted"
        ? augmentModelsWithCapacityAdapter(members.map((m) => m.id), requiredCapabilities, chatSettings).map((id) => members.find((m) => m.id === id) || { id, weight: 1 })
        : null;

      if (comboStrategy === "fusion") {
        const fusionCfg = comboCfg.fusion || settingsStrategy;
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, translationCache, null, autoRouterPath);
          },
          log,
          comboName: modelStr,
          judgeModel: fusionCfg?.judgeModel || comboCfg.fusion?.judge,
          tuning: fusionCfg?.fusionTuning || fusionCfg?.tuning || comboCfg.fusion?.tuning,
        });
      }

      const comboStickyLimit = policy.sticky ?? chatSettings.comboStickyRoundRobinLimit;
      const nestedSession = resolveSessionIdentity({ headers: clientRawRequest?.headers, body });
      const nestedSessionId = nestedSession?.sessionId || null;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        members: augmentedMembers || members,
        policy,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, translationCache, null, autoRouterPath),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        sessionId: nestedSessionId,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
            })
          : null,
        resolveModel: getModelInfo,
        speedMode: getSpeedMode(body, clientRawRequest?.headers)
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Reject disabled models at routing time (#4249).
  // disabledModels is UI-only today — check it here so the gate is enforced
  // on every request path, not just the /v1/models listing.
  try {
    const disabledForProvider = await getDisabledByProvider(provider);
    if (Array.isArray(disabledForProvider) && disabledForProvider.includes(model)) {
      log.warn("CHAT", `Model "${model}" is disabled for provider "${provider}"`);
      return errorResponse(HTTP_STATUS.NOT_FOUND, `Model "${model}" is disabled`);
    }
  } catch {
    // Non-fatal: if DB is unavailable, allow the request through rather than
    // blocking all traffic with a misleading 404.
  }

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";
  const preferredConnectionId = request?.headers?.get("x-connection-id") || request?.headers?.get("x-ez-connection-id") || request?.headers?.get("x-9r-connection-id") || null;

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  const excludeProxyPoolIds = new Set();
  let lastError = null;
  let lastStatus = null;
  let lastHeaders = null;
  // Only used by the "cache-affinity" strategy; cheap enough to compute once here.
  const cacheKey = buildCacheAffinityKey(body);

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId,
      cacheKey,
      requestedModel: requestedModel || model,
      excludeProxyPoolIds,
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if ((process.env.EZROUTER_HA_CONFIG || process.env.NINEROUTER_HA_CONFIG) && request && excludeConnectionIds.size === 0) {
        const { maybeForwardChat } = await import('@/lib/ha/routing.js');
        const originalModel = requestedModel || clientRawRequest?.body?.model || body.model;
        const peerResponse = await maybeForwardChat(request, { ...body, model: originalModel }, modelStr, true);
        if (peerResponse) return peerResponse;
      }
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        // Preserve the upstream class so 4xx still means stop and 5xx still means
        // retry, EXCEPT for the one status that lied here: a non-model 404, which
        // is a cooldown the router set itself (see clientStatusForBreakerOpen).
        // credentials.lastErrorCode is only populated when the stored error provably
        // belongs to THIS model (see auth.js), so a stale code from another request
        // can no longer decide this status.
        const status = clientStatusForBreakerOpen(lastStatus || Number(credentials.lastErrorCode), errorMsg);
        log.warn("CHAT", `[${provider}/${model}] ${status} | ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        if (isRoutableProvider(provider)) {
          log.warn("AUTH", `No active credentials for provider: ${provider}`);
          return errorResponse(
            HTTP_STATUS.NOT_FOUND,
            `No active credentials for provider: ${provider}. Connect an account for this provider in the dashboard.`,
            { code: "provider_not_configured" },
          );
        }
        log.warn("AUTH", `Unknown provider: ${provider}`);
        return errorResponse(
          HTTP_STATUS.NOT_FOUND,
          `Unknown provider "${provider}" in model "${provider}/${model}". See /v1/models for what this router serves.`,
        );
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(clientStatusForUpstream(lastStatus, lastError), lastError || "All accounts unavailable", null, lastHeaders);
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    let result;
    try {
      result = await handleChatCore({
        translationCache,
        body: { ...structuredClone(body), model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: { ...refreshedCredentials, rawHeaders: clientRawRequest?.headers },
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        headroomEnabled: !!chatSettings.headroomEnabled,
        headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
        headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
        headroomTimeoutMs: chatSettings.headroomTimeoutMs,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        ponytailEnabled: !!chatSettings.ponytailEnabled,
        ponytailLevel: chatSettings.ponytailLevel || "full",
        customPromptEnabled: !!chatSettings.customPromptEnabled || !!chatSettings.customSystemPromptEnabled,
        customPrompt: chatSettings.customPrompt || chatSettings.customSystemPrompt || "",
        toolRankEnabled: !!chatSettings.toolRankEnabled,
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        toolHistoryPruning: chatSettings.toolHistoryPruning || { enabled: false },
        providerThinking,
        // Per-provider user overrides (custom headers / connect timeout) from settings
        providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
        toolDisclosure: (chatSettings.toolDisclosureEnabled || chatSettings.toolDisclosureFilterEnabled) ? {
          disclosureEnabled: !!chatSettings.toolDisclosureEnabled,
          filterEnabled: !!chatSettings.toolDisclosureFilterEnabled,
          maxTools: chatSettings.toolDisclosureMaxTools ?? 20,
        } : null,
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model, provider);
          // "Consecutive" strikes: a success clears the breaker for this pair.
          clearAntigravityStrikes(credentials.connectionId, model);
        },
        onEmptyStream: async () => {
          await markAccountUnavailable(
            credentials.connectionId,
            HTTP_STATUS.BAD_GATEWAY,
            `Empty streaming response from ${provider}/${model}`,
            provider,
            model,
            Date.now() + EMPTY_CONTENT_COOLDOWN_MS
          );
        }
      });
    } catch (coreErr) {
      log.error?.("CHAT", `[${provider}/${model}] handleChatCore uncaught exception: ${coreErr?.message || coreErr}`);
      result = createErrorResult(HTTP_STATUS.INTERNAL_SERVER_ERROR, `Chat execution failed: ${coreErr?.message || "Internal error"}`);
    }

    const isSuccess = result instanceof Response || (result && !result.isError && (result.ok || result.status === HTTP_STATUS.OK || !result.status));
    if (isSuccess) {
      const resp = result instanceof Response ? result : (result.response || result);
      return annotateDirectResponse({
        requestedModel: requestedModel || modelStr,
        resolvedModel: `${provider}/${model}`,
      }, resp);
    }

    const errorStatus = result?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    const errorMessage = result?.error || "Upstream request failed";

    const proxyPoolId = credentials.connectionId === "noauth"
      ? credentials.providerSpecificData?.connectionProxyPoolId
      : null;
    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result?.resetsAtMs;
    if (provider === "antigravity" && (errorStatus === 409 || errorStatus === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, errorStatus, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData,
        errorMessage
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, errorStatus, errorMessage, provider, model, resetsAtMs, proxyPoolId)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${errorStatus}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      if (proxyPoolId) excludeProxyPoolIds.add(proxyPoolId);
      lastError = errorMessage;
      lastStatus = errorStatus;
      lastHeaders = upstreamResponseHeaders(result?.response?.headers);
      continue;
    }

    const finalResp = result instanceof Response ? result : (result?.response || errorResponse(errorStatus, errorMessage));
    return annotateDirectResponse({
      requestedModel: requestedModel || modelStr,
      resolvedModel: `${provider}/${model}`,
    }, finalResp);
  }
}
