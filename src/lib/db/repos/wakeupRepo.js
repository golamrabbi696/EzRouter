import { randomUUID } from "node:crypto";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { nextWakeupAt } from "@/shared/services/wakeupSchedule";

const emptyState = () => ({ enabled: true, tasks: [], runs: [], leases: {} });

export async function getWakeupState() {
  const db = await getAdapter();
  const settings = parseJson(db.get("SELECT data FROM settings WHERE id = 1")?.data, {});
  return { ...emptyState(), ...settings.wakeupState };
}

async function mutate(callback) {
  const db = await getAdapter();
  let result;
  db.transaction(() => {
    const settings = parseJson(db.get("SELECT data FROM settings WHERE id = 1")?.data, {});
    const state = { ...emptyState(), ...settings.wakeupState };
    result = callback(state);
    settings.wakeupState = state;
    db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [stringifyJson(settings)]);
  });
  return result;
}

function assertIdle(state, id) {
  if (state.runs.some((run) => run.taskId === id && run.status === "running")) throw new Error("Task is running; wait before editing or deleting it.");
}

export async function saveWakeupTask(input, id = null) {
  const nextRunAt = input.enabled ? nextWakeupAt(input.schedule) : null;
  return mutate((state) => {
    const existing = id && state.tasks.find((task) => task.id === id);
    if (id && !existing) throw new Error("Task not found.");
    if (!id && state.tasks.length >= 100) throw new Error("Maximum 100 tasks.");
    if (id) assertIdle(state, id);
    const task = { ...input, id: id || randomUUID(), nextRunAt, createdAt: existing?.createdAt || new Date().toISOString() };
    state.tasks = existing ? state.tasks.map((item) => item.id === id ? task : item) : [...state.tasks, task];
    return task;
  });
}

export async function deleteWakeupTask(id) {
  return mutate((state) => {
    assertIdle(state, id);
    if (!state.tasks.some((task) => task.id === id)) throw new Error("Task not found.");
    state.tasks = state.tasks.filter((task) => task.id !== id);
  });
}

export async function setWakeupEnabled(enabled) {
  return mutate((state) => { state.enabled = enabled; });
}

export async function recoverWakeupRuns(now = Date.now()) {
  return mutate((state) => {
    for (const run of state.runs) {
      if (run.status === "running" && run.expiresAt <= now) {
        run.status = "interrupted";
        run.finishedAt = new Date(now).toISOString();
      }
    }
    for (const [id, lease] of Object.entries(state.leases)) if (lease.expiresAt <= now) delete state.leases[id];
  });
}

export async function claimWakeupRun(taskId, trigger = "manual", now = Date.now(), account = null) {
  return mutate((state) => {
    const task = taskId ? state.tasks.find((item) => item.id === taskId) : account;
    if (!task) throw new Error("Task not found.");
    if (trigger === "scheduled" && (!state.enabled || !task.enabled || !task.nextRunAt || Date.parse(task.nextRunAt) > now)) return null;
    if (taskId && state.runs.some((run) => run.taskId === taskId && run.status === "running")) return null;
    if (state.runs.filter((run) => run.status === "running").length >= 20) throw new Error("Too many running tasks.");
    if (trigger === "scheduled") task.nextRunAt = nextWakeupAt(task.schedule, now);
    const run = {
      id: randomUUID(), taskId, name: task.name, trigger, status: "running",
      startedAt: new Date(now).toISOString(), expiresAt: now + task.connectionIds.length * 65000 + 10000,
      results: [],
    };
    state.runs = [run, ...state.runs.filter((item) => item.status === "running"), ...state.runs.filter((item) => item.status !== "running").slice(0, 99)];
    return { run, task: { ...task } };
  });
}

export async function recordWakeupResult(runId, result) {
  return mutate((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (run?.status === "running") run.results.push(result);
  });
}

export async function finishWakeupRun(runId, interrupted = false) {
  return mutate((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (run?.status !== "running") return;
    const statuses = new Set(run.results.map((item) => item.status));
    run.status = interrupted || !statuses.size ? "interrupted" : statuses.size === 1 ? run.results[0].status : "partial";
    run.finishedAt = new Date().toISOString();
    const retained = new Set(state.runs.filter((item) => item.status !== "running").slice(0, 100).map((item) => item.id));
    state.runs = state.runs.filter((item) => item.status === "running" || retained.has(item.id));
  });
}

export async function acquirePingLease(connectionId) {
  return mutate((state) => {
    if (state.leases[connectionId]?.expiresAt > Date.now()) return null;
    const token = randomUUID();
    state.leases[connectionId] = { token, expiresAt: Date.now() + 90000 };
    return token;
  });
}

export async function releasePingLease(connectionId, token) {
  return mutate((state) => {
    if (state.leases[connectionId]?.token === token) delete state.leases[connectionId];
  });
}
