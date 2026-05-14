import {
  PERSONAL_DASHBOARD_RUNNER_VERSION,
  choosePersonalDashboardRightNow,
  makePersonalDashboardIntegrationHealth,
  type PersonalDashboardCommandCenter,
  type PersonalDashboardCommitment,
  type PersonalDashboardDailyState,
  type PersonalDashboardHealthStatus,
  type PersonalDashboardIntegrationHealth,
  type PersonalDashboardOutcome,
} from "@shared/personalDashboard";
import {
  getIntegrationByProvider,
  getLatestSamsungSyncPayload,
  getLatestUserInsight,
  getLatestWeeklyReview,
  getPersonalDashboardDailyState,
  listDockItems,
  listUpcomingDockItems,
} from "../../db";
import {
  getValidGoogleToken,
  getValidWhoopToken,
} from "../../helpers/tokenRefresh";
import { CLOCKIFY_PROVIDER } from "../../routers/helpers";
import {
  getGmailMessages,
  getGmailWaitingOn,
  getGoogleCalendarEvents,
} from "../integrations/google";
import {
  getTodoistCompletedTaskCount,
  getTodoistTasks,
} from "../integrations/todoist";
import { getWhoopSummary } from "../integrations/whoop";

type IntegrationRecord = Awaited<ReturnType<typeof getIntegrationByProvider>>;

type CalendarEventLike = {
  id?: string;
  summary?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string } | null;
  end?: { date?: string; dateTime?: string } | null;
};

type GmailMessageLike = {
  id?: string;
  threadId?: string;
  internalDate?: string | number;
  payload?: { headers?: Array<{ name?: string; value?: string }> };
};

type GmailWaitingOnLike = {
  id?: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  url?: string;
};

type TodoistTaskLike = {
  id?: string | number;
  content?: string;
  url?: string | null;
  priority?: number;
  due?: { date?: string; datetime?: string } | null;
};

export type GetPersonalDashboardCommandCenterInput = {
  userId: number;
  dateKey: string;
  timezoneOffsetMinutes?: number;
  now?: Date;
};

export async function getPersonalDashboardCommandCenter(
  input: GetPersonalDashboardCommandCenterInput
): Promise<PersonalDashboardCommandCenter> {
  const now = input.now ?? new Date();
  const [
    googleIntegration,
    todoistIntegration,
    clockifyIntegration,
    whoopIntegration,
    samsungIntegration,
    dockItems,
    upcomingDockItems,
    weeklyReview,
    latestInsight,
    samsungPayload,
    dailyState,
  ] = await Promise.all([
    getIntegrationByProvider(input.userId, "google"),
    getIntegrationByProvider(input.userId, "todoist"),
    getIntegrationByProvider(input.userId, CLOCKIFY_PROVIDER),
    getIntegrationByProvider(input.userId, "whoop"),
    getIntegrationByProvider(input.userId, "samsung-health"),
    listDockItems(input.userId, 50),
    listUpcomingDockItems(input.userId, {
      windowHours: 36,
      now,
      limit: 20,
    }),
    getLatestWeeklyReview(input.userId),
    getLatestUserInsight(input.userId),
    getLatestSamsungSyncPayload(input.userId),
    getPersonalDashboardDailyState(input.userId, input.dateKey),
  ]);

  const [todoist, google, whoop] = await Promise.all([
    loadTodoistSlice({
      integration: todoistIntegration,
      dateKey: input.dateKey,
      timezoneOffsetMinutes: input.timezoneOffsetMinutes,
    }),
    loadGoogleSlice({
      userId: input.userId,
      integration: googleIntegration,
      now,
    }),
    loadWhoopSlice(input.userId, whoopIntegration),
  ]);

  const integrations: PersonalDashboardIntegrationHealth[] = [
    integrationHealth(
      "google",
      googleIntegration,
      google.status,
      google.reason
    ),
    integrationHealth(
      "gmail",
      googleIntegration,
      google.gmailStatus,
      google.gmailReason
    ),
    integrationHealth(
      "calendar",
      googleIntegration,
      google.calendarStatus,
      google.calendarReason
    ),
    integrationHealth("drive", googleIntegration, google.status, google.reason),
    integrationHealth(
      "todoist",
      todoistIntegration,
      todoist.status,
      todoist.reason
    ),
    integrationHealth("clockify", clockifyIntegration),
    integrationHealth("whoop", whoopIntegration, whoop.status, whoop.reason),
    makePersonalDashboardIntegrationHealth({
      key: "samsungHealth",
      connected: Boolean(samsungIntegration || samsungPayload),
      status: samsungPayload
        ? "connected"
        : samsungIntegration
          ? "stale"
          : "missing",
      reason: samsungPayload
        ? null
        : samsungIntegration
          ? "No Samsung Health sync payload has been received yet."
          : "Samsung Health is not connected.",
      lastSeenAt:
        samsungPayload?.capturedAt ?? samsungIntegration?.updatedAt ?? null,
    }),
    makePersonalDashboardIntegrationHealth({
      key: "weather",
      connected: Boolean(process.env.OPENWEATHER_API_KEY?.trim()),
      status: process.env.OPENWEATHER_API_KEY?.trim() ? "connected" : "offline",
      reason: process.env.OPENWEATHER_API_KEY?.trim()
        ? null
        : "OPENWEATHER_API_KEY is not configured.",
    }),
    makePersonalDashboardIntegrationHealth({
      key: "news",
      connected: (process.env.NEWS_FEED_MODE ?? "merged").trim() !== "off",
      status:
        (process.env.NEWS_FEED_MODE ?? "merged").trim() === "off"
          ? "offline"
          : "connected",
      reason:
        (process.env.NEWS_FEED_MODE ?? "merged").trim() === "off"
          ? "NEWS_FEED_MODE is off."
          : null,
    }),
  ];

  const rightNow = choosePersonalDashboardRightNow({
    priorityTask: topTodoistTask(todoist.tasks),
    nextMeeting: nextCalendarEvent(google.calendarEvents, now),
    urgentEmail: topGmailMessage(google.gmailMessages),
  });
  const dailyWorkflow = buildPersonalDashboardWorkflowSuggestions({
    dateKey: input.dateKey,
    rightNow,
    tasks: todoist.tasks,
    waitingOn: google.waitingOn,
    now,
  });
  const dailyProgress = buildPersonalDashboardDailyProgress(dailyState);

  return {
    _runnerVersion: PERSONAL_DASHBOARD_RUNNER_VERSION,
    generatedAt: now.toISOString(),
    dateKey: input.dateKey,
    userId: input.userId,
    metrics: {
      tasksDueToday: todoist.tasks.length,
      tasksCompletedToday: todoist.completedCount,
      meetingsRemaining: remainingMeetingCount(google.calendarEvents, now),
      inboxToTriage: google.gmailMessages.length,
      waitingOnCount: google.waitingOn.length,
      dockReminderCount: upcomingDockItems.length,
      activeDockCount: dockItems.length,
    },
    rightNow,
    dailyWorkflow,
    dailyProgress,
    integrations,
    dailyBrief: {
      status:
        dailyState.dailyBriefStatus === "ready" ? "ready" : "server_ready",
      reason:
        dailyState.dailyBriefStatus === "ready"
          ? "Daily Brief is saved for today."
          : "Daily Brief can now persist on the server; none is saved for today.",
    },
    todayPlan: {
      status:
        dailyState.todayPlanStatus === "ready" ||
        dailyState.todayPlanStatus === "completed"
          ? "ready"
          : "server_ready",
      reason:
        dailyState.todayPlanStatus === "ready" ||
        dailyState.todayPlanStatus === "completed"
          ? "Today Plan is saved for today."
          : "Today Plan can now persist on the server; none is saved for today.",
    },
    weeklyReview: {
      headline: weeklyReview?.headline ?? null,
      weekKey: weeklyReview?.weekKey ?? null,
      status: weeklyReview?.status ?? null,
      generatedAt: toIso(weeklyReview?.generatedAt),
    },
    insight: {
      status: latestInsight?.status ?? null,
      generatedAt: toIso(latestInsight?.generatedAt),
    },
    sourceFreshness: [
      {
        source: "todoist",
        status: todoist.status,
        fetchedAt: todoist.fetchedAt,
        detail: todoist.reason,
      },
      {
        source: "calendar",
        status: google.calendarStatus,
        fetchedAt: google.calendarFetchedAt,
        detail: google.calendarReason,
      },
      {
        source: "gmail",
        status: google.gmailStatus,
        fetchedAt: google.gmailFetchedAt,
        detail: google.gmailReason,
      },
      {
        source: "health",
        status: whoop.status,
        fetchedAt: whoop.fetchedAt,
        detail: whoop.reason,
      },
      {
        source: "dock",
        status: "connected",
        fetchedAt: now.toISOString(),
        detail: `${dockItems.length} active dock item(s).`,
      },
    ],
  };
}

function integrationHealth(
  key: Parameters<typeof makePersonalDashboardIntegrationHealth>[0]["key"],
  integration: IntegrationRecord,
  status?: PersonalDashboardHealthStatus,
  reason?: string | null
): PersonalDashboardIntegrationHealth {
  return makePersonalDashboardIntegrationHealth({
    key,
    connected: Boolean(integration?.accessToken),
    status,
    reason,
    lastSeenAt: integration?.updatedAt ?? integration?.createdAt ?? null,
  });
}

async function loadTodoistSlice(args: {
  integration: IntegrationRecord;
  dateKey: string;
  timezoneOffsetMinutes?: number;
}) {
  const fetchedAt = new Date().toISOString();
  if (!args.integration?.accessToken) {
    return {
      tasks: [] as TodoistTaskLike[],
      completedCount: 0,
      status: "missing" as const,
      reason: "Todoist is not connected.",
      fetchedAt: null,
    };
  }

  try {
    const [tasks, completedCount] = await Promise.all([
      getTodoistTasks(args.integration.accessToken, "today") as Promise<
        TodoistTaskLike[]
      >,
      getTodoistCompletedTaskCount(
        args.integration.accessToken,
        args.dateKey,
        args.timezoneOffsetMinutes
      ),
    ]);
    return {
      tasks,
      completedCount,
      status: "connected" as const,
      reason: null,
      fetchedAt,
    };
  } catch (error) {
    return {
      tasks: [] as TodoistTaskLike[],
      completedCount: 0,
      status: classifyFetchError(error),
      reason: errorMessage(error),
      fetchedAt,
    };
  }
}

async function loadGoogleSlice(args: {
  userId: number;
  integration: IntegrationRecord;
  now: Date;
}) {
  const fetchedAt = new Date().toISOString();
  const empty = {
    status: "missing" as PersonalDashboardHealthStatus,
    reason: "Google is not connected.",
    calendarEvents: [] as CalendarEventLike[],
    gmailMessages: [] as GmailMessageLike[],
    waitingOn: [] as GmailWaitingOnLike[],
    calendarStatus: "missing" as PersonalDashboardHealthStatus,
    calendarReason: "Google is not connected.",
    calendarFetchedAt: null as string | null,
    gmailStatus: "missing" as PersonalDashboardHealthStatus,
    gmailReason: "Google is not connected.",
    gmailFetchedAt: null as string | null,
  };

  if (!args.integration?.accessToken) return empty;

  let token: string;
  try {
    token = await getValidGoogleToken(args.userId);
  } catch (error) {
    const status = classifyFetchError(error);
    const reason = errorMessage(error);
    return {
      ...empty,
      status,
      reason,
      calendarStatus: status,
      calendarReason: reason,
      gmailStatus: status,
      gmailReason: reason,
    };
  }

  const end = new Date(args.now.getTime() + 24 * 60 * 60 * 1000);
  const [calendarResult, gmailResult, waitingOnResult] =
    await Promise.allSettled([
      getGoogleCalendarEvents(token, {
        startIso: args.now.toISOString(),
        endIso: end.toISOString(),
        maxResults: 50,
      }) as Promise<CalendarEventLike[]>,
      getGmailMessages(token, 50) as Promise<GmailMessageLike[]>,
      getGmailWaitingOn(token, 25),
    ]);

  const calendarOk = calendarResult.status === "fulfilled";
  const gmailOk = gmailResult.status === "fulfilled";
  const waitingOk = waitingOnResult.status === "fulfilled";
  const gmailStatus =
    gmailOk && waitingOk
      ? "connected"
      : classifyFetchError(
          gmailResult.status === "rejected"
            ? gmailResult.reason
            : waitingOnResult.status === "rejected"
              ? waitingOnResult.reason
              : null
        );

  return {
    status:
      calendarOk || gmailOk || waitingOk
        ? ("connected" as const)
        : ("failing" as const),
    reason:
      calendarOk || gmailOk || waitingOk
        ? null
        : "Google sources failed to load.",
    calendarEvents: calendarOk ? calendarResult.value : [],
    gmailMessages: gmailOk ? gmailResult.value : [],
    waitingOn: waitingOk ? waitingOnResult.value : [],
    calendarStatus: calendarOk
      ? ("connected" as const)
      : classifyFetchError(calendarResult.reason),
    calendarReason: calendarOk ? null : errorMessage(calendarResult.reason),
    calendarFetchedAt: fetchedAt,
    gmailStatus,
    gmailReason:
      gmailOk && waitingOk
        ? null
        : errorMessage(
            gmailResult.status === "rejected"
              ? gmailResult.reason
              : waitingOnResult.status === "rejected"
                ? waitingOnResult.reason
                : null
          ),
    gmailFetchedAt: fetchedAt,
  };
}

export function buildPersonalDashboardWorkflowSuggestions(input: {
  dateKey: string;
  rightNow: PersonalDashboardCommandCenter["rightNow"];
  tasks: TodoistTaskLike[];
  waitingOn: GmailWaitingOnLike[];
  now: Date;
}): PersonalDashboardCommandCenter["dailyWorkflow"] {
  const waitingCommitments = dedupeById<PersonalDashboardCommitment>(
    input.waitingOn.map((item, index) => {
      const sourceId = gmailSourceId(item);
      const subject = normalizeText(item.subject) ?? "Waiting-on thread";
      const fallbackUrl = sourceId
        ? `https://mail.google.com/mail/u/0/#inbox/${sourceId}`
        : null;
      return {
        id: `waiting-on:${sourceId ?? `${input.dateKey}:${index}`}`,
        title: `Follow up: ${subject}`,
        source: "gmail" as const,
        sourceId,
        owner: normalizePerson(item.to) ?? normalizePerson(item.from),
        dueAt: null,
        status: "waiting" as const,
        url: normalizeUrl(item.url) ?? fallbackUrl,
      };
    })
  ).slice(0, 3);

  const rightNowCommitment: PersonalDashboardCommitment[] = input.rightNow
    ? [
        {
          id: `right-now:${input.rightNow.kind}:${
            input.rightNow.sourceId ?? input.dateKey
          }`,
          title: input.rightNow.title,
          source: input.rightNow.kind,
          sourceId: input.rightNow.sourceId,
          owner: null,
          dueAt: null,
          status:
            input.rightNow.kind === "gmail"
              ? ("waiting" as const)
              : ("open" as const),
          url: normalizeUrl(input.rightNow.sourceUrl),
        },
      ]
    : [];

  const suggestedCommitments = dedupeById([
    ...waitingCommitments,
    ...rightNowCommitment,
  ]).slice(0, 5);

  const suggestedOutcomes = dedupeById<PersonalDashboardOutcome>(
    sortedTasks(input.tasks)
      .map((task, index) => ({
        id: `task-outcome:${taskSourceId(task, index)}`,
        title: taskTitle(task, `Outcome ${index + 1}`),
        status: "active" as const,
        metricLabel: "Task",
        target: "Complete today",
        current: null,
      }))
  ).slice(0, 3);

  if (suggestedOutcomes.length === 0) {
    suggestedOutcomes.push({
      id: `fallback-outcome:${input.dateKey}:${input.now.getTime()}`,
      title:
        input.rightNow?.title ?? "Define one meaningful outcome for today",
      status: "active",
      metricLabel: "Progress",
      target: "Done today",
      current: null,
    });
  }

  return {
    suggestedCommitments,
    suggestedOutcomes: suggestedOutcomes.slice(0, 5),
  };
}

export function buildPersonalDashboardDailyProgress(
  state: Pick<
    PersonalDashboardDailyState,
    | "dailyBriefStatus"
    | "dailyBrief"
    | "todayPlanStatus"
    | "todayPlan"
    | "commitments"
    | "outcomes"
    | "updatedAt"
  >
): PersonalDashboardCommandCenter["dailyProgress"] {
  const commitments = {
    total: state.commitments.length,
    open: countByStatus(state.commitments, "open"),
    waiting: countByStatus(state.commitments, "waiting"),
    blocked: countByStatus(state.commitments, "blocked"),
    done: countByStatus(state.commitments, "done"),
  };
  const outcomes = {
    total: state.outcomes.length,
    active: countByStatus(state.outcomes, "active"),
    paused: countByStatus(state.outcomes, "paused"),
    won: countByStatus(state.outcomes, "won"),
    missed: countByStatus(state.outcomes, "missed"),
  };

  const hasWorkflow =
    state.dailyBriefStatus !== "not_started" ||
    state.todayPlanStatus !== "not_started" ||
    Boolean(state.dailyBrief?.headline?.trim()) ||
    Boolean(state.todayPlan?.topPriority?.trim()) ||
    commitments.total > 0 ||
    outcomes.total > 0;
  const hasAttention =
    state.dailyBriefStatus === "failed" ||
    commitments.blocked > 0 ||
    outcomes.missed > 0;
  const isComplete =
    hasWorkflow &&
    state.todayPlanStatus === "completed" &&
    commitments.open === 0 &&
    commitments.waiting === 0 &&
    commitments.blocked === 0 &&
    outcomes.active === 0 &&
    outcomes.paused === 0;

  return {
    dailyBriefStatus: state.dailyBriefStatus,
    todayPlanStatus: state.todayPlanStatus,
    headline: normalizeText(state.dailyBrief?.headline),
    topPriority: normalizeText(state.todayPlan?.topPriority),
    updatedAt: state.updatedAt,
    commitments,
    outcomes,
    tone: !hasWorkflow
      ? "empty"
      : hasAttention
        ? "attention"
        : isComplete
          ? "complete"
          : "planned",
  };
}

async function loadWhoopSlice(userId: number, integration: IntegrationRecord) {
  const fetchedAt = new Date().toISOString();
  if (!integration?.accessToken) {
    return {
      status: "missing" as const,
      reason: "WHOOP is not connected.",
      fetchedAt: null,
    };
  }
  try {
    const token = await getValidWhoopToken(userId);
    await getWhoopSummary(token);
    return {
      status: "connected" as const,
      reason: null,
      fetchedAt,
    };
  } catch (error) {
    return {
      status: classifyFetchError(error),
      reason: errorMessage(error),
      fetchedAt,
    };
  }
}

function remainingMeetingCount(events: CalendarEventLike[], now: Date): number {
  return events.filter(event => {
    const endRaw = event.end?.dateTime ?? event.end?.date;
    const startRaw = event.start?.dateTime ?? event.start?.date;
    const value = endRaw ?? startRaw;
    if (!value) return false;
    const time = new Date(value).getTime();
    return Number.isFinite(time) && time >= now.getTime();
  }).length;
}

function topTodoistTask(tasks: TodoistTaskLike[]) {
  const sorted = sortedTasks(tasks);
  const task = sorted[0];
  if (!task) return null;
  const id = taskSourceId(task, "");
  return {
    id,
    title: taskTitle(task, "Untitled task"),
    url:
      normalizeUrl(task.url) ??
      (id ? `https://app.todoist.com/app/task/${id}` : null),
  };
}

function sortedTasks(tasks: TodoistTaskLike[]): TodoistTaskLike[] {
  return [...tasks].sort((a, b) => {
    const aPriority = Number(a.priority ?? 1);
    const bPriority = Number(b.priority ?? 1);
    if (aPriority !== bPriority) return bPriority - aPriority;
    return dueTime(a) - dueTime(b);
  });
}

function nextCalendarEvent(events: CalendarEventLike[], now: Date) {
  const sorted = events
    .map(event => {
      const startRaw = event.start?.dateTime ?? event.start?.date;
      const startMs = startRaw ? new Date(startRaw).getTime() : NaN;
      return { event, startMs };
    })
    .filter(
      ({ startMs }) => Number.isFinite(startMs) && startMs >= now.getTime()
    )
    .sort((a, b) => a.startMs - b.startMs);
  const event = sorted[0]?.event;
  if (!event) return null;
  return {
    id: String(event.id ?? ""),
    title: String(event.summary ?? "Untitled event"),
    url: event.htmlLink ?? null,
  };
}

function topGmailMessage(messages: GmailMessageLike[]) {
  const message = messages[0];
  if (!message) return null;
  const id = String(message.threadId ?? message.id ?? "");
  return {
    id,
    title: getGmailHeader(message, "Subject") || "Important unread email",
    url: id ? `https://mail.google.com/mail/u/0/#inbox/${id}` : null,
  };
}

function getGmailHeader(message: GmailMessageLike, name: string): string {
  const headers = Array.isArray(message.payload?.headers)
    ? message.payload.headers
    : [];
  const found = headers.find(
    header => String(header.name ?? "").toLowerCase() === name.toLowerCase()
  );
  return String(found?.value ?? "");
}

function dueTime(task: TodoistTaskLike): number {
  const raw = task.due?.datetime ?? task.due?.date;
  if (!raw) return Number.POSITIVE_INFINITY;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function classifyFetchError(error: unknown): PersonalDashboardHealthStatus {
  const message = errorMessage(error)?.toLowerCase() ?? "";
  if (message.includes("429") || message.includes("rate"))
    return "rate_limited";
  if (message.includes("not connected")) return "missing";
  return "failing";
}

function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeUrl(value: string | null | undefined): string | null {
  const trimmed = normalizeText(value);
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

function gmailSourceId(item: GmailWaitingOnLike): string | null {
  const value = normalizeText(item.threadId) ?? normalizeText(item.id);
  return value ?? null;
}

function taskTitle(task: TodoistTaskLike, fallback: string): string {
  return normalizeText(task.content) ?? fallback;
}

function taskSourceId(task: TodoistTaskLike, fallback: string | number): string {
  return normalizeText(task.id) ?? String(fallback);
}

function countByStatus<T extends { status: string }>(
  items: T[],
  status: T["status"]
): number {
  return items.filter((item) => item.status === status).length;
}

function normalizeText(value: string | number | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed ? trimmed : null;
}

function normalizePerson(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of items) {
    if (!item.id || byId.has(item.id)) continue;
    byId.set(item.id, item);
  }
  return Array.from(byId.values());
}
