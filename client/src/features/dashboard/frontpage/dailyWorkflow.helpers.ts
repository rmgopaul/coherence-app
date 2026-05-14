import type {
  PersonalDashboardCommandCenter,
  PersonalDashboardCommitment,
  PersonalDashboardDailyBrief,
  PersonalDashboardDailyBriefStatus,
  PersonalDashboardDailyState,
  PersonalDashboardOutcome,
  PersonalDashboardTodayPlan,
  PersonalDashboardTodayPlanStatus,
} from "@shared/personalDashboard";

export type DailyWorkflowDraft = {
  dailyBriefStatus: PersonalDashboardDailyBriefStatus;
  dailyBrief: PersonalDashboardDailyBrief;
  todayPlanStatus: PersonalDashboardTodayPlanStatus;
  todayPlan: PersonalDashboardTodayPlan;
  commitments: PersonalDashboardCommitment[];
  outcomes: PersonalDashboardOutcome[];
};

export function emptyDailyWorkflowDraft(): DailyWorkflowDraft {
  return {
    dailyBriefStatus: "not_started",
    dailyBrief: {
      headline: "",
      summary: null,
      generatedAt: null,
      sourceRefs: [],
    },
    todayPlanStatus: "not_started",
    todayPlan: {
      topPriority: null,
      notes: null,
      blocks: [],
      updatedAt: null,
    },
    commitments: [],
    outcomes: [],
  };
}

export function dailyWorkflowDraftFromState(
  state: PersonalDashboardDailyState | null | undefined
): DailyWorkflowDraft {
  const empty = emptyDailyWorkflowDraft();
  if (!state) return empty;

  return {
    dailyBriefStatus: state.dailyBriefStatus,
    dailyBrief: state.dailyBrief ?? empty.dailyBrief,
    todayPlanStatus: state.todayPlanStatus,
    todayPlan: state.todayPlan ?? empty.todayPlan,
    commitments: state.commitments,
    outcomes: state.outcomes,
  };
}

export function buildDailyBriefDraft(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardDailyBrief {
  const metrics = commandCenter.metrics;
  const headline =
    commandCenter.rightNow?.title.trim() ||
    (metrics.tasksDueToday > 0
      ? `${metrics.tasksDueToday} tasks need attention today`
      : "No urgent personal dashboard signal");

  const summary = [
    `${metrics.tasksDueToday} tasks due today`,
    `${metrics.meetingsRemaining} meetings remaining`,
    `${metrics.inboxToTriage} inbox items to triage`,
    `${metrics.waitingOnCount} waiting-on threads`,
  ].join("; ");

  return {
    headline,
    summary,
    generatedAt: now.toISOString(),
    sourceRefs: commandCenter.rightNow
      ? [
          {
            source: commandCenter.rightNow.kind,
            id: commandCenter.rightNow.sourceId,
            label: commandCenter.rightNow.reason,
            url: normalizeExternalUrl(commandCenter.rightNow.sourceUrl),
          },
        ]
      : [],
  };
}

export function buildTodayPlanDraft(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardTodayPlan {
  return {
    topPriority: commandCenter.rightNow?.title ?? null,
    notes: commandCenter.rightNow?.reason ?? null,
    blocks: commandCenter.rightNow
      ? [
          {
            id: `right-now:${commandCenter.rightNow.kind}:${
              commandCenter.rightNow.sourceId ?? commandCenter.dateKey
            }`,
            title: commandCenter.rightNow.title,
            startIso: null,
            endIso: null,
            source: commandCenter.rightNow.kind,
            sourceId: commandCenter.rightNow.sourceId,
            status: "planned",
          },
        ]
      : [],
    updatedAt: now.toISOString(),
  };
}

export function buildCommitmentDraft(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardCommitment | null {
  if (!commandCenter.rightNow) return null;

  return {
    id: `commitment:${commandCenter.rightNow.kind}:${
      commandCenter.rightNow.sourceId ?? now.getTime()
    }`,
    title: commandCenter.rightNow.title,
    source: commandCenter.rightNow.kind,
    sourceId: commandCenter.rightNow.sourceId,
    owner: null,
    dueAt: null,
    status: "open",
    url: normalizeExternalUrl(commandCenter.rightNow.sourceUrl),
  };
}

export function buildOutcomeDraft(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardOutcome {
  return {
    id: `outcome:${commandCenter.dateKey}:${now.getTime()}`,
    title:
      commandCenter.rightNow?.title ??
      "Define one meaningful outcome for today",
    status: "active",
    metricLabel: "Progress",
    target: "Done today",
    current: null,
  };
}

export function normalizeDailyWorkflowDraftForSave(
  draft: DailyWorkflowDraft,
  now: Date
): DailyWorkflowDraft {
  const headline = draft.dailyBrief.headline.trim();
  const topPriority = draft.todayPlan.topPriority?.trim() || null;
  const notes = draft.todayPlan.notes?.trim() || null;

  return {
    dailyBriefStatus: headline ? draft.dailyBriefStatus : "not_started",
    dailyBrief: {
      headline,
      summary: draft.dailyBrief.summary?.trim() || null,
      generatedAt: draft.dailyBrief.generatedAt ?? now.toISOString(),
      sourceRefs: draft.dailyBrief.sourceRefs.slice(0, 50),
    },
    todayPlanStatus:
      topPriority || notes || draft.todayPlan.blocks.length > 0
        ? draft.todayPlanStatus
        : "not_started",
    todayPlan: {
      topPriority,
      notes,
      blocks: draft.todayPlan.blocks.slice(0, 40),
      updatedAt: now.toISOString(),
    },
    commitments: draft.commitments
      .map((item) => ({
        ...item,
        title: item.title.trim(),
        owner: item.owner?.trim() || null,
      }))
      .filter((item) => item.title.length > 0)
      .slice(0, 100),
    outcomes: draft.outcomes
      .map((item) => ({
        ...item,
        title: item.title.trim(),
        metricLabel: item.metricLabel?.trim() || null,
        target: item.target?.trim() || null,
        current: item.current?.trim() || null,
      }))
      .filter((item) => item.title.length > 0)
      .slice(0, 50),
  };
}

function normalizeExternalUrl(value: string | null): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : null;
}
