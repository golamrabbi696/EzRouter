import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveBareModelStaticOwner } from "open-sse/services/model.js";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-bare-model-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const { getModelInfo } = await import("@/sse/services/model.js");

  return {
    getModelInfo,
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("bare model resolution", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("resolves prefix-collision models to the prefix-matching provider", () => {
    // glm-5.2 is declared by glm, opencode-go, qianfan, etc. — the name prefix
    // is the deterministic tiebreak, so bare "glm-5.2" means glm/glm-5.2.
    expect(resolveBareModelStaticOwner("glm-5.2")).toBe("glm");
  });

  it("resolves single-owner models without admin data", () => {
    expect(resolveBareModelStaticOwner("claude-opus-4-20250514")).toBe("anthropic");
  });

  it("leaves connection-less catalog models for the live opencode catalog", () => {
    // Not declared statically (opencode's catalog is fetched at runtime).
    expect(resolveBareModelStaticOwner("big-pickle")).toBeNull();
    expect(resolveBareModelStaticOwner("deepseek-v4-flash-free")).toBeNull();
  });

  it("routes bare opencode free models via the live catalog", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [{ id: "big-pickle" }, { id: "deepseek-v4-flash-free" }],
      }),
    }));

    const info = await ctx.getModelInfo("big-pickle");
    expect(info.provider).toBe("opencode");
    expect(info.model).toBe("big-pickle");

    const deep = await ctx.getModelInfo("deepseek-v4-flash-free");
    expect(deep.provider).toBe("opencode");
    expect(deep.model).toBe("deepseek-v4-flash-free");
  });

  it("routes bare static-registry names without hitting the catalog", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    globalThis.fetch = vi.fn(async () => {
      throw new Error("catalog fetch must not be reached");
    });

    const info = await ctx.getModelInfo("glm-5.2");
    expect(info.provider).toBe("glm");
    expect(info.model).toBe("glm-5.2");
  });

  it("lets user-defined model aliases win over static catalog owners", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    globalThis.fetch = vi.fn(async () => {
      throw new Error("catalog fetch must not be reached");
    });

    // Explicit alias intent (e.g. point bare glm-5.2 at opencode's free tier)
    // must beat the deterministic static scan, which would route to glm.
    const { setModelAlias } = await import("@/lib/localDb");
    await setModelAlias("glm-5.2", "oc/glm-5.2");

    const info = await ctx.getModelInfo("glm-5.2");
    expect(info.provider).toBe("opencode");
    expect(info.model).toBe("glm-5.2");
  });
});
