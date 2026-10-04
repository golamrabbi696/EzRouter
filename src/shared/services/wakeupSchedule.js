const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function validateWakeupTask(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Task must be an object.");
  const { name, provider, connectionIds, enabled, schedule } = input;
  if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("Name must contain 1–80 characters.");
  if (!["claude", "codex"].includes(provider)) throw new Error("Choose Claude or Codex.");
  if (!Array.isArray(connectionIds) || !connectionIds.length || connectionIds.length > 20 ||
      connectionIds.some((id) => typeof id !== "string" || !id || id.length > 128) || new Set(connectionIds).size !== connectionIds.length) {
    throw new Error("Choose 1–20 distinct accounts.");
  }
  if (typeof enabled !== "boolean") throw new Error("Enabled must be a boolean.");
  const model = input.model ?? "";
  const prompt = input.prompt ?? "hi";
  const reasoning = input.reasoning ?? "none";
  if (typeof model !== "string" || model.length > 120 || (model && !/^[a-zA-Z0-9._:/-]+$/.test(model))) throw new Error("Invalid model ID.");
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 500) throw new Error("Prompt must contain 1–500 characters.");
  if (!["none", "low", "medium", "high"].includes(reasoning)) throw new Error("Invalid reasoning effort.");
  let normalized;
  if (schedule?.kind === "interval") {
    if (!Number.isInteger(schedule.minutes) || schedule.minutes < 5 || schedule.minutes > 10080) throw new Error("Interval must be 5–10080 minutes.");
    normalized = { kind: "interval", minutes: schedule.minutes };
  } else if (schedule?.kind === "daily") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) throw new Error("Choose a valid time (HH:mm).");
    if (typeof schedule.timezone !== "string" || schedule.timezone.length > 80) throw new Error("Choose a valid timezone.");
    try { new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(); } catch { throw new Error("Choose a valid timezone."); }
    if (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.length > 7 ||
        schedule.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6) || new Set(schedule.days).size !== schedule.days.length) {
      throw new Error("Choose distinct weekdays.");
    }
    normalized = { kind: "daily", time: schedule.time, timezone: schedule.timezone, days: [...schedule.days].sort() };
  } else throw new Error("Choose daily or interval scheduling.");
  return { name: name.trim(), provider, connectionIds: [...connectionIds], enabled, model, prompt: prompt.trim(), reasoning, schedule: normalized };
}

export function nextWakeupAt(schedule, after = Date.now()) {
  if (schedule.kind === "interval") return new Date(after + schedule.minutes * 60000).toISOString();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = (time) => Object.fromEntries(formatter.formatToParts(time).map(({ type, value }) => [type, value]));
  const initial = parts(after);
  const initialDate = `${initial.year}-${initial.month}-${initial.day}`;
  const alreadyPassed = `${initial.hour}:${initial.minute}` >= schedule.time;
  for (let candidate = Math.floor(after / 60000) * 60000 + 60000; candidate <= after + 8 * 86400000; candidate += 60000) {
    const local = parts(candidate);
    if (alreadyPassed && `${local.year}-${local.month}-${local.day}` === initialDate) continue;
    if (`${local.hour}:${local.minute}` === schedule.time && schedule.days.includes(WEEKDAYS.indexOf(local.weekday))) {
      return new Date(candidate).toISOString();
    }
  }
  throw new Error("No upcoming wakeup time.");
}
