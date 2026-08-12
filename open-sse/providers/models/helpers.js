// Codex auto-generates a "-review" variant for each llm model (review quota family)
export const CODEX_REVIEW_SUFFIX = "-review";

const CODEX_EFFORT_LEVELS = ["xhigh", "high", "medium", "low"];

export function withCodexEffortVariants(modelIds) {
  const targetSet = new Set(modelIds);
  return (models) => models.flatMap((model) => {
    if (!targetSet.has(model.id) || (model.kind || model.type || "llm") !== "llm") return [model];
    return [
      model,
      ...CODEX_EFFORT_LEVELS.map(level => ({
        ...model,
        id: `${model.id}-${level}`,
        name: `${model.name} (${level === "xhigh" ? "xHigh" : level.charAt(0).toUpperCase() + level.slice(1)})`,
      })),
    ];
  });
}

export function withCodexReviewModels(models) {
  return models.flatMap((model) => {
    if ((model.kind || model.type || "llm") !== "llm" || model.id.endsWith(CODEX_REVIEW_SUFFIX)) {
      return [model];
    }
    return [
      model,
      {
        ...model,
        id: `${model.id}${CODEX_REVIEW_SUFFIX}`,
        name: `${model.name} Review`,
        upstreamModelId: model.upstreamModelId || model.id,
        quotaFamily: "review"
      }
    ];
  });
}
