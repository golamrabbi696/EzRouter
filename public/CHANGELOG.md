# v0.6.3 (2026-09-05)

## Fixes & Enhancements
- **CLI & Process Cleanup**: Added `next-server` process title matching in `killAllAppProcesses` and targeted `-sTCP:LISTEN` in `killProcessOnPort` to ensure background server processes and occupied ports are cleanly terminated on CLI start.
- **Database Log Noise Reduction**: Silenced benign SQLite fallback warnings (`better-sqlite3` ABI version mismatch on upgraded Node runtimes) in `driver.js` when built-in `node:sqlite` or `sql.js` successfully initializes.
- **Crash Log Filtering & Telemetry**: Captured process termination signals (`signal=SIGTERM`/`SIGKILL`) in CLI event handlers and filtered non-fatal runtime notices from crash logs to prevent false-alarm crash reports.

# v0.6.2 (2026-09-04)

## Fixes & Enhancements
- **Non-Streaming & Model Test Hardening**: Hardened `handleNonStreamingResponse`, `handleForcedSSEToJson`, `BaseExecutor`, and Next.js chat completions route against null/undefined references and unhandled exceptions, returning standard error responses (e.g. HTTP 502) instead of uncaught HTTP 500 runtime crashes during model testing.
- **Response Compatibility**: Decorated returned `Response` in non-streaming and forced SSE handlers with `.success = true` and `.response = res` so both native `Response` consumers (`.status`, `.json()`) and internal wrapper consumers are seamlessly supported.
- **Token Usage Accuracy**: Removed artificial 2000-token padding in non-streaming responses, preserving exact upstream token usage metrics.
- **Executor & Route Error Boundaries**: Added defensive response validation before header/status inspection in `BaseExecutor`, wrapped `handleChatCore` and route handlers in structured error boundaries returning standard OpenAI JSON errors with appropriate HTTP status codes (400, 401, 429, 502, 500).

# v0.6.1 (2026-09-04)

## Fixes & Enhancements
- **Chat & Gateway**: Fixed HTTP 500 runtime crash during model testing by importing missing `extractThinking` and `prefetchRemoteImages` in `chatCore.js`.
- **Thinking Defaults**: Restored provider-level thinking default injection logic using `extractThinking` verification to ensure dashboard-configured thinking levels are honored across all client formats.
- **Tool Call Sanitization**: Added defensive null/malformed guards in `getToolCallIds` and `ensureToolCallIds` (`toolCall.js`) preventing crashes on undefined/null tool entries.
- **Response Model Echo**: Preserved client-requested model name in OpenAI→Claude responses instead of upstream provider model name, preventing Claude Code session restore rejections.
- **Stream Fallback**: Added stream abort and combo fallback trigger when upstream returns empty content with terminal error in `native_finish_reason` across `stream.js`, `sseToJsonHandler.js`, and `nonStreamingHandler.js`.
- **Fallback & Rate Limits**: Added generic parser fallback for `resetsAtMs` in upstream error parsing to ensure 429 reset locks are respected.
- **CORS Support**: Allowed CORS preflight (`OPTIONS`) requests on public LLM endpoints (`/v1/*`, `/v1beta/*`, `/codex/*`).
- **Headroom**: Rewrote static asset and link paths in Headroom dashboard proxy responses.
- **Assistant Prefill**: Included `SERVER_TOOL_USE` in assistant prefill tool checks.
- **Model Capabilities**: Added GLM-5.3-Flash and DeepSeek V4 Vision patterns, and updated GLM-5.3 context window to 1m.

# v0.6.0 (2026-09-04)

## Upstream Synchronization & Core Enhancements (decolua/9router Sync)
- **Security**: Closed SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714).
- **Auth**: Protected root `/responses` rewrite requiring API key validation in dashboardGuard.
- **Fetch**: Added Ollama Cloud web fetch provider.
- **Search**: Added Antigravity Web Search, Xquik, Ollama-search, and Zai-search providers on `POST /v1/search`.
- **Gemini / Antigravity**: Added Gemini 3.8 Flash support, bumped IDE fingerprint to 2.11.0, and added quota-aware routing with reset-aware fallback.
- **Claude**: Added Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bumped Claude Code fingerprint to 2.1.258, and dropped foreign tool ID server tool blocks.
- **Providers & Models**: Added status filter (All / Active / Inactive / No connection) on Providers dashboard; added max height and scroll for connection list; added Grok CLI bulk import; daily model capabilities background sync from models.dev.

# v0.5.99 (2026-09-01)
# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.5.55 (2026-08-14)

## Critical Fixes
- **Upstream Network Request Timeouts in Antigravity OAuth**:
  - Added strict `AbortSignal.timeout(10000)` and `AbortSignal.timeout(5000)` on Google token exchange, user info, and Code Assist discovery endpoints.
  - Prevents backend thread hanging indefinitely on slow or blocked upstream requests.

# v0.5.98 (2026-09-01)

## Critical Fixes
- **Keepalive Fetch & Exact-Origin Redirection**:
  - Added `keepalive: true` to `/api/oauth/callback` fetch so browser window closure never terminates in-flight token exchange with upstream.
  - Dynamically resolved `redirect_uri` to `${window.location.origin}/callback` to prevent cross-origin isolation issues between `localhost` and `127.0.0.1`.

# v0.5.97 (2026-09-01)

## Critical Fixes
- **OAuth Callback Direct Fallback & Session Retention**:
  - Improved server-side `/api/oauth/callback` handler to automatically resolve the provider and complete token exchange even if the in-memory session was cleared or initiated across isolated workers.
  - Retain completed session status in memory to ensure polling and manual submit resolve immediately without timing out.

# v0.5.96 (2026-09-01)

## Features & Improvements
- **Continuous Polling & Auto-Close Reliability**:
  - Ensured OAuth session polling continuously checks for server-side exchange completion without premature cancellation.
  - Automatically closes modal and refreshes accounts table as soon as authorization completes in the background.

# v0.5.95 (2026-09-01)

## Features & Improvements
- **Zero-Touch Automatic Callback Population & Connect Button Fix**:
  - Automatically populate the OAuth callback URL into Step 2 input box upon authorization.
  - Added responsive `isSubmitting` loading state and decoupled `exchangeTokens` from local state to ensure smooth manual and automatic connection.

# v0.5.94 (2026-09-01)

## Critical Fixes
- **Synchronized Token Exchange & Single-Use Code Mutex**:
  - Implemented `performSynchronizedExchange` coordinator to eliminate race conditions between the server-side callback auto-relay (`/api/oauth/callback`) and client-side modal event listeners (`BroadcastChannel`, `localStorage`, `postMessage`).
  - Concurrent code exchange requests for the same OAuth state now await a single in-flight promise and share the exact same connection result, preventing Google OAuth single-use authorization code invalidation (`invalid_grant: Bad Request`).

# v0.5.93 (2026-09-01)

## Features & Improvements
- **Zero-Touch Automatic OAuth Callback Connection**:
  - Implemented server-side OAuth callback relay endpoint (`/api/oauth/callback`) and dynamic session tracker (`registerOAuthSession`, `poll-status`) for Antigravity, Gemini, Claude, and all OAuth providers.
  - When the user signs in with Google / Antigravity and is redirected to `/callback`, the callback page immediately relays the authorization code to the server, exchanges tokens, and saves the connection automatically without requiring manual URL copy & paste.
  - Fixed `BroadcastChannel` premature close issue in `/callback` page to ensure cross-tab broadcast messages are delivered reliably.
  - Added idempotency check in `/api/oauth/[provider]/exchange` to eliminate `invalid_grant` errors when manually submitting callback URLs whose single-use codes were already exchanged.

# v0.5.92 (2026-08-29)

## Critical Fixes
- **Account Selection & Non-Streaming Response Fix**:
  - Fixed result evaluation check in `src/sse/handlers/chat.js` (`isSuccess = result instanceof Response || (result && !result.isError)`). Previously, `if (result.success)` evaluated `undefined` to `false` for raw `Response` objects returned by `handleChatCore`, causing successful non-streaming model responses to mistakenly mark active accounts as unavailable and loop into a false `HTTP 500: All accounts unavailable` error.

# v0.5.91 (2026-08-29)

## Packaging & Standalone Bundle Release
- Repackaged full Next.js standalone application distribution bundle for global CLI updates.

# v0.5.90 (2026-08-29)

## Fixes & Improvements
- **Model Test Ping Timeout & Error Handling**:
  - Increased model test ping timeout from 15s to 60s to support heavy reasoning models with long time-to-first-token (e.g. DeepSeek V4 Pro, Nemotron 550B).
  - Wrapped internal test requests in `try...catch` handlers across LLM, Embedding, Image, and STT probes to prevent unhandled exceptions and return clean HTTP 504 / timeout messages instead of HTTP 500.

# v0.5.89 (2026-08-29)

## Fixes & Provider Registry Updates
- **NVIDIA NIM Model Catalog Update**:
  - Updated active models in `open-sse/providers/registry/nvidia.js` to match NVIDIA NIM's latest catalog (`minimaxai/minimax-m3`, `moonshotai/kimi-k3`, `deepseek-ai/deepseek-v4-pro-0813`, `deepseek-ai/deepseek-v4-flash-0731`, `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`).
  - Removed deprecated `z-ai/glm-5.2` (reached end-of-life upstream on 2026-08-21).
- **Universal Provider Health & Model Testing**:
  - Validated all active connections across all configured providers for non-streaming model test pings and streaming responses.

# v0.5.88 (2026-08-29)

## Fixes & Provider Engine Resilience
- **Non-Streaming Response Handler Stabilization**:
  - Fixed parameter extraction in `handleNonStreamingResponse` (`open-sse/handlers/chatCore/nonStreamingHandler.js`) to safely read `provider`, `model`, `connectionId`, and `apiKey` directly and via fallbacks, resolving `TypeError: Cannot destructure property 'provider' of 'modelInfo' as it is undefined` that caused HTTP 500 on Vertex AI (`vx/gemini-3.7-flash`), Ollama, Claude, and other non-streaming requests.
  - Added comprehensive multi-target format translations for non-streaming responses (OpenAI, OpenAI Responses, Claude Messages, Gemini/Vertex, Ollama).
- **SSE Stream-Only Provider Forced Streaming**:
  - Added `forceStream: true` transport flags to stream-only and custom protocol providers (`antigravity`, `gemini-cli`, `kiro`, `cursor`, `devin-cli`, `windsurf`, `qoder`, `qoderwork-cn`).
  - Added automatic SSE stream detector and parser in `handleNonStreamingResponse` to gracefully convert upstream SSE stream output to standard OpenAI completions when non-streaming JSON is requested.
  - Exported `parseGeminiSSEToOpenAIResponse` in `sseToJsonHandler.js` to correctly handle Google CloudCode and Gemini CLI internal streaming responses.

# v0.5.87 (2026-08-23)

## Fixes & Model Testing
- **Antigravity & Model Ping Connection Pinning**:
  - Enforced `x-9r-connection-id` header support in chat routing handler to pin model test ping calls directly to the targeted connection.
  - Fully verified non-streaming Antigravity & OpenRouter model testing from the dashboard.

# v0.5.86 (2026-08-23)

## Fixes & Resilience
- **Model Echo Backward Compatibility**:
  - Upgraded `canonicalEchoModel` in `open-sse/services/model.js` to accept both call styles (`canonicalEchoModel({ requestedModel, provider, model })` and legacy positional arguments `canonicalEchoModel(requestedModel, modelInfo)`).
  - Guarantees complete crash resilience for all upstream providers and non-streaming endpoints under all runtime bundle variations.

# v0.5.85 (2026-08-23)

## Fixes & Packaging
- **OpenRouter Non-Streaming Model Echo**:
  - Packed and published the `canonicalEchoModel` fix in `nonStreamingHandler.js`, permanently resolving `TypeError: Cannot destructure property 'provider' of 'b' as it is undefined` across global npm installations.

# v0.5.84 (2026-08-23)

## Stability & Engine Improvements
- **OpenRouter & Non-Streaming Gateway Stabilization**:
  - Validated and finalized response model echo logic and error annotations for OpenRouter models.
  - Re-synchronized clean production standalone bundles across all runtime engines.

# v0.5.83 (2026-08-23)

## Fixes & OpenRouter Stability
- **Non-Streaming Response Formatting**:
  - Packed and released the fix for `canonicalEchoModel` parameter signature in `nonStreamingHandler.js`, permanently resolving `TypeError: Cannot destructure property 'provider' of 'b' as it is undefined`.
  - Rebuilt standalone CLI package to guarantee updated runtime chunks on global npm installations.

# v0.5.82 (2026-08-23)

## Fixes
- **Non-Streaming Response Formatting**:
  - Corrected parameter signature in `nonStreamingHandler.js` when calling `canonicalEchoModel({ requestedModel, provider, model })`, resolving `TypeError: Cannot destructure property 'provider' of 'b' as it is undefined`.
  - Fully stabilized non-streaming and streaming OpenRouter model responses.

# v0.5.81 (2026-08-23)

## Fixes & Provider Enhancements
- **OpenRouter Gateway & Fallback Routing**:
  - Registered `OpenRouterExecutor` in the central executor registry (`open-sse/executors/index.js`), ensuring `allow_fallbacks: true` is properly injected on all OpenRouter chat requests.
  - Resolved HTTP 502 `Invalid URL:` errors caused by OpenRouter's misconfigured internal "Stealth" routes.
  - Enhanced `parseUpstreamError` to annotate 502/500 upstream errors with actionable guidance when an OpenRouter sub-provider endpoint fails.

# v0.5.80 (2026-08-23)

## Fixes & UI/UX Enhancements
- **Usage & Analytics Filter Aggregation**:
  - Fully resolved data lookups for extended time periods (`90d`, `180d`, `365d`, and `all`) across both REST endpoints and real-time SSE streams.
  - Implemented dynamic daily bucket calculation in `getChartData()` for 90D/180D/365D/All-time chart trends.
  - Aligned `/api/usage/stream` validation with shared period constants (`VALID_USAGE_STATS_PERIODS`), eliminating unexpected fallbacks to `today`.
- **Packaging & Performance Optimization**:
  - Restructured `.gitignore` rules to completely ignore standalone Next.js CLI runtime artifacts (`/cli/app/`) and generated `.tgz` packages, eliminating IDE, editor, and sub-agent file-indexing freezes.
  - Synchronized and verified all version tags and manifests for stable offline npm deployments.

# v0.5.79 (2026-08-23)

## Fixes & Improvements
- **Usage & Analytics Extended Period Aggregation**:
  - Added support for extended period filters (`90d`, `180d`, `365d`, and `all`) in `usageRepo.js` query calculations and `getChartData()`.
  - Updated SSE stream endpoint (`/api/usage/stream`) to validate against all shared usage periods (`VALID_USAGE_STATS_PERIODS`), fixing data updates when toggling 90D/180D/365D filters.

# v0.5.78 (2026-08-23)

## Fixes & Enhancements (PRs #3589, #3591 & Branding)
- **Responses API Output & Streaming Translation (#3589)**:
  - Preserved emitted Responses API output items across provider translations in `response.completed.response.output`.
  - Added seamless Gemini & Antigravity non-streaming and forced-SSE conversion into standard Responses JSON.
- **OpenCode Free Responses Migration (#3591)**:
  - Migrated OpenCode Free endpoint to Responses API (`/zen/v1/responses`) to fix `muse-spark-1.2-contributor-free` HTTP 500 error.
  - Automatically normalized `max_tokens` and `max_completion_tokens` into `max_output_tokens` while dropping incompatible Chat-only fields.
- **Branding & API Key Fallback**:
  - Replaced legacy `sk_9router` fallback with `sk_ezrouter` across all CLI tool setup cards and 34 language i18n literal bundles.
  - Ignored `/cli/app/` build artifacts and tarballs in `.gitignore` to prevent IDE & AI tool indexing stalls.

# v0.5.77 (2026-08-23)

## Features & Enhancements (PRs #3534–#3584)
- **Qoder Multimodal & Frontier Model Refresh (#3555)**:
  - Added support for `Qwen3.8-Max (qmodel_38max)`, `GLM-5.3 (gmodel)`, and `Lite` models.
  - Implemented full multimodal vision pass-through for Qoder (`image_url`, base64 Data URIs, and automatic conversion of Claude-style base64 image blocks into standard data URIs).
  - Added complete 1M token context window capability and reasoning parameter mappings.
- **Quota Safety Buffer & Account Pause (#3584)**:
  - Added configurable per-window pause threshold buffer in Provider Limits and Edit Connection modal (`quotaPauseThresholds`).
  - Automatically transitions low-quota connections to `Paused (quota)` state before complete depletion to seamlessly route traffic to backup accounts.
  - Added `Paused (quota)` status badges in Connection Rows and Provider Limits cards.
- **Progressive Tool Disclosure (#3575)**:
  - Implemented static MCP tool schema filtering and BM25 relevance ranking for heavy MCP server sessions, reducing per-turn schema token overhead by 60%–75%.
  - Added dashboard toggles in Token Saver for *Filter MCP tool schemas* and *BM25 tool relevance* with configurable `maxTools` threshold.
- **Grok CLI Reasoning Support (#3540)**:
  - Added `reasoning.effort` parameter forwarding for Grok 4.6 (`grok-4.6`, `grok-4.6-xhigh`, `grok-4.6-low`, etc.).
- **Self-Hosted Provider Endpoints (#3539)**:
  - Added configurable `Base URL` input fields in Add API Key modal for self-hosted TTS, STT, and Embedding connections (preventing unintended localhost loopback in Docker).
- **Groq Model Catalog (#3558)**:
  - Replaced decommissioned Groq models and added dynamic `modelsFetcher` support.

## Stability & Bug Fixes (PRs #3534–#3560)
- **Combo & Streaming Failover**:
  - **Empty Stream Failover (#3560)**: Automatically falls back to the next combo account when an upstream provider returns HTTP 200 with an empty or keepalive-only stream (`peekStreamForContent`).
  - **TTFT Watchdog (#3556)**: Added 30s time-to-first-token watchdog timer to detect and abort stalled upstream streams before the first byte arrives.
  - **Stream Abort Usage Recording (#3542)**: Accurately records partial token usage in SQLite database (`STREAM USAGE (aborted)`) when client aborts mid-stream.
  - **Ollama NDJSON & Responses Single Decoder (#3546, #3547)**: Resolved split multi-byte UTF-8 character corruption across network chunk boundaries by enforcing single stream decoders.
  - **CommandCode Error Role (#3549)**: Wrapped CommandCode stream error chunk in `assistant` role for client compatibility.
  - **Multi-Endpoint Transport Routing (#3538)**: Synchronized outbound request wire format with matching transport endpoint (`resolveUpstreamRoute`).
- **Memory, Session & Process Lifecycle**:
  - **OAuth Server & Timer Leak Fix (#3543)**: Resolved unhandled error cases in local OAuth callback servers, eliminating port locks (EADDRINUSE) and orphaned 100ms interval timers.
  - **Session Store LRU Eviction (#3550)**: Fixed session cache eviction to drop Least-Recently-Used (LRU) sessions instead of oldest inserted connections, preserving active session continuity.
  - **Usage Millisecond Deduplication (#3544)**: Prevented dropping legitimate concurrent requests that arrive within the exact same millisecond.
  - **Quota Countdown Single-Timer (#3537)**: Unified auto-refresh and countdown timers to prevent double-speed countdowns during tab visibility changes.
  - **Database SIGINT/SIGTERM Graceful Exit (#3551)**: Configured `sql.js` adapter to persist dirty database state and exit cleanly on shutdown signals.
  - **Headroom Safe Process Spawning (#3534)**: Replaced `execSync` with `execFileSync` in python candidate detection to prevent command injection and issues with paths containing spaces.
  - **Connection Testing Deadlines (#3552, #3553)**: Enforced 10s/15s timeout deadlines via `fetchWithTimeout` across provider validation routes to prevent indefinite socket hangs.

---

# v0.5.76 (2026-08-23)

## Fixes
- **Dashboard & Middleware Initialization**:
  - Restored self-generating `jwt-secret` file persistence (`~/.ezrouter/jwt-secret`) in `dashboardSession.js` when `JWT_SECRET` environment variable is not explicitly provided in production/CLI mode. Resolves HTTP 500 Internal Server Error on `/dashboard` and dashboard routes.

---

# v0.5.75 (2026-08-23)

## Security & Upstream Hardening (GHSA Fixes #3496–#3503)
- **Authentication & Authorization**:
  - Implemented strict route protection on `/api/headroom/*`, `/api/tunnel/*`, `/api/auth/reset-password`, and Cursor auto-import endpoints (GHSA-g6g7, GHSA-x5c9, GHSA-86m2, GHSA-8gmq, GHSA-6g2f).
  - Protected `/api/providers` and `/api/usage/stats` endpoints and enforced masked credential exposure (GHSA-vjc7).
  - Required CLI token authentication for `/api/mcp/[plugin]/message` and `/api/mcp/[plugin]/sse` bridge routes (GHSA-63p9, GHSA-fhh6).
  - Implemented dual-factor authentication (CLI token + password or JWT session + password) for database export and import (GHSA-qvfm).
  - Enforced explicit `JWT_SECRET` configuration and removed insecure fallback generation (GHSA-jphh).
  - Extended `PROTECTED_SETTING_KEYS` in settings handler to prevent mass assignment vulnerabilities (GHSA-vmjq).
  - Hardened IP extraction against `Host` header and `X-Forwarded-For` spoofing, binding trust strictly to peer token validation (GHSA-32gc, GHSA-5mj8, GHSA-7cfm).
  - Added SSRF protection with URL validation and Undici DNS pinning for external fetch and Kiro/OIDC endpoints (GHSA-8g4w, GHSA-6mwv, GHSA-cmhj, GHSA-qj3v).

## Stability & Bug Fixes (PRs #3476–#3529)
- **Model Routing & Token Limits**:
  - Exposed aggregate combo token limits (`context_length` and `max_completion_tokens`) on `/v1/models` (#3529).
  - Fixed non-streaming request handling when `stream` key is omitted (#3528).
  - Forwarded reasoning effort for OpenCode Zen stealth models (#3504) and added Muse model Responses API transport handling (#3509).
- **Streaming & Memory Optimization**:
  - Added immediate cleanup for SSE MCP bridges and usage stats listeners on client disconnects (#3526, #3527).
  - Fixed OpenAI→Claude duplicate terminal chunk flush and tool parameter double serialization (#3520).
  - Prevented dropping generated images from OpenAI-format streams (#3521).
  - Recorded usage snapshots on premature stream aborts (#3513).
  - Corrected Claude thinking parameter translation for Ollama models (#3478) and ZAI effort objects (#3479).
- **CLI & SQLite Runtime Resilience**:
  - Added dynamic ABI compatibility check for `better-sqlite3` native binaries with auto-rebuild on Node.js version changes.
  - Implemented atomic publishing for sql.js database files (#3523).
  - Refused to clobber Codex and GitHub Copilot configuration files when existing configs cannot be parsed (#3524, #3525).

---

# v0.5.74 (2026-08-22)

## Features & Improvements
- **Upstream Sync & Enhancements (PRs #3417–#3466)**:
  - **Claude Streaming**: Decloak tool names in same-format streaming passthrough (`decloakStreamChunk`) (#3466).
  - **Combo & Account Fallback**: Automatically fall back to the next combo account when an upstream provider returns an empty HTTP 200 response with no text, tool calls, or reasoning (`EMPTY_CONTENT_COOLDOWN_MS`) (#3465).
  - **Codex Usage**: Added GPT-5.3-Codex-Spark quota tracking support (`spark_session` and `spark_weekly`) (#3458).
  - **SSE Streaming Keepalive**: Emits SSE keepalive ping every 10s during upstream inference silence for Claude Code (`SSE_KEEPALIVE_MS`) (#3457).
  - **Gemini / Antigravity System Prompts**: Sanitized client branding mentions in system prompts to prevent provider-level rejections (#3454).
  - **OpenCode-Go**: Added `ox-alpha-free` (`Ox Alpha Free`) and `muse-spark-1.2-contributor` models with Chat Completions transport guard and full test coverage (#3451).
  - **Kimi Performance**: Enabled `forceStream: true` for Kimi Code messages to reduce TTFT from 20s to 2s (#3421).
  - **MiniMax Multi-Transport**: Preserved images and OpenAI wire format for MiniMax-M3 requests on matching OpenAI transports (#3419).
- **OAuth & Error Recovery UX**:
  - Added dedicated **"Reconnect"** action button to connection rows for expired/invalidated OAuth sessions.
  - Added friendly human-readable error messages for token expiration (`invalid_grant`, `refresh_token_expired`, `reauth_required`, `unrecoverable_refresh_error`).
  - Gated Reconnect action strictly for auth failures while preserving raw technical errors for rate limits (429) and network issues.
- **Runtime & Process Isolation**:
  - Pointed default `DATA_DIR` and `.env.example` configurations to `~/.ezrouter` and `/var/lib/ezrouter`.
  - Updated default development and server ports to `20126`.
  - Updated CLI `getAppDataDir()` fallback to `~/.ezrouter` / `%APPDATA%/ezrouter`.
  - Enhanced CLI `PROCESS_IDENTIFIERS` to manage `ezrouter` processes while retaining `9router` for clean migration.
  - Updated default SAML Service Provider issuer to `urn:ezrouter:sp` and SAML fallback port to `20126`.
  - Updated generated runtime `package.json` package names to `ezrouter-runtime`.
- **Branding**:
  - Updated `UpdatePanel` modal strings to reference EzRouter (`ezrouter CLI install`, `run ezrouter again`).
  - Updated Skills dashboard display name to `EzRouter (Entry)`.

## Fixes
- **OpenCode Free & Ox Alpha Model Aliases**:
  - Added upstream alias mapping in `open-sse/providers/registry/opencode.js` and `open-sse/executors/opencode.js` so that `oc/ox-alpha`, `oc/ox-alpha-free`, and `oc/x-preview-f-free` all resolve to OpenCode's wire ID `x-preview-f-free` and pass `dispatchModel` to the executor (resolves `[401]: Model ox-alpha-free is not supported`).
  - Added OpenCode Free models (`mimo-v2.5-free`, `hy3-free`, `nemotron-3.5-lightning-free`, `nemotron-3-ultra-free`, `laguna-s-2.1-free`) to the registry catalog.
  - Fixed `isResponsesResponse` reference in `nonStreamingHandler.js`.
- **Google & Antigravity Request Payload**:
  - Stripped `stream` and `stream_options` fields from Google Gemini/Antigravity/Vertex payloads in `chatCore.js`, `antigravity.js`, and `gemini-cli.js` (resolves HTTP 400 `Invalid JSON payload received. Unknown name "stream": Cannot find field`).
- **Provider Details & Pagination**:
  - Restored `Pagination` import in `src/app/(dashboard)/dashboard/providers/[id]/page.js`, fixing runtime render crash when a provider has >10 accounts (e.g. Antigravity with 11 accounts).
  - Fixed `getProviderStats` and `freeTierEntries` in `src/app/(dashboard)/dashboard/providers/page.js` to dynamically match all valid connection types (`oauth`, `apikey`, `api_key`, `cookie`), ensuring accurate account counts on overview cards.
  - Fixed template string syntax in `src/app/(dashboard)/dashboard/providers/[id]/page.js` (`fetchConnections` was sending literal string `"${encodeURIComponent(providerId)}"` instead of evaluating `providerId`).
- **CLI Tools & Media Combo Configurations**:
  - Updated legacy hardcoded port `20128` fallbacks to dynamic `window.location.origin` / `20126` in Media Combo details, DeepSeek TUI, Hermes, Grok Build, OpenClaw, JCode, and CLI tools cards.
  - Updated JCode settings route to recognize both port 20126 and 20128 configurations.
- **Build & Component Exports**:
  - Added missing barrel exports for `AddCustomVideoModal` and `Pagination` in `src/shared/components/index.js`, fixing runtime failures in custom video model provider creation.
  - Removed unused `Pagination` import in `providers/[id]/page.js`.
  - Fixed `api/translator/send` to use `getProjectIdForConnection` instead of the removed `resolveAntigravityProjectId` helper.
- **Testing & Packaging**:
  - Added OpenCode-Go model catalog unit tests for `ox-alpha-free` in `tests/unit/opencode-go-models.test.js` (12/12 pass).
  - Restored `module.exports` and `require.main` guard in `cli/scripts/build-cli.js` so `cli-build-artifacts.test.js` runs in isolation without triggering full builds.
  - Updated `tests/unit/saml.test.js` default issuer expectation to `urn:ezrouter:sp`.
  - Normalized Node platform version and package semver in `tests/translator/golden-url-header.test.js` to ensure snapshot stability.

---

# v0.5.72 (2026-08-22)

## Internal
- Version bump and packaging sync for CLI release

---

# v0.5.71 (2026-08-22)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
