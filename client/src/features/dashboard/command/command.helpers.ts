/**
 * Pure helpers for the Command Deck (D5) view. Owns the small math
 * pieces the React component used to inline: clock formatting,
 * overdue counting, headline + reason derivation, and the "next event
 * + countdown" pick.
 */
import { toDateKey } from "@shared/dateKey";
import type { CalendarEvent, TodoistTask } from "../types";

/** "14:23:05" — 24h-ish HH:MM:SS, uppercased to match the deck strip. */
export function clockLabel(now: Date): string {
  return now
    .toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    .toUpperCase();
}

/**
 * Count tasks whose due date is strictly before today (the user's local
 * day). Mirrors the inline filter the deck used to do — pulled out so
 * fixtures can drive it.
 */
export function countOverdue(
  tasks: TodoistTask[],
  now: Date = new Date()
): number {
  const today = todayKey(now);
  let count = 0;
  for (const t of tasks) {
    const due = t.due?.date;
    if (!due) continue;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : due.slice(0, 10);
    if (dateOnly < today) count++;
  }
  return count;
}

function todayKey(now: Date): string {
  return toDateKey(now);
}

export interface DerivedCommandHeadline {
  headline: string;
  reason: string;
}

export function deriveCommandHeadline({
  kingOfDay,
  tasks,
  now = new Date(),
}: {
  kingOfDay: { title?: string | null; reason?: string | null } | null;
  tasks: TodoistTask[];
  now?: Date;
}): DerivedCommandHeadline {
  const overdueCount = countOverdue(tasks, now);
  const headline =
    kingOfDay?.title ?? tasks[0]?.content ?? "ALL CLEAR";
  const reason =
    kingOfDay?.reason ??
    (overdueCount > 0
      ? `${overdueCount} overdue — fix the bleed first.`
      : "ship something small.");
  return { headline, reason };
}

/**
 * Returns the next future calendar event + minutes until it. Both null
 * when nothing is upcoming.
 */
export function pickNextEvent(
  calendar: CalendarEvent[],
  now: number = Date.now()
): { event: CalendarEvent | null; minsUntil: number | null } {
  const next = calendar.find((e) => {
    const startIso = e.start?.dateTime ?? e.start?.date ?? null;
    if (!startIso) return false;
    const t = new Date(startIso).getTime();
    return !Number.isNaN(t) && t > now;
  });
  if (!next) return { event: null, minsUntil: null };
  const nextStart = next.start?.dateTime ?? next.start?.date ?? null;
  if (!nextStart) return { event: next, minsUntil: null };
  const ms = new Date(nextStart).getTime();
  if (Number.isNaN(ms)) return { event: next, minsUntil: null };
  const minsUntil = Math.max(0, Math.round((ms - now) / 60_000));
  return { event: next, minsUntil };
}

/**
 * Returns the rest of today's upcoming events after the next one,
 * sorted ascending. Used to fill the right column under the next-up
 * card.
 */
export function pickUpcomingAfter(
  calendar: CalendarEvent[],
  excludeId: string | null | undefined,
  now: number = Date.now(),
  limit: number = 4
): CalendarEvent[] {
  return calendar
    .filter((e) => {
      const s = e.start?.dateTime ?? e.start?.date ?? null;
      if (!s || (excludeId && e.id === excludeId)) return false;
      const t = new Date(s).getTime();
      return !Number.isNaN(t) && t > now;
    })
    .slice(0, limit);
}
