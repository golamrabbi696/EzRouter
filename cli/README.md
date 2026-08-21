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
