import type { PlanItemData } from "./types";

export const DEFAULT_TASK_DURATION_MINUTES = 30;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;
const DEFAULT_EMAIL_DEADLINE_HOUR = 17;
const DEFAULT_HABIT_DURATION_MINUTES = 10;
const MORNING_HABIT_WINDOW_HOUR = 10;
const SCHEDULER_ROUNDING_MINUTES = 5;

type CalendarEventInput = any;
type TodoistTaskInput = any;
type EmailInput = any;
type HabitInput = any;

type DayPlanSeed = {
  dayLabel: "Today's Plan" | "Tomorrow's Plan";
  dateKey: string;
  autoItems: PlanItemData[];
};

type FreeBlock = {
  startMs: number;
  endMs: number;
};

export const PLAN_SOURCE_PRIORITY: Record<PlanItemData["source"], number> = {
  calendar: 0,
  todoist: 1,
  email: 2,
  habit: 3,
  suggestion: 4,
};

const toDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseDateSafe = (value?: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

export const getTaskDateKey = (task: TodoistTaskInput): string | null => {
  if (typeof task?.due?.date === "string" && task.due.date.length >= 10) {
    return task.due.date.slice(0, 10);
  }
  if (typeof task?.due?.datetime === "string") {
    const date = parseDateSafe(task.due.datetime);
    if (date) return toDateKey(date);
  }
  return null;
};

export const getEventDateKey = (event: CalendarEventInput): string | null => {
  if (typeof event?.start?.date === "string" && event.start.date.length >= 10) {
    return event.start.date.slice(0, 10);
  }
  if (typeof event?.start?.dateTime === "string") {
    const date = parseDateSafe(event.start.dateTime);
    if (date) return toDateKey(date);
  }
  return null;
};

const formatTime = (date: Date): string => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const formatTimeLabel = (startMs: number, durationMinutes?: number): string => {
  const start = new Date(startMs);
  if (!durationMinutes) return formatTime(start);
  return `${formatTime(start)} • ${durationMinutes}m`;
};

const dueTimeLabel = (startMs: number): string => `Due ${formatTime(new Date(startMs))}`;
const overdueTimeLabel = (originalDueMs: number): string => `Overdue • Due ${formatTime(new Date(originalDueMs))}`;

const roundUpToMinutes = (ms: number, minutes: number): number => {
  const intervalMs = minutes * 60 * 1000;
  return Math.ceil(ms / intervalMs) * intervalMs;
};

const getTaskDueDate = (task: TodoistTaskInput): Date | null => {
  if (typeof task?.due?.datetime === "string") {
    return parseDateSafe(task.due.datetime);
  }
  if (typeof task?.due?.date === "string") {
    // Todoist due.date is date-only, not a timed due.
    return parseDateSafe(`${task.due.date}T23:59:00`);
  }
  return null;
};

const isTaskCompleted = (task: TodoistTaskInput): boolean => {
  const candidateFlags = [
    (task as any)?.isCompleted,
    (task as any)?.is_completed,
    (task as any)?.completed,
    (task as any)?.checked,
  ];
  return candidateFlags.some((value) => value === true || value === 1 || value === "1");
};

const taskHasExplicitDueTime = (task: TodoistTaskInput): boolean => {
  const dueDateTime = task?.due?.datetime;
  if (typeof dueDateTime !== "string" || dueDateTime.trim().length === 0) return false;
  return parseDateSafe(dueDateTime) !== null;
};

const getEventStartEnd = (event: CalendarEventInput): { startMs: number; endMs: number; allDay: boolean } | null => {
  const startRaw = event?.start?.dateTime || event?.start?.date;
  if (!startRaw) return null;

  const start = parseDateSafe(startRaw);
  if (!start) return null;

  const allDay = Boolean(event?.start?.date && !event?.start?.dateTime);
  const endRaw = event?.end?.dateTime || event?.end?.date;
  const end = parseDateSafe(endRaw);

  let endMs = end ? end.getTime() : start.getTime() + 60 * 60 * 1000;
  if (endMs <= start.getTime()) {
    endMs = start.getTime() + 60 * 60 * 1000;
  }

  return {
    startMs: start.getTime(),
    endMs,
    allDay,
  };
};

const getEmailHeader = (message: EmailInput, headerName: string): string => {
  const headers = Array.isArray(message?.payload?.headers) ? message.payload.headers : [];
  const target = headers.find((header: any) => String(header?.name || "").toLowerCase() === headerName.toLowerCase());
  return typeof target?.value === "string" ? target.value : "";
};

const buildEmailThreadUrl = (message: EmailInput): string | undefined => {
  const threadId = typeof message?.threadId === "string" ? message.threadId.trim() : "";
  if (!threadId) return undefined;
  return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
};

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 3);

const STOPWORD_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "todo",
  "task",
  "call",
  "email",
  "follow",
  "meeting",
  "project",
  "update",
  "review",
  "check",
  "plan",
  "prep",
]);

const getSimilarityToken = (value: string): string | null => {
  const parts = tokenize(value);
  for (const token of parts) {
    if (token.length < 4) continue;
    if (STOPWORD_TOKENS.has(token)) continue;
    return token;
  }
  return parts.length > 0 ? parts[0] : null;
};

const matchEventForTask = (
  taskTitle: string,
  events: Array<{ id: string; title: string; startMs: number }>
): { eventStartMs: number | null; score: number } => {
  const taskTokens = new Set(tokenize(taskTitle));
  if (taskTokens.size === 0) return { eventStartMs: null, score: 0 };

  let best: { eventStartMs: number | null; score: number } = { eventStartMs: null, score: 0 };
  for (const event of events) {
    const eventTokens = tokenize(event.title);
    let score = 0;
    for (const token of eventTokens) {
      if (taskTokens.has(token)) score += 1;
    }
    if (score > best.score) {
      best = { eventStartMs: event.startMs, score };
    }
  }
  return best;
};

const normalizeText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAY_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const textMentionsPlanDate = (text: string, dateKey: string, now: Date): boolean => {
  const planDate = parseDateSafe(`${dateKey}T00:00:00`);
  if (!planDate) return false;
  const planWeekday = planDate.getDay();

  const todayKey = toDateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = toDateKey(tomorrow);

  let hasExplicitMarker = false;

  if (/\btoday\b/i.test(text)) {
    hasExplicitMarker = true;
    if (dateKey !== todayKey) return false;
  }
  if (/\btomorrow\b/i.test(text)) {
    hasExplicitMarker = true;
    if (dateKey !== tomorrowKey) return false;
  }

  for (let index = 0; index < WEEKDAY_NAMES.length; index += 1) {
    const full = WEEKDAY_NAMES[index];
    const short = WEEKDAY_SHORT[index];
    const fullRegex = new RegExp(`\\b${full}\\b`, "i");
    const shortRegex = new RegExp(`\\b${short}\\b`, "i");
    if (fullRegex.test(text) || shortRegex.test(text)) {
      hasExplicitMarker = true;
      if (index !== planWeekday) return false;
    }
  }

  const isoMatches = Array.from(text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g));
  if (isoMatches.length > 0) {
    hasExplicitMarker = true;
    const matched = isoMatches.some((match) => {
      const key = `${match[1]}-${match[2]}-${match[3]}`;
      return key === dateKey;
    });
    if (!matched) return false;
  }

  const usMatches = Array.from(text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g));
  if (usMatches.length > 0) {
    hasExplicitMarker = true;
    const matched = usMatches.some((match) => {
      const month = Number(match[1]);
      const day = Number(match[2]);
      if (!Number.isFinite(month) || !Number.isFinite(day)) return false;
      if (month !== planDate.getMonth() + 1 || day !== planDate.getDate()) return false;
      if (!match[3]) return true;
      let year = Number(match[3]);
      if (year < 100) year += 2000;
      return year === planDate.getFullYear();
    });
    if (!matched) return false;
  }

  return hasExplicitMarker;
};

const extractEmailDeadlineMs = (
  email: EmailInput,
  dateKey: string,
  now: Date
): number | null => {
  const subject = getEmailHeader(email, "Subject");
  const snippet = typeof email?.snippet === "string" ? email.snippet : "";
  const text = normalizeText(`${subject} ${snippet}`);

  const deadlineIntent =
    /\b(due|deadline|submit|deliver|before|by|asap|action required|eod|end of day|tonight)\b/i.test(text);
  if (!deadlineIntent) return null;

  const mentionsPlanDate = textMentionsPlanDate(text, dateKey, now);
  const mentionsOtherRelativeDay = /\b(today|tomorrow)\b/i.test(text);
  if (mentionsOtherRelativeDay && !mentionsPlanDate) return null;
  if (!mentionsPlanDate && /\b(on|by|due)\s+\d{1,2}\/\d{1,2}\b/i.test(text)) return null;

  const dayDate = parseDateSafe(`${dateKey}T00:00:00`);
  if (!dayDate) return null;

  let hours = DEFAULT_EMAIL_DEADLINE_HOUR;
  let minutes = 0;

  const eodMentioned = /\b(eod|end of day|tonight)\b/i.test(text);
  if (!eodMentioned) {
    const match =
      text.match(/\b(?:by|due(?:\s+by)?|deadline(?:\s+is)?|before|at)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) ||
      text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);

    if (!match) {
      // Explicit date without an explicit time still gets a same-day deadline slot.
      if (!mentionsPlanDate) return null;
    } else {
      let parsedHour = Number(match[1]);
      const parsedMinutes = match[2] ? Number(match[2]) : 0;
      const meridiem = String(match[3] || "").toLowerCase();
      if (!Number.isFinite(parsedHour) || !Number.isFinite(parsedMinutes)) return null;
      if (parsedHour < 1 || parsedHour > 12 || parsedMinutes < 0 || parsedMinutes > 59) return null;
      if (meridiem === "pm" && parsedHour < 12) parsedHour += 12;
      if (meridiem === "am" && parsedHour === 12) parsedHour = 0;
      hours = parsedHour;
      minutes = parsedMinutes;
    }
  }

  const deadlineDate = new Date(dayDate);
  deadlineDate.setHours(hours, minutes, 0, 0);
  return deadlineDate.getTime();
};

const isHabitSkipped = (habitName: string): boolean => {
  const normalized = normalizeText(habitName);
  return /\bno\s*alcohol\b|\bno\s*420\b/.test(normalized);
};

const isFlossHabit = (habitName: string): boolean => /\bfloss\b/i.test(habitName);

const isBtanHabit = (habitName: string): boolean =>
  /\bbtan\b/i.test(habitName) || /brush\s+teeth\s+at\s+night/i.test(habitName);

export const parseDurationMinutesFromTask = (
  task: TodoistTaskInput,
  fallbackMinutes = DEFAULT_TASK_DURATION_MINUTES
): number => {
  const labels: string[] = [];
  if (Array.isArray(task?.labels)) {
    for (const label of task.labels) {
      if (typeof label === "string") labels.push(label);
    }
  }
  if (Array.isArray((task as any)?.labelNames)) {
    for (const label of (task as any).labelNames) {
      if (typeof label === "string") labels.push(label);
    }
  }

  const candidates = [...labels, String(task?.content || "")];
  for (const raw of candidates) {
    const match = raw.match(/(?:^|\b)(\d{1,3})\s*m(?:in)?(?:\b|$)/i);
    if (!match) continue;
    const minutes = Number(match[1]);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }

  return fallbackMinutes;
};

const buildDayBounds = (dateKey: string): { dayStartMs: number; dayEndMs: number } => {
  const dayStart = new Date(`${dateKey}T00:00:00`);
  const dayEnd = new Date(`${dateKey}T00:00:00`);
  dayStart.setHours(DAY_START_HOUR, 0, 0, 0);
  dayEnd.setHours(DAY_END_HOUR, 0, 0, 0);
  return { dayStartMs: dayStart.getTime(), dayEndMs: dayEnd.getTime() };
};

const buildFreeBlocks = (
  dateKey: string,
  timedEvents: Array<{ startMs: number; endMs: number }>,
  earliestStartMs?: number
): FreeBlock[] => {
  const { dayStartMs, dayEndMs } = buildDayBounds(dateKey);
  const effectiveStartMs = Math.max(dayStartMs, earliestStartMs ?? dayStartMs);
  if (timedEvents.length === 0) return [{ startMs: effectiveStartMs, endMs: dayEndMs }];

  const sorted = [...timedEvents]
    .map((event) => ({
      startMs: Math.max(dayStartMs, event.startMs),
      endMs: Math.min(dayEndMs, event.endMs),
    }))
    .filter((event) => event.endMs > event.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (sorted.length === 0) return [{ startMs: effectiveStartMs, endMs: dayEndMs }];

  const merged: Array<{ startMs: number; endMs: number }> = [];
  for (const event of sorted) {
    const last = merged[merged.length - 1];
    if (!last || event.startMs > last.endMs) {
      merged.push({ ...event });
      continue;
    }
    last.endMs = Math.max(last.endMs, event.endMs);
  }

  const free: FreeBlock[] = [];
  let cursor = effectiveStartMs;
  for (const event of merged) {
    if (event.startMs > cursor) {
      free.push({ startMs: cursor, endMs: event.startMs });
    }
    cursor = Math.max(cursor, event.endMs);
  }
  if (cursor < dayEndMs) {
    free.push({ startMs: cursor, endMs: dayEndMs });
  }
  return free;
};

const placeInFreeBlocks = (
  freeBlocks: FreeBlock[],
  durationMinutes: number,
  preferredEndMs?: number | null
): number | null => {
  const durationMs = durationMinutes * 60 * 1000;

  if (preferredEndMs && Number.isFinite(preferredEndMs)) {
    // Place as close as possible before the preferred end (meeting prep behavior).
    for (let i = freeBlocks.length - 1; i >= 0; i -= 1) {
      const block = freeBlocks[i];
      const cappedEnd = Math.min(block.endMs, preferredEndMs);
      if (cappedEnd - block.startMs < durationMs) continue;
      const startMs = cappedEnd - durationMs;
      if (startMs < block.startMs) continue;

      const original = { ...block };
      const next: FreeBlock[] = [];
      if (startMs > original.startMs) next.push({ startMs: original.startMs, endMs: startMs });
      if (cappedEnd < original.endMs) next.push({ startMs: cappedEnd, endMs: original.endMs });
      freeBlocks.splice(i, 1, ...next);
      return startMs;
    }
  }

  for (let i = 0; i < freeBlocks.length; i += 1) {
    const block = freeBlocks[i];
    if (block.endMs - block.startMs < durationMs) continue;
    const startMs = block.startMs;
    block.startMs += durationMs;
    if (block.startMs >= block.endMs) {
      freeBlocks.splice(i, 1);
    }
    return startMs;
  }

  return null;
};

const placeInFreeBlocksAtOrAfter = (
  freeBlocks: FreeBlock[],
  durationMinutes: number,
  startAtMs: number
): number | null => {
  const durationMs = durationMinutes * 60 * 1000;
  for (let i = 0; i < freeBlocks.length; i += 1) {
    const block = freeBlocks[i];
    const candidateStart = Math.max(block.startMs, startAtMs);
    const candidateEnd = candidateStart + durationMs;
    if (candidateEnd > block.endMs) continue;

    const original = { ...block };
    const replacement: FreeBlock[] = [];
    if (candidateStart > original.startMs) {
      replacement.push({ startMs: original.startMs, endMs: candidateStart });
    }
    if (candidateEnd < original.endMs) {
      replacement.push({ startMs: candidateEnd, endMs: original.endMs });
    }
    freeBlocks.splice(i, 1, ...replacement);
    return candidateStart;
  }
  return null;
};

const buildTaskUrl = (task: TodoistTaskInput): string => {
  if (typeof task?.url === "string" && task.url.trim().length > 0) return task.url;
  return `https://todoist.com/app/task/${String(task?.id || "")}`;
};

export function buildDayPlanSeed(params: {
  calendarEvents: CalendarEventInput[];
  todoistTasks: TodoistTaskInput[];
  emails?: EmailInput[];
  habits: HabitInput[];
  now?: Date;
}): DayPlanSeed {
  const now = params.now || new Date();
  const nowMs = now.getTime();
  const todayKey = toDateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = toDateKey(tomorrow);

  const todayEvents = (params.calendarEvents || []).filter((event) => getEventDateKey(event) === todayKey);
  const tomorrowEvents = (params.calendarEvents || []).filter((event) => getEventDateKey(event) === tomorrowKey);
  const todayTasks = (params.todoistTasks || []).filter((task) => getTaskDateKey(task) === todayKey);
  const tomorrowTasks = (params.todoistTasks || []).filter((task) => getTaskDateKey(task) === tomorrowKey);
  const todayHabits = (params.habits || []).filter((habit) => !habit?.completed);

  const getDeadlineEmailsForDate = (targetDateKey: string) =>
    (params.emails || [])
      .map((email) => {
        const deadlineMs = extractEmailDeadlineMs(email, targetDateKey, now);
        if (!deadlineMs) return null;
        const subject = getEmailHeader(email, "Subject").trim() || "Email follow-up";
        const from = getEmailHeader(email, "From").trim();
        return {
          id: `email:${String(email?.id || Math.random())}`,
          title: from ? `${subject} (${from})` : subject,
          deadlineMs,
          sourceUrl: buildEmailThreadUrl(email),
        };
      })
      .filter(Boolean) as Array<{ id: string; title: string; deadlineMs: number; sourceUrl?: string }>;

  const todayDeadlineEmails = getDeadlineEmailsForDate(todayKey);
  const tomorrowDeadlineEmails = getDeadlineEmailsForDate(tomorrowKey);

  const hasTodayCoreItems =
    todayEvents.length + todayTasks.length + todayDeadlineEmails.length + todayHabits.length > 0;
  const dateKey = hasTodayCoreItems ? todayKey : tomorrowKey;
  const isTodayPlan = dateKey === todayKey;
  const { dayStartMs, dayEndMs } = buildDayBounds(dateKey);
  const nowRoundedMs = roundUpToMinutes(nowMs, SCHEDULER_ROUNDING_MINUTES);
  const effectivePlanStartMs = isTodayPlan ? Math.min(dayEndMs, Math.max(dayStartMs, nowRoundedMs)) : dayStartMs;
  const dayLabel: DayPlanSeed["dayLabel"] = hasTodayCoreItems ? "Today's Plan" : "Tomorrow's Plan";
  const events = hasTodayCoreItems ? todayEvents : tomorrowEvents;
  const tasksForDay = (hasTodayCoreItems ? todayTasks : tomorrowTasks).filter((task) => !isTaskCompleted(task));
  const habits = hasTodayCoreItems ? todayHabits : [];
  const deadlineEmails = hasTodayCoreItems ? todayDeadlineEmails : tomorrowDeadlineEmails;

  const normalizedEvents = events
    .map((event) => {
      const timing = getEventStartEnd(event);
      if (!timing) return null;
      const isPastTimedEvent = isTodayPlan && !timing.allDay && timing.endMs <= nowMs;
      if (isPastTimedEvent) return null;

      return {
        id: String(event.id || Math.random()),
        title: String(event.summary || "Untitled event"),
        startMs: timing.startMs,
        endMs: timing.endMs,
        allDay: timing.allDay,
        htmlLink: typeof event.htmlLink === "string" ? event.htmlLink : undefined,
      };
    })
    .filter(Boolean) as Array<{
    id: string;
    title: string;
    startMs: number;
    endMs: number;
    allDay: boolean;
    htmlLink?: string;
  }>;

  const eventItems: PlanItemData[] = normalizedEvents.map((event) => ({
    // Ongoing timed events are anchored at "now" so the plan reflects current state.
    // All-day events keep their existing label.
    id: `event:${event.id}`,
    type: "event",
    source: "calendar",
    title: event.title,
    timeLabel: event.allDay
      ? "All-day"
      : isTodayPlan && event.startMs < effectivePlanStartMs
        ? `Now • until ${formatTime(new Date(event.endMs))}`
        : formatTimeLabel(event.startMs),
    sortMs: event.allDay ? event.startMs : Math.max(event.startMs, effectivePlanStartMs),
    startMs: event.allDay ? event.startMs : Math.max(event.startMs, effectivePlanStartMs),
    durationMinutes: Math.max(15, Math.round((event.endMs - event.startMs) / 60000)),
    dueTime: false,
    dateKey,
    sourceUrl: event.htmlLink,
  }));

  const dueTimeTasks = tasksForDay
    .filter((task) => taskHasExplicitDueTime(task))
    .map((task) => {
      const dueDate = parseDateSafe(task?.due?.datetime || null);
      const dueMs = dueDate ? dueDate.getTime() : null;
      if (!dueMs) return null;
      const durationMinutes = parseDurationMinutesFromTask(task);
      const scheduledMs = isTodayPlan ? Math.max(dueMs, effectivePlanStartMs) : dueMs;
      return {
        id: `task:${String(task.id || Math.random())}`,
        type: "task" as const,
        source: "todoist" as const,
        title: String(task.content || "Untitled task"),
        timeLabel: isTodayPlan && dueMs < effectivePlanStartMs ? overdueTimeLabel(dueMs) : dueTimeLabel(dueMs),
        sortMs: scheduledMs,
        startMs: scheduledMs,
        durationMinutes,
        dueTime: true,
        dateKey,
        sourceUrl: buildTaskUrl(task),
      };
    })
    .filter(Boolean) as PlanItemData[];

  const deadlineEmailItems: PlanItemData[] = deadlineEmails.map((email) => ({
    id: email.id,
    type: "task",
    source: "email",
    title: email.title,
    timeLabel:
      isTodayPlan && email.deadlineMs < effectivePlanStartMs
        ? overdueTimeLabel(email.deadlineMs)
        : dueTimeLabel(email.deadlineMs),
    sortMs: isTodayPlan ? Math.max(email.deadlineMs, effectivePlanStartMs) : email.deadlineMs,
    startMs: isTodayPlan ? Math.max(email.deadlineMs, effectivePlanStartMs) : email.deadlineMs,
    durationMinutes: DEFAULT_TASK_DURATION_MINUTES,
    dueTime: true,
    dateKey,
    sourceUrl: email.sourceUrl,
  }));

  const timedEvents = normalizedEvents.filter((event) => !event.allDay);
  const freeBlocks = buildFreeBlocks(dateKey, timedEvents, effectivePlanStartMs);

  const eventContext = normalizedEvents.map((event) => ({
    id: event.id,
    title: event.title,
    startMs: event.startMs,
  }));

  const parentTaskIds = new Set(
    tasksForDay
      .map((task) => String((task as any)?.parentId || (task as any)?.parent_id || "").trim())
      .filter((id) => id.length > 0)
  );

  const schedulableTasksRaw = tasksForDay.filter((task) => !taskHasExplicitDueTime(task)).map((task) => {
    const durationMinutes = parseDurationMinutesFromTask(task);
    const dueDate = getTaskDueDate(task);
    const match = matchEventForTask(String(task?.content || ""), eventContext);
    const taskId = String(task?.id || Math.random());
    const parentId = String((task as any)?.parentId || (task as any)?.parent_id || "").trim();
    const projectId = String((task as any)?.projectId || (task as any)?.project_id || "").trim();
    const lexicalToken = getSimilarityToken(String(task?.content || ""));

    let groupKey = "";
    if (parentId) {
      groupKey = `parent:${parentId}`;
    } else if (parentTaskIds.has(taskId)) {
      groupKey = `parent:${taskId}`;
    } else if (projectId && lexicalToken) {
      groupKey = `project:${projectId}:${lexicalToken}`;
    } else if (projectId) {
      groupKey = `project:${projectId}`;
    } else if (lexicalToken) {
      groupKey = `topic:${lexicalToken}`;
    } else {
      groupKey = `task:${taskId}`;
    }

    return {
      task,
      id: `task:${taskId}`,
      title: String(task.content || "Untitled task"),
      durationMinutes,
      dueDateMs: dueDate ? dueDate.getTime() : null,
      prepBeforeMs: match.score > 0 ? match.eventStartMs : null,
      prepScore: match.score,
      sourceUrl: buildTaskUrl(task),
      groupKey,
      lexicalToken,
    };
  });

  schedulableTasksRaw.sort((a, b) => {
    if (a.prepBeforeMs && b.prepBeforeMs && a.prepBeforeMs !== b.prepBeforeMs) {
      return a.prepBeforeMs - b.prepBeforeMs;
    }
    if (a.prepBeforeMs && !b.prepBeforeMs) return -1;
    if (!a.prepBeforeMs && b.prepBeforeMs) return 1;

    if (a.groupKey !== b.groupKey) {
      if (a.dueDateMs && b.dueDateMs && a.dueDateMs !== b.dueDateMs) {
        return a.dueDateMs - b.dueDateMs;
      }
      if (a.dueDateMs && !b.dueDateMs) return -1;
      if (!a.dueDateMs && b.dueDateMs) return 1;
      return a.groupKey.localeCompare(b.groupKey, undefined, { sensitivity: "base" });
    }

    if (a.dueDateMs && b.dueDateMs && a.dueDateMs !== b.dueDateMs) return a.dueDateMs - b.dueDateMs;
    if (a.dueDateMs && !b.dueDateMs) return -1;
    if (!a.dueDateMs && b.dueDateMs) return 1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  const scheduledTaskItems: PlanItemData[] = [];
  const lastGroupEndByKey = new Map<string, number>();
  for (const candidate of schedulableTasksRaw) {
    let startMs: number | null = null;
    const previousGroupEnd = lastGroupEndByKey.get(candidate.groupKey);
    if (previousGroupEnd) {
      startMs = placeInFreeBlocksAtOrAfter(freeBlocks, candidate.durationMinutes, previousGroupEnd);
    }
    if (!startMs) {
      startMs = placeInFreeBlocks(freeBlocks, candidate.durationMinutes, candidate.prepBeforeMs);
    }
    if (!startMs) {
      startMs = placeInFreeBlocksAtOrAfter(freeBlocks, candidate.durationMinutes, effectivePlanStartMs);
    }
    if (!startMs) continue;

    scheduledTaskItems.push({
      id: candidate.id,
      type: "task",
      source: "todoist",
      title: candidate.title,
      timeLabel: formatTimeLabel(startMs, candidate.durationMinutes),
      sortMs: startMs,
      startMs,
      durationMinutes: candidate.durationMinutes,
      dueTime: false,
      dateKey,
      sourceUrl: candidate.sourceUrl,
    });
    lastGroupEndByKey.set(candidate.groupKey, startMs + candidate.durationMinutes * 60 * 1000);
  }

  const habitItems: PlanItemData[] = [];
  const filteredHabits = habits
    .map((habit) => ({
      id: `habit:${String(habit?.id || Math.random())}`,
      name: String(habit?.name || "Habit").trim() || "Habit",
    }))
    .filter((habit) => !isHabitSkipped(habit.name));

  const habitCandidates = filteredHabits.sort((a, b) => {
    const aFloss = isFlossHabit(a.name);
    const bFloss = isFlossHabit(b.name);
    if (aFloss !== bFloss) return aFloss ? -1 : 1;
    const aBtan = isBtanHabit(a.name);
    const bBtan = isBtanHabit(b.name);
    if (aBtan !== bBtan) return aBtan ? 1 : -1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });

  for (const habit of habitCandidates) {
    let startMs: number | null = null;
    if (isFlossHabit(habit.name)) {
      const morningAnchor = Math.max(
        effectivePlanStartMs,
        dayStartMs + (MORNING_HABIT_WINDOW_HOUR - DAY_START_HOUR) * 60 * 60 * 1000
      );
      startMs = placeInFreeBlocks(freeBlocks, DEFAULT_HABIT_DURATION_MINUTES, morningAnchor);
    } else if (isBtanHabit(habit.name)) {
      startMs = placeInFreeBlocks(freeBlocks, DEFAULT_HABIT_DURATION_MINUTES, dayEndMs);
    } else {
      startMs = placeInFreeBlocks(freeBlocks, DEFAULT_HABIT_DURATION_MINUTES, null);
    }
    if (!startMs) continue;
    habitItems.push({
      id: habit.id,
      type: "habit",
      source: "habit",
      title: habit.name,
      timeLabel: formatTimeLabel(startMs, DEFAULT_HABIT_DURATION_MINUTES),
      sortMs: startMs,
      startMs,
      durationMinutes: DEFAULT_HABIT_DURATION_MINUTES,
      dueTime: false,
      dateKey,
    });
  }

  const autoItems = [...eventItems, ...dueTimeTasks, ...scheduledTaskItems, ...deadlineEmailItems, ...habitItems].sort((a, b) => {
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    const sourcePriorityDelta = (PLAN_SOURCE_PRIORITY[a.source] ?? 99) - (PLAN_SOURCE_PRIORITY[b.source] ?? 99);
    if (sourcePriorityDelta !== 0) return sourcePriorityDelta;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  return { dayLabel, dateKey, autoItems };
}
