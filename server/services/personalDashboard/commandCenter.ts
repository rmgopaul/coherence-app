import {
  PERSONAL_DASHBOARD_RUNNER_VERSION,
  choosePersonalDashboardRightNow,
  makePersonalDashboardIntegrationHealth,
  type PersonalDashboardCommandCenter,
  type PersonalDashboardCommitment,
  type PersonalDashboardDailyState,
  type PersonalDashboardHealthStatus,
  type PersonalDashboardIntegrationHealth,
  type PersonalDashboardMetricSummary,
  type PersonalDashboardOutcome,
  type PersonalDashboardPlanBlock,
  type PersonalDashboardTodayOps,
  type PersonalDashboardTodayOpsCard,
  type PersonalDashboardWorkspacePrompt,
} from "@shared/personalDashboard";
import { countNoteLinksByExternalIds } from "../../db/notes";
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

type WorkspacePromptCounts = {
  todoist: Record<string, number>;
  calendar: Record<string, number>;
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
  const workspacePromptCandidates = buildWorkspacePromptCandidates({
    rightNow,
    tasks: todoist.tasks,
    calendarEvents: google.calendarEvents,
    now,
  });
  const [todoistWorkspaceCounts, calendarWorkspaceCounts] = await Promise.all([
    countNoteLinksByExternalIds(
      input.userId,
      "todoist_task",
      workspacePromptCandidates
        .filter(prompt => prompt.kind === "todoist")
        .map(prompt => prompt.sourceId)
    ),
    countNoteLinksByExternalIds(
      input.userId,
      "google_calendar_event",
      workspacePromptCandidates
        .filter(prompt => prompt.kind === "calendar")
        .map(prompt => prompt.sourceId)
    ),
  ]);
  const workspacePrompts = filterWorkspacePromptsWithoutNotes(
    workspacePromptCandidates,
    {
      todoist: todoistWorkspaceCounts,
      calendar: calendarWorkspaceCounts,
    }
  );
  const dailyProgress = buildPersonalDashboardDailyProgress(dailyState);
  const todayOps = buildPersonalDashboardTodayOps({
    dateKey: input.dateKey,
    now,
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
    tasks: todoist.tasks,
    waitingOn: google.waitingOn,
    workspacePrompts,
    dailyState,
    dailyProgress,
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
    dailyWorkflow,
    dailyProgress,
    todayOps,
    workspacePrompts,
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
    sortedTasks(input.tasks).map((task, index) => ({
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
      title: input.rightNow?.title ?? "Define one meaningful outcome for today",
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

export function buildPersonalDashboardTodayOps(input: {
  dateKey: string;
  now: Date;
  metrics: PersonalDashboardMetricSummary;
  rightNow: PersonalDashboardCommandCenter["rightNow"];
  tasks: TodoistTaskLike[];
  waitingOn: GmailWaitingOnLike[];
  workspacePrompts: PersonalDashboardWorkspacePrompt[];
  dailyState: PersonalDashboardDailyState;
  dailyProgress: PersonalDashboardCommandCenter["dailyProgress"];
}): PersonalDashboardTodayOps {
  const cards: Omit<PersonalDashboardTodayOpsCard, "rank">[] = [];
  const seenTargets = new Set<string>();
  const addCard = (card: Omit<PersonalDashboardTodayOpsCard, "rank">) => {
    if (cards.length >= 6) return;
    const targetKey = `${card.source}:${card.sourceId ?? card.relatedId ?? card.title}`;
    if (seenTargets.has(targetKey)) return;
    seenTargets.add(targetKey);
    cards.push(card);
  };

  if (input.rightNow) {
    addCard({
      id: `right-now:${input.rightNow.kind}:${input.rightNow.sourceId ?? input.dateKey}`,
      kind: "right_now",
      title: input.rightNow.title,
      reason: input.rightNow.reason,
      source: input.rightNow.kind,
      sourceId: input.rightNow.sourceId,
      sourceUrl: normalizeUrl(input.rightNow.sourceUrl),
      status: "current",
      primaryAction: normalizeUrl(input.rightNow.sourceUrl)
        ? "open_source"
        : "add_to_plan",
      workspaceTarget: workspaceTargetFromRightNow(input.rightNow),
      relatedId: input.rightNow.sourceId,
    });
  }

  const nextMeetingPrompt = input.workspacePrompts.find(
    prompt => prompt.kind === "calendar"
  );
  if (nextMeetingPrompt) {
    addCard({
      id: `workspace:${nextMeetingPrompt.kind}:${nextMeetingPrompt.sourceId}`,
      kind: "workspace_prompt",
      title: nextMeetingPrompt.title,
      reason: nextMeetingPrompt.reason,
      source: "calendar",
      sourceId: nextMeetingPrompt.sourceId,
      sourceUrl: normalizeUrl(nextMeetingPrompt.sourceUrl),
      status: "needs workspace",
      primaryAction: "create_workspace_note",
      workspaceTarget: workspaceTargetFromPrompt(nextMeetingPrompt),
      relatedId: nextMeetingPrompt.sourceId,
    });
  }

  input.waitingOn.slice(0, 3).forEach((item, index) => {
    const sourceId = gmailSourceId(item);
    const subject = normalizeText(item.subject) ?? "Waiting-on thread";
    const fallbackUrl = sourceId
      ? `https://mail.google.com/mail/u/0/#inbox/${sourceId}`
      : null;
    const url = normalizeUrl(item.url) ?? fallbackUrl;
    addCard({
      id: `waiting-on:${sourceId ?? `${input.dateKey}:${index}`}`,
      kind: "waiting_on",
      title: `Follow up: ${subject}`,
      reason:
        normalizePerson(item.to) || normalizePerson(item.from)
          ? `Waiting on ${normalizePerson(item.to) ?? normalizePerson(item.from)}.`
          : "Waiting-on Gmail thread needs a decision.",
      source: "gmail",
      sourceId,
      sourceUrl: url,
      status: "waiting",
      primaryAction: url ? "open_source" : "add_to_plan",
      workspaceTarget: null,
      relatedId: sourceId,
    });
  });

  sortedTasks(input.tasks)
    .filter(task => Number(task.priority ?? 1) >= 3)
    .forEach((task, index) => {
      const sourceId = taskSourceId(task, index);
      const url =
        normalizeUrl(task.url) ??
        `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`;
      addCard({
        id: `todoist:${sourceId}`,
        kind: "todoist",
        title: taskTitle(task, `Task ${index + 1}`),
        reason: `Priority ${Number(task.priority ?? 1)} Todoist task due today.`,
        source: "todoist",
        sourceId,
        sourceUrl: url,
        status: "open",
        primaryAction: "open_source",
        workspaceTarget: {
          kind: "todoist",
          taskId: sourceId,
          title: taskTitle(task, `Task ${index + 1}`),
          url,
        },
        relatedId: sourceId,
      });
    });

  for (const commitment of input.dailyState.commitments) {
    if (commitment.status === "done") continue;
    addCard({
      id: `saved-commitment:${commitment.id}`,
      kind: "saved_commitment",
      title: commitment.title,
      reason: "Saved commitment still needs closure.",
      source: commitment.source,
      sourceId: commitment.sourceId,
      sourceUrl: sourceUrlFromCommitment(commitment),
      status: commitment.status,
      primaryAction: "mark_done_local",
      workspaceTarget: workspaceTargetFromCommitment(commitment),
      relatedId: commitment.id,
    });
  }

  for (const outcome of input.dailyState.outcomes) {
    if (outcome.status === "won" || outcome.status === "missed") continue;
    addCard({
      id: `saved-outcome:${outcome.id}`,
      kind: "saved_outcome",
      title: outcome.title,
      reason: "Saved outcome is still active.",
      source: "today_plan",
      sourceId: outcome.id,
      sourceUrl: null,
      status: outcome.status,
      primaryAction: "mark_done_local",
      workspaceTarget: null,
      relatedId: outcome.id,
    });
  }

  for (const block of input.dailyState.todayPlan?.blocks ?? []) {
    if (block.status === "done" || block.status === "skipped") continue;
    addCard({
      id: `saved-plan-block:${block.id}`,
      kind: "saved_plan_block",
      title: block.title,
      reason: "Saved plan block is still open.",
      source: block.source,
      sourceId: block.sourceId,
      sourceUrl: sourceUrlFromPlanBlock(block),
      status: block.status,
      primaryAction: "mark_done_local",
      workspaceTarget: workspaceTargetFromPlanBlock(block),
      relatedId: block.id,
    });
  }

  const rankedCards = cards.map((card, index) => ({
    ...card,
    rank: index + 1,
  }));

  return {
    autoBrief: buildTodayOpsAutoBrief({
      metrics: input.metrics,
      rightNow: input.rightNow,
      cards: rankedCards,
      now: input.now,
    }),
    cards: rankedCards,
    progress: input.dailyProgress,
  };
}

function workspaceTargetFromRightNow(
  rightNow: NonNullable<PersonalDashboardCommandCenter["rightNow"]>
): PersonalDashboardTodayOpsCard["workspaceTarget"] {
  const sourceId = normalizeText(rightNow.sourceId);
  if (!sourceId) return null;
  if (rightNow.kind === "todoist") {
    return {
      kind: "todoist",
      taskId: sourceId,
      title: rightNow.title,
      url:
        normalizeUrl(rightNow.sourceUrl) ??
        `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`,
    };
  }
  if (rightNow.kind === "calendar") {
    return {
      kind: "calendar",
      eventId: sourceId,
      title: rightNow.title,
      url: normalizeUrl(rightNow.sourceUrl),
      startIso: null,
    };
  }
  return null;
}

function workspaceTargetFromPrompt(
  prompt: PersonalDashboardWorkspacePrompt
): PersonalDashboardTodayOpsCard["workspaceTarget"] {
  if (prompt.kind === "todoist") {
    return {
      kind: "todoist",
      taskId: prompt.sourceId,
      title: prompt.title,
      url:
        normalizeUrl(prompt.sourceUrl) ??
        `https://app.todoist.com/app/task/${encodeURIComponent(prompt.sourceId)}`,
    };
  }

  return {
    kind: "calendar",
    eventId: prompt.sourceId,
    title: prompt.title,
    url: normalizeUrl(prompt.sourceUrl),
    startIso: null,
  };
}

function workspaceTargetFromCommitment(
  commitment: PersonalDashboardCommitment
): PersonalDashboardTodayOpsCard["workspaceTarget"] {
  const sourceId = normalizeText(commitment.sourceId);
  if (!sourceId) return null;
  if (commitment.source === "todoist") {
    return {
      kind: "todoist",
      taskId: sourceId,
      title: commitment.title,
      url:
        normalizeUrl(commitment.url) ??
        `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`,
    };
  }
  if (commitment.source === "calendar") {
    return {
      kind: "calendar",
      eventId: sourceId,
      title: commitment.title,
      url: normalizeUrl(commitment.url),
      startIso: commitment.dueAt,
    };
  }
  return null;
}

function sourceUrlFromCommitment(
  commitment: PersonalDashboardCommitment
): string | null {
  const explicitUrl = normalizeUrl(commitment.url);
  if (explicitUrl) return explicitUrl;
  const sourceId = normalizeText(commitment.sourceId);
  if (!sourceId) return null;
  if (commitment.source === "todoist") {
    return `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`;
  }
  if (commitment.source === "calendar") {
    return `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(
      sourceId
    )}`;
  }
  return null;
}

function workspaceTargetFromPlanBlock(
  block: PersonalDashboardPlanBlock
): PersonalDashboardTodayOpsCard["workspaceTarget"] {
  const sourceId = normalizeText(block.sourceId);
  if (!sourceId) return null;
  if (block.source === "todoist") {
    return {
      kind: "todoist",
      taskId: sourceId,
      title: block.title,
      url: `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`,
    };
  }
  if (block.source === "calendar") {
    return {
      kind: "calendar",
      eventId: sourceId,
      title: block.title,
      url: null,
      startIso: block.startIso,
    };
  }
  return null;
}

function sourceUrlFromPlanBlock(
  block: PersonalDashboardPlanBlock
): string | null {
  const sourceId = normalizeText(block.sourceId);
  if (!sourceId) return null;
  if (block.source === "todoist") {
    return `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`;
  }
  if (block.source === "calendar") {
    return `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(
      sourceId
    )}`;
  }
  return null;
}

function buildTodayOpsAutoBrief(input: {
  metrics: PersonalDashboardMetricSummary;
  rightNow: PersonalDashboardCommandCenter["rightNow"];
  cards: PersonalDashboardTodayOpsCard[];
  now: Date;
}): PersonalDashboardTodayOps["autoBrief"] {
  const metrics = input.metrics;
  const firstCard = input.cards[0];
  const headline =
    normalizeText(input.rightNow?.title) ??
    normalizeText(firstCard?.title) ??
    (metrics.tasksDueToday > 0
      ? `${metrics.tasksDueToday} tasks need attention today`
      : "Today Ops is clear");
  const sourceRefs = input.cards.slice(0, 5).map(card => ({
    source: card.source,
    id: card.sourceId,
    label: card.reason || card.title,
    url: normalizeUrl(card.sourceUrl),
  }));
  const summaryBullets = [
    `${formatMetricCount(metrics.tasksDueToday, "task")} due today; ${formatMetricCount(
      metrics.tasksCompletedToday,
      "completed task"
    )}.`,
    `${formatMetricCount(metrics.meetingsRemaining, "meeting")} remaining.`,
    `${formatMetricCount(metrics.waitingOnCount, "waiting-on thread")} and ${formatMetricCount(
      metrics.inboxToTriage,
      "inbox item"
    )} to triage.`,
    metrics.dockReminderCount > 0
      ? `${formatMetricCount(metrics.dockReminderCount, "dock reminder")} due soon.`
      : null,
    input.cards.length > 0
      ? `${formatMetricCount(input.cards.length, "ranked action")} ready for triage.`
      : "No ranked action card needs attention.",
  ].filter((item): item is string => Boolean(item));

  return {
    headline,
    summaryBullets,
    generatedAt: input.now.toISOString(),
    sourceRefs,
  };
}

function formatMetricCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function buildPersonalDashboardWorkspacePrompts(input: {
  rightNow: PersonalDashboardCommandCenter["rightNow"];
  tasks: TodoistTaskLike[];
  calendarEvents: CalendarEventLike[];
  now: Date;
  noteCounts: WorkspacePromptCounts;
}): PersonalDashboardWorkspacePrompt[] {
  return filterWorkspacePromptsWithoutNotes(
    buildWorkspacePromptCandidates(input),
    input.noteCounts
  );
}

function buildWorkspacePromptCandidates(input: {
  rightNow: PersonalDashboardCommandCenter["rightNow"];
  tasks: TodoistTaskLike[];
  calendarEvents: CalendarEventLike[];
  now: Date;
}): PersonalDashboardWorkspacePrompt[] {
  const candidates: PersonalDashboardWorkspacePrompt[] = [];
  const event = nextCalendarEvent(input.calendarEvents, input.now);
  if (event?.id) {
    candidates.push({
      id: `workspace:calendar:${event.id}`,
      kind: "calendar",
      sourceId: event.id,
      title: event.title,
      sourceUrl: event.url,
      reason: "Upcoming calendar event has no linked workspace note.",
      actionLabel: "Prep meeting note",
      href: workspacePromptHref("calendar", event.id),
    });
  }

  const task = highPriorityTodoistTask(input.tasks);
  if (task?.id) {
    candidates.push({
      id: `workspace:todoist:${task.id}`,
      kind: "todoist",
      sourceId: task.id,
      title: task.title,
      sourceUrl: task.url,
      reason: "High-priority Todoist task has no linked workspace note.",
      actionLabel: "Create working note",
      href: workspacePromptHref("todoist", task.id),
    });
  }

  if (
    input.rightNow?.sourceId &&
    (input.rightNow.kind === "todoist" || input.rightNow.kind === "calendar")
  ) {
    candidates.push({
      id: `workspace:right-now:${input.rightNow.kind}:${input.rightNow.sourceId}`,
      kind: input.rightNow.kind,
      sourceId: input.rightNow.sourceId,
      title: input.rightNow.title,
      sourceUrl: normalizeUrl(input.rightNow.sourceUrl),
      reason: "Right-now item has no linked workspace note.",
      actionLabel: "Open workspace",
      href: workspacePromptHref(input.rightNow.kind, input.rightNow.sourceId),
    });
  }

  return dedupeByWorkspaceTarget(candidates).slice(0, 3);
}

function filterWorkspacePromptsWithoutNotes(
  candidates: PersonalDashboardWorkspacePrompt[],
  noteCounts: WorkspacePromptCounts
): PersonalDashboardWorkspacePrompt[] {
  return candidates.filter(candidate => {
    const count =
      candidate.kind === "todoist"
        ? noteCounts.todoist[candidate.sourceId]
        : noteCounts.calendar[candidate.sourceId];
    return !count;
  });
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
  const hasDailyBriefContent = Boolean(
    state.dailyBrief?.headline?.trim() ||
    state.dailyBrief?.summary?.trim() ||
    (state.dailyBrief?.sourceRefs.length ?? 0) > 0
  );

  const hasWorkflow =
    state.dailyBriefStatus !== "not_started" ||
    state.todayPlanStatus !== "not_started" ||
    hasDailyBriefContent ||
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

function highPriorityTodoistTask(tasks: TodoistTaskLike[]) {
  const sorted = sortedTasks(tasks);
  const task =
    sorted.find(item => Number(item.priority ?? 1) >= 3) ?? sorted[0];
  if (!task) return null;
  const id = taskSourceId(task, "");
  if (!id) return null;
  return {
    id,
    title: taskTitle(task, "Untitled task"),
    url:
      normalizeUrl(task.url) ??
      `https://app.todoist.com/app/task/${encodeURIComponent(id)}`,
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
  const id = normalizeText(event.id);
  if (!id) return null;
  return {
    id,
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

function taskSourceId(
  task: TodoistTaskLike,
  fallback: string | number
): string {
  return normalizeText(task.id) ?? String(fallback);
}

function workspacePromptHref(kind: "todoist" | "calendar", sourceId: string) {
  const key = kind === "todoist" ? "taskId" : "eventId";
  return `/notes?${key}=${encodeURIComponent(sourceId)}`;
}

function dedupeByWorkspaceTarget(
  items: PersonalDashboardWorkspacePrompt[]
): PersonalDashboardWorkspacePrompt[] {
  const byTarget = new Map<string, PersonalDashboardWorkspacePrompt>();
  for (const item of items) {
    const key = `${item.kind}:${item.sourceId}`;
    if (!byTarget.has(key)) byTarget.set(key, item);
  }
  return Array.from(byTarget.values());
}

function countByStatus<T extends { status: string }>(
  items: T[],
  status: T["status"]
): number {
  return items.filter(item => item.status === status).length;
}

function normalizeText(
  value: string | number | null | undefined
): string | null {
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
