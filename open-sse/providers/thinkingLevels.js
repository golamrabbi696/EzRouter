// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { PROVIDERS } from "./index.js";
import { getProviderModels } from "../config/providerModels.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  qoder: L.budgetX,
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  opencode: L.levelMax,   // zen gateway enum: none|low|medium|high|max (no xhigh/minimal)
  deepseek: L.hiMax,
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
  nous: L.base,
  meta: ["minimal", "low", "medium", "high", "xhigh"], // Muse Spark — no disable, no max
  ollama: L.levelMax,
};

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
const GPT_56_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

// Opus/Sonnet 4.6 lack xhigh (Anthropic + Kiro docs) — keep the 4-level+max set.
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  { provider: "codex", pattern: "*gpt-6*", levels: CODEX_GPT_5_6_LEVELS },
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { providers: ["openai", "codex"], pattern: "*gpt-5.6*", levels: GPT_56_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  { pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // mimo-v2.5-pro on opencode-go rejects reasoning_effort "max" (probed live); v2.5 accepts it.
  { pattern: "*mimo*v2.5-pro*", levels: ["none", "low", "medium", "high", "xhigh"] },
  { provider: "ollama", pattern: "*gpt-oss*", levels: ["none", "low", "medium", "high"] },
  { provider: "ollama-local", pattern: "*gpt-oss*", levels: ["none", "low", "medium", "high"] },
  // Qoder's private chat wire accepts reasoning_effort levels through the
  // parameters block. Keep max distinct from xhigh instead of applying the
  // generic OpenAI max→xhigh clamp.
  { provider: "qoder", pattern: "*", levels: L.budgetX },
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable.
  // ⚠️ The codebuddy-cn exact ids below MUST stay above this unqualified glob —
  // PATTERN_THINKING is first-match-wins, so a later provider-qualified entry
  // would never fire for dotted ids like deepseek-v4.1-flash.
  { provider: "codebuddy-cn", pattern: "deepseek-v4-pro",     levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4.1-flash", levels: ["low", "high", "max"] },
  { pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / kimi-k3-1 / minimax-m3)
  // fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3",      levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.3-flash", levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "kimi-k2.8-preview",  levels: ["low", "medium", "high"] },
  { provider: "codebuddy-cn", pattern: "hy3",          levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4-preview",  levels: ["high"] },
  // codebuddy-intl rides the same gateway catalog, so its deepseek levels match.
  { provider: "codebuddy-intl", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  // MiniMax Code (mcode) — adaptive effort via output_config.effort. M3.1
  // always thinks (no none); M3 is switchable with none/high only, per the
  // magpie static catalog. M2.7 pair falls through to the claude-adaptive
  // set minus none (canDisable: false).
  { provider: "minimax-code", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code", pattern: "MiniMax-M3", levels: ["none", "high"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3.1*", levels: ["low", "medium", "high", "xhigh", "max"] },
  { provider: "minimax-code-global", pattern: "MiniMax-M3", levels: ["none", "high"] },
  // GLM-5.3 backends (z.ai + Alibaba MaaS, probed live 2026-09-21) accept exactly
  // low|high|max for reasoning_effort — xhigh/medium are a 400. Match the exact
  // model suffix so the -prime variant (wider set) is not caught. Placed after
  // the provider-scoped glm entries above so they keep precedence.
  { pattern: "*glm-5.3", levels: ["low", "high", "max"] },
];

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const baseId = String(model || "").replace(/\([^()]+\)\s*$/, "");
  const modelLevels = provider === "codex"
    ? getProviderModels("cx").find((entry) => entry.id === baseId)?.thinkingLevels
    : null;
  const hit = PATTERN_THINKING.find((p) => (!p.providers || !provider || p.providers.includes(provider)) && (!p.provider || p.provider === provider) && matchPattern(p.pattern, model));
  const providerFmt = provider ? PROVIDERS[provider]?.thinkingFormat : null;
  const fmt = providerFmt || caps.thinkingFormat;
  let levels = modelLevels || caps.thinkingLevels || hit?.levels || FORMAT_LEVELS[fmt] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}

export function supportsThinkingLevel(provider, model, level) {
  return getThinkingLevels(provider, model)?.includes(level) === true;
}
