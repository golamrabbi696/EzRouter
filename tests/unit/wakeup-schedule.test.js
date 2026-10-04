import { describe, expect, it } from "vitest";
import { nextWakeupAt, validateWakeupTask } from "../../src/shared/services/wakeupSchedule.js";

const schedule = { kind: "daily", time: "06:00", timezone: "Asia/Ho_Chi_Minh", days: [0, 1, 2, 3, 4, 5, 6] };
const task = { name: "Morning", provider: "codex", connectionIds: ["account"], enabled: true, model: "", prompt: "hi", reasoning: "none", schedule };

describe("wakeup schedules", () => {
  it("finds the next daily time in the chosen timezone", () => {
    expect(nextWakeupAt(schedule, Date.parse("2026-10-02T00:00:00Z"))).toBe("2026-10-02T23:00:00.000Z");
  });
  it("supports selected weekdays", () => {
    expect(nextWakeupAt({ ...schedule, days: [1] }, Date.parse("2026-10-02T00:00:00Z"))).toBe("2026-10-04T23:00:00.000Z");
  });
  it("does not repeat a wall-clock time during DST fallback", () => {
    expect(nextWakeupAt({ ...schedule, timezone: "America/New_York", time: "01:30" }, Date.parse("2026-11-01T05:30:00Z"))).toBe("2026-11-02T06:30:00.000Z");
  });
  it("skips nonexistent spring-forward times", () => {
    expect(nextWakeupAt({ ...schedule, timezone: "America/New_York", time: "02:30" }, Date.parse("2026-03-08T05:00:00Z"))).toBe("2026-03-09T06:30:00.000Z");
  });
  it("calculates interval from now rather than replaying missed runs", () => {
    expect(nextWakeupAt({ kind: "interval", minutes: 60 }, Date.parse("2026-10-02T00:00:00Z"))).toBe("2026-10-02T01:00:00.000Z");
  });
  it("validates account selection and strips untrusted extra properties", () => {
    expect(validateWakeupTask({ ...task, accessToken: "secret" })).toEqual(task);
    expect(() => validateWakeupTask({ ...task, connectionIds: [] })).toThrow();
    expect(() => validateWakeupTask({ ...task, connectionIds: ["account", "account"] })).toThrow();
  });
  it.each([
    { ...schedule, timezone: "Not/AZone" }, { ...schedule, time: "25:00" },
    { ...schedule, days: [] }, { kind: "interval", minutes: 0 }, { kind: "interval", minutes: 1.5 },
  ])("rejects invalid schedule %j", (invalid) => {
    expect(() => validateWakeupTask({ ...task, schedule: invalid })).toThrow();
  });
});
