import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const driver = vi.hoisted(() => ({ adapter: null }));
vi.mock("@/lib/db/driver.js", () => ({ getAdapter: async () => driver.adapter }));
import {
  getWakeupState, saveWakeupTask, deleteWakeupTask, claimWakeupRun, finishWakeupRun,
  recoverWakeupRuns, acquirePingLease, releasePingLease, recordWakeupResult, setWakeupEnabled,
} from "../../src/lib/db/repos/wakeupRepo.js";

const task = { name: "Morning", provider: "codex", connectionIds: ["account"], enabled: true, model: "", prompt: "hi", reasoning: "none", schedule: { kind: "interval", minutes: 60 } };
let database;
let directory;
function openDatabase() {
  database = new DatabaseSync(join(directory, "test.sqlite"));
  database.exec("CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY, data TEXT)");
  driver.adapter = {
    get: (sql, params = []) => database.prepare(sql).get(...params),
    run: (sql, params = []) => database.prepare(sql).run(...params),
    transaction(callback) {
      database.exec("BEGIN IMMEDIATE");
      try { const result = callback(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "wakeup-test-")); openDatabase(); });
afterEach(() => { database.close(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

describe("persistent wakeup tasks", () => {
  it("persists tasks across a database reopen and preserves unrelated settings", async () => {
    database.prepare("INSERT INTO settings VALUES(1, ?)").run(JSON.stringify({ requireLogin: true }));
    const saved = await saveWakeupTask(task);
    database.close(); openDatabase();
    expect((await getWakeupState()).tasks[0]).toEqual(saved);
    expect(JSON.parse(database.prepare("SELECT data FROM settings").get().data).requireLogin).toBe(true);
  });
  it("claims a due task once, advances its schedule before sending, and blocks overlapping manual runs", async () => {
    const saved = await saveWakeupTask(task);
    const due = Date.parse(saved.nextRunAt) + 3 * 3600000;
    const first = await claimWakeupRun(saved.id, "scheduled", due);
    expect(first.run.status).toBe("running");
    expect(await claimWakeupRun(saved.id, "scheduled", due)).toBe(null);
    expect(await claimWakeupRun(saved.id)).toBe(null);
    expect(Date.parse((await getWakeupState()).tasks[0].nextRunAt)).toBe(due + 3600000);
  });
  it("manual runs do not change the next scheduled time", async () => {
    const saved = await saveWakeupTask(task);
    await claimWakeupRun(saved.id);
    expect((await getWakeupState()).tasks[0].nextRunAt).toBe(saved.nextRunAt);
    await expect(deleteWakeupTask(saved.id)).rejects.toThrow("running");
  });
  it("recovers stale runs without replaying external requests", async () => {
    const saved = await saveWakeupTask(task);
    const { run } = await claimWakeupRun(saved.id);
    await recordWakeupResult(run.id, { connectionId: "account", status: "succeeded" });
    await recoverWakeupRuns(run.expiresAt + 1);
    expect((await getWakeupState()).runs[0]).toMatchObject({ status: "interrupted", results: [{ connectionId: "account", status: "succeeded" }] });
  });
  it("supports disabled tasks and global pause while allowing explicit manual execution", async () => {
    const saved = await saveWakeupTask({ ...task, enabled: false });
    expect(await claimWakeupRun(saved.id, "scheduled")).toBe(null);
    await setWakeupEnabled(false);
    expect((await claimWakeupRun(saved.id)).run.status).toBe("running");
  });
  it("holds account leases across database reopen and releases only the owner token", async () => {
    const token = await acquirePingLease("account");
    database.close(); openDatabase();
    expect(await acquirePingLease("account")).toBe(null);
    await releasePingLease("account", "wrong-token");
    expect(await acquirePingLease("account")).toBe(null);
    await releasePingLease("account", token);
    expect(await acquirePingLease("account")).toEqual(expect.any(String));
  });
  it("retains history after deletion", async () => {
    const saved = await saveWakeupTask(task);
    const { run } = await claimWakeupRun(saved.id);
    await recordWakeupResult(run.id, { connectionId: "account", status: "succeeded" });
    await finishWakeupRun(run.id);
    await deleteWakeupTask(saved.id);
    expect((await getWakeupState()).runs[0].status).toBe("succeeded");
    expect((await getWakeupState()).tasks).toHaveLength(0);
  });

  it.each(["failed", "skipped"])("reports an entirely %s run accurately", async (status) => {
    const saved = await saveWakeupTask(task);
    const { run } = await claimWakeupRun(saved.id);
    await recordWakeupResult(run.id, { connectionId: "account", status });
    await finishWakeupRun(run.id);
    expect((await getWakeupState()).runs[0].status).toBe(status);
  });
});
