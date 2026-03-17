export type ClockifyUser = {
  id: string;
  name: string;
  email: string | null;
  activeWorkspaceId: string | null;
  defaultWorkspaceId: string | null;
};

export type ClockifyWorkspace = {
  id: string;
  name: string;
};

export type ClockifyTimeEntry = {
  id: string;
  description: string;
  projectId: string | null;
  projectName: string | null;
  taskId: string | null;
  start: string | null;
  end: string | null;
  duration: string | null;
  durationSeconds: number | null;
  isRunning: boolean;
  tagIds: string[];
};

export type StartClockifyTimeEntryInput = {
  description: string;
  projectId?: string | null;
};

const CLOCKIFY_API_BASE = "https://api.clockify.me/api/v1";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseIsoDurationToSeconds(value: string | null): number | null {
  if (!value) return null;

  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(value);
  if (!match) return null;

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = match[3] ? Number(match[3]) : 0;

  if (![hours, minutes, seconds].every(Number.isFinite)) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

function computeFallbackDurationSeconds(startIso: string | null, endIso: string | null): number | null {
  if (!startIso) return null;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return null;

  const endMs = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(endMs)) return null;

  return Math.max(0, Math.round((endMs - startMs) / 1000));
}

function mapClockifyUser(payload: unknown): ClockifyUser {
  const record = asRecord(payload);
  return {
    id: toNonEmptyString(record.id) ?? "",
    name: toNonEmptyString(record.name) ?? "",
    email: toNonEmptyString(record.email),
    activeWorkspaceId: toNonEmptyString(record.activeWorkspace),
    defaultWorkspaceId: toNonEmptyString(record.defaultWorkspace),
  };
}

function mapClockifyWorkspace(payload: unknown): ClockifyWorkspace {
  const record = asRecord(payload);
  return {
    id: toNonEmptyString(record.id) ?? "",
    name: toNonEmptyString(record.name) ?? "Untitled Workspace",
  };
}

function mapClockifyTimeEntry(payload: unknown): ClockifyTimeEntry {
  const record = asRecord(payload);
  const timeInterval = asRecord(record.timeInterval);
  const project = asRecord(record.project);

  const start = toNonEmptyString(timeInterval.start);
  const end = toNonEmptyString(timeInterval.end);
  const duration = toNonEmptyString(timeInterval.duration);
  const durationSeconds =
    parseIsoDurationToSeconds(duration) ?? computeFallbackDurationSeconds(start, end);

  const rawTagIds = Array.isArray(record.tagIds) ? record.tagIds : [];
  const tagIds = rawTagIds
    .map((value) => toNonEmptyString(value))
    .filter((value): value is string => Boolean(value));

  return {
    id: toNonEmptyString(record.id) ?? "",
    description: toNonEmptyString(record.description) ?? "",
    projectId: toNonEmptyString(record.projectId),
    projectName: toNonEmptyString(project.name),
    taskId: toNonEmptyString(record.taskId),
    start,
    end,
    duration,
    durationSeconds,
    isRunning: !end,
    tagIds,
  };
}

async function clockifyFetch<T>(
  apiKey: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const url = path.startsWith("http")
    ? path
    : `${CLOCKIFY_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;

  const headers = new Headers(init?.headers);
  headers.set("X-Api-Key", apiKey.trim());
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers,
  });

  const text = await response.text().catch(() => "");

  if (!response.ok) {
    throw new Error(
      `Clockify API request failed (${response.status} ${response.statusText})${
        text ? `: ${text}` : ""
      }`
    );
  }

  if (!text.trim()) {
    return undefined as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Clockify API returned a non-JSON response.");
  }
}

export async function getClockifyCurrentUser(apiKey: string): Promise<ClockifyUser> {
  const payload = await clockifyFetch<unknown>(apiKey, "/user");
  const user = mapClockifyUser(payload);
  if (!user.id) {
    throw new Error("Clockify returned an invalid user payload.");
  }
  return user;
}

export async function listClockifyWorkspaces(apiKey: string): Promise<ClockifyWorkspace[]> {
  const payload = await clockifyFetch<unknown>(apiKey, "/workspaces");
  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map(mapClockifyWorkspace)
    .filter((workspace) => workspace.id.length > 0);
}

export async function getClockifyInProgressTimeEntry(
  apiKey: string,
  workspaceId: string,
  userId: string
): Promise<ClockifyTimeEntry | null> {
  const params = new URLSearchParams({
    "in-progress": "true",
    "page-size": "1",
    page: "1",
    hydrated: "true",
  });

  const payload = await clockifyFetch<unknown>(
    apiKey,
    `/workspaces/${encodeURIComponent(workspaceId)}/user/${encodeURIComponent(userId)}/time-entries?${params.toString()}`
  );

  const rows = Array.isArray(payload) ? payload : [];
  if (rows.length === 0) return null;
  return mapClockifyTimeEntry(rows[0]);
}

export async function getClockifyRecentTimeEntries(
  apiKey: string,
  workspaceId: string,
  userId: string,
  limit = 20
): Promise<ClockifyTimeEntry[]> {
  const pageSize = Math.max(1, Math.min(100, Math.trunc(limit)));
  const params = new URLSearchParams({
    "page-size": String(pageSize),
    page: "1",
    hydrated: "true",
  });

  const payload = await clockifyFetch<unknown>(
    apiKey,
    `/workspaces/${encodeURIComponent(workspaceId)}/user/${encodeURIComponent(userId)}/time-entries?${params.toString()}`
  );

  const rows = Array.isArray(payload) ? payload : [];
  return rows
    .map(mapClockifyTimeEntry)
    .filter((entry) => entry.id.length > 0)
    .sort((a, b) => {
      const aMs = a.start ? Date.parse(a.start) : 0;
      const bMs = b.start ? Date.parse(b.start) : 0;
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });
}

export async function startClockifyTimeEntry(
  apiKey: string,
  workspaceId: string,
  input: StartClockifyTimeEntryInput
): Promise<ClockifyTimeEntry> {
  const description = input.description.trim();
  if (!description) {
    throw new Error("Clockify time entry description is required.");
  }

  const payload = await clockifyFetch<unknown>(
    apiKey,
    `/workspaces/${encodeURIComponent(workspaceId)}/time-entries`,
    {
      method: "POST",
      body: JSON.stringify({
        description,
        start: new Date().toISOString(),
        billable: false,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    }
  );

  const mapped = mapClockifyTimeEntry(payload);
  if (!mapped.id) {
    throw new Error("Clockify did not return a valid time entry.");
  }
  return mapped;
}

export async function stopClockifyInProgressTimeEntry(
  apiKey: string,
  workspaceId: string,
  userId: string
): Promise<ClockifyTimeEntry | null> {
  const runningEntry = await getClockifyInProgressTimeEntry(apiKey, workspaceId, userId);
  if (!runningEntry) return null;

  const payload = await clockifyFetch<unknown>(
    apiKey,
    `/workspaces/${encodeURIComponent(workspaceId)}/user/${encodeURIComponent(userId)}/time-entries`,
    {
      method: "PATCH",
      body: JSON.stringify({
        end: new Date().toISOString(),
      }),
    }
  );

  const stoppedEntry = mapClockifyTimeEntry(payload);
  if (!stoppedEntry.id) {
    return {
      ...runningEntry,
      end: new Date().toISOString(),
      isRunning: false,
      durationSeconds:
        computeFallbackDurationSeconds(runningEntry.start, new Date().toISOString()) ??
        runningEntry.durationSeconds,
    };
  }

  return stoppedEntry;
}
