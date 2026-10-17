export default {
  id: "kira",
  priority: 120,
  alias: "kira",
  aliases: [
    "kiraai",
  ],
  uiAlias: "kira",
  display: {
    name: "Kira AI",
    icon: "sparkles",
    color: "#C87941",
    textIcon: "KA",
    website: "https://kiraai.vn",
    notice: {
      text: "OpenAI-compatible AI platform from Vietnam. Offers native models (kira-3.5-flash, kira-3.5-pro, kira-mini-1.0) and top-tier LLMs with vision, image, and TTS capabilities.",
      apiKeyUrl: "https://kiraai.vn/developer/",
    },
  },
  category: "apikey",
  authType: "apikey",
  transport: {
    baseUrl: "https://kiraai.vn/api/v1/chat/completions",
    validateUrl: "https://kiraai.vn/api/v1/models",
    retry: {
      429: 2,
    },
  },
  models: [
    { id: "kira-3.5-flash", name: "Kira 3.5 Flash" },
    { id: "kira-3.5-pro", name: "Kira 3.5 Pro" },
    { id: "kira-mini-1.0", name: "Kira Mini 1.0" },
    { id: "kira-2.5-flash", name: "Kira 2.5 Flash" },
    { id: "kira-2.5-pro", name: "Kira 2.5 Pro" },
    { id: "kira-coding", name: "Kira Coding" },
    { id: "kira-3.0-image", name: "Kira 3.0 Image", kind: "image" },
    { id: "kira-3.0-flash-tts", name: "Kira 3.0 Flash TTS", kind: "tts" },
  ],
  modelsFetcher: { url: "https://kiraai.vn/api/v1/models", type: "openai" },
  passthroughModels: true,
};
