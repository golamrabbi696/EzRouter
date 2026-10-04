"use client";

import { useState } from "react";
import Tooltip from "@/shared/components/Tooltip";

export default function PingNowButton({ connectionId, disabled = false, onComplete }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function ping() {
    if (busy) return;
    if (result) {
      setResult(null);
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/wakeup", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ping", connectionId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Ping failed.");
      setResult(data);
      if (onComplete) Promise.resolve(onComplete()).catch(() => {});
    } catch (error) {
      setResult({ status: "failed", message: error.message });
    } finally { setBusy(false); }
  }

  const message = busy ? "Pinging…" : result ? `${result.message} Click to reset.` : "Ping now — sends a small request. Consumes quota; does not change Auto-Ping.";
  const color = result ? result.status === "succeeded" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400" : "text-text-muted hover:text-primary";

  return (
    <Tooltip text={message}>
      <button type="button" onClick={ping} disabled={busy || (disabled && !result)} aria-label={message} aria-busy={busy}
        className={`flex h-8 w-8 items-center justify-center rounded-lg ${color} hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50`}>
        <span aria-hidden="true" style={{ fontSize: busy ? 20 : 32 }} className={`material-symbols-outlined ${busy ? "animate-spin" : ""}`}>{busy ? "progress_activity" : "play_arrow"}</span>
      </button>
    </Tooltip>
  );
}
