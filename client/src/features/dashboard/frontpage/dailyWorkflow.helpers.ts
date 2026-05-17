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
import type { WorkspaceNoteRow } from "./useWorkspaceNotes";

export type DailyWorkflowDraft = {
  dailyBriefStatus: PersonalDashboardDailyBriefStatus;
  dailyBrief: PersonalDashboardDailyBrief;
  todayPlanStatus: PersonalDashboardTodayPlanStatus;
  todayPlan: PersonalDashboardTodayPlan;
  commitments: PersonalDashboardCommitment[];
  outcomes: PersonalDashboardOutcome[];
};

export type EndOfDayReviewSummary = {
  commitmentCounts: {
    total: number;
    done: number;
    open: number;
    waiting: number;
    blocked: number;
  };
  outcomeCounts: {
    total: number;
    won: number;
    active: number;
    paused: number;
    missed: number;
  };
  planBlockCounts: {
    total: number;
    done: number;
    planned: number;
    active: number;
    skipped: number;
  };
  needsAttention: string[];
  tone: "empty" | "clear" | "attention";
  summary: string;
};

export type CarryForwardDailyWorkflowPatch = {
  commitments: PersonalDashboardCommitment[];
  outcomes: PersonalDashboardOutcome[];
  todayPlanStatus?: PersonalDashboardTodayPlanStatus;
  todayPlan?: PersonalDashboardTodayPlan;
  carryForwardCount: number;
};

type ManualWorkflowIdKind = "commitment" | "outcome" | "plan-block";
type WorkspaceCapableDailyWorkflowItem =
  | PersonalDashboardCommitment
  | PersonalDashboardTodayPlan["blocks"][number];
type DailyBriefSourceRef = PersonalDashboardDailyBrief["sourceRefs"][number];

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

export function createManualDailyWorkflowId(
  kind: ManualWorkflowIdKind
): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:manual:${randomId}`;
}

export function hasDailyBriefDraftContent(
  brief: PersonalDashboardDailyBrief
): boolean {
  return Boolean(
    brief.headline.trim() ||
    brief.summary?.trim() ||
    brief.sourceRefs.length > 0
  );
}

export function hasDailyWorkflowDraftContent(
  draft: DailyWorkflowDraft
): boolean {
  return Boolean(
    hasDailyBriefDraftContent(draft.dailyBrief) ||
    draft.todayPlan.topPriority?.trim() ||
    draft.todayPlan.notes?.trim() ||
    draft.todayPlan.blocks.length > 0 ||
    draft.commitments.length > 0 ||
    draft.outcomes.length > 0
  );
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

function summarizeBriefSourceRefs(
  sourceRefs: PersonalDashboardDailyBrief["sourceRefs"]
): string | null {
  const labels = sourceRefs
    .map((sourceRef) => sourceRef.label.trim())
    .filter((label) => label.length > 0);
  if (labels.length === 0) return null;

  const visibleLabels = labels.slice(0, 5).join("; ");
  const overflowCount = labels.length - 5;
  const suffix = overflowCount > 0 ? `; +${overflowCount} more` : "";
  return `${labels.length} ${labels.length === 1 ? "source" : "sources"}: ${visibleLabels}${suffix}`;
}

export function refreshDailyBriefDraftFromSources(
  brief: PersonalDashboardDailyBrief,
  commandCenter: PersonalDashboardCommandCenter | null | undefined,
  now: Date
): PersonalDashboardDailyBrief {
  const sourceSummary = summarizeBriefSourceRefs(brief.sourceRefs);
  const rightNowTitle = commandCenter?.rightNow?.title.trim() || null;
  const firstSourceLabel =
    brief.sourceRefs.find((sourceRef) => sourceRef.label.trim().length > 0)
      ?.label.trim() ?? null;
  const headline =
    firstSourceLabel ||
    rightNowTitle ||
    brief.headline.trim() ||
    "Daily brief refreshed";

  const metricSummary = commandCenter
    ? [
        `${commandCenter.metrics.tasksDueToday} tasks due today`,
        `${commandCenter.metrics.meetingsRemaining} meetings remaining`,
        `${commandCenter.metrics.inboxToTriage} inbox items to triage`,
        `${commandCenter.metrics.waitingOnCount} waiting-on threads`,
      ].join("; ")
    : null;
  const rightNowSummary = commandCenter?.rightNow
    ? `Right now: ${commandCenter.rightNow.title.trim()} (${commandCenter.rightNow.reason.trim()}).`
    : null;
  const summary = [
    sourceSummary ? `Brief sources: ${sourceSummary}.` : null,
    metricSummary ? `Current signals: ${metricSummary}.` : null,
    rightNowSummary,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ...brief,
    headline,
    summary: summary || brief.summary?.trim() || null,
    generatedAt: now.toISOString(),
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

export function completeAllCommitments(
  commitments: PersonalDashboardCommitment[]
): PersonalDashboardCommitment[] {
  return commitments.map((item) =>
    item.status === "done" ? item : { ...item, status: "done" }
  );
}

export function winActiveOutcomes(
  outcomes: PersonalDashboardOutcome[]
): PersonalDashboardOutcome[] {
  return outcomes.map((item) =>
    item.status === "active" ? { ...item, status: "won" } : item
  );
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function buildEndOfDayReviewSummary(
  draft: DailyWorkflowDraft
): EndOfDayReviewSummary {
  const commitmentCounts = draft.commitments.reduce(
    (counts, item) => ({
      ...counts,
      total: counts.total + 1,
      [item.status]: counts[item.status] + 1,
    }),
    { total: 0, done: 0, open: 0, waiting: 0, blocked: 0 }
  );
  const outcomeCounts = draft.outcomes.reduce(
    (counts, item) => ({
      ...counts,
      total: counts.total + 1,
      [item.status]: counts[item.status] + 1,
    }),
    { total: 0, won: 0, active: 0, paused: 0, missed: 0 }
  );
  const planBlockCounts = draft.todayPlan.blocks.reduce(
    (counts, item) => ({
      ...counts,
      total: counts.total + 1,
      [item.status]: counts[item.status] + 1,
    }),
    { total: 0, done: 0, planned: 0, active: 0, skipped: 0 }
  );

  const needsAttention = [
    commitmentCounts.open > 0
      ? countLabel(commitmentCounts.open, "open commitment")
      : null,
    commitmentCounts.waiting > 0
      ? countLabel(commitmentCounts.waiting, "waiting commitment")
      : null,
    commitmentCounts.blocked > 0
      ? countLabel(commitmentCounts.blocked, "blocked commitment")
      : null,
    outcomeCounts.active > 0
      ? countLabel(outcomeCounts.active, "active outcome")
      : null,
    outcomeCounts.paused > 0
      ? countLabel(outcomeCounts.paused, "paused outcome")
      : null,
    planBlockCounts.planned > 0
      ? countLabel(planBlockCounts.planned, "planned block")
      : null,
    planBlockCounts.active > 0
      ? countLabel(planBlockCounts.active, "active block")
      : null,
  ].filter((item): item is string => Boolean(item));

  const trackedCount =
    commitmentCounts.total + outcomeCounts.total + planBlockCounts.total;
  const tone =
    trackedCount === 0
      ? "empty"
      : needsAttention.length === 0
        ? "clear"
        : "attention";
  const summary =
    tone === "empty"
      ? "No commitments, outcomes, or plan blocks are tracked yet."
      : tone === "clear"
        ? "Everything tracked for today has a terminal status."
        : `Review before closing: ${needsAttention.join("; ")}.`;

  return {
    commitmentCounts,
    outcomeCounts,
    planBlockCounts,
    needsAttention,
    tone,
    summary,
  };
}

export function nextDailyWorkflowDateKey(dateKey: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return formatDateInput(tomorrow);
  }

  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3])
  );
  date.setDate(date.getDate() + 1);
  return formatDateInput(date);
}

function carriedId(
  targetDateKey: string,
  kind: "commitment" | "outcome" | "plan-block",
  sourceId: string
): string {
  return `carry:${targetDateKey}:${kind}:${sourceId}`;
}

function mergeById<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const existingIds = new Set(existing.map((item) => item.id));
  return [
    ...existing,
    ...incoming.filter((item) => !existingIds.has(item.id)),
  ];
}

export function buildCarryForwardDailyWorkflowPatch(
  draft: DailyWorkflowDraft,
  targetState: PersonalDashboardDailyState | null | undefined,
  sourceDateKey: string,
  targetDateKey: string,
  now: Date
): CarryForwardDailyWorkflowPatch {
  const existingCommitments = targetState?.commitments ?? [];
  const existingOutcomes = targetState?.outcomes ?? [];
  const existingPlan = targetState?.todayPlan ?? {
    topPriority: null,
    notes: null,
    blocks: [],
    updatedAt: null,
  };

  const carriedCommitments = draft.commitments
    .filter((item) => item.status !== "done")
    .map((item) => ({
      ...item,
      id: carriedId(targetDateKey, "commitment", item.id),
      dueAt: null,
    }));
  const carriedOutcomes = draft.outcomes
    .filter((item) => item.status === "active" || item.status === "paused")
    .map((item) => ({
      ...item,
      id: carriedId(targetDateKey, "outcome", item.id),
    }));
  const carriedPlanBlocks = draft.todayPlan.blocks
    .filter((item) => item.status === "planned" || item.status === "active")
    .map((item) => ({
      ...item,
      id: carriedId(targetDateKey, "plan-block", item.id),
      startIso: null,
      endIso: null,
      status: "planned" as const,
    }));

  const commitments = mergeById(existingCommitments, carriedCommitments);
  const outcomes = mergeById(existingOutcomes, carriedOutcomes);
  const blocks = mergeById(existingPlan.blocks, carriedPlanBlocks);
  const carryForwardCount =
    commitments.length -
    existingCommitments.length +
    outcomes.length -
    existingOutcomes.length +
    blocks.length -
    existingPlan.blocks.length;

  const todayPlan =
    carriedPlanBlocks.length > 0
      ? {
          ...existingPlan,
          topPriority:
            existingPlan.topPriority ??
            carriedCommitments[0]?.title ??
            carriedOutcomes[0]?.title ??
            draft.todayPlan.topPriority,
          notes:
            existingPlan.notes ??
            `Carried forward from ${sourceDateKey}.`,
          blocks,
          updatedAt: now.toISOString(),
        }
      : undefined;

  return {
    commitments,
    outcomes,
    todayPlanStatus: todayPlan
      ? targetState?.todayPlanStatus === "not_started" ||
        !targetState?.todayPlanStatus
        ? "draft"
        : targetState.todayPlanStatus
      : undefined,
    todayPlan,
    carryForwardCount,
  };
}

export function workspaceNoteRowFromDailyWorkflowItem(
  item: WorkspaceCapableDailyWorkflowItem
): WorkspaceNoteRow | null {
  const sourceId = item.sourceId?.trim();
  if (!sourceId) return null;
  const title = item.title.trim() || sourceId;

  if (item.source === "todoist") {
    return {
      kind: "todoist",
      taskId: sourceId,
      content: title,
      taskUrl:
        normalizeExternalUrl("url" in item ? item.url : null) ??
        `https://todoist.com/showTask?id=${encodeURIComponent(sourceId)}`,
      dueDate: "dueAt" in item ? item.dueAt : null,
      projectName: null,
    };
  }

  if (item.source === "calendar") {
    return {
      kind: "calendar",
      eventId: sourceId,
      title,
      eventUrl:
        normalizeExternalUrl("url" in item ? item.url : null) ??
        `https://calendar.google.com/calendar/u/0/r/eventedit/${encodeURIComponent(
          sourceId
        )}`,
      start:
        "startIso" in item ? item.startIso : "dueAt" in item ? item.dueAt : null,
      location: null,
      recurringEventId: null,
      iCalUID: null,
    };
  }

  return null;
}

export function sourceUrlForBriefSourceRef(
  sourceRef: DailyBriefSourceRef
): string | null {
  const explicitUrl = normalizeExternalUrl(sourceRef.url);
  if (explicitUrl) return explicitUrl;
  if (sourceRef.source === "todoist" && sourceRef.id?.trim()) {
    return `https://app.todoist.com/app/task/${encodeURIComponent(
      sourceRef.id.trim()
    )}`;
  }
  return null;
}

export function workspaceNoteRowFromBriefSourceRef(
  sourceRef: DailyBriefSourceRef
): WorkspaceNoteRow | null {
  const sourceId = sourceRef.id?.trim();
  if (!sourceId) return null;
  const title = sourceRef.label.trim() || sourceId;
  const sourceUrl = sourceUrlForBriefSourceRef(sourceRef);

  if (sourceRef.source === "todoist") {
    return {
      kind: "todoist",
      taskId: sourceId,
      content: title,
      taskUrl:
        sourceUrl ??
        `https://app.todoist.com/app/task/${encodeURIComponent(sourceId)}`,
      dueDate: null,
      projectName: null,
    };
  }

  if (sourceRef.source === "calendar") {
    return {
      kind: "calendar",
      eventId: sourceId,
      title,
      eventUrl: sourceUrl ?? "",
      start: null,
      location: null,
      recurringEventId: null,
      iCalUID: null,
    };
  }

  return null;
}

function isWorkspaceNoteRow(
  row: WorkspaceNoteRow | null
): row is WorkspaceNoteRow {
  return row !== null;
}

export function workspaceNoteRowsFromDailyWorkflowDraft(
  draft: DailyWorkflowDraft
): WorkspaceNoteRow[] {
  return [
    ...draft.dailyBrief.sourceRefs.map(workspaceNoteRowFromBriefSourceRef),
    ...draft.commitments.map(workspaceNoteRowFromDailyWorkflowItem),
    ...draft.todayPlan.blocks.map(workspaceNoteRowFromDailyWorkflowItem),
  ].filter(isWorkspaceNoteRow);
}

export function normalizeDailyWorkflowDraftForSave(
  draft: DailyWorkflowDraft,
  now: Date
): DailyWorkflowDraft {
  const headline = draft.dailyBrief.headline.trim();
  const summary = draft.dailyBrief.summary?.trim() || null;
  const topPriority = draft.todayPlan.topPriority?.trim() || null;
  const notes = draft.todayPlan.notes?.trim() || null;
  const sourceRefs = draft.dailyBrief.sourceRefs
    .map((item) => ({
      ...item,
      id: item.id?.trim() || null,
      label: item.label.trim(),
      url: normalizeExternalUrl(item.url),
    }))
    .filter((item) => item.label.length > 0)
    .slice(0, 50);
  const blocks = draft.todayPlan.blocks
    .map((item) => ({
      ...item,
      title: item.title.trim(),
      startIso: normalizeIsoDateTime(item.startIso),
      endIso: normalizeIsoDateTime(item.endIso),
      sourceId: item.sourceId?.trim() || null,
    }))
    .filter((item) => item.title.length > 0)
    .slice(0, 40);
  const hasDailyBriefContent = Boolean(
    headline || summary || sourceRefs.length
  );

  return {
    dailyBriefStatus: hasDailyBriefContent
      ? draft.dailyBriefStatus === "not_started"
        ? "draft"
        : draft.dailyBriefStatus
      : "not_started",
    dailyBrief: {
      headline,
      summary,
      generatedAt: draft.dailyBrief.generatedAt ?? now.toISOString(),
      sourceRefs,
    },
    todayPlanStatus:
      topPriority || notes || blocks.length > 0
        ? draft.todayPlanStatus
        : "not_started",
    todayPlan: {
      topPriority,
      notes,
      blocks,
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
