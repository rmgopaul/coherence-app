import type { PlanItemData } from "./types";

export const DEFAULT_TASK_DURATION_MINUTES = 30;
const DAY_START_HOUR = 8;
const DAY_END_HOUR = 20;

type CalendarEventInput = any;
type TodoistTaskInput = any;
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

const tokenize = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((part) => part.length >= 3);

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

const buildFreeBlocks = (dateKey: string, timedEvents: Array<{ startMs: number; endMs: number }>): FreeBlock[] => {
  const { dayStartMs, dayEndMs } = buildDayBounds(dateKey);
  if (timedEvents.length === 0) return [{ startMs: dayStartMs, endMs: dayEndMs }];

  const sorted = [...timedEvents]
    .map((event) => ({
      startMs: Math.max(dayStartMs, event.startMs),
      endMs: Math.min(dayEndMs, event.endMs),
    }))
    .filter((event) => event.endMs > event.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  if (sorted.length === 0) return [{ startMs: dayStartMs, endMs: dayEndMs }];

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
  let cursor = dayStartMs;
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

const buildTaskUrl = (task: TodoistTaskInput): string => {
  if (typeof task?.url === "string" && task.url.trim().length > 0) return task.url;
  return `https://todoist.com/app/task/${String(task?.id || "")}`;
};

export function buildDayPlanSeed(params: {
  calendarEvents: CalendarEventInput[];
  todoistTasks: TodoistTaskInput[];
  habits: HabitInput[];
  now?: Date;
}): DayPlanSeed {
  const now = params.now || new Date();
  const todayKey = toDateKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = toDateKey(tomorrow);

  const todayEvents = (params.calendarEvents || []).filter((event) => getEventDateKey(event) === todayKey);
  const tomorrowEvents = (params.calendarEvents || []).filter((event) => getEventDateKey(event) === tomorrowKey);
  const todayTasks = (params.todoistTasks || []).filter((task) => getTaskDateKey(task) === todayKey);
  const tomorrowTasks = (params.todoistTasks || []).filter((task) => getTaskDateKey(task) === tomorrowKey);

  const hasTodayCoreItems = todayEvents.length + todayTasks.length > 0;
  const dateKey = hasTodayCoreItems ? todayKey : tomorrowKey;
  const dayLabel: DayPlanSeed["dayLabel"] = hasTodayCoreItems ? "Today's Plan" : "Tomorrow's Plan";
  const events = hasTodayCoreItems ? todayEvents : tomorrowEvents;
  const tasksForDay = hasTodayCoreItems ? todayTasks : tomorrowTasks;
  const undatedTasks = (params.todoistTasks || []).filter((task) => !getTaskDateKey(task));
  const habits = (params.habits || []).filter((habit) => !habit?.completed);

  const normalizedEvents = events
    .map((event) => {
      const timing = getEventStartEnd(event);
      if (!timing) return null;
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
    id: `event:${event.id}`,
    type: "event",
    source: "calendar",
    title: event.title,
    timeLabel: event.allDay ? "All-day" : formatTimeLabel(event.startMs),
    sortMs: event.startMs,
    startMs: event.startMs,
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
      return {
        id: `task:${String(task.id || Math.random())}`,
        type: "task" as const,
        source: "todoist" as const,
        title: String(task.content || "Untitled task"),
        timeLabel: dueTimeLabel(dueMs),
        sortMs: dueMs,
        startMs: dueMs,
        durationMinutes,
        dueTime: true,
        dateKey,
        sourceUrl: buildTaskUrl(task),
      };
    })
    .filter(Boolean) as PlanItemData[];

  const timedEvents = normalizedEvents.filter((event) => !event.allDay);
  const freeBlocks = buildFreeBlocks(dateKey, timedEvents);

  const eventContext = normalizedEvents.map((event) => ({
    id: event.id,
    title: event.title,
    startMs: event.startMs,
  }));

  const schedulableTasksRaw = [...tasksForDay.filter((task) => !taskHasExplicitDueTime(task)), ...undatedTasks].map((task) => {
    const durationMinutes = parseDurationMinutesFromTask(task);
    const dueDate = getTaskDueDate(task);
    const match = matchEventForTask(String(task?.content || ""), eventContext);
    return {
      task,
      id: `task:${String(task.id || Math.random())}`,
      title: String(task.content || "Untitled task"),
      durationMinutes,
      dueDateMs: dueDate ? dueDate.getTime() : null,
      prepBeforeMs: match.score > 0 ? match.eventStartMs : null,
      prepScore: match.score,
      sourceUrl: buildTaskUrl(task),
    };
  });

  schedulableTasksRaw.sort((a, b) => {
    if (a.prepBeforeMs && b.prepBeforeMs && a.prepBeforeMs !== b.prepBeforeMs) {
      return a.prepBeforeMs - b.prepBeforeMs;
    }
    if (a.prepBeforeMs && !b.prepBeforeMs) return -1;
    if (!a.prepBeforeMs && b.prepBeforeMs) return 1;
    if (a.dueDateMs && b.dueDateMs && a.dueDateMs !== b.dueDateMs) return a.dueDateMs - b.dueDateMs;
    if (a.dueDateMs && !b.dueDateMs) return -1;
    if (!a.dueDateMs && b.dueDateMs) return 1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  const scheduledTaskItems: PlanItemData[] = [];
  for (const candidate of schedulableTasksRaw) {
    const startMs = placeInFreeBlocks(freeBlocks, candidate.durationMinutes, candidate.prepBeforeMs);
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
  }

  const habitItems: PlanItemData[] = [];
  for (const habit of habits) {
    const startMs = placeInFreeBlocks(freeBlocks, 15, null);
    if (!startMs) continue;
    habitItems.push({
      id: `habit:${String(habit.id || Math.random())}`,
      type: "habit",
      source: "habit",
      title: String(habit.name || "Habit"),
      timeLabel: formatTimeLabel(startMs, 15),
      sortMs: startMs,
      startMs,
      durationMinutes: 15,
      dueTime: false,
      dateKey,
    });
  }

  const autoItems = [...eventItems, ...dueTimeTasks, ...scheduledTaskItems, ...habitItems].sort((a, b) => {
    if (a.sortMs !== b.sortMs) return a.sortMs - b.sortMs;
    if (a.type === "event" && b.type !== "event") return -1;
    if (a.type !== "event" && b.type === "event") return 1;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  return { dayLabel, dateKey, autoItems };
}

