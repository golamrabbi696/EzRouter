export default {
  id: "commandcode",
  priority: 100,
  alias: "commandcode",
  aliases: [
    "cmc",
  ],
  uiAlias: "cmc",
  display: {
    name: "Command Code",
    icon: "smart_toy",
    color: "#000000",
    textIcon: "CC",
    website: "https://commandcode.ai",
    notice: {
      text: "Use your CommandCode CLI API key (starts with user_...) from ~/.commandcode/auth.json or commandcode.ai/studio.",
      apiKeyUrl: "https://commandcode.ai/studio",
    },
  },
  category: "apikey",
  transport: {
    // Provider surface first. /alpha/generate is the CLI-only endpoint: it is
    // version-gated and region-gated for external callers, so a Meta model that
    // the account may use still 403s "not available in your region" there.
    // /provider/v1/chat/completions is the same gateway on the documented
    // Provider API surface; the executor falls back to alpha on 403/404.
    baseUrl: "https://api.commandcode.ai/provider/v1/chat/completions",
    cliUrl: "https://api.commandcode.ai/alpha/generate",
    // Body/response shape stays NDJSON (AI SDK v5) on both surfaces — the
    // executor pins responseFormat to "commandcode" so the SSE translator runs.
    format: "openai",
    forceStream: true,
    headers: {
      // Latest published CLI build (registry.npmjs.org/command-code/latest).
      "x-command-code-version": "1.81.0",
    },
  },
  models: [
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "deepseek/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp" },
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp", upstreamModelId: "deepseek/deepseek-v4-flash-vision-exp" },
    { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code" },
    { id: "moonshotai/Kimi-K2.7-Code-Highspeed", name: "Kimi K2.7 Code HighSpeed" },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6" },
    { id: "moonshotai/Kimi-K2.5", name: "Kimi K2.5" },
    { id: "zai-org/GLM-5.2", name: "GLM 5.2" },
    { id: "zai-org/GLM-5.2-Fast", name: "GLM 5.2 Fast" },
    { id: "zai-org/GLM-5.1", name: "GLM 5.1" },
    { id: "zai-org/GLM-5", name: "GLM 5" },
    { id: "MiniMaxAI/MiniMax-M3", name: "MiniMax M3" },
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7" },
    { id: "MiniMaxAI/MiniMax-M2.5", name: "MiniMax M2.5" },
    { id: "xiaomi/mimo-v2.5-pro", name: "MiMo V2.5 Pro" },
    { id: "xiaomi/mimo-v2.5", name: "MiMo V2.5" },
    { id: "Qwen/Qwen3.6-Max-Preview", name: "Qwen 3.6 Max Preview" },
    { id: "Qwen/Qwen3.6-Plus", name: "Qwen 3.6 Plus" },
    { id: "Qwen/Qwen3.7-Max", name: "Qwen 3.7 Max" },
    { id: "Qwen/Qwen3.7-Plus", name: "Qwen 3.7 Plus" },
    { id: "stepfun/Step-3.7-Flash", name: "Step 3.7 Flash" },
    { id: "stepfun/Step-3.5-Flash", name: "Step 3.5 Flash" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b", name: "Nemotron 3 Ultra" },
    { id: "meta/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
    { id: "meta/muse-spark-1.2-contributor", name: "Muse Spark 1.2 Contributor" },
    { id: "meta/muse-spark-1.3", name: "Muse Spark 1.3" },
    { id: "meta/muse-spark-1.2", name: "Muse Spark 1.2" },
  ],
  // The live catalog is public and rotates; the list above is the offline seed
  // and any id the account actually has is allowed through.
  modelsFetcher: { url: "https://api.commandcode.ai/provider/v1/models", type: "commandcode" },
  passthroughModels: true,
  features: {
    usage: true,
    // API-key connections must be able to hit /api/usage/<id> (like ocg does).
    usageApikey: true,
  },
};
