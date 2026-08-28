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

## Internal
- Version bump and packaging sync for CLI release
