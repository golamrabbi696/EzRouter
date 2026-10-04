import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/index.js", () => ({ getProviderConnections: vi.fn() }));
vi.mock("@/lib/db/repos/wakeupRepo.js", () => ({
  getWakeupState: vi.fn(), claimWakeupRun: vi.fn(), recordWakeupResult: vi.fn(), finishWakeupRun: vi.fn(), recoverWakeupRuns: vi.fn(),
}));
vi.mock("../../src/shared/services/quotaAutoPing", () => ({ pingAccountNow: vi.fn() }));
import { executeWakeupRun, runWakeupTick } from "../../src/shared/services/wakeupTasks.js";

beforeEach(() => vi.clearAllMocks());
describe("wakeup task execution", () => {
  it("continues after one account fails, and skips removed accounts", async () => {
    const deps = {
      getProviderConnections: vi.fn().mockResolvedValue([{ id: "first", provider: "codex", authType: "oauth" }, { id: "second", provider: "codex", authType: "oauth" }]),
      pingAccountNow: vi.fn().mockRejectedValueOnce(new Error("private token" )).mockResolvedValueOnce({ status: "succeeded", message: "Ping completed." }),
      recordWakeupResult: vi.fn(), finishWakeupRun: vi.fn(),
    };
    await executeWakeupRun({ run: { id: "run" }, task: { provider: "codex", connectionIds: ["first", "second", "removed"] } }, deps);
    expect(deps.recordWakeupResult.mock.calls.map((call) => call[1].status)).toEqual(["failed", "succeeded", "skipped"]);
    expect(JSON.stringify(deps.recordWakeupResult.mock.calls)).not.toContain("private token");
    expect(deps.finishWakeupRun).toHaveBeenCalledWith("run");
  });
  it("marks run interrupted if result persistence fails", async () => {
    const deps = {
      getProviderConnections: vi.fn().mockResolvedValue([]), pingAccountNow: vi.fn(),
      recordWakeupResult: vi.fn().mockRejectedValue(new Error("disk full")), finishWakeupRun: vi.fn(),
    };
    await executeWakeupRun({ run: { id: "run" }, task: { provider: "codex", connectionIds: ["removed"] } }, deps);
    expect(deps.finishWakeupRun).toHaveBeenCalledWith("run", true);
  });
  it("only runs claimed due tasks, never disabled or future tasks", async () => {
    const deps = {
      recoverWakeupRuns: vi.fn(),
      getWakeupState: vi.fn().mockResolvedValue({ enabled: true, tasks: [
        { id: "due", enabled: true, nextRunAt: "2000-01-01" },
        { id: "claimed-elsewhere", enabled: true, nextRunAt: "2000-01-01" },
        { id: "disabled", enabled: false, nextRunAt: "2000-01-01" },
        { id: "future", enabled: true, nextRunAt: "2100-01-01" },
      ] }),
      claimWakeupRun: vi.fn().mockResolvedValueOnce({ run: { id: "run" } }).mockResolvedValueOnce(null),
      executeWakeupRun: vi.fn().mockResolvedValue(),
    };
    await runWakeupTick(deps);
    expect(deps.claimWakeupRun).toHaveBeenCalledTimes(2);
    expect(deps.executeWakeupRun).toHaveBeenCalledTimes(1);
  });
});
