import { describe, expect, it } from "vitest";
import { filterModelsForImport } from "../../src/shared/utils/modelImportFilter.js";

const freeModels = [
  { id: "openrouter/model:free" },
  { id: "model-free" },
  { id: "tier-model", tier: "free" },
  { id: "flag-model", free: true },
  { id: "other-flag-model", is_free: true },
  { id: "zero-price", pricing: { prompt: "0", completion: "0.0" } },
  { id: "numeric-zero", pricing: { prompt: 0, completion: 0 } },
  { name: "name-free" },
  { model: "fallback:free" },
];
const paidModels = [
  { id: "paid-input", pricing: { prompt: "0.000001", completion: "0" } },
  { id: "paid-output", pricing: { prompt: 0, completion: 0.002 } },
  { id: "partial-paid", pricing: { completion: "1e-6" } },
  { id: "paid-tier", tier: "paid" },
  { id: "paid-tier-zero", tier: "paid", pricing: { prompt: 0, completion: 0 } },
  { id: "request-cost:free", pricing: { prompt: 0, completion: 0, request: "0.01" } },
  { id: "image-cost", free: true, pricing: { prompt: 0, completion: 0, image: "0.01" } },
];
const unknownModels = [
  { id: "unspecified" },
  { id: "partial-zero", pricing: { prompt: 0 } },
  { id: "null-price", pricing: { prompt: null, completion: null } },
  { id: "blank-price", pricing: { prompt: " ", completion: "" } },
  { id: "boolean-price", pricing: { prompt: false, completion: false } },
  { id: "invalid-price", pricing: { prompt: "free", completion: "NaN" } },
  { id: "negative-price", pricing: { prompt: -1, completion: -1 } },
  { id: "infinite-price", pricing: { prompt: Infinity, completion: Infinity } },
  { id: "string-flags", free: "true", is_free: "true" },
  null,
];

describe("model import price filters", () => {
  it.each(freeModels)("recognizes free catalog entry $id", (model) => {
    expect(filterModelsForImport([model], "free")).toEqual([model]);
    expect(filterModelsForImport([model], "paid")).toEqual([]);
  });

  it.each(paidModels)("recognizes paid catalog entry $id", (model) => {
    expect(filterModelsForImport([model], "paid")).toEqual([model]);
    expect(filterModelsForImport([model], "free")).toEqual([]);
  });

  it.each(unknownModels)("does not guess missing or invalid prices for %j", (model) => {
    expect(filterModelsForImport([model], "free")).toEqual([]);
    expect(filterModelsForImport([model], "paid")).toEqual([]);
  });

  it("does not let a free label override a positive price or paid tier", () => {
    const models = [
      { id: "model:free", pricing: { prompt: 0.1, completion: 0 }, free: true },
      { id: "model-free", tier: "paid" },
    ];
    expect(filterModelsForImport(models, "free")).toEqual([]);
    expect(filterModelsForImport(models, "paid")).toEqual(models);
  });

  it("keeps all entries by default and leaves provider metadata intact", () => {
    const models = [...freeModels, ...paidModels, ...unknownModels];
    const original = structuredClone(models);
    expect(filterModelsForImport(models)).toBe(models);
    expect(filterModelsForImport(models, "all")).toBe(models);
    const filtered = filterModelsForImport(models, "free");
    expect(filtered).toEqual(freeModels);
    expect(filtered[0]).toBe(models[0]);
    expect(models).toEqual(original);
  });

  it.each([undefined, null, {}])("handles a missing model array %j", (models) => {
    expect(filterModelsForImport(models, "free")).toEqual([]);
  });
});
