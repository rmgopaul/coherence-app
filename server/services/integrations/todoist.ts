import { toDateKey } from "@shared/dateKey";

export interface TodoistTask {
  id: string;
  content: string;
  description: string;
  projectId: string;
  parentId?: string;
  priority: number;
  labels: string[];
  due?: {
    date: string;
    datetime?: string;
    string: string;
  };
}

export interface TodoistProject {
  id: string;
  name: string;
  color: string;
}

export interface TodoistCompletedTask {
  completionKey: string;
  taskId: string | null;
  content: string;
  completedAt: string | null;
  dateKey: string;
}

const TODOIST_API_BASE = "https://api.todoist.com/api/v1";

type RawTodoistTask = {
  id: string | number;
  content?: string;
  description?: string;
  projectId?: string | number;
  project_id?: string | number;
  parentId?: string | number;
  parent_id?: string | number;
  priority?: number;
  labels?: unknown[];
  due?: {
    date?: string;
    datetime?: string;
    string?: string;
  } | null;
};

type RawTodoistProject = {
  id: string | number;
  name?: string;
  color?: string;
};

function mapTask(task: RawTodoistTask): TodoistTask {
  const dueDateTime = task?.due?.datetime ?? undefined;
  const dueDateOnly =
    task?.due?.date ??
    (typeof dueDateTime === "string" && dueDateTime.length >= 10 ? dueDateTime.slice(0, 10) : "");

  return {
    id: String(task.id),
    content: task.content ?? "",
    description: task.description ?? "",
    projectId: String(task.projectId ?? task.project_id ?? ""),
    parentId: task.parentId !== undefined || task.parent_id !== undefined
      ? String(task.parentId ?? task.parent_id)
      : undefined,
    priority: task.priority ?? 1,
    labels: Array.isArray(task.labels) ? task.labels.map(String) : [],
    due: task.due
      ? {
        date: dueDateOnly,
        datetime: dueDateTime,
        string: task.due.string ?? task.due.date ?? task.due.datetime ?? "",
      }
      : undefined,
  };
}

function mapProject(project: RawTodoistProject): TodoistProject {
  return {
    id: String(project.id),
    name: project.name ?? "Untitled",
    color: project.color ?? "gray",
  };
}

function extractResults<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (
    payload &&
    typeof payload === "object" &&
    "results" in payload &&
    Array.isArray((payload as any).results)
  ) {
    return (payload as any).results as T[];
  }
  return [];
}

function extractNextCursor(payload: unknown): string | null {
  if (
    payload &&
    typeof payload === "object" &&
    typeof (payload as any).next_cursor === "string" &&
    (payload as any).next_cursor.length > 0
  ) {
    return (payload as any).next_cursor as string;
  }
  return null;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseTaskDueDate(value?: string): Date | null {
  if (!value) return null;
  const normalized = value.length === 10 ? `${value}T00:00:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function toDateKeyAtOffset(date: Date, timezoneOffsetMinutes?: number): string {
  if (typeof timezoneOffsetMinutes !== "number" || !Number.isFinite(timezoneOffsetMinutes)) {
    return toDateKey(date);
  }
  // Convert UTC instant into the caller's local wall clock using the
  // provided offset, then format the shifted instant as a UTC date key
  // (because we've baked the offset into the timestamp itself).
  const shifted = new Date(date.getTime() - timezoneOffsetMinutes * 60 * 1000);
  return toDateKey(shifted, "UTC");
}

function toStartAndEnd(
  dateKey: string,
  timezoneOffsetMinutes?: number
): { start: Date; end: Date } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    throw new Error(`Invalid dateKey: ${dateKey}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (typeof timezoneOffsetMinutes === "number" && Number.isFinite(timezoneOffsetMinutes)) {
    const startUtcMs =
      Date.UTC(year, month - 1, day, 0, 0, 0, 0) + timezoneOffsetMinutes * 60 * 1000;
    const start = new Date(startUtcMs);
    const end = new Date(startUtcMs + 24 * 60 * 60 * 1000);
    return { start, end };
  }

  const start = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(start.getTime())) {
    throw new Error(`Invalid dateKey: ${dateKey}`);
  }
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseCompletedDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

type RawCompletedTaskItem = {
  task_id?: string | number;
  taskId?: string | number;
  task?: { id?: string | number; content?: string; name?: string };
  id?: string | number;
  content?: string;
  task_name?: string;
  completed_at?: string;
  completed_at_utc?: string;
  completed_date?: string;
  completedAt?: string;
  event_id?: string;
  completion_id?: string;
  history_id?: string;
};

function mapCompletedTaskItem(item: RawCompletedTaskItem): {
  completionKey: string;
  taskId: string | null;
  content: string;
  completedAt: string | null;
} {
  const taskIdValue =
    item?.task_id ??
    item?.taskId ??
    item?.task?.id ??
    item?.id ??
    null;
  const taskId = taskIdValue === null || taskIdValue === undefined ? null : String(taskIdValue);
  const content =
    asString(item?.content) ??
    asString(item?.task_name) ??
    asString(item?.task?.content) ??
    asString(item?.task?.name) ??
    "(untitled task)";
  const completedAtRaw =
    asString(item?.completed_at) ??
    asString(item?.completed_at_utc) ??
    asString(item?.completed_date) ??
    asString(item?.completedAt);
  const completedDate = parseCompletedDate(completedAtRaw);
  const completedAt = completedDate ? completedDate.toISOString() : null;
  const completionUniqueId =
    asString(item?.event_id) ??
    asString(item?.completion_id) ??
    asString(item?.history_id) ??
    null;

  return {
    // Use task+timestamp as canonical completion identity so recurring tasks
    // completed multiple times on the same day are counted correctly.
    completionKey:
      completionUniqueId ??
      `${taskId ?? "unknown"}|${completedAt ?? "na"}|${content.toLowerCase()}`,
    taskId,
    content,
    completedAt,
  };
}

async function fetchAllTodoistTasks(accessToken: string): Promise<TodoistTask[]> {
  const all: RawTodoistTask[] = [];
  let cursor: string | null = null;

  // Guard loop in case cursor response is unexpected.
  for (let i = 0; i < 20; i += 1) {
    const params = new URLSearchParams();
    params.set("limit", "200");
    if (cursor) params.set("cursor", cursor);
    const url = `${TODOIST_API_BASE}/tasks?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Todoist API error: ${response.statusText}`);
    }

    const data = await response.json();
    all.push(...extractResults<RawTodoistTask>(data));
    cursor = extractNextCursor(data);
    if (!cursor) break;
  }

  return all.map(mapTask);
}

async function applyFilter(
  accessToken: string,
  tasks: TodoistTask[],
  filter?: string
): Promise<TodoistTask[]> {
  const normalized = (filter ?? "").trim();
  if (!normalized) return tasks;

  const lower = normalized.toLowerCase();

  if (lower === "today") {
    const now = new Date();
    return tasks.filter((task) => {
      const dueDate = parseTaskDueDate(task.due?.date);
      return dueDate ? sameDay(dueDate, now) : false;
    });
  }

  if (lower === "7 days" || lower === "upcoming") {
    const today = startOfDay(new Date());
    const end = startOfDay(new Date(today));
    end.setDate(end.getDate() + 7);
    return tasks.filter((task) => {
      const dueDate = parseTaskDueDate(task.due?.date);
      return dueDate ? dueDate >= today && dueDate <= end : false;
    });
  }

  if (lower.startsWith("@")) {
    const rawLabel = lower.slice(1).trim();
    return tasks.filter((task) =>
      task.labels.some((label) => {
        const normalizedLabel = label.toLowerCase().replace(/^@/, "");
        return normalizedLabel === rawLabel;
      })
    );
  }

  if (lower.startsWith("#")) {
    const token = lower.slice(1).trim();
    if (!token) return tasks;
    const projects = await getTodoistProjects(accessToken);
    const matchedProjectIds = new Set(
      projects
        .filter((project) => {
          const projectName = project.name.toLowerCase();
          const projectId = project.id.toLowerCase();
          return projectName === token || projectId === token;
        })
        .map((project) => project.id)
    );
    if (matchedProjectIds.size === 0) return [];
    return tasks.filter((task) => matchedProjectIds.has(task.projectId));
  }

  return tasks;
}

export async function getTodoistTasks(accessToken: string, filter?: string): Promise<TodoistTask[]> {
  const allTasks = await fetchAllTodoistTasks(accessToken);
  return applyFilter(accessToken, allTasks, filter);
}

export async function getTodoistProjects(accessToken: string): Promise<TodoistProject[]> {
  const response = await fetch(`${TODOIST_API_BASE}/projects`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Todoist API error: ${response.statusText}`);
  }

  const data = await response.json();
  return extractResults<any>(data).map(mapProject);
}

export async function createTodoistTask(
  accessToken: string,
  content: string,
  description?: string,
  projectId?: string,
  priority?: number,
  dueString?: string,
  dueDate?: string
): Promise<TodoistTask> {
  const response = await fetch(`${TODOIST_API_BASE}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      description,
      project_id: projectId,
      priority,
      due_string: dueString,
      due_date: dueDate,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Todoist API error: ${response.statusText}`);
  }

  const data = await response.json();
  if (data && typeof data === "object" && "task" in data) {
    return mapTask((data as any).task);
  }
  return mapTask(data);
}

export async function completeTodoistTask(accessToken: string, taskId: string): Promise<void> {
  const response = await fetch(`${TODOIST_API_BASE}/tasks/${taskId}/close`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Todoist API error: ${response.statusText}`);
  }
}

async function fetchCompletedFromByCompletionDate(
  accessToken: string,
  start: Date,
  end: Date
): Promise<Array<ReturnType<typeof mapCompletedTaskItem>>> {
  const all: Array<ReturnType<typeof mapCompletedTaskItem>> = [];
  let cursor: string | null = null;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({
      since: start.toISOString(),
      until: end.toISOString(),
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const response = await fetch(
      `${TODOIST_API_BASE}/tasks/completed/by_completion_date?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Todoist completed API error (${response.status}): ${body || response.statusText}`);
    }

    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : extractResults<any>(data);
    all.push(...items.map(mapCompletedTaskItem));

    const nextCursor =
      typeof data?.next_cursor === "string" && data.next_cursor.length > 0
        ? data.next_cursor
        : null;
    if (!nextCursor || items.length === 0) break;
    cursor = nextCursor;
  }

  return all;
}

async function fetchCompletedFromByDueDate(
  accessToken: string,
  start: Date,
  end: Date
): Promise<Array<ReturnType<typeof mapCompletedTaskItem>>> {
  const all: Array<ReturnType<typeof mapCompletedTaskItem>> = [];
  let cursor: string | null = null;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({
      since: start.toISOString(),
      until: end.toISOString(),
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const response = await fetch(
      `${TODOIST_API_BASE}/tasks/completed/by_due_date?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Todoist completed-by-due API error (${response.status}): ${body || response.statusText}`);
    }

    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : extractResults<any>(data);
    all.push(...items.map(mapCompletedTaskItem));

    const nextCursor =
      typeof data?.next_cursor === "string" && data.next_cursor.length > 0
        ? data.next_cursor
        : null;
    if (!nextCursor || items.length === 0) break;
    cursor = nextCursor;
  }

  return all;
}

async function fetchCompletedFromLegacySync(
  accessToken: string,
  start: Date,
  end: Date
): Promise<Array<ReturnType<typeof mapCompletedTaskItem>>> {
  const all: Array<ReturnType<typeof mapCompletedTaskItem>> = [];
  let offset = 0;

  for (let page = 0; page < 100; page += 1) {
    const params = new URLSearchParams({
      since: start.toISOString(),
      until: end.toISOString(),
      limit: "200",
      offset: String(offset),
    });
    const response = await fetch(
      `https://api.todoist.com/sync/v9/completed/get_all?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.timeout(15_000),
      }
    );

    if (!response.ok) {
      throw new Error(`Todoist completed API error: ${response.statusText}`);
    }

    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    all.push(...items.map(mapCompletedTaskItem));

    const hasMore = Boolean(data?.has_more);
    if (!hasMore || items.length === 0) break;
    offset += items.length;
  }

  return all;
}

function dedupeCompletedTasks(
  items: Array<ReturnType<typeof mapCompletedTaskItem>>,
  start: Date,
  end: Date,
  timezoneOffsetMinutes?: number
): TodoistCompletedTask[] {
  const byKey = new Map<string, TodoistCompletedTask>();

  for (const item of items) {
    let dateKey = toDateKeyAtOffset(start, timezoneOffsetMinutes);

    if (item.completedAt) {
      const completedDate = new Date(item.completedAt);
      if (!Number.isNaN(completedDate.getTime())) {
        if (completedDate < start || completedDate >= end) continue;
        dateKey = toDateKeyAtOffset(completedDate, timezoneOffsetMinutes);
      }
    }

    if (!byKey.has(item.completionKey)) {
      byKey.set(item.completionKey, {
        completionKey: item.completionKey,
        taskId: item.taskId,
        content: item.content,
        completedAt: item.completedAt,
        dateKey,
      });
    }
  }

  return Array.from(byKey.values()).sort((a, b) => {
    const left = a.completedAt ? Date.parse(a.completedAt) : 0;
    const right = b.completedAt ? Date.parse(b.completedAt) : 0;
    return left - right;
  });
}

export async function getTodoistCompletedTasks(
  accessToken: string,
  dateKey: string,
  timezoneOffsetMinutes?: number
): Promise<TodoistCompletedTask[]> {
  const { start, end } = toStartAndEnd(dateKey, timezoneOffsetMinutes);
  const fetchStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const fetchEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const [primary, byDueDate, legacy] = await Promise.allSettled([
    fetchCompletedFromByCompletionDate(accessToken, fetchStart, fetchEnd),
    fetchCompletedFromByDueDate(accessToken, fetchStart, fetchEnd),
    fetchCompletedFromLegacySync(accessToken, fetchStart, fetchEnd),
  ]);

  const merged: Array<ReturnType<typeof mapCompletedTaskItem>> = [];
  if (primary.status === "fulfilled") merged.push(...primary.value);
  if (byDueDate.status === "fulfilled") merged.push(...byDueDate.value);
  if (legacy.status === "fulfilled") merged.push(...legacy.value);

  if (merged.length > 0) {
    return dedupeCompletedTasks(merged, fetchStart, fetchEnd, timezoneOffsetMinutes).filter(
      (task) => task.dateKey === dateKey
    );
  }

  if (primary.status === "rejected") throw primary.reason;
  if (byDueDate.status === "rejected") throw byDueDate.reason;
  throw legacy.status === "rejected"
    ? legacy.reason
    : new Error("Failed to fetch Todoist completed tasks");
}

export async function getTodoistCompletedTasksInRange(
  accessToken: string,
  startDateKey: string,
  endDateKeyExclusive: string,
  timezoneOffsetMinutes?: number
): Promise<TodoistCompletedTask[]> {
  const { start } = toStartAndEnd(startDateKey, timezoneOffsetMinutes);
  const { start: end } = toStartAndEnd(endDateKeyExclusive, timezoneOffsetMinutes);
  if (end <= start) return [];

  const fetchStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const fetchEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);
  const [primary, byDueDate, legacy] = await Promise.allSettled([
    fetchCompletedFromByCompletionDate(accessToken, fetchStart, fetchEnd),
    fetchCompletedFromByDueDate(accessToken, fetchStart, fetchEnd),
    fetchCompletedFromLegacySync(accessToken, fetchStart, fetchEnd),
  ]);

  const merged: Array<ReturnType<typeof mapCompletedTaskItem>> = [];
  if (primary.status === "fulfilled") merged.push(...primary.value);
  if (byDueDate.status === "fulfilled") merged.push(...byDueDate.value);
  if (legacy.status === "fulfilled") merged.push(...legacy.value);

  if (merged.length > 0) {
    return dedupeCompletedTasks(merged, fetchStart, fetchEnd, timezoneOffsetMinutes).filter(
      (task) => task.dateKey >= startDateKey && task.dateKey < endDateKeyExclusive
    );
  }

  if (primary.status === "rejected") throw primary.reason;
  if (byDueDate.status === "rejected") throw byDueDate.reason;
  throw legacy.status === "rejected"
    ? legacy.reason
    : new Error("Failed to fetch Todoist completed tasks");
}

export async function getTodoistCompletedTaskCount(
  accessToken: string,
  dateKey: string,
  timezoneOffsetMinutes?: number
): Promise<number> {
  const { start, end } = toStartAndEnd(dateKey, timezoneOffsetMinutes);
  const fetchStart = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const fetchEnd = new Date(end.getTime() + 24 * 60 * 60 * 1000);

  const [primary, byDueDate, legacy] = await Promise.allSettled([
    fetchCompletedFromByCompletionDate(accessToken, fetchStart, fetchEnd),
    fetchCompletedFromByDueDate(accessToken, fetchStart, fetchEnd),
    fetchCompletedFromLegacySync(accessToken, fetchStart, fetchEnd),
  ]);

  const merged: Array<ReturnType<typeof mapCompletedTaskItem>> = [];
  if (primary.status === "fulfilled") merged.push(...primary.value);
  if (byDueDate.status === "fulfilled") merged.push(...byDueDate.value);
  if (legacy.status === "fulfilled") merged.push(...legacy.value);

  if (merged.length === 0) {
    if (primary.status === "rejected") throw primary.reason;
    if (byDueDate.status === "rejected") throw byDueDate.reason;
    if (legacy.status === "rejected") throw legacy.reason;
    return 0;
  }

  const countForSource = (items: Array<ReturnType<typeof mapCompletedTaskItem>>): number => {
    if (items.length === 0) return 0;
    const tasks = dedupeCompletedTasks(items, fetchStart, fetchEnd, timezoneOffsetMinutes);
    return tasks.filter((task) => task.dateKey === dateKey).length;
  };

  const mergedCount = countForSource(merged);
  const primaryCount = primary.status === "fulfilled" ? countForSource(primary.value) : 0;
  const byDueCount = byDueDate.status === "fulfilled" ? countForSource(byDueDate.value) : 0;
  const legacyCount = legacy.status === "fulfilled" ? countForSource(legacy.value) : 0;

  return Math.max(mergedCount, primaryCount, byDueCount, legacyCount);
}
