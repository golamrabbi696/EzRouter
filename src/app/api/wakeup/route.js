import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/db/index.js";
import {
  getWakeupState, saveWakeupTask, deleteWakeupTask, setWakeupEnabled,
  claimWakeupRun, recordWakeupResult, finishWakeupRun,
} from "@/lib/db/repos/wakeupRepo.js";
import { validateWakeupTask } from "@/shared/services/wakeupSchedule";
import { configureWakeupTasks, runWakeupTaskNow } from "@/shared/services/wakeupTasks";
import { pingAccountNow } from "@/shared/services/quotaAutoPing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };

async function accounts() {
  return (await getProviderConnections({ isActive: true })).filter((item) =>
    item.isActive !== false && item.authType === "oauth" && ["claude", "codex"].includes(item.provider)
  );
}

export async function GET() {
  try {
    const data = await getWakeupState();
    return NextResponse.json({
      enabled: data.enabled, tasks: data.tasks, runs: data.runs,
      accounts: (await accounts()).map(({ id, provider, name, email }) => ({ id, provider, name: name || email || id })),
    }, { headers });
  } catch {
    return NextResponse.json({ error: "Unable to load wakeup tasks." }, { status: 500, headers });
  }
}

export async function POST(request) {
  const origin = request.headers.get("origin");
  let validOrigin = !origin;
  try {
    if (origin) {
      const parsed = new URL(origin);
      validOrigin = ["http:", "https:"].includes(parsed.protocol) && parsed.host === (request.headers.get("host") || new URL(request.url).host);
    }
  } catch { validOrigin = false; }
  if (request.headers.get("sec-fetch-site") === "cross-site" || !validOrigin) {
    return NextResponse.json({ error: "Same-origin request required." }, { status: 403 });
  }
  if (!request.headers.get("content-type")?.startsWith("application/json")) return NextResponse.json({ error: "JSON required." }, { status: 415 });
  let body;
  try {
    const text = await request.text();
    if (text.length > 16000) return NextResponse.json({ error: "Request too large." }, { status: 413 });
    body = JSON.parse(text);
  } catch { return NextResponse.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Object required." }, { status: 400 });

  try {
    if (["update", "delete", "run"].includes(body.action) && (typeof body.id !== "string" || !body.id || body.id.length > 128)) {
      return NextResponse.json({ error: "Valid task ID required." }, { status: 400 });
    }
    let result;
    if (body.action === "create" || body.action === "update") {
      let task;
      try { task = validateWakeupTask(body.task); }
      catch (error) { return NextResponse.json({ error: error.message }, { status: 400 }); }
      const available = await accounts();
      if ((task.enabled || body.action === "create") && task.connectionIds.some((id) => !available.some((account) => account.id === id && account.provider === task.provider))) {
        return NextResponse.json({ error: "Choose active OAuth accounts from the selected provider." }, { status: 400 });
      }
      result = await saveWakeupTask(task, body.action === "update" ? body.id : null);
    } else if (body.action === "delete") {
      await deleteWakeupTask(body.id);
    } else if (body.action === "enabled") {
      if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "Enabled must be boolean." }, { status: 400 });
      await setWakeupEnabled(body.enabled);
    } else if (body.action === "run") {
      const run = await runWakeupTaskNow(body.id);
      return NextResponse.json({ run }, { status: 202, headers });
    } else if (body.action === "ping") {
      const account = (await accounts()).find((item) => item.id === body.connectionId);
      if (!account) return NextResponse.json({ error: "Active Claude or Codex OAuth account required." }, { status: 400 });
      const claim = await claimWakeupRun(null, "manual", Date.now(), { name: "Ping now", connectionIds: [account.id] });
      try {
        const startedAt = Date.now();
        result = await pingAccountNow(account.id);
        await recordWakeupResult(claim.run.id, { connectionId: account.id, ...result, durationMs: Date.now() - startedAt });
        await finishWakeupRun(claim.run.id);
      } catch {
        await finishWakeupRun(claim.run.id, true);
        throw new Error("Unable to complete ping.");
      }
      return NextResponse.json(result, { headers });
    } else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    configureWakeupTasks(await getWakeupState());
    return NextResponse.json({ task: result, ok: true }, { headers });
  } catch (error) {
    const expected = ["Task not found.", "Task is already running.", "Task is running; wait before editing or deleting it.", "Maximum 100 tasks.", "Too many running tasks."];
    return NextResponse.json({ error: expected.includes(error.message) ? error.message : "Wakeup operation failed." }, { status: expected.includes(error.message) ? 409 : 500, headers });
  }
}
