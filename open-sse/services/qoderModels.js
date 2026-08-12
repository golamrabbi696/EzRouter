/**
 * Qoder model catalog — re-exports protocol catalog (single source of truth).
 */

export {
  getQoderModelConfig,
  resolveQoderModels,
  invalidateQoderCatalog,
  clearQoderCatalog,
} from "../protocol/qoder/index.js";


export async function resolveQoderCredentials(credentials, proxyOptions = null, signal = null) {
  const raw = credentials?.apiKey || credentials?.accessToken;
  return {
    ...credentials,
    accessToken: raw,
    apiKey: raw,
  };
}
