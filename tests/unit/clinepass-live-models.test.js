// /api/v1/models no longer lists cline-pass/* ids; the recommended-models
// feed's clinePass[] is the live source. resolveClinepassModels() must read it
// and only fall back to /models when the feed is unavailable.

import { describe, it, expect, vi, afterEach } from "vitest";

const MODELS_URL = "https://api.cline.bot/api/v1/models";
const FEED_URL = "https://api.cline.bot/api/v1/ai/cline/recommended-models";
const json = (obj, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => obj });

afterEach(() => vi.unstubAllGlobals());

async function resolveWith(routes) {
  vi.stubGlobal("fetch", vi.fn(async (url) => routes[String(url)] ?? json({}, false)));
  const { resolveClinepassModels } = await import("../../open-sse/services/clinepassModels.js");
  return resolveClinepassModels({ accessToken: "test-token" });
}

describe("resolveClinepassModels", () => {
  it("uses the feed's clinePass tier, ignoring other tiers", async () => {
    const result = await resolveWith({
      [FEED_URL]: json({
        free: [{ id: "cline-free/x" }],
        clinePass: [{ id: "cline-pass/glm-5.3", name: "GLM-5.3" }, { id: "cline-pass/kimi-k3" }],
      }),
      [MODELS_URL]: json([{ id: "z-ai/glm-5.3" }]),
    });
    expect(result.models).toEqual([
      { id: "cline-pass/glm-5.3", name: "GLM-5.3" },
      { id: "cline-pass/kimi-k3", name: "cline-pass/kimi-k3" },
    ]);
  });

  it("falls back to /api/v1/models when the feed's clinePass tier has no cline-pass ids", async () => {
    const result = await resolveWith({
      [FEED_URL]: json({ clinePass: [{ id: "z-ai/glm-5.3" }] }),
      [MODELS_URL]: json([{ id: "cline-pass/glm-5.3" }]),
    });
    expect(result.models.map((m) => m.id)).toEqual(["cline-pass/glm-5.3"]);
  });

  it("falls back to /api/v1/models when the feed is down", async () => {
    const result = await resolveWith({ [MODELS_URL]: json([{ id: "cline-pass/glm-5.3" }, { id: "z-ai/glm-5.3" }]) });
    expect(result.models.map((m) => m.id)).toEqual(["cline-pass/glm-5.3"]);
  });

  it("returns null when neither source lists a cline-pass model", async () => {
    expect(await resolveWith({ [MODELS_URL]: json([{ id: "z-ai/glm-5.3" }]) })).toBeNull();
  });
});
