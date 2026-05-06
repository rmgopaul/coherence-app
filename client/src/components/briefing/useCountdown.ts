import { useEffect, useState } from "react";

export type CountdownSeverity = "none" | "calm" | "warn" | "critical";

export interface CountdownState {
  label: string;
  severity: CountdownSeverity;
  msRemaining: number;
}

const ONE_MIN_MS = 60_000;
const FIVE_MIN_MS = 5 * ONE_MIN_MS;
const ONE_HOUR_MS = 60 * ONE_MIN_MS;

export function useCountdown(dueDate: Date | null): CountdownState {
  const [now, setNow] = useState(() => Date.now());

  const msRemaining = dueDate ? Math.max(0, dueDate.getTime() - now) : 0;
  const severity: CountdownSeverity = dueDate
    ? deriveSeverity(msRemaining)
    : "none";
  const isPastDue = dueDate ? dueDate.getTime() <= now : false;

  useEffect(() => {
    if (!dueDate || isPastDue) return;
    const tickMs = severity === "critical" ? 1_000 : ONE_MIN_MS;
    const id = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [dueDate, severity, isPastDue]);

  if (!dueDate) {
    return { label: "—", severity: "none", msRemaining: 0 };
  }
  return {
    label: formatCountdown(msRemaining),
    severity,
    msRemaining,
  };
}

export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return "00:00";
  if (msRemaining >= ONE_HOUR_MS) {
    const totalMin = Math.floor(msRemaining / ONE_MIN_MS);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${pad2(m)}m`;
  }
  const totalSec = Math.floor(msRemaining / 1_000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

export function deriveSeverity(msRemaining: number): CountdownSeverity {
  if (msRemaining <= FIVE_MIN_MS) return "critical";
  if (msRemaining <= ONE_HOUR_MS) return "warn";
  return "calm";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
