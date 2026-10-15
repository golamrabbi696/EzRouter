// OpenAI-compatible embeddings adapter (most providers)
import { bearerAuth } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

// media-only providers without a registry file keep URL here; rest derive from registry media.embeddingConfig.baseUrl
const ENDPOINTS = {
  "jina-ai": "https://api.jina.ai/v1/embeddings",
};

const embedCfg = (id) => PROVIDER_MEDIA[id]?.embeddingConfig || {};
const embedUrl = (id) => embedCfg(id).baseUrl || ENDPOINTS[id];

export default function createOpenAIEmbeddingAdapter(providerId) {
  const cfg = embedCfg(providerId);
  return {
    buildUrl: () => embedUrl(providerId),
    buildHeaders: (creds) => {
      // cfg.tokenField: providers whose API rejects the raw accessToken in
      // favor of an exchange-derived token (GitHub Copilot → copilotToken).
      const token = (cfg.tokenField && creds?.[cfg.tokenField]) || creds?.apiKey || creds?.accessToken;
      return {
        "Content-Type": "application/json",
        ...(token ? { "Authorization": `Bearer ${token}` } : bearerAuth(creds)),
        ...(cfg.headers || {}),
      };
    },
    buildBody: (model, { input, encoding_format, dimensions }) => {
      const body = { model, input };
      if (encoding_format) body.encoding_format = encoding_format;
      if (dimensions != null && dimensions !== "") {
        const dim = Number(dimensions);
        if (Number.isFinite(dim) && dim > 0) body.dimensions = dim;
      }
      return body;
    },
    normalize: (responseBody) => responseBody,
  };
}
