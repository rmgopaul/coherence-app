/**
 * Pure helpers used by NewsprintColumns / FocusModeRail.
 *
 * Extracted so they can be unit-tested under the existing Node-env
 * vitest setup without pulling in React or JSX.
 */
import type { CalendarEvent, TodoistTask } from "../types";

const MS_PER_DAY = 86_400_000;

export function formatEventTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(" ", "")
    .toLowerCase();
}

export function eventLocationLabel(event: CalendarEvent): string | null {
  const location = event.location ?? "";
  if (/meet\.google\.com|zoom\.us|teams\.microsoft/i.test(location)) return "Video";
  if (location) {
    return location.length > 28 ? `${location.slice(0, 25)}…` : location;
  }
  return null;
}

export function taskPriorityOrder(t: TodoistTask): number {
  // Todoist: priority 4 = P1 (highest), 1 = P4 (lowest).
  const p = t.priority ?? 1;
  return 5 - p;
}

export function isTaskOverdue(t: TodoistTask, now: Date = new Date()): boolean {
  const due = t.due?.date ?? null;
  if (!due) return false;
  // Todoist `due.date` is either a YYYY-MM-DD date-only string or a
  // full ISO datetime. `new Date("YYYY-MM-DD")` parses as UTC, which
  // drifts by up to a day in non-UTC zones. Parse date-only values as
  // local midnight so "today" reads as today in the user's zone.
  let dueMidnight: number;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    dueMidnight = new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  } else {
    const parsed = new Date(due);
    if (Number.isNaN(parsed.getTime())) return false;
    dueMidnight = new Date(
      parsed.getFullYear(),
      parsed.getMonth(),
      parsed.getDate()
    ).getTime();
  }
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return dueMidnight < today.getTime();
}

export function daysAgoLabel(
  iso?: string | null,
  now: number = Date.now()
): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const days = Math.max(0, Math.round((now - d.getTime()) / MS_PER_DAY));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

export function extractName(rawFrom: string): string {
  if (!rawFrom) return "—";
  const match = /^(.*?)\s*<([^>]+)>$/.exec(rawFrom);
  if (match) {
    const name = match[1].trim().replace(/^"|"$/g, "");
    return name || match[2].split("@")[0];
  }
  return rawFrom.split("@")[0];
}

export function countdownLabel(
  startIso?: string | null,
  now: number = Date.now()
): string {
  if (!startIso) return "";
  const startMs = new Date(startIso).getTime();
  if (Number.isNaN(startMs)) return "";
  const diff = Math.max(0, startMs - now);
  const totalMin = Math.floor(diff / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}
