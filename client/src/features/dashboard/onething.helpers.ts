/**
 * Pure helpers for OneThing (D2 view).
 *
 * - deriveOneThing — picks the headline + reason + source label from
 *   the dashboard data slice (server king → most-overdue → first task →
 *   empty fallback).
 * - pickAfterThat — sorts upcoming calendar events into the 3-up
 *   "after that" strip below the headline.
 */
import type { CalendarEvent, TodoistTask } from "./types";
import {
  isTaskOverdue,
  taskPriorityOrder,
} from "./frontpage/newsprint.helpers";

export interface DerivedHeadline {
  title: string;
  reason: string;
  meta: { dueLabel: string | null; sourceLabel: string };
}

interface KingLike {
  title?: string | null;
  reason?: string | null;
  source?: string | null;
}

interface DataSlice {
  kingOfDay: KingLike | null;
  tasks: { dueToday: TodoistTask[] };
}

/**
 * Headline derivation order:
 *   1. server-picked king (auto/manual/ai) — authoritative if present
 *   2. most overdue task in priority order
 *   3. first task today (priority order)
 *   4. empty state
 */
export function deriveOneThing(data: DataSlice): DerivedHeadline {
  if (data.kingOfDay?.title) {
    const source = data.kingOfDay.source ?? "auto";
    return {
      title: data.kingOfDay.title,
      reason: data.kingOfDay.reason ?? "today's headline",
      meta: {
        dueLabel: null,
        sourceLabel:
          source === "manual"
            ? "PINNED"
            : source === "ai"
              ? "AI · KING OF DAY"
              : "AUTO · KING OF DAY",
      },
    };
  }

  const sorted = [...data.tasks.dueToday].sort(
    (a, b) => taskPriorityOrder(a) - taskPriorityOrder(b)
  );
  const overdue = sorted.find((t) => isTaskOverdue(t));
  const top = overdue ?? sorted[0];
  if (top) {
    return {
      title: top.content,
      reason: overdue
        ? "overdue — finish this first."
        : "P1 today — start here.",
      meta: { dueLabel: top.due?.date ?? null, sourceLabel: "TODOIST" },
    };
  }

  return {
    title: "nothing burning.",
    reason: "pick one and ship it.",
    meta: { dueLabel: null, sourceLabel: "EMPTY" },
  };
}

/**
 * Returns the next 3 calendar events that haven't started yet, sorted
 * chronologically. Discards events with malformed start times.
 */
export function pickAfterThat(
  calendar: CalendarEvent[],
  now: number = Date.now(),
  limit: number = 3
): CalendarEvent[] {
  return [...calendar]
    .filter((e) => {
      const startIso = e.start?.dateTime ?? e.start?.date ?? null;
      if (!startIso) return false;
      const t = new Date(startIso).getTime();
      return !Number.isNaN(t) && t > now;
    })
    .sort((a, b) => {
      const aT = new Date(
        a.start?.dateTime ?? a.start?.date ?? 0
      ).getTime();
      const bT = new Date(
        b.start?.dateTime ?? b.start?.date ?? 0
      ).getTime();
      return aT - bT;
    })
    .slice(0, limit);
}
