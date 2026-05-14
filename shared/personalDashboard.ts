export const PERSONAL_DASHBOARD_RUNNER_VERSION = "personal-command-center-v1";

export const PERSONAL_DASHBOARD_INTEGRATION_KEYS = [
  "google",
  "gmail",
  "calendar",
  "drive",
  "todoist",
  "clockify",
  "whoop",
  "samsungHealth",
  "weather",
  "news",
] as const;

export type PersonalDashboardIntegrationKey =
  (typeof PERSONAL_DASHBOARD_INTEGRATION_KEYS)[number];

export type PersonalDashboardHealthStatus =
  | "connected"
  | "missing"
  | "stale"
  | "failing"
  | "rate_limited"
  | "offline";

export type PersonalDashboardSourceKind =
  | "todoist"
  | "calendar"
  | "gmail"
  | "dock"
  | "daily_brief"
  | "today_plan"
  | "weekly_review"
  | "health"
  | "system";

export type PersonalDashboardIntegrationHealth = {
  key: PersonalDashboardIntegrationKey;
  label: string;
  status: PersonalDashboardHealthStatus;
  reason: string | null;
  connected: boolean;
  lastSeenAt: string | null;
  actionHref: string | null;
};

export type PersonalDashboardMetricSummary = {
  tasksDueToday: number;
  tasksCompletedToday: number;
  meetingsRemaining: number;
  inboxToTriage: number;
  waitingOnCount: number;
  dockReminderCount: number;
  activeDockCount: number;
};

export type PersonalDashboardRightNow = {
  title: string;
  kind: PersonalDashboardSourceKind;
  sourceId: string | null;
  sourceUrl: string | null;
  reason: string;
};

export type PersonalDashboardFeatureReadiness = {
  status: "not_started" | "local_only" | "server_ready" | "ready";
  reason: string;
};

export type PersonalDashboardDailyBriefStatus =
  | "not_started"
  | "draft"
  | "ready"
  | "failed";

export type PersonalDashboardTodayPlanStatus =
  | "not_started"
  | "draft"
  | "ready"
  | "completed";

export type PersonalDashboardDailyBrief = {
  headline: string;
  summary: string | null;
  generatedAt: string | null;
  sourceRefs: Array<{
    source: PersonalDashboardSourceKind | PersonalDashboardIntegrationKey;
    id: string | null;
    label: string;
    url: string | null;
  }>;
};

export type PersonalDashboardPlanBlock = {
  id: string;
  title: string;
  startIso: string | null;
  endIso: string | null;
  source: PersonalDashboardSourceKind;
  sourceId: string | null;
  status: "planned" | "active" | "done" | "skipped";
};

export type PersonalDashboardTodayPlan = {
  topPriority: string | null;
  notes: string | null;
  blocks: PersonalDashboardPlanBlock[];
  updatedAt: string | null;
};

export type PersonalDashboardCommitment = {
  id: string;
  title: string;
  source: PersonalDashboardSourceKind | PersonalDashboardIntegrationKey;
  sourceId: string | null;
  owner: string | null;
  dueAt: string | null;
  status: "open" | "waiting" | "done" | "blocked";
  url: string | null;
};

export type PersonalDashboardOutcome = {
  id: string;
  title: string;
  status: "active" | "won" | "missed" | "paused";
  metricLabel: string | null;
  target: string | null;
  current: string | null;
};

export type PersonalDashboardDailyState = {
  dateKey: string;
  dailyBriefStatus: PersonalDashboardDailyBriefStatus;
  dailyBrief: PersonalDashboardDailyBrief | null;
  todayPlanStatus: PersonalDashboardTodayPlanStatus;
  todayPlan: PersonalDashboardTodayPlan | null;
  commitments: PersonalDashboardCommitment[];
  outcomes: PersonalDashboardOutcome[];
  updatedAt: string | null;
};

export type PersonalDashboardCommandCenter = {
  _runnerVersion: typeof PERSONAL_DASHBOARD_RUNNER_VERSION;
  generatedAt: string;
  dateKey: string;
  userId: number;
  metrics: PersonalDashboardMetricSummary;
  rightNow: PersonalDashboardRightNow | null;
  integrations: PersonalDashboardIntegrationHealth[];
  dailyBrief: PersonalDashboardFeatureReadiness;
  todayPlan: PersonalDashboardFeatureReadiness;
  weeklyReview: {
    headline: string | null;
    weekKey: string | null;
    status: string | null;
    generatedAt: string | null;
  };
  insight: {
    status: string | null;
    generatedAt: string | null;
  };
  sourceFreshness: Array<{
    source: PersonalDashboardSourceKind | PersonalDashboardIntegrationKey;
    status: PersonalDashboardHealthStatus;
    fetchedAt: string | null;
    detail: string | null;
  }>;
};

export const PERSONAL_DASHBOARD_INTEGRATION_LABELS: Record<
  PersonalDashboardIntegrationKey,
  string
> = {
  google: "Google",
  gmail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
  todoist: "Todoist",
  clockify: "Clockify",
  whoop: "WHOOP",
  samsungHealth: "Samsung Health",
  weather: "Weather",
  news: "News",
};

export const PERSONAL_DASHBOARD_INTEGRATION_ACTIONS: Record<
  PersonalDashboardIntegrationKey,
  string | null
> = {
  google: "/settings",
  gmail: "/settings",
  calendar: "/settings",
  drive: "/settings",
  todoist: "/settings",
  clockify: "/widget/clockify",
  whoop: "/settings",
  samsungHealth: "/health",
  weather: "/settings",
  news: "/settings",
};

export function makePersonalDashboardIntegrationHealth(args: {
  key: PersonalDashboardIntegrationKey;
  connected: boolean;
  status?: PersonalDashboardHealthStatus;
  reason?: string | null;
  lastSeenAt?: string | Date | null;
}): PersonalDashboardIntegrationHealth {
  const status = args.status ?? (args.connected ? "connected" : "missing");
  return {
    key: args.key,
    label: PERSONAL_DASHBOARD_INTEGRATION_LABELS[args.key],
    status,
    reason: args.reason ?? null,
    connected: args.connected,
    lastSeenAt: toIsoOrNull(args.lastSeenAt),
    actionHref: PERSONAL_DASHBOARD_INTEGRATION_ACTIONS[args.key],
  };
}

export function choosePersonalDashboardRightNow(input: {
  priorityTask?: { id: string; title: string; url?: string | null } | null;
  nextMeeting?: { id: string; title: string; url?: string | null } | null;
  urgentEmail?: { id: string; title: string; url?: string | null } | null;
}): PersonalDashboardRightNow | null {
  if (input.priorityTask) {
    return {
      title: input.priorityTask.title,
      kind: "todoist",
      sourceId: input.priorityTask.id,
      sourceUrl: input.priorityTask.url ?? null,
      reason: "Highest-priority task due today.",
    };
  }
  if (input.nextMeeting) {
    return {
      title: input.nextMeeting.title,
      kind: "calendar",
      sourceId: input.nextMeeting.id,
      sourceUrl: input.nextMeeting.url ?? null,
      reason: "Next scheduled commitment.",
    };
  }
  if (input.urgentEmail) {
    return {
      title: input.urgentEmail.title,
      kind: "gmail",
      sourceId: input.urgentEmail.id,
      sourceUrl: input.urgentEmail.url ?? null,
      reason: "Highest-priority inbox item needing attention.",
    };
  }
  return null;
}

function toIsoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
