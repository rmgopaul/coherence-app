import type {
  CalendarEvent,
  GmailMessage,
  TodoistTask,
} from "@/features/dashboard/types";

const TODOIST_PRIORITY_HIGHEST = 4;
const FALLBACK_TASK_DUE_HOUR = 17;

export function selectTopTask(tasks: TodoistTask[]): TodoistTask | null {
  if (!tasks.length) return null;
  const p1 = tasks.filter((t) => t.priority === TODOIST_PRIORITY_HIGHEST);
  const pool = p1.length ? p1 : tasks;
  return pool
    .slice()
    .sort((a, b) => taskDueMs(a) - taskDueMs(b))[0] ?? null;
}

export function getTopTaskDueDate(task: TodoistTask | null): Date | null {
  if (!task?.due) return null;
  if (task.due.datetime) return new Date(task.due.datetime);
  if (task.due.date) {
    return new Date(`${task.due.date}T${pad2(FALLBACK_TASK_DUE_HOUR)}:00:00`);
  }
  return null;
}

function taskDueMs(task: TodoistTask): number {
  const d = getTopTaskDueDate(task);
  return d ? d.getTime() : Number.POSITIVE_INFINITY;
}

export function getEventStart(event: CalendarEvent): Date | null {
  const raw = event?.start?.dateTime ?? event?.start?.date ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function getNextCalendarEvent(
  events: CalendarEvent[],
  now: Date
): CalendarEvent | null {
  return (
    events
      .map((ev) => ({ ev, start: getEventStart(ev) }))
      .filter(
        (x): x is { ev: CalendarEvent; start: Date } =>
          x.start !== null && x.start.getTime() > now.getTime()
      )
      .sort((a, b) => a.start.getTime() - b.start.getTime())[0]?.ev ?? null
  );
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function countEventsToday(events: CalendarEvent[], now: Date): number {
  return events.reduce((n, ev) => {
    const s = getEventStart(ev);
    return s && isSameDay(s, now) ? n + 1 : n;
  }, 0);
}

export function getFirstEventTodayStart(
  events: CalendarEvent[],
  now: Date
): Date | null {
  return events
    .map((ev) => getEventStart(ev))
    .filter((d): d is Date => d !== null && isSameDay(d, now))
    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
}

export function countOverdueP1(tasks: TodoistTask[], now: Date): number {
  const startOfToday = startOfDay(now);
  return tasks.reduce((n, t) => {
    if (t.priority !== TODOIST_PRIORITY_HIGHEST) return n;
    const due = getTopTaskDueDate(t);
    if (!due) return n;
    return due.getTime() < startOfToday.getTime() ? n + 1 : n;
  }, 0);
}

export function oldestOverdueDays(tasks: TodoistTask[], now: Date): number | null {
  const startOfToday = startOfDay(now);
  let oldest: number | null = null;
  for (const t of tasks) {
    const due = getTopTaskDueDate(t);
    if (!due) continue;
    if (due.getTime() >= startOfToday.getTime()) continue;
    const days = Math.floor(
      (startOfToday.getTime() - startOfDay(due).getTime()) / 86_400_000
    );
    if (oldest === null || days > oldest) oldest = days;
  }
  return oldest;
}

const FLAG_LABELS = new Set(["STARRED", "IMPORTANT"]);

export function countFlaggedEmails(messages: GmailMessage[]): number {
  return messages.reduce((n, m) => {
    const labels: unknown = m?.labelIds;
    if (!Array.isArray(labels)) return n;
    return labels.some((l) => typeof l === "string" && FLAG_LABELS.has(l))
      ? n + 1
      : n;
  }, 0);
}

export function countUnreadEmails(messages: GmailMessage[]): number {
  return messages.reduce((n, m) => {
    const labels: unknown = m?.labelIds;
    if (!Array.isArray(labels)) return n;
    return labels.includes("UNREAD") ? n + 1 : n;
  }, 0);
}

export function getEventAttendeeOrLocation(event: CalendarEvent): string | null {
  const attendees = event?.attendees;
  if (Array.isArray(attendees) && attendees.length > 0) {
    return `${attendees.length} attendee${attendees.length === 1 ? "" : "s"}`;
  }
  const location = event?.location;
  if (typeof location === "string" && location.trim()) {
    return location.trim();
  }
  return null;
}

export function getEventTitle(event: CalendarEvent): string {
  const summary = event?.summary;
  return typeof summary === "string" && summary.trim() ? summary : "Untitled";
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
