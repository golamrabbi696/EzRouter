import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let getAdapter;
let createApiKey;
let getApiKeyByValue;
let reserveApiKeyTokens;
let settleApiKeyTokens;
let updateApiKey;
let validateApiKey;

const prefix = `policy-test-${Date.now()}`;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ezrouter-test-api-keys-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  ({ getAdapter } = await import("../../src/lib/db/driver.js"));
  ({
    createApiKey,
    getApiKeyByValue,
    reserveApiKeyTokens,
    settleApiKeyTokens,
    updateApiKey,
    validateApiKey,
  } = await import("../../src/lib/db/repos/apiKeysRepo.js"));
  const db = await getAdapter();
  db.run("DELETE FROM apiKeys WHERE name LIKE ?", [`${prefix}%`]);
});

afterAll(async () => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("API key policies", () => {
  it("keeps policy fields optional for new keys", async () => {
    const key = await createApiKey(`${prefix}-unrestricted`, "test-machine");
    expect(key.expiresAt).toBeNull();
    expect(key.tokenLimit).toBeNull();
    expect(key.allowedModels).toBeNull();
    expect(await validateApiKey(key.key)).toBe(true);
  });

  it("reserves quota atomically and settles against actual usage", async () => {
    const key = await createApiKey(`${prefix}-limited`, "test-machine", { tokenLimit: 10 });
    expect(await reserveApiKeyTokens(key.key, 8)).toMatchObject({ ok: true, reserved: 8 });
    expect(await reserveApiKeyTokens(key.key, 3)).toMatchObject({ ok: false });
    await settleApiKeyTokens(key.key, 8, 5);
    const after = await getApiKeyByValue(key.key);
    expect(after.tokensUsed).toBe(5);
    expect(after.tokensReserved).toBe(0);
  });

  it("reserves concurrent quota only once", async () => {
    const key = await createApiKey(`${prefix}-atomic`, "test-machine", { tokenLimit: 10 });
    const reservations = await Promise.all(Array.from({ length: 4 }, () => reserveApiKeyTokens(key.key, 5)));
    expect(reservations.filter((result) => result.ok)).toHaveLength(2);
    const after = await getApiKeyByValue(key.key);
    expect(after.tokensReserved).toBe(10);
  });

  it("adds quota without resetting recorded usage", async () => {
    const key = await createApiKey(`${prefix}-top-up`, "test-machine", { tokenLimit: 100 });
    await reserveApiKeyTokens(key.key, 40);
    await settleApiKeyTokens(key.key, 40, 40);
    await updateApiKey(key.id, { tokenLimitIncrement: 50 });
    const after = await getApiKeyByValue(key.key);
    expect(after.tokenLimit).toBe(150);
    expect(after.tokensUsed).toBe(40);
    expect(await reserveApiKeyTokens(key.key, 110)).toMatchObject({ ok: true, reserved: 110 });
  });

  it("invalidates an expired key while allowing a future expiry", async () => {
    const key = await createApiKey(`${prefix}-expiring`, "test-machine");
    await updateApiKey(key.id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(await validateApiKey(key.key)).toBe(false);
    await updateApiKey(key.id, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await validateApiKey(key.key)).toBe(true);
  });
});
