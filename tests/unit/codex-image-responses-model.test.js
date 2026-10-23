import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("../../src/sse/services/auth.js", () => ({
  ...mocks,
  extractApiKey: () => null,
  resolveClientApiKey: async () => ({ apiKey: null, valid: true }),
  isValidApiKey: vi.fn(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: async () => ({ requireApiKey: false }) }));
vi.mock("../../src/sse/services/model.js", () => ({
  getModelInfo: async () => ({ provider: "codex", model: "gpt-image-2.5" }),
  getComboModels: async () => null,
}));
vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  enforceKeyAccess: async () => null,
}));
vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_provider, credentials) => credentials,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("../../src/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

import { handleImageGenerationCore } from "../../open-sse/handlers/imageGenerationCore.js";
import { handleImageGeneration } from "../../src/sse/handlers/imageGeneration.js";
import codexAdapter from "../../open-sse/handlers/imageProviders/codex.js";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

const toolModels = [
  "gpt-image-1.5", "gpt-image-2", "gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst",
];

function imageResponse() {
  return new Response('event: response.output_item.done\ndata: {"item":{"type":"image_generation_call","result":"image"}}\n\n', {
    headers: { "Content-Type": "text/event-stream" },
  });
}

function unsupportedModel(model) {
  return Response.json({ detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.` }, { status: 400 });
}

function imageRequest() {
  return new Request("http://localhost/v1/images/generations", {
    method: "POST",
    body: JSON.stringify({ model: "cx/gpt-image-2.5", prompt: "Draw a square" }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CODEX_IMAGE_RESPONSES_MODEL", "");
  mocks.getProviderCredentials.mockImplementation(async (_provider, excluded) => {
    const connectionId = ["account-a", "account-b"].find(id => !excluded.has(id));
    return connectionId ? { connectionId, accessToken: "test-token" } : null;
  });
  mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
  vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body);
    return request.model === "gpt-5.5" ? unsupportedModel(request.model) : imageResponse();
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Codex image Responses model", () => {
  it("anchors the existing cooldown rule for a rejected Codex main model", () => {
    const res = checkFallbackError(400,
      "The 'gpt-5.6-luna' model is not supported when using Codex with a ChatGPT account.",
      0, "codex",
    );
    expect(res.shouldFallback).toBe(true);
    expect(res.cooldownMs).toBeGreaterThan(0);
  });

  it("recognizes a rejection of the configured main model during account fallback", async () => {
    vi.stubEnv("CODEX_IMAGE_RESPONSES_MODEL", "gpt-6-astra");
    fetch.mockResolvedValueOnce(unsupportedModel("gpt-6-astra"));
    const response = await handleImageGeneration(imageRequest());
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    for (const [, options] of fetch.mock.calls) expect(JSON.parse(options.body).model).toBe("gpt-6-astra");
  });

  it.each(toolModels)("avoids the retired default main model for %s", async (model) => {
    const result = await handleImageGenerationCore({
      body: { prompt: "Draw a square" },
      modelInfo: { provider: "codex", model },
      credentials: { accessToken: "test-token" },
    });
    expect(result.success).toBe(true);
    expect((await result.response.json()).data).toEqual([{ b64_json: "image" }]);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.tools[0]).toMatchObject({ model, action: "generate" });
  });

  it("lets operators select the Responses model without changing the image tool", () => {
    vi.stubEnv("CODEX_IMAGE_RESPONSES_MODEL", "  gpt-6-astra  ");
    const body = codexAdapter.buildBody("gpt-image-2.5", {
      prompt: "Edit the square", image: "data:image/png;base64,aW1hZ2U=",
    });
    expect(body.model).toBe("gpt-6-astra");
    expect(body.tools[0]).toMatchObject({ model: "gpt-image-2.5", action: "edit" });
  });

  it("uses the default for a whitespace-only setting", () => {
    vi.stubEnv("CODEX_IMAGE_RESPONSES_MODEL", "  ");
    expect(codexAdapter.buildBody("gpt-image-2.5", { prompt: "Draw" }).model).toBe("gpt-5.6-terra");
  });

  it("keeps explicit Responses image aliases independent of the setting", () => {
    vi.stubEnv("CODEX_IMAGE_RESPONSES_MODEL", "gpt-6-astra");
    const body = codexAdapter.buildBody("gpt-5.6-terra-image", { prompt: "Draw" });
    expect(body.model).toBe("gpt-5.6-terra");
    expect(body.tools[0]).not.toHaveProperty("model");
  });

  it("tries another account without locking the image model for a main-model rejection", async () => {
    fetch.mockResolvedValueOnce(unsupportedModel("gpt-5.6-terra"));
    const response = await handleImageGeneration(imageRequest());
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
    expect(mocks.clearAccountError).toHaveBeenCalledWith("account-b", expect.any(Object), "gpt-image-2.5");
  });

  it("returns the upstream error after exhausting accounts without persisting an image cooldown", async () => {
    fetch.mockImplementation(async () => unsupportedModel("gpt-5.6-terra"));
    const response = await handleImageGeneration(imageRequest());
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("gpt-5.6-terra");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(3);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it.each([
    [400, { detail: "The 'gpt-image-2.5' model is not supported when using Codex with a ChatGPT account." }],
    [400, { detail: "Invalid image size" }],
    [429, { detail: "Rate limit exceeded" }],
  ])("retains normal account handling for status %s with %j", async (status, error) => {
    fetch.mockResolvedValueOnce(Response.json(error, { status }));
    const response = await handleImageGeneration(imageRequest());
    expect(response.status).toBe(status);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "account-a", status, expect.any(String), "codex", "gpt-image-2.5",
    );
  });
});
