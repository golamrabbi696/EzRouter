"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Input from "@/shared/components/Input";
import Select from "@/shared/components/Select";

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fieldClass = "rounded-lg border border-border bg-surface-2 px-3 py-2 text-text-main";
const runTime = (value, timeZone, date = false) => value ? new Intl.DateTimeFormat("en-GB", date
  ? { timeZone, day: "2-digit", month: "short", year: "numeric" }
  : { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)) : "—";
const scheduleLabel = (schedule) => schedule.kind === "interval"
  ? `Every ${schedule.minutes} minutes`
  : `${schedule.days.length === 7 ? "Daily" : schedule.days.length ? [...schedule.days].sort((first, second) => first - second).map((day) => weekdays[day]).join(", ") : "Choose weekdays"} at ${schedule.time} · ${schedule.timezone}`;
const runLabels = { running: "Running", succeeded: "Succeeded", partial: "Partially completed", failed: "Failed", skipped: "Skipped", interrupted: "Interrupted" };
const resultStyle = (status) => status === "succeeded" ? "bg-green-500/10 text-green-700 dark:text-green-400"
  : status === "failed" ? "bg-red-500/10 text-red-700 dark:text-red-400"
  : status === "running" ? "bg-blue-500/10 text-blue-700 dark:text-blue-400"
  : "bg-amber-500/10 text-amber-700 dark:text-amber-400";
const newTask = () => ({
  name: "", provider: "codex", connectionIds: [], model: "", prompt: "hi", reasoning: "none", enabled: true,
  schedule: { kind: "daily", time: "06:00", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, days: [0, 1, 2, 3, 4, 5, 6] },
});

export default function WakeupPage() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [showHistory, setShowHistory] = useState(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/wakeup", { cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load wakeup tasks.");
    setData(result);
  }, []);

  useEffect(() => {
    const load = () => refresh().catch((failure) => setError(failure.message));
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, 10000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function action(body) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/wakeup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Operation failed.");
      if (body.action === "create" || body.action === "update") setDraft(null);
      if (body.action === "delete") setDeleting(null);
      await refresh();
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }

  const updateDraft = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const updateSchedule = (patch) => setDraft((current) => ({ ...current, schedule: { ...current.schedule, ...patch } }));
  const accountName = (id) => data?.accounts.find((account) => account.id === id)?.name || id;
  const taskRuns = data?.runs.filter((run) => run.taskId) || [];
  const invalidDraft = draft && (!draft.connectionIds.length || draft.connectionIds.length > 20
    || draft.connectionIds.some((id) => !data.accounts.some((account) => account.id === id && account.provider === draft.provider))
    || (draft.schedule.kind === "daily" && !draft.schedule.days.length));

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1 className="text-2xl font-semibold text-text-main">Wakeup Tasks</h1>
          <p className="mt-1 text-sm text-text-muted">Choose which accounts to wake up and when.</p>
          <details className="mt-2 max-w-xl text-sm text-text-muted"><summary className="w-fit cursor-pointer py-2 focus-visible:outline-2 focus-visible:outline-primary">How it works</summary><p className="py-2 leading-relaxed">Requests consume quota and require the server to stay running. Closing this browser is fine. Missed schedules run once after restart. Pausing does not cancel a run already in progress. Auto-Ping in Quota Tracker is separate.</p></details></div>
        <Button icon="add" className="min-h-11" onClick={() => { setDraft(newTask()); setShowHistory(false); setError(""); }} disabled={busy || !data || !!draft}>Add schedule</Button>
      </header>
      {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-600">{error}</p>}
      {!data && <p role="status">Loading wakeup tasks…</p>}
      {data && <>
        <section aria-label="Automatic wakeup status" className={`flex flex-wrap items-center justify-between gap-4 rounded-xl border p-5 ${data.enabled ? "border-border bg-surface" : "border-amber-500/30 bg-amber-500/5"}`}>
          <div className="space-y-1" role="status">
            <h2 className="font-semibold text-text-main">{data.enabled ? "Automatic wakeups active" : "Automatic wakeups paused"}</h2>
            <p className="text-sm text-text-muted">{data.enabled ? `${data.tasks.filter((task) => task.enabled).length} of ${data.tasks.length} schedules enabled. Paused tasks will not run automatically.` : "No scheduled tasks will run. You can still run tasks manually."}</p>
          </div>
          <Button className="min-h-11" variant={data.enabled ? "secondary" : "primary"} disabled={busy} onClick={() => action({ action: "enabled", enabled: !data.enabled })}>{data.enabled ? "Pause all schedules" : "Resume schedules"}</Button>
        </section>
        <nav aria-label="Wakeup views" className="flex gap-2 border-b border-border pb-3">
          <Button className="min-h-11" variant={!showHistory ? "secondary" : "ghost"} aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>Schedules</Button>
          <Button className="min-h-11" variant={showHistory ? "secondary" : "ghost"} aria-pressed={showHistory} onClick={() => setShowHistory(true)}>History</Button>
        </nav>
        {!showHistory && draft && <section aria-label={draft.id ? "Edit wakeup task" : "New wakeup task"} className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-lg font-semibold">{draft.id ? "Edit schedule" : "New schedule"}</h2>
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); action({ action: draft.id ? "update" : "create", id: draft.id, task: draft }); }}>
            <fieldset disabled={busy} className="min-w-0 space-y-5">
            <Input label="Schedule name" aria-label="Schedule name" autoFocus required maxLength={80} value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
            <h3 className="font-medium">1. Accounts</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Provider" aria-label="Provider" value={draft.provider} options={[{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }]}
                onChange={(event) => updateDraft({ provider: event.target.value, connectionIds: [], model: "" })} />
            </div>
            <fieldset className="min-w-0 rounded-lg border border-border p-3"><legend className="px-1 text-sm font-medium">Accounts · {draft.connectionIds.length} selected (max 20)</legend>
              <div className="grid max-h-48 gap-2 overflow-y-auto sm:grid-cols-2">
                {data.accounts.filter((account) => account.provider === draft.provider).map((account) => <label key={account.id} className="flex min-h-11 min-w-0 items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-2">
                  <input type="checkbox" checked={draft.connectionIds.includes(account.id)} disabled={!draft.connectionIds.includes(account.id) && draft.connectionIds.length >= 20} onChange={(event) => updateDraft({ connectionIds: event.target.checked ? [...draft.connectionIds, account.id] : draft.connectionIds.filter((id) => id !== account.id) })} />
                  <span className="break-all">{account.name}</span></label>)}
              </div>
              {!data.accounts.some((account) => account.provider === draft.provider) && <p className="text-sm text-text-muted">No active OAuth accounts for this provider.</p>}
              {!draft.connectionIds.length && <p className="mt-2 text-sm text-text-muted">Choose at least one account.</p>}
              {draft.connectionIds.some((id) => !data.accounts.some((account) => account.id === id)) && <p role="alert" className="mt-2 text-sm text-red-600">Some selected accounts are missing or inactive. <button type="button" className="underline" onClick={() => updateDraft({ connectionIds: draft.connectionIds.filter((id) => data.accounts.some((account) => account.id === id)) })}>Remove unavailable accounts</button></p>}
            </fieldset>
            <h3 className="font-medium">2. Schedule</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <Select label="Repeat" aria-label="Repeat" value={draft.schedule.kind === "interval" ? "interval" : draft.schedule.days.length === 7 ? "daily" : "weekdays"} options={[{ value: "daily", label: "Every day" }, { value: "weekdays", label: "Selected weekdays" }, { value: "interval", label: "Every N minutes" }]}
                onChange={(event) => updateSchedule(event.target.value === "interval" ? { kind: "interval", minutes: 60 } : { kind: "daily", time: draft.schedule.time || "06:00", timezone: draft.schedule.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, days: event.target.value === "daily" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5] })} />
              {draft.schedule.kind === "interval" ? <Input label="Interval (minutes)" aria-label="Interval (minutes)" type="number" min={5} max={10080} required value={draft.schedule.minutes} onChange={(event) => updateSchedule({ minutes: Number(event.target.value) })} /> : <>
                <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
                <Input label="Time" aria-label="Time" type="time" required value={draft.schedule.time} onChange={(event) => updateSchedule({ time: event.target.value })} />
                <Input label="Timezone" aria-label="Timezone" required placeholder="Asia/Ho_Chi_Minh" value={draft.schedule.timezone} onChange={(event) => updateSchedule({ timezone: event.target.value })} />
                </div>
                {draft.schedule.days.length !== 7 && <fieldset className="min-w-0 sm:col-span-2"><legend className="mb-2 text-sm font-medium">Weekdays</legend><div className="flex flex-wrap gap-2">{weekdays.map((label, index) =>
                  <label key={label} className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 text-sm"><input type="checkbox" checked={draft.schedule.days.includes(index)} onChange={(event) => updateSchedule({ days: event.target.checked ? [...draft.schedule.days, index] : draft.schedule.days.filter((day) => day !== index) })} />{label}</label>)}</div>{!draft.schedule.days.length && <p className="mt-2 text-sm text-red-600">Choose at least one weekday.</p>}</fieldset>}
              </>}
            </div>
            <details className="rounded-lg border border-border p-3">
              <summary className="cursor-pointer py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-primary">Advanced settings</summary>
              <div className="mt-3 space-y-4">
                <p className="text-sm text-text-muted">Defaults work for a lightweight wakeup request.</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label="Model (optional)" aria-label="Model" placeholder="Default lightweight model" maxLength={120} value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })} />
                  {draft.provider === "codex" && <Select label="Reasoning" aria-label="Reasoning" value={draft.reasoning} options={["none", "low", "medium", "high"].map((value) => ({ value, label: value }))} onChange={(event) => updateDraft({ reasoning: event.target.value })} />}
                </div>
                <label className="flex flex-col gap-1 text-sm font-medium">Prompt<textarea className={fieldClass} rows={2} required maxLength={500} value={draft.prompt} onInvalid={(event) => { event.target.closest("details").open = true; }} onChange={(event) => updateDraft({ prompt: event.target.value })} /></label>
              </div>
            </details>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.target.checked })} />Enable this schedule</label>
            <div className="space-y-2 rounded-lg bg-surface-2 p-4 text-sm" aria-live="polite">
              <h3 className="font-medium">Schedule preview</h3>
              <p className="text-text-muted">Requests consume quota. Keep the server running for scheduled requests.</p>
              <p className="break-words">{scheduleLabel(draft.schedule)} · {draft.connectionIds.length} {draft.provider === "codex" ? "Codex" : "Claude"} accounts</p>
              {!draft.enabled && <p>This task is paused and will not run automatically.</p>}
              {!data.enabled && <p>Saving will not resume automatic wakeups. Use “Resume schedules” when you are ready.</p>}
            </div>
            <div className="flex flex-wrap gap-2"><Button className="min-h-11" type="submit" loading={busy} disabled={invalidDraft}>Save schedule</Button><Button className="min-h-11" type="button" variant="secondary" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button></div>
            </fieldset>
          </form>
        </section>}
        {!showHistory && !data.tasks.length && !draft && <div className="rounded-xl border border-dashed border-border p-10 text-center text-text-muted">No schedules yet. Choose “Add schedule” to select accounts and a time.</div>}
        {!showHistory && <div className="space-y-4">
          {data.tasks.map((task) => {
            const active = taskRuns.find((run) => run.taskId === task.id && run.status === "running");
            const latest = taskRuns.find((run) => run.taskId === task.id && run.status !== "running");
            const running = !!active;
            const timeZone = task.schedule.kind === "daily" ? task.schedule.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
            const success = latest?.status === "succeeded";
            const status = running ? "Running now" : !task.enabled ? "Task paused" : !data.enabled ? "Paused by global setting" : "Scheduled";
            return <article key={task.id} className="space-y-4 rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <h2 className="min-w-0 flex-1 break-words text-lg font-semibold">{task.name}</h2>
                <span className={`rounded-full border px-3 py-1 text-xs font-medium ${running || (task.enabled && data.enabled) ? "border-primary/30 bg-primary/10 text-text-main" : "border-border bg-surface-2 text-text-muted"}`}>{status}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-10 gap-y-4 py-2">
                <div><p className="text-4xl font-semibold tracking-tight tabular-nums">{task.schedule.kind === "daily" ? task.schedule.time : <>{task.schedule.minutes}<span className="ml-2 text-base font-normal text-text-muted">min interval</span></>}</p><p className="mt-2 break-all text-sm text-text-muted">{timeZone.replaceAll("_", " ")}</p></div>
                {task.schedule.kind === "daily" && <div><p className="mb-3 text-sm font-medium">{task.schedule.days.length === 7 ? "Every day" : task.schedule.days.length === 5 && [1, 2, 3, 4, 5].every((day) => task.schedule.days.includes(day)) ? "Monday to Friday" : "Selected weekdays"}</p><ul aria-label="Scheduled weekdays" className="flex flex-wrap gap-2">{[1, 2, 3, 4, 5, 6, 0].map((day) => <li key={day} aria-label={`${weekdays[day]}: ${task.schedule.days.includes(day) ? "scheduled" : "off"}`} className={`rounded-lg border px-2.5 py-2 text-xs font-medium ${task.schedule.days.includes(day) ? "border-primary/30 bg-primary/10 text-text-main" : "border-transparent text-text-muted"}`}>{weekdays[day]}</li>)}</ul></div>}
              </div>
              <details className="group border-y border-border py-2 text-sm">
                <summary className="cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-primary"><span className="ml-2 font-semibold">{task.provider === "codex" ? "Codex" : "Claude"}</span><span className="ml-3 rounded-full bg-surface-2 px-3 py-1 text-xs text-text-muted">{task.connectionIds.length} accounts</span><span className="ml-3 text-text-muted">View details</span></summary>
                <ul className="grid gap-2 py-3 sm:grid-cols-2">{task.connectionIds.map((id) => <li key={id} className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-2 px-3 py-3"><span aria-hidden="true" className="material-symbols-outlined shrink-0 text-lg text-text-muted">account_circle</span><span className="break-all">{accountName(id)}</span></li>)}</ul>
                <dl className="flex flex-wrap gap-x-8 gap-y-3 py-3 text-sm"><div><dt className="text-xs text-text-muted">Model</dt><dd className="mt-1 break-all">{task.model || "Default lightweight model"}</dd></div>{task.provider === "codex" && <div><dt className="text-xs text-text-muted">Reasoning</dt><dd className="mt-1">{task.reasoning}</dd></div>}</dl>
              </details>
              <div className="grid gap-6 py-3 text-sm sm:grid-cols-2">
                <div className="space-y-2"><p className="text-xs font-medium uppercase tracking-wider text-text-muted">Next run</p>{!task.enabled ? <p>Not scheduled — task paused</p> : !data.enabled ? <p>Not scheduled while paused</p> : <><p className="text-3xl font-semibold tabular-nums">{runTime(task.nextRunAt, timeZone)}</p><p>{runTime(task.nextRunAt, timeZone, true)}</p><p className="break-all text-xs text-text-muted">{timeZone.replaceAll("_", " ")}</p></>}</div>
                <div className="space-y-2 border-t border-border pt-5 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0"><p className="text-xs font-medium uppercase tracking-wider text-text-muted">Last completed run</p>{latest ? <><p className={`flex items-center gap-2 text-xl font-semibold ${success ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}`}><span aria-hidden="true" className="material-symbols-outlined">{success ? "check_circle" : "error"}</span>{runLabels[latest.status] || latest.status}</p><p>{latest.results.filter((result) => result.status === "succeeded").length} accounts succeeded</p><p className="text-xs text-text-muted">{runTime(latest.startedAt, timeZone, true)} · {runTime(latest.startedAt, timeZone)} · {timeZone.replaceAll("_", " ")}</p><Button variant="ghost" className="min-h-11" onClick={() => setShowHistory(true)}>View run history</Button></> : <p>No completed runs yet</p>}</div>
              </div>
              {running && <p role="status" className="text-sm text-text-muted">A run is in progress. Editing and manual runs are unavailable until it finishes.</p>}
              <p className="text-xs text-text-muted">Running once sends requests immediately and consumes quota.</p>
              <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                <Button className="min-h-11" variant="secondary" disabled={busy || running || !!draft} onClick={() => setDraft({ ...task, connectionIds: [...task.connectionIds], schedule: { ...task.schedule } })}>Edit schedule</Button>
                <Button className="min-h-11" variant="secondary" disabled={busy || running} onClick={() => action({ action: "run", id: task.id })}>{running ? "Running…" : "Run once now"}</Button>
                <Button className="min-h-11" variant="ghost" disabled={busy || running || !!draft} onClick={() => action({ action: "update", id: task.id, task: { ...task, enabled: !task.enabled } })}>{task.enabled ? "Pause task" : "Enable task"}</Button>
                <Button className="min-h-11 sm:ml-auto" variant="ghost" disabled={busy || running || !!draft} onClick={() => setDeleting(task.id)}>Delete</Button>
              </div>
              {deleting === task.id && <div role="group" aria-label="Confirm deletion" className="space-y-2 rounded-lg bg-red-500/5 p-3 text-sm"><p>Delete this schedule? Existing history stays.</p><div className="flex flex-wrap gap-2"><Button className="min-h-11" variant="danger" disabled={busy || running} onClick={() => action({ action: "delete", id: task.id })}>Confirm delete</Button><Button className="min-h-11" variant="secondary" disabled={busy} onClick={() => setDeleting(null)}>Cancel</Button></div></div>}
            </article>;
          })}
        </div>}
        {showHistory && <section className="space-y-4" aria-label="Wakeup history">
          <div className="flex flex-wrap items-end justify-between gap-2"><div><h2 className="text-lg font-semibold">Task run history</h2><p className="mt-1 text-sm text-text-muted">Open a run to inspect account results. Individual account pings are excluded.</p></div><p className="text-xs text-text-muted">Times in {Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll("_", " ")}</p></div>
          {!taskRuns.length && <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">No task runs in recent history.</p>}
          {taskRuns.map((run) => <details key={run.id} className="group overflow-hidden rounded-xl border border-border bg-surface">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-4 p-5 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
              <span aria-hidden="true" className="material-symbols-outlined text-text-muted transition-transform group-open:rotate-90">chevron_right</span>
              <span className="min-w-0 flex-1 basis-40"><span className="block break-words font-semibold">{run.name}</span><span className="mt-1 block text-xs text-text-muted">{run.trigger === "manual" ? "Manual run" : "Scheduled run"}</span></span>
              <span className="flex flex-col items-start gap-2"><span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${resultStyle(run.status)}`}><span aria-hidden="true" className="material-symbols-outlined text-base">{run.status === "succeeded" ? "check_circle" : run.status === "running" ? "pending" : "info"}</span>{runLabels[run.status] || run.status}</span><span className="text-xs text-text-muted">{run.results.filter((result) => result.status === "succeeded").length} succeeded / {run.results.length} results{run.status === "running" ? " so far" : ""}</span></span>
              <span className="w-full border-t border-border pt-3 text-sm sm:w-auto sm:min-w-36 sm:border-t-0 sm:pt-0 sm:text-right"><span className="block font-medium tabular-nums">{runTime(run.startedAt, undefined)}</span><span className="mt-1 block text-xs text-text-muted">{runTime(run.startedAt, undefined, true)}</span></span>
            </summary>
            <div className="border-t border-border px-5 pb-2">
              {run.status === "interrupted" && <p role="note" className="my-4 rounded-lg bg-amber-500/10 p-3 text-sm text-text-main">Run interrupted. Delivery may have occurred; check quota before retrying. Interrupted runs are not automatically retried.</p>}
              {!run.results.length && <p className="py-5 text-sm text-text-muted">{run.status === "running" ? "Waiting for account results…" : "No account results were recorded."}</p>}
              <ul className="divide-y divide-border">{run.results.map((result) => <li key={result.connectionId} className="grid min-w-0 gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0"><p className="break-all text-sm font-medium">{accountName(result.connectionId)}</p><p className="mt-1.5 break-words text-sm leading-relaxed text-text-muted">{result.message}</p></div>
                <div className="flex items-center gap-3 sm:justify-end"><span className={`rounded-full px-3 py-1 text-xs font-medium ${resultStyle(result.status)}`}>{runLabels[result.status] || result.status}</span><span className="min-w-12 text-right text-xs tabular-nums text-text-muted">{Number.isFinite(result.durationMs) ? `${(result.durationMs / 1000).toFixed(1)}s` : "—"}</span></div>
              </li>)}</ul>
            </div>
          </details>)}
        </section>}
      </>}
    </div>
  );
}
