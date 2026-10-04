import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", () => ({ NextResponse: { json: (data, options) => Response.json(data, options) } }));
vi.mock("@/lib/db/index.js", () => ({ getProviderConnections: vi.fn() }));
vi.mock("@/lib/db/repos/wakeupRepo.js", () => ({
  getWakeupState: vi.fn(), saveWakeupTask: vi.fn(), deleteWakeupTask: vi.fn(), setWakeupEnabled: vi.fn(),
  claimWakeupRun: vi.fn(), recordWakeupResult: vi.fn(), finishWakeupRun: vi.fn(),
}));
vi.mock("@/shared/services/wakeupTasks", () => ({ configureWakeupTasks: vi.fn(), runWakeupTaskNow: vi.fn() }));
vi.mock("@/shared/services/quotaAutoPing", () => ({ pingAccountNow: vi.fn() }));
import { getProviderConnections } from "@/lib/db/index.js";
import { getWakeupState, saveWakeupTask } from "@/lib/db/repos/wakeupRepo.js";
import { pingAccountNow } from "@/shared/services/quotaAutoPing";
import { GET, POST } from "../../src/app/api/wakeup/route.js";

const task = { name: "Morning", provider: "codex", connectionIds: ["account"], enabled: true, schedule: { kind: "interval", minutes: 60 } };
const request = (body, headers = {}) => new Request("http://localhost/api/wakeup", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks();
  getWakeupState.mockResolvedValue({ enabled: true, tasks: [], runs: [], leases: { secret: "internal" } });
  getProviderConnections.mockResolvedValue([{ id: "account", provider: "codex", authType: "oauth", isActive: true, name: "Account", accessToken: "secret", refreshToken: "secret" }]);
});
describe("wakeup API", () => {
  it("does not expose provider credentials or internal leases", async () => {
    const response = await GET();
    expect(await response.text()).not.toContain("secret");
  });
  it("validates active account ownership by provider", async () => {
    expect((await POST(request({ action: "create", task: { ...task, provider: "claude" } }))).status).toBe(400);
    expect(saveWakeupTask).not.toHaveBeenCalled();
  });
  it("rejects cross-origin writes before any provider call", async () => {
    expect((await POST(request({ action: "ping", connectionId: "account" }, { Origin: "https://attacker.test" }))).status).toBe(403);
    expect(pingAccountNow).not.toHaveBeenCalled();
  });
  it("accepts the public Host when Next normalizes request.url to an internal hostname", async () => {
    const response = await POST(new Request("http://localhost:20139/api/wakeup", {
      method: "POST", headers: { "Content-Type": "application/json", Host: "127.0.0.1:20139", Origin: "http://127.0.0.1:20139", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ action: "create", task }),
    }));
    expect(response.status).toBe(200);
  });
  it("rejects invalid schedules", async () => {
    expect((await POST(request({ action: "create", task: { ...task, schedule: { kind: "interval", minutes: 0 } } }))).status).toBe(400);
  });
  it("does not save tokens or extra fields from a task payload", async () => {
    expect((await POST(request({ action: "create", task: { ...task, accessToken: "injected" } }))).status).toBe(200);
    expect(saveWakeupTask.mock.calls[0][0]).not.toHaveProperty("accessToken");
  });
  it("rejects an unknown account before pinging", async () => {
    expect((await POST(request({ action: "ping", connectionId: "unknown" }))).status).toBe(400);
    expect(pingAccountNow).not.toHaveBeenCalled();
  });
});
