/**
 * Pure helpers for TasksTriage. Extracted so the priority banding,
 * label formatting, and class mapping can be tested without mounting
 * React or stubbing tRPC.
 *
 * The component itself stays thin — it imports these and wires the
 * onComplete mutation.
 */
import type { TodoistTask } from "../types";
import { isTaskOverdue, taskPriorityOrder } from "./newsprint.helpers";

export interface TriageBands {
  overdue: TodoistTask[];
  today: TodoistTask[];
}

const DEFAULT_OVERDUE_CAP = 6;
const DEFAULT_TODAY_CAP = 8;

/**
 * Split today's todoist load into OVERDUE + TODAY bands. Both are
 * pre-sorted by priority (P1 first), then capped so the column stays
 * scannable.
 */
export function splitTriageBands(
  tasks: TodoistTask[],
  now: Date = new Date(),
  caps: { overdue?: number; today?: number } = {}
): TriageBands {
  const overdueCap = caps.overdue ?? DEFAULT_OVERDUE_CAP;
  const todayCap = caps.today ?? DEFAULT_TODAY_CAP;

  const sorted = [...tasks].sort(
    (a, b) => taskPriorityOrder(a) - taskPriorityOrder(b)
  );

  const overdue: TodoistTask[] = [];
  const today: TodoistTask[] = [];
  for (const t of sorted) {
    if (isTaskOverdue(t, now)) overdue.push(t);
    else today.push(t);
  }

  return {
    overdue: overdue.slice(0, overdueCap),
    today: today.slice(0, todayCap),
  };
}

/** "P1" / "P2" / "P3" / "P4" — Todoist 4 = P1 (highest), 1 = P4. */
export function priorityLabel(t: TodoistTask): string {
  const p = t.priority ?? 1;
  return `P${5 - p}`;
}

/**
 * CSS modifier for the priority dot — `--p1` is filled red, `--p2` is
 * striped, `--p3` is plain paper. Anything below P3 also lands on `--p3`.
 */
export function priorityClass(t: TodoistTask): string {
  const p = t.priority ?? 1;
  if (p === 4) return "fp-triage-row__bx--p1";
  if (p === 3) return "fp-triage-row__bx--p2";
  return "fp-triage-row__bx--p3";
}

/**
 * Display the task's project name when the server has enriched it,
 * else null. Some Todoist responses omit projectName for tasks in the
 * inbox.
 */
export function projectLabel(t: TodoistTask): string | null {
  const anyT = t as unknown as { projectName?: string };
  const name = anyT.projectName?.trim();
  return name && name.length > 0 ? name : null;
}

/**
 * Render the due field as a human label:
 *   - has time component (T12:00) → localized "12:00 pm"
 *   - bare date              → "today"
 *   - missing                → null
 */
export function dueLabel(t: TodoistTask): string | null {
  const date = t.due?.date;
  if (!date) return null;
  const hasTime = /T\d{2}:\d{2}/.test(date);
  if (!hasTime) return "today";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}
