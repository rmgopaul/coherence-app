import {
  PERSONAL_DASHBOARD_RUNNER_VERSION,
  choosePersonalDashboardRightNow,
  makePersonalDashboardIntegrationHealth,
  type PersonalDashboardCommandCenter,
  type PersonalDashboardHealthStatus,
  type PersonalDashboardIntegrationHealth,
} from "@shared/personalDashboard";
import {
  getIntegrationByProvider,
  getLatestSamsungSyncPayload,
  getLatestUserInsight,
  getLatestWeeklyReview,
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
    integrations,
    dailyBrief: {
      status: "not_started",
      reason: "Daily Brief generation is not server-backed yet.",
    },
    todayPlan: {
      status: "local_only",
      reason: "Today's Plan overrides still persist in browser storage.",
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
    waitingOn: [] as unknown[],
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
  const sorted = [...tasks].sort((a, b) => {
    const aPriority = Number(a.priority ?? 1);
    const bPriority = Number(b.priority ?? 1);
    if (aPriority !== bPriority) return bPriority - aPriority;
    return dueTime(a) - dueTime(b);
  });
  const task = sorted[0];
  if (!task) return null;
  const id = String(task.id ?? "");
  return {
    id,
    title: String(task.content ?? "Untitled task"),
    url: task.url ?? (id ? `https://app.todoist.com/app/task/${id}` : null),
  };
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
