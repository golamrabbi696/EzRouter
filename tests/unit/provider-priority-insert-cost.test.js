import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

// Self-isolating: DATA_DIR points at a temp dir so seeding never touches ~/.ezrouter.
const originalDataDir = process.env.DATA_DIR;
let tempDir;
let createProviderConnection;
let getProviderConnections;
let deleteProviderConnection;
let updateProviderConnection;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ezrouter-test-priority-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  ({
    createProviderConnection,
    getProviderConnections,
    deleteProviderConnection,
    updateProviderConnection,
  } = await import("../../src/lib/db/index.js"));
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function seed(provider, n) {
  for (let i = 0; i < n; i++) {
    await createProviderConnection({
      provider,
      authType: "apikey",
      name: `seed-${i}`,
      apiKey: `k${i}`,
    });
  }
}

describe("provider insert is O(1) in pool size (#4311)", () => {
  it("assigns sequential priorities without a renumber pass", async () => {
    const P = `openai-compatible-seq-${Date.now()}`;
    await seed(P, 3);
    const list = await getProviderConnections({ provider: P });
    expect(list.map((c) => c.name)).toEqual(["seed-0", "seed-1", "seed-2"]);
    expect(list.map((c) => c.priority)).toEqual([1, 2, 3]);
  });

  it("keeps a large pool in insertion order", async () => {
    const P = `openai-compatible-ord-${Date.now()}`;
    await seed(P, 60);
    const list = await getProviderConnections({ provider: P });
    expect(list).toHaveLength(60);
    // The bug showed up as reordering once the pool grew past a few rows.
    expect(list[0].name).toBe("seed-0");
    expect(list[59].name).toBe("seed-59");
    for (let i = 1; i < list.length; i++) {
      expect(list[i].priority).toBeGreaterThan(list[i - 1].priority);
    }
  });

  it("still renumbers on delete, so gaps do not accumulate", async () => {
    const P = `openai-compatible-del-${Date.now()}`;
    await seed(P, 4);
    const before = await getProviderConnections({ provider: P });
    await deleteProviderConnection(before[0].id);
    const after = await getProviderConnections({ provider: P });
    expect(after.map((c) => c.priority)).toEqual([1, 2, 3]);
  });

  it("still renumbers on an explicit priority update", async () => {
    // Unique alias per run: the DB persists across runs, so a fixed alias
    // would accumulate rows and make this assertion depend on test order.
    const P = `openai-compatible-upd-${Date.now()}`;
    await seed(P, 4);
    await new Promise((r) => setTimeout(r, 10));
    const list = await getProviderConnections({ provider: P });
    // Move the last one to the front.
    await updateProviderConnection(list[3].id, { priority: 1 });
    const after = await getProviderConnections({ provider: P });
    expect(after[0].name).toBe("seed-3");
  });
});

describe("name collision no longer destroys a key silently (#4311)", () => {
  // Seeded once: these cases each mutate the SAME row, so a per-test seed
  // would make the later assertions depend on earlier ones.
  const P = `openai-compatible-clash-${Date.now()}`;
  let orig;

  beforeAll(async () => {
    await seed(P, 1);
    orig = (await getProviderConnections({ provider: P }))[0];
  });

  it("throws a typed conflict instead of overwriting, when overwrite is refused", async () => {
    await expect(
      createProviderConnection({
        provider: P,
        authType: "apikey",
        name: orig.name,
        apiKey: "REPLACEMENT-KEY",
        allowOverwrite: false,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_NAME_CONFLICT", existingId: orig.id });

    // The stored key must be untouched.
    const after = (await getProviderConnections({ provider: P }))[0];
    expect(after.apiKey).toBe(orig.apiKey);
  });

  it("still overwrites when the caller opts in", async () => {
    const updated = await createProviderConnection({
      provider: P,
      authType: "apikey",
      name: orig.name,
      apiKey: "REPLACEMENT-KEY",
      allowOverwrite: true,
    });
    expect(updated.id).toBe(orig.id);
    const after = (await getProviderConnections({ provider: P }))[0];
    expect(after.apiKey).toBe("REPLACEMENT-KEY");
  });

  it("defaults to the previous overwrite behaviour for existing callers", async () => {
    // Every other call site in the repo (oauth routes, bulk import) omits the
    // flag, so they must keep working exactly as before.
    const updated = await createProviderConnection({
      provider: P,
      authType: "apikey",
      name: orig.name,
      apiKey: "LEGACY-PATH-KEY",
    });
    expect(updated.id).toBe(orig.id);
  });

  it("does not collide across different providers", async () => {
    const other = await createProviderConnection({
      provider: "openai-compatible-other",
      authType: "apikey",
      name: orig.name,
      apiKey: "other-key",
    });
    expect(other.id).not.toBe(orig.id);
  });
});
