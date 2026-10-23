export default {
  id: "ollama-local",
  priority: 50,
  hasFree: true,
  alias: "ollama-local",
  display: {
    name: "Ollama Local",
    icon: "cloud",
    color: "#ffffffff",
    textIcon: "OL",
    website: "https://ollama.com",
  },
  category: "apikey",
  // The connection's own endpoint, stored as providerSpecificData.baseUrl.
  baseUrlField: {
    label: "Ollama Host URL",
    placeholder: "http://localhost:11434",
  },
  transport: {
    baseUrl: "http://localhost:11434/api/chat",
    format: "ollama",
    thinkingFormat: "ollama",
  },
  models: [
    { id: "embeddinggemma", name: "EmbeddingGemma", kind: "embedding" },
    { id: "nomic-embed-text", name: "Nomic Embed Text", kind: "embedding" },
    { id: "bge-m3", name: "BGE M3", kind: "embedding" },
    { id: "clef", name: "Clef", kind: "systemone" },
    { id: "clef-flash", name: "Clef Flash", kind: "systemone" },
  ],
  serviceKinds: ["llm", "embedding", "systemone"],
  embeddingConfig: { baseUrl: "http://localhost:11434/v1/embeddings", authType: "none" },
  systemoneConfig: {
    baseUrl: "http://localhost:11434/v1/systemone",
    // Saved host (providerSpecificData.baseUrl) is joined with this path.
    path: "/v1/systemone",
  },
};
