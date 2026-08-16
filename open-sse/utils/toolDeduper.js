/**
 * Tool normalization before dispatch:
 * - MCP-equivalent built-in tool dedup (Claude clients only, reduces token bloat).
 * - Exact same-name tool dedup for DeepSeek models — the DeepSeek upstream rejects
 *   duplicate tool names with 400 "Tool names must be unique" on every endpoint
 *   (verified live 2026-08-15 against api.deepseek.com, opencode.go and a LiteLLM
 *   gateway; GLM/MiniMax/Kimi upstreams accept duplicates). First definition wins,
 *   tool_choice and message-history references are by name/id so nothing breaks.
 */

const DEDUP_RULES = [
  {
    // Exa MCP present → drop built-in web tools (Exa is preferred).
    triggers: ["mcp__exa__web_search_exa", "mcp__exa__web_fetch_exa"],
    strip: ["WebSearch", "WebFetch", "mcp__workspace__web_fetch"],
  },
  {
    // Tavily MCP present → drop built-in web tools.
    triggers: ["mcp__tavily__tavily_search", "mcp__tavily__tavily_extract"],
    strip: ["WebSearch", "WebFetch", "mcp__workspace__web_fetch"],
  },
  {
    // Browser MCP present → drop Cowork's duplicate Claude_in_Chrome connector.
    triggers: [/^mcp__browsermcp__/],
    strip: [/^mcp__Claude_in_Chrome__/],
  },
];

function getToolName(t) {
  return t?.name || t?.function?.name || "";
}

function matches(name, pattern) {
  if (typeof pattern === "string") return name === pattern;
  return pattern instanceof RegExp ? pattern.test(name) : false;
}

// "model(level)" is a 9router thinking override; strip before matching.
function isDeepSeekModel(model) {
  if (typeof model !== "string") return false;
  return /^deepseek-/.test(model.replace(/\([^()]+\)\s*$/, "").trim());
}

/**
 * @param {Array} tools - translated tools array
 * @param {Object} [opts]
 * @param {string|null} [opts.clientTool] - detected client ("claude" | "codex" | ...)
 * @param {string|null} [opts.model] - model id, may carry a (level) thinking suffix
 * @returns {{ tools: Array, stripped: Array<string> }}
 */
function dedupeTools(tools, opts = {}) {
  if (!Array.isArray(tools) || tools.length === 0) return { tools, stripped: [] };

  const clientTool = opts.clientTool ?? null;
  const model = opts.model ?? null;
  const stripped = [];
  let current = tools;

  // 1. MCP-equivalent built-in rules (Claude clients only).
  if (clientTool === "claude") {
    const names = current.map(getToolName);
    const toStrip = new Set();
    for (const rule of DEDUP_RULES) {
      const hasTrigger = names.some((n) => rule.triggers.some((p) => matches(n, p)));
      if (!hasTrigger) continue;
      for (const n of names) {
        if (rule.strip.some((p) => matches(n, p))) toStrip.add(n);
      }
    }
    if (toStrip.size > 0) {
      current = current.filter((t) => !toStrip.has(getToolName(t)));
      stripped.push(...toStrip);
    }
  }

  // 2. Exact same-name dedup (DeepSeek models only). First definition wins.
  if (isDeepSeekModel(model)) {
    const seen = new Set();
    const unique = [];
    for (const t of current) {
      const name = getToolName(t);
      if (!name) {
        unique.push(t);
        continue;
      }
      if (seen.has(name)) {
        stripped.push(name);
        continue;
      }
      seen.add(name);
      unique.push(t);
    }
    current = unique;
  }

  return { tools: current, stripped };
}

export { dedupeTools };
