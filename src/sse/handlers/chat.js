import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
} from "../services/auth.js";
import { cacheClaudeHeaders } from "open-sse/utils/claudeHeaderCache.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
<<<<<<< HEAD
import { isRoutableProvider } from "@/shared/constants/providers.js";
import { getModelInfo, getComboModels } from "../services/model.js";
=======
import { getModelInfo, getComboModels, getComboConfig } from "../services/model.js";
>>>>>>> 1615622142 (feat: replace Gemini 3.5 Flash with 3.7 Flash and add combo weights/config support)
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse, createErrorResult, clientStatusForUpstream, clientStatusForBreakerOpen } from "open-sse/utils/error.js";
import { handleComboChat, handleFusionChat } from "open-sse/services/combo.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { EMPTY_CONTENT_COOLDOWN_MS } from "open-sse/config/errorConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null, translationCache = null) {
  let body;
  try {
    body = await request.json();
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

  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  if (settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    const valid = await isValidApiKey(apiKey);
    if (!valid) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
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
    const dbPolicy = comboConfig.policy || {};
    const settingsStrategy = comboStrategies[modelStr] || {};
    // DB policy.strategy takes precedence if present, else settings fallbackStrategy
    const comboStrategy = dbPolicy.strategy || settingsStrategy.fallbackStrategy || settings.comboStrategy || "fallback";
    const policy = { ...dbPolicy, strategy: comboStrategy, sticky: dbPolicy.sticky ?? settings.comboStickyRoundRobinLimit ?? 1 };
    // For weighted strategy, derive members from DB config; otherwise use models
    const members = comboConfig.members || comboModels.map((id) => ({ id, weight: 1 }));
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
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
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
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
      comboStrategy,
      comboStickyLimit
    });
  }

  // Single model request
  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, translationCache = null) {
  const modelInfo = await getModelInfo(modelStr);

  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboCfg = await getComboConfig(modelStr);
    if (comboCfg && comboCfg.models.length > 0) {
      const comboModels = comboCfg.models;
      const chatSettings = await getSettings();
      const comboStrategies = chatSettings.comboStrategies || {};
<<<<<<< HEAD
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
=======
      const dbPolicy = comboCfg.policy || {};
      const settingsStrategy = comboStrategies[modelStr] || {};
      const comboStrategy = dbPolicy.strategy || settingsStrategy.fallbackStrategy || chatSettings.comboStrategy || "fallback";
      const policy = { ...dbPolicy, strategy: comboStrategy, sticky: dbPolicy.sticky ?? chatSettings.comboStickyRoundRobinLimit ?? 1 };
      const members = comboCfg.members || comboModels.map((id) => ({ id, weight: 1 }));
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));
      const augmentedMembers = comboStrategy === "weighted"
        ? augmentModelsWithCapacityAdapter(members.map((m) => m.id), requiredCapabilities, chatSettings).map((id) => members.find((m) => m.id === id) || { id, weight: 1 })
        : null;
>>>>>>> 1615622142 (feat: replace Gemini 3.5 Flash with 3.7 Flash and add combo weights/config support)

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
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, translationCache);
          },
          log,
          comboName: modelStr,
          judgeModel: fusionCfg?.judgeModel || comboCfg.fusion?.judge,
          tuning: fusionCfg?.fusionTuning || fusionCfg?.tuning || comboCfg.fusion?.tuning,
        });
      }

<<<<<<< HEAD
      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey),
=======
      const comboStickyLimit = policy.sticky ?? chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        members: augmentedMembers || members,
        policy,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, translationCache),
          adapterAdded
        ),
>>>>>>> 1615622142 (feat: replace Gemini 3.5 Flash with 3.7 Flash and add combo weights/config support)
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";
  const pinnedConnectionId = request?.headers?.get("x-9r-connection-id") || null;

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, { preferredConnectionId: pinnedConnectionId });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
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
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
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
      return errorResponse(clientStatusForUpstream(lastStatus, lastError), lastError || "All accounts unavailable");
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
        credentials: refreshedCredentials,
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
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        toolHistoryPruning: chatSettings.toolHistoryPruning || { enabled: false },
        providerThinking,
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
          await clearAccountError(credentials.connectionId, credentials, model);
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
      return result instanceof Response ? result : (result.response || result);
    }

    const errorStatus = result?.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    const errorMessage = result?.error || "Upstream request failed";

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result?.resetsAtMs;
    if (provider === "antigravity" && (errorStatus === 409 || errorStatus === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, errorStatus, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const shouldFallback = provider === "antigravity" && quotaResetMs
      ? true
      : (await markAccountUnavailable(credentials.connectionId, errorStatus, errorMessage, provider, model, resetsAtMs)).shouldFallback;

    if (shouldFallback) {
      log.warn("FALLBACK", `⇄ ACC:${credentials.connectionName} UNAVAILABLE (${errorStatus}) → NEXT ACCOUNT`);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = errorMessage;
      lastStatus = errorStatus;
      continue;
    }

    return result instanceof Response ? result : (result?.response || errorResponse(errorStatus, errorMessage));
  }
}
