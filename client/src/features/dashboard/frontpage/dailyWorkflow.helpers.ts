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
import { formatDateInput } from "@shared/dateKey";

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
  return buildCommitmentDrafts(commandCenter, now)[0] ?? null;
}

export function buildCommitmentDrafts(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardCommitment[] {
  const suggestions = commandCenter.dailyWorkflow.suggestedCommitments;
  if (suggestions.length > 0) return suggestions;
  if (!commandCenter.rightNow) return [];

  return [
    {
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
    },
  ];
}

export function buildOutcomeDraft(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardOutcome {
  return buildOutcomeDrafts(commandCenter, now)[0]!;
}

export function buildOutcomeDrafts(
  commandCenter: PersonalDashboardCommandCenter,
  now: Date
): PersonalDashboardOutcome[] {
  const suggestions = commandCenter.dailyWorkflow.suggestedOutcomes;
  if (suggestions.length > 0) return suggestions;

  return [
    {
      id: `outcome:${commandCenter.dateKey}:${now.getTime()}`,
      title:
        commandCenter.rightNow?.title ??
        "Define one meaningful outcome for today",
      status: "active",
      metricLabel: "Progress",
      target: "Done today",
      current: null,
    },
  ];
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
        dueAt: normalizeIsoDateTime(item.dueAt),
        url: normalizeExternalUrl(item.url),
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

export function dateTimeLocalInputFromIso(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${formatDateInput(date)}T${hh}:${min}`;
}

export function isoFromDateTimeLocalInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeIsoDateTime(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeExternalUrl(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
