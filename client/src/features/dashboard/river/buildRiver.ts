/**
 * buildRiver — pure helper that merges today's calendar events,
 * todoist tasks, and unread/important inbox messages into a single
 * chronologically sorted "river" of items, each tagged with a kind +
 * a size hint so the UI can scale headlines (huge / big / med / sm).
 *
 * Pure on purpose: no fetch, no React, no Date.now() except as an
 * injected default. Tested in buildRiver.test.ts.
 */
import type {
  CalendarEvent,
  GmailMessage,
  TodoistTask,
} from "../types";

export type RiverKind = "cal" | "task" | "mail" | "file";
export type RiverSize = "huge" | "big" | "med" | "sm";

export interface RiverItem {
  id: string;
  kind: RiverKind;
  size: RiverSize;
  /** Epoch ms — used for chronological sort. */
  ts: number;
  /** Human time label (e.g. "10:00 AM" or "3:45p"). */
  timeLabel: string;
  title: string;
  meta?: string | null;
  href?: string | null;
}

export interface BuildRiverInput {
  calendar: CalendarEvent[];
  tasks: TodoistTask[];
  inbox: GmailMessage[];
  now?: Date;
}

const MS_PER_HOUR = 3_600_000;

function formatTime(ms: number): string {
  return new Date(ms)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
}

function startOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

function endOfDay(d: Date): number {
  const c = new Date(d);
  c.setHours(23, 59, 59, 999);
  return c.getTime();
}

function readGmailHeader(m: GmailMessage, name: string): string {
  const headers = m.payload?.headers as
    | Array<{ name?: string; value?: string }>
    | undefined;
  if (!Array.isArray(headers)) return "";
  const lower = name.toLowerCase();
  return headers.find((h) => (h.name ?? "").toLowerCase() === lower)?.value ?? "";
}

/** P1 → huge, P2 → big, P3 → med, P4 → sm. */
function taskSize(t: TodoistTask): RiverSize {
  const p = t.priority ?? 1;
  if (p === 4) return "huge";
  if (p === 3) return "big";
  if (p === 2) return "med";
  return "sm";
}

/** Calendar events default to "med" but the next-up one gets "big". */
function calendarSize(start: number, now: number): RiverSize {
  const delta = start - now;
  if (delta >= -10 * 60_000 && delta <= MS_PER_HOUR) return "big";
  return "med";
}

/** Mail rows are always small unless they're starred (= "med"). */
function mailSize(m: GmailMessage): RiverSize {
  const labels = (m.labelIds ?? []) as string[];
  return labels.includes("STARRED") ? "med" : "sm";
}

export function buildRiver({
  calendar,
  tasks,
  inbox,
  now = new Date(),
}: BuildRiverInput): RiverItem[] {
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);
  const nowMs = now.getTime();

  const items: RiverItem[] = [];

  // -- Calendar
  for (const e of calendar) {
    const startIso = e.start?.dateTime ?? e.start?.date ?? null;
    if (!startIso) continue;
    const ms = new Date(startIso).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms < dayStart || ms > dayEnd) continue;
    items.push({
      id: `cal-${e.id ?? ms}`,
      kind: "cal",
      size: calendarSize(ms, nowMs),
      ts: ms,
      timeLabel: formatTime(ms),
      title: e.summary ?? "(untitled)",
      meta: e.location ?? null,
      href: e.htmlLink ?? null,
    });
  }

  // -- Tasks (use due time when present, otherwise pin to noon so they
  //    sort sensibly inside the day rather than at midnight).
  for (const t of tasks) {
    const due = t.due?.date ?? null;
    let ms: number;
    if (due && /T\d{2}:\d{2}/.test(due)) {
      const parsed = new Date(due);
      if (Number.isNaN(parsed.getTime())) continue;
      ms = parsed.getTime();
    } else if (due) {
      // Date-only — anchor to local noon.
      const [y, m, d] = due.split("-").map(Number);
      if (!y || !m || !d) continue;
      ms = new Date(y, m - 1, d, 12, 0, 0).getTime();
    } else {
      ms = new Date(now).setHours(12, 0, 0, 0);
    }
    items.push({
      id: `task-${t.id}`,
      kind: "task",
      size: taskSize(t),
      ts: ms,
      timeLabel: formatTime(ms),
      title: t.content,
      meta: `P${5 - (t.priority ?? 1)}`,
      href: null,
    });
  }

  // -- Mail (cap to 8 most recent so the river isn't drowned)
  const recentMail = [...inbox]
    .map((m) => {
      const internal = Number(
        (m as { internalDate?: string | number }).internalDate ?? 0
      );
      return { m, ts: internal };
    })
    .filter(({ ts }) => ts > 0 && ts >= dayStart && ts <= dayEnd)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);

  for (const { m, ts } of recentMail) {
    const subject = readGmailHeader(m, "Subject") || "(no subject)";
    const from = readGmailHeader(m, "From") || "";
    items.push({
      id: `mail-${m.id ?? ts}`,
      kind: "mail",
      size: mailSize(m),
      ts,
      timeLabel: formatTime(ts),
      title: subject,
      meta: from || null,
      href: m.threadId
        ? `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(m.threadId)}`
        : null,
    });
  }

  return items.sort((a, b) => a.ts - b.ts);
}
