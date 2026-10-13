import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;
let nodes;
let models;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-node-cleanup-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
  const { getAdapter } = await import("@/lib/db/driver.js");
  db = await getAdapter();
  nodes = await import("@/lib/db/repos/nodesRepo.js");
  models = await import("@/lib/db/repos/aliasRepo.js");
});

afterEach(() => {
  db?.close();
  delete global._dbAdapter;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("provider node custom model cleanup", () => {
  it.each(["openai-compatible", "anthropic-compatible", "custom-embedding"])(
    "removes all model types owned by a deleted %s node",
    async (type) => {
      const id = `${type}-test`;
      const node = await nodes.createProviderNode({ id, type, name: "Custom provider" });
      for (const modelType of ["llm", "image", "embedding"]) {
        await models.addCustomModel({ providerAlias: id, id: "custom-model", type: modelType });
      }
      await models.addCustomModel({ providerAlias: `${id}-other`, id: "custom-model" });
      await models.addCustomModel({ providerAlias: "ollama", id: "custom-model" });
      await models.setModelAlias("unrelated", "ollama/custom-model");

      expect(await nodes.deleteProviderNode(id)).toEqual(node);
      expect(await nodes.getProviderNodeById(id)).toBeNull();
      expect(await models.getCustomModels()).toEqual([
        expect.objectContaining({ providerAlias: `${id}-other` }),
        expect.objectContaining({ providerAlias: "ollama" }),
      ]);
      expect(await models.getModelAliases()).toEqual({ unrelated: "ollama/custom-model" });
    }
  );

  it("leaves models untouched when the node does not exist", async () => {
    await models.addCustomModel({ providerAlias: "missing", id: "legacy-model" });
    expect(await nodes.deleteProviderNode("missing")).toBeNull();
    expect(await models.getCustomModels()).toHaveLength(1);
  });

  it("rolls back model cleanup if node deletion fails", async () => {
    await nodes.createProviderNode({ id: "protected", type: "openai-compatible", name: "Protected" });
    await models.addCustomModel({ providerAlias: "protected", id: "custom-model" });
    db.exec(`CREATE TRIGGER prevent_node_delete BEFORE DELETE ON providerNodes
      BEGIN SELECT RAISE(ABORT, 'deletion blocked'); END;`);

    await expect(nodes.deleteProviderNode("protected")).rejects.toThrow("deletion blocked");
    expect(await nodes.getProviderNodeById("protected")).not.toBeNull();
    expect(await models.getCustomModels()).toHaveLength(1);
  });
});
