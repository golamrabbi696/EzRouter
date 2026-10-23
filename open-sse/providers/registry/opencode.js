export default {
  id: "opencode",
  priority: 40,
  hasFree: true,
  alias: "oc",
  uiAlias: "oc",
  display: {
    name: "OpenCode Free",
    icon: "terminal",
    color: "#E87040",
    textIcon: "OC",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://opencode.ai",
    headers: {
      "x-opencode-client": "desktop",
    },
    forceStream: true,
    noAuth: true,
    // Zen reasoning models reject multi-turn history whose assistant messages
    // carry no reasoning_content (400 missing_required_parameter), and the
    // response pipeline strips the field before it reaches the client, so the
    // echo can never come from the client. Inject a placeholder instead.
    reasoningInject: {
      scope: "all",
    },
    quirks: {
      forceAutoToolChoiceModels: ["muse-spark-1.3-contributor-free"],
      // The free lane's MiMo route (OpenRouter-backed) streams thinking as
      // `reasoning` + `reasoning_details[]`, not reasoning_content. stream.js lifts
      // the alias into reasoning_content for OpenAI-shaped clients; every other
      // model on the lane already emits reasoning_content, so the lift is a no-op.
      reasoningAliasFields: true,
    },
  },
  models: [
    // Muse Spark models are served by /zen/v1/responses; the rest stay on
    // /chat/completions, so the format is declared per-model, not per-provider.
    { id: "x-preview-f-free", name: "Ox Alpha Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "ox-alpha-free", name: "Ox Alpha Free", upstreamModelId: "x-preview-f-free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "ox-alpha", name: "Ox Alpha", upstreamModelId: "x-preview-f-free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "muse-spark-1.2-contributor-free", name: "Muse Spark 1.2 Contributor Free", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3 Contributor Free", targetFormat: "openai-responses", supportedFormats: ["openai-responses"] },
    { id: "union-alpha", name: "Union Alpha Free", targetFormat: "claude", supportedFormats: ["claude"] },
    { id: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free", supportedFormats: ["openai", "claude", "openai-responses"] },
    { id: "mimo-v2.5-free", name: "MiMo v2.5 Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "hy3-free", name: "Hunyuan 3 Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free", targetFormat: "openai", supportedFormats: ["openai"] },
    { id: "jev-1.13-free", name: "Jev 1.13 Free", kind: "systemone" },
  ],
  serviceKinds: ["llm", "systemone"],
  systemoneConfig: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    headers: {
      "x-opencode-client": "desktop",
      "User-Agent": "opencode/latest/2.0.29/cli",
    },
  },
  modelsFetcher: { url: "https://opencode.ai/zen/v1/models", type: "opencode-free" },
  passthroughModels: true,
};
