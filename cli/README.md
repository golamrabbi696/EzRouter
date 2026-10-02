# EzRouter - FREE AI Router & Token Saver

**Never stop coding. Save 20-40% tokens with RTK + auto-fallback to FREE & cheap AI models.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

[![GitHub stars](https://img.shields.io/github/stars/golamrabbi696/EzRouter?style=flat)](https://github.com/golamrabbi696/EzRouter/stargazers)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/golamrabbi696/EzRouter/blob/main/LICENSE)

---

## 🤔 Why EzRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**EzRouter solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**Option 1 — npm (recommended for desktop):**

```bash
npm install -g @rabbi696/ezrouter
ezrouter

# Or run directly with npx
npx @rabbi696/ezrouter
```

**Option 2 — Docker (server/VPS):**

```bash
docker run -d --name ezrouter -p 20126:20126 \
  -v "$HOME/.ezrouter:/app/data" -e DATA_DIR=/app/data \
  golamrabbi696/ezrouter:latest
```

Published images: [Docker Hub](https://hub.docker.com/r/decolua/9router) • [GHCR](https://github.com/decolua/9router/pkgs/container/9router) (multi-platform amd64/arm64).

🎉 Dashboard opens at `http://localhost:20126`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20126/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
ezrouter                    # Start with default settings (port 20126)
ezrouter --port 8080        # Custom port
ezrouter --no-browser       # Don't open browser
ezrouter --skip-update      # Skip auto-update check
ezrouter --help             # Show all options
```

**Dashboard**: `http://localhost:20126/dashboard`

---

## 🔌 Connect to a Remote EzRouter

Already running EzRouter on another machine (e.g. a team server on your LAN)? Point this machine's CLI tools at it — no local server is started:

```bash
npx @rabbi696/ezrouter connect http://<server-host>:20126                       # pick tools interactively
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools claude,codex  # or choose up front
npx @rabbi696/ezrouter connect --reset --tools claude,codex                     # undo
```

It logs in with the dashboard password (hidden prompt), reuses or creates an API key named `cli-<hostname>`, and writes each tool's config (backing up the original once as `*.bak-ezrouter`).

Supported tools: `claude`, `codex`, `opencode`, `droid`, `crush`, `kilo`, `cline`, `pi`, `omp`, or `all`.

### Models

Models come from the **server's own CLI-tools configuration**, so a client gets whatever the operator already picked on the dashboard. Nothing is hardcoded.

| Tool | Model taken from (first match wins) |
|---|---|
| `claude` | tier flag (`--opus` …) → server's Claude tier → *left unset* (Claude Code's own default) |
| others | `--model` → that tool's own model on the server → server's OpenCode model → *tool skipped* |

`kilo` has no readable model on the server, so it always uses `--model` or the OpenCode model. A Claude tier the server doesn't set is removed from your config rather than kept from an earlier run. A skipped tool makes the command exit `1`.

### Overriding the server's models

```bash
# One Claude tier; the other tiers still come from the server
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools claude --sonnet cc/claude-sonnet-5-5

# Every Claude tier
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools claude \
  --fable cc/claude-fable-5-1 --opus cc/claude-opus-5-5 \
  --sonnet cc/claude-sonnet-5-5 --haiku cc/claude-haiku-4-5-20251001

# All non-Claude tools at once
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools codex,opencode,kilo --model ocg/deepseek-flash

# Claude and other tools in one run
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools claude,codex --opus cc/claude-opus-5-5 --model gpt-6

# A different model per tool: --model covers every non-Claude tool in a run, so run once per tool
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools codex --model gpt-6
npx @rabbi696/ezrouter connect http://<server-host>:20126 --tools opencode --model ocg/glm-5.3
```

A model the server doesn't list is still written, with a `not listed by server` warning. To see the ids it serves: `curl http://<server-host>:20126/v1/models -H "Authorization: Bearer <your key>"`.

### Checking the current config

`ezrouter show` prints what each CLI tool on this machine is currently set to — base URL, masked API key and models. It only reads local files and never contacts a server.

```bash
npx @rabbi696/ezrouter show                 # every supported tool
npx @rabbi696/ezrouter show claude          # one tool
npx @rabbi696/ezrouter show claude codex    # several
npx @rabbi696/ezrouter show claude --json   # machine-readable (key still masked)
```

```
✅ Claude Code
   File:     ~/.claude/settings.json
   Base URL: http://<server-host>:20126/v1
   API key:  sk-a1b…9f3c
   Models:
     fable   cc/claude-fable-5-1
     opus    cc/claude-opus-5-5
     sonnet  cc/claude-sonnet-5-5
```

Tools not pointed at EzRouter are listed as `not configured`. For Codex, OpenCode and Cline it also warns when an EzRouter entry exists but another provider is the active one.

### Other options

| Option | Purpose |
|---|---|
| `--password <pw>` | Dashboard password (or `EZROUTER_PASSWORD`); prompted if omitted — preferred, keeps it out of shell history |
| `--api-key <key>` | Use this key and skip login. The server's models can't be read without a login, so pass model flags |
| `--key-name <name>` | API key name to reuse/create (default `cli-<hostname>`) |
| `--print-env` | Also print `OPENAI_BASE_URL` / `OPENAI_API_KEY` for other CLIs |
| `--reset` | Remove the EzRouter settings from the selected tools |

See `ezrouter connect --help` for the full list.

> ⚠️ Over plain `http://` the password and API key are sent unencrypted — use a trusted LAN/VPN or put HTTPS in front. The API key is stored in each tool's config file.

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.ezrouter/db/data.sqlite`
- **Windows**: `%APPDATA%/ezrouter/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.ezrouter` to persist)

---

---

## 🙏 Acknowledgments

- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation
- **[decolua/9router](https://github.com/decolua/9router)** - Upstream repository

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.
