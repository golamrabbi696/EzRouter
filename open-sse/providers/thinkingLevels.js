// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
// Reuses capabilities.js (thinkingFormat/canDisable) so this file only maps format→levels (DRY).
import { getCapabilitiesForModel } from "./capabilities.js";
import { matchPattern } from "./pricing.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";
import { PROVIDERS } from "./index.js";

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // claude-adaptive, kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
const FORMAT_LEVELS = {
  qoder: L.budgetX,
  openai: L.openai,
  "claude-adaptive": L.levelMax,
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

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
const PATTERN_THINKING = [
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { providers: ["openai", "codex"], pattern: "*gpt-5.6*", levels: GPT_56_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  { provider: "ollama", pattern: "*gpt-oss*", levels: ["none", "low", "medium", "high"] },
  { provider: "ollama-local", pattern: "*gpt-oss*", levels: ["none", "low", "medium", "high"] },
  // codebuddy-cn per-model effort sets — read off the client picker (server-
  // delivered supportedEfforts), 2026-08-30. Gateway uses thinkingFormat "openai"
  // but rejects levels outside each model's set.
  { provider: "codebuddy-cn", pattern: "glm-5.3*",     levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "hy3*",         levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4*",         levels: ["high"] },
];

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  if (provider === "kiro" && resolveKiroEffortPath(model) === null) return null;
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  const hit = PATTERN_THINKING.find((p) => (!p.providers || !provider || p.providers.includes(provider)) && (!p.provider || p.provider === provider) && matchPattern(p.pattern, model));
  const providerFmt = provider ? PROVIDERS[provider]?.thinkingFormat : null;
  const fmt = providerFmt || caps.thinkingFormat;
  let levels = caps.thinkingLevels || hit?.levels || FORMAT_LEVELS[fmt] || L.base;
  if (caps.thinkingCanDisable === false) levels = levels.filter((l) => l !== "none");
  return levels;
}

export function supportsThinkingLevel(provider, model, level) {
  return getThinkingLevels(provider, model)?.includes(level) === true;
}
