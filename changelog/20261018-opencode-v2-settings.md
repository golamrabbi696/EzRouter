# OpenCode V2 settings emission (opencode-settings API)

- **Date:** 2026-10-18
- **Status:** Implemented (uncommitted → `feature/opencode-v2-settings-api`)
- **Branch:** `feature/opencode-v2-settings-api`

## Summary

The in-app "configure opencode" configurator (`/api/cli-tools/opencode-settings`)
emitted **legacy V1** config (`provider` + `npm: @ai-sdk/openai-compatible` +
`options`). opencode **V2** ignores that shape, so the provider never selected the
Responses transport and the session failed with:

```
Error: Invalid 9router/openai-compatible-responses stream event
```

Root cause of the stream failure is the **provider package id**:

- correct / V2-native: `@opencode/ai/providers/openai-compatible-responses` (hyphen)
- wrong: `@opencode/ai/providers/openai-compatible/responses` (slash) — a different
  registered entry that does **not** select the Responses transport, so opencode fell
  back to `/chat/completions` with a Responses-shaped body plus a stray `endpoint`
  field → 400 → the stream failed opencode's Responses validator (`SchemaError: item.namespace`).

Changes:

- `POST` now writes a **V2-native `providers` block only** (never `provider`), using the
  hyphen package id, `settings.baseURL`, and `capabilities` on each model.
- Existing V1 configs are **migrated in place** on the next `POST`; pre-existing models
  are preserved. The now-empty V1 keys (`provider`, `agent`) are dropped rather than
  left behind as `{}`.
- `GET` reads **either** schema (`providers["9router"]` or `provider["9router"]`) and
  normalizes `baseURL` into `opencode.baseURL` for the UI.
- `DELETE` removes the entry from **both** schemas (and drops the keys once empty).
- Subagent block migrated `agent` → `agents`.
- **Data-loss fix:** `POST` used a bare `JSON.parse` on the existing file and, on
  failure, silently started from `{}` — wiping `mcp`, `plugins`, models, etc. for any
  JSONC config. It now reuses `readConfig()`, which strips comments (string-aware, so
  `https://…` survives) and trailing commas.

## Files

- `src/app/api/cli-tools/opencode-settings/route.js`
- `src/app/(dashboard)/dashboard/cli-tools/components/OpenCodeToolCard.js`
- `tests/unit/opencode-settings-v2.test.js` (new)

## Testing

`tests/unit/opencode-settings-v2.test.js` — 6 cases: V2 emission (never V1),
V1→V2 in-place migration (V1 keys dropped), dual-schema reads, dual-schema delete,
JSONC `POST` preservation (comments + trailing commas + `mcp`/`plugins`), and
`//`-scheme survival through comment stripping. Not executed locally (no
`node_modules` in this workspace); rely on CI. The comment-stripping regex was
checked standalone against comments, `https://` strings, and escaped quotes.

End-to-end already verified for the config side (outside this repo): with
`~/.config/opencode/opencode.json` set to the hyphen package,
`opencode run --model 9router/General "reply OK"` → `{"type":"text",...,"text":"OK"}`,
no `endpoint` 400, no stream validation error.

## Risks / Limitations

- Backward compatible on read; writes are V2-only (intended — V1 is deprecated).
- Assumes opencode V2 resolves the provider package from the hyphen id; not asserted
  against an installed V2 binary in-repo.
- **Known, pre-existing (not fixed):** `GET` returns the whole config to the client,
  including `settings.apiKey`. Left as-is because changing the response shape is
  outside this task — flagging for a follow-up.
- Comment stripping is regex-based; a `//` sequence *inside a string value* is
  preserved, but exotic JSONC (e.g. unterminated block comments) still falls back to
  `null` (treated as "no config").
