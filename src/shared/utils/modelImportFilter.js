function parsePrice(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : null;
}

function modelPriceTier(model) {
  const pricing = model?.pricing;
  const hasPaidPrice = pricing && typeof pricing === "object" && !Array.isArray(pricing)
    && Object.values(pricing).some((value) => parsePrice(value) > 0);
  if (model?.tier === "paid" || hasPaidPrice) return "paid";
  const prompt = parsePrice(pricing?.prompt);
  const completion = parsePrice(pricing?.completion);
  if (prompt === 0 && completion === 0) return "free";
  if (model?.tier === "free" || model?.free === true || model?.is_free === true) return "free";
  const id = model?.id || model?.name || model?.model;
  if (typeof id === "string" && (id.endsWith(":free") || id.endsWith("-free"))) return "free";
  return "unknown";
}

// Missing pricing does not imply that a model is paid.
export function filterModelsForImport(models, filter = "all") {
  if (!Array.isArray(models)) return [];
  if (filter !== "free" && filter !== "paid") return models;
  return models.filter((model) => modelPriceTier(model) === filter);
}
