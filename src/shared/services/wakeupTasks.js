import { getProviderConnections } from "@/lib/db/index.js";
import { getWakeupState, claimWakeupRun, recordWakeupResult, finishWakeupRun, recoverWakeupRuns } from "@/lib/db/repos/wakeupRepo.js";
import { pingAccountNow } from "./quotaAutoPing";

const state = global.__wakeupTasks ??= { interval: null, ticking: false };

export async function executeWakeupRun(claim, deps = { getProviderConnections, pingAccountNow, recordWakeupResult, finishWakeupRun }) {
  try {
    for (const connectionId of claim.task.connectionIds) {
      const startedAt = Date.now();
      const connections = await deps.getProviderConnections({ provider: claim.task.provider, isActive: true });
      const connection = connections.find((item) => item.id === connectionId && item.authType === "oauth");
      let result;
      if (!connection) result = { status: "skipped", message: "Account removed, inactive or changed provider." };
      else {
        try { result = await deps.pingAccountNow(connectionId, claim.task); }
        catch { result = { status: "failed", message: "Unable to run account ping." }; }
      }
      await deps.recordWakeupResult(claim.run.id, { connectionId, ...result, durationMs: Date.now() - startedAt });
    }
    await deps.finishWakeupRun(claim.run.id);
  } catch {
    await deps.finishWakeupRun(claim.run.id, true);
  }
}

export async function runWakeupTaskNow(id) {
  await recoverWakeupRuns();
  const claim = await claimWakeupRun(id);
  if (!claim) throw new Error("Task is already running.");
  void executeWakeupRun(claim).catch(() => console.warn("[Wakeup] Failed to persist task result."));
  return claim.run;
}

export async function runWakeupTick(deps = { recoverWakeupRuns, getWakeupState, claimWakeupRun, executeWakeupRun }) {
  if (state.ticking) return;
  state.ticking = true;
  try {
    await deps.recoverWakeupRuns();
    const data = await deps.getWakeupState();
    if (!data.enabled) return;
    for (const task of data.tasks) {
      if (!task.enabled || !task.nextRunAt || Date.parse(task.nextRunAt) > Date.now()) continue;
      const claim = await deps.claimWakeupRun(task.id, "scheduled");
      if (claim) void deps.executeWakeupRun(claim).catch(() => console.warn("[Wakeup] Failed to persist task result."));
    }
  } finally {
    state.ticking = false;
  }
}

export function configureWakeupTasks(data) {
  if (!data?.enabled || !data.tasks?.some((task) => task.enabled)) {
    clearInterval(state.interval);
    state.interval = null;
    return;
  }
  if (state.interval) return;
  const tick = () => { runWakeupTick().catch(() => console.warn("[Wakeup] Scheduler tick failed.")); };
  state.interval = setInterval(tick, 15000);
  state.interval.unref?.();
  tick();
}
