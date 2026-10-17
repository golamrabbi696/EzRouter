/**
 * opencode V2 config emission for the 9router OpenCode configurator.
 *
 * Guards the regression that broke opencode V2:
 *  - emitted provider must use the V2-native `providers` block with the exact
 *    registered package id `@opencode/ai/providers/openai-compatible-responses`
 *    (hyphen form). The slash form selects a different transport and made
 *    opencode send a Responses body to the chat route (400 + stream parse fail).
 *  - `provider` (V1) / `npm: @ai-sdk/openai-compatible` must never be emitted.
 *  - reads must stay backward compatible with existing V1 configs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import fs from "fs/promises";
import path from "path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

vi.mock("child_process", () => ({
  exec: (cmd, opts, cb) => cb(null, "ok", ""),
}));

vi.mock("@/lib/db", () => ({
  getApiKeys: vi.fn(async () => [{ key: "sk_test_key", isActive: true }]),
}));

const { GET, POST, DELETE } = await import(
  "../../src/app/api/cli-tools/opencode-settings/route.js"
);

const PACKAGE_ID = "@opencode/ai/providers/openai-compatible-responses";

let home;
const configPath = () => path.join(home, ".config", "opencode", "opencode.json");
const readConfigFile = async () => JSON.parse(await fs.readFile(configPath(), "utf-8"));

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-v2-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(home, { recursive: true, force: true });
});

const post = (body) => POST({ json: async () => body });

describe("opencode settings route — V2 emission", () => {
  it("writes a V2 providers block and never a legacy V1 block", async () => {
    await post({
      baseUrl: "https://9router.example.com",
      apiKey: "sk_test_key",
      models: ["General", "Fast"],
      activeModel: "General",
      subagentModel: "Fast",
    });

    const config = await readConfigFile();

    expect(config.provider).toBeUndefined();
    expect(config.agent).toBeUndefined();
    expect(config.providers["9router"].package).toBe(PACKAGE_ID);
    expect(config.providers["9router"].settings.baseURL).toBe("https://9router.example.com/v1");
    expect(config.providers["9router"].settings.apiKey).toBe("sk_test_key");
    expect(config.providers["9router"].models.General).toEqual({
      name: "General",
      capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    });
    expect(config.providers["9router"].models.General.modalities).toBeUndefined();
    expect(config.model).toBe("9router/General");
    expect(config.agents.explorer.model).toBe("9router/Fast");
  });

  it("migrates an existing V1 config in place", async () => {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(
      configPath(),
      JSON.stringify({
        provider: {
          "9router": {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://old.example.com/v1", apiKey: "old" },
            models: { Old: { name: "Old", modalities: { input: ["text"], output: ["text"] } } },
          },
        },
        model: "9router/Old",
        agent: { explorer: { model: "9router/Old" } },
      }),
    );

    await post({ baseUrl: "https://9router.example.com", apiKey: "sk_new", models: ["New"] });

    const config = await readConfigFile();
    expect(config.provider).toBeUndefined();
    expect(config.agent).toBeUndefined();
    // pre-existing models are preserved on the V2 entry
    expect(Object.keys(config.providers["9router"].models).sort()).toEqual(["New", "Old"]);
    expect(config.model).toBe("9router/New");
  });

  it("reads baseURL + models from either schema", async () => {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });

    await fs.writeFile(
      configPath(),
      JSON.stringify({ providers: { "9router": { settings: { baseURL: "https://v2/v1" }, models: { A: {} } } } }),
    );
    let res = await GET();
    expect(res.body.has9Router).toBe(true);
    expect(res.body.opencode.baseURL).toBe("https://v2/v1");
    expect(res.body.opencode.models).toEqual(["A"]);

    await fs.writeFile(
      configPath(),
      JSON.stringify({ provider: { "9router": { options: { baseURL: "https://v1/v1" }, models: { B: {} } } } }),
    );
    res = await GET();
    expect(res.body.has9Router).toBe(true);
    expect(res.body.opencode.baseURL).toBe("https://v1/v1");
    expect(res.body.opencode.models).toEqual(["B"]);
  });

  it("deletes both key shapes on reset", async () => {
    await post({ baseUrl: "https://9router.example.com", apiKey: "sk_test_key", models: ["General"] });
    await DELETE({ url: "https://x/api/cli-tools/opencode-settings" });

    const config = await readConfigFile();
    expect(config.providers?.["9router"]).toBeUndefined();
    expect(config.provider?.["9router"]).toBeUndefined();
    expect(config.agents?.explorer).toBeUndefined();
    expect(config.agent?.explorer).toBeUndefined();
    expect(config.model).toBeUndefined();
  });
});
