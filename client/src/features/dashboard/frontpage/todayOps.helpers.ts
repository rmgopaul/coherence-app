import {
  PERSONAL_DASHBOARD_SOURCE_KINDS,
  type PersonalDashboardCommitment,
  type PersonalDashboardDailyBrief,
  type PersonalDashboardDailyBriefStatus,
  type PersonalDashboardDailyState,
  type PersonalDashboardOutcome,
  type PersonalDashboardPlanBlock,
  type PersonalDashboardSourceKind,
  type PersonalDashboardTodayOps,
  type PersonalDashboardTodayOpsCard,
  type PersonalDashboardTodayOpsCardAction,
  type PersonalDashboardTodayPlan,
  type PersonalDashboardTodayPlanStatus,
} from "@shared/personalDashboard";
import type { SignalActionKey } from "@/lib/signalActions";
import type { WorkspaceNoteRow } from "./useWorkspaceNotes";

export type TodayOpsDailyStatePatch = {
  dailyBriefStatus?: PersonalDashboardDailyBriefStatus;
  dailyBrief?: PersonalDashboardDailyBrief | null;
  todayPlanStatus?: PersonalDashboardTodayPlanStatus;
  todayPlan?: PersonalDashboardTodayPlan | null;
  commitments?: PersonalDashboardCommitment[];
  outcomes?: PersonalDashboardOutcome[];
};

export type TodayOpsCarryForwardPatch = TodayOpsDailyStatePatch & {
  carryForwardCount: number;
};

export const TODAY_OPS_SAFE_PRIMARY_ACTIONS: PersonalDashboardTodayOpsCardAction[] =
  [
    "open_source",
    "create_workspace_note",
    "add_to_plan",
    "mark_done_local",
    "carry_forward_local",
  ];

export function isTodayOpsSafePrimaryAction(
  action: string
): action is PersonalDashboardTodayOpsCardAction {
  return TODAY_OPS_SAFE_PRIMARY_ACTIONS.includes(
    action as PersonalDashboardTodayOpsCardAction
  );
}

export function todayOpsWorkspaceSignalActionKeys(
  card: PersonalDashboardTodayOpsCard
): SignalActionKey[] {
  const actions: SignalActionKey[] = [
    "create-workspace-note",
    "open-workspace-notes",
    "attach-existing-note",
  ];
  return card.primaryAction === "create_workspace_note"
    ? actions.filter(action => action !== "create-workspace-note")
    : actions;
}

export function todayOpsLinkedNotesBadgeCanCreate(
  card: PersonalDashboardTodayOpsCard
): boolean {
  return card.primaryAction !== "create_workspace_note";
}

export function todayOpsCardToWorkspaceNoteRow(
  card: PersonalDashboardTodayOpsCard
): WorkspaceNoteRow | null {
  const target = card.workspaceTarget;
  if (!target) return null;
  if (target.kind === "todoist") {
    return {
      kind: "todoist",
      taskId: target.taskId,
      content: target.title,
      taskUrl:
        normalizeExternalUrl(target.url) ??
        `https://app.todoist.com/app/task/${encodeURIComponent(target.taskId)}`,
      dueDate: null,
      projectName: null,
    };
  }

  return {
    kind: "calendar",
    eventId: target.eventId,
    title: target.title,
    eventUrl: normalizeExternalUrl(target.url) ?? "",
    start: target.startIso,
    location: null,
    recurringEventId: null,
    iCalUID: null,
  };
}

export function buildTodayOpsCommitPlanPatch(
  todayOps: PersonalDashboardTodayOps,
  state: PersonalDashboardDailyState,
  now: Date
): TodayOpsDailyStatePatch {
  const currentPlan = existingTodayPlan(state);
  const topCard = todayOps.cards[0] ?? null;
  const summary = todayOps.autoBrief.summaryBullets.join("\n");

  return {
    dailyBriefStatus: "ready",
    dailyBrief: {
      headline: todayOps.autoBrief.headline,
      summary,
      generatedAt: todayOps.autoBrief.generatedAt,
      sourceRefs: todayOps.autoBrief.sourceRefs
        .map(sourceRef => ({
          ...sourceRef,
          label: sourceRef.label.trim(),
          url: normalizeExternalUrl(sourceRef.url),
        }))
        .filter(sourceRef => sourceRef.label.length > 0)
        .slice(0, 50),
    },
    todayPlanStatus: "ready",
    todayPlan: {
      ...currentPlan,
      topPriority: topCard?.title ?? currentPlan.topPriority ?? null,
      notes: currentPlan.notes ?? summary,
      updatedAt: now.toISOString(),
    },
  };
}

export function buildTodayOpsAddCardToPlanPatch(
  card: PersonalDashboardTodayOpsCard,
  state: PersonalDashboardDailyState,
  dateKey: string,
  now: Date
): TodayOpsDailyStatePatch {
  const currentPlan = existingTodayPlan(state);
  const block = todayOpsPlanBlockFromCard(card, dateKey);
  const exists = currentPlan.blocks.some(
    item =>
      item.id === block.id ||
      (block.sourceId !== null &&
        item.source === block.source &&
        item.sourceId === block.sourceId)
  );

  return {
    todayPlanStatus:
      state?.todayPlanStatus && state.todayPlanStatus !== "not_started"
        ? state.todayPlanStatus
        : "draft",
    todayPlan: {
      ...currentPlan,
      topPriority: currentPlan.topPriority ?? card.title,
      notes: currentPlan.notes ?? card.reason,
      blocks: exists ? currentPlan.blocks : [...currentPlan.blocks, block],
      updatedAt: now.toISOString(),
    },
  };
}

export function buildTodayOpsMarkDonePatch(
  card: PersonalDashboardTodayOpsCard,
  state: PersonalDashboardDailyState | null | undefined,
  now: Date
): TodayOpsDailyStatePatch | null {
  if (!state) return null;
  const relatedId = card.relatedId?.trim();
  if (!relatedId) return null;

  if (card.kind === "saved_commitment") {
    let changed = false;
    const commitments = state.commitments.map(item => {
      if (item.id !== relatedId || item.status === "done") return item;
      changed = true;
      return { ...item, status: "done" as const };
    });
    return changed ? { commitments } : null;
  }

  if (card.kind === "saved_outcome") {
    let changed = false;
    const outcomes = state.outcomes.map(item => {
      if (item.id !== relatedId || item.status === "won") return item;
      changed = true;
      return { ...item, status: "won" as const };
    });
    return changed ? { outcomes } : null;
  }

  if (card.kind === "saved_plan_block" && state.todayPlan) {
    let changed = false;
    const blocks = state.todayPlan.blocks.map(item => {
      if (item.id !== relatedId || item.status === "done") return item;
      changed = true;
      return { ...item, status: "done" as const };
    });
    return changed
      ? {
          todayPlanStatus: state.todayPlanStatus,
          todayPlan: {
            ...state.todayPlan,
            blocks,
            updatedAt: now.toISOString(),
          },
        }
      : null;
  }

  return null;
}

export function buildTodayOpsCarryForwardCardPatch(
  card: PersonalDashboardTodayOpsCard,
  state: PersonalDashboardDailyState | null | undefined,
  targetState: PersonalDashboardDailyState | null | undefined,
  targetDateKey: string,
  now: Date
): TodayOpsCarryForwardPatch {
  const relatedId = card.relatedId?.trim();
  if (!state || !relatedId) return { carryForwardCount: 0 };

  if (card.kind === "saved_commitment") {
    const source = state.commitments.find(
      item => item.id === relatedId && item.status !== "done"
    );
    if (!source) return { carryForwardCount: 0 };
    const commitments = targetState?.commitments ?? [];
    const carried = {
      ...source,
      id: carriedId(targetDateKey, "commitment", source.id),
      dueAt: null,
    };
    if (commitments.some(item => item.id === carried.id)) {
      return { carryForwardCount: 0 };
    }
    return {
      commitments: [...commitments, carried],
      carryForwardCount: 1,
    };
  }

  if (card.kind === "saved_outcome") {
    const source = state.outcomes.find(
      item =>
        item.id === relatedId &&
        (item.status === "active" || item.status === "paused")
    );
    if (!source) return { carryForwardCount: 0 };
    const outcomes = targetState?.outcomes ?? [];
    const carried = {
      ...source,
      id: carriedId(targetDateKey, "outcome", source.id),
    };
    if (outcomes.some(item => item.id === carried.id)) {
      return { carryForwardCount: 0 };
    }
    return {
      outcomes: [...outcomes, carried],
      carryForwardCount: 1,
    };
  }

  if (card.kind === "saved_plan_block") {
    const source = state.todayPlan?.blocks.find(
      item =>
        item.id === relatedId &&
        (item.status === "planned" || item.status === "active")
    );
    if (!source) return { carryForwardCount: 0 };
    const targetPlan = existingTodayPlan(targetState);
    const carried = {
      ...source,
      id: carriedId(targetDateKey, "plan-block", source.id),
      startIso: null,
      endIso: null,
      status: "planned" as const,
    };
    if (targetPlan.blocks.some(item => item.id === carried.id)) {
      return { carryForwardCount: 0 };
    }
    return {
      todayPlanStatus:
        targetState?.todayPlanStatus &&
        targetState.todayPlanStatus !== "not_started"
          ? targetState.todayPlanStatus
          : "draft",
      todayPlan: {
        ...targetPlan,
        topPriority: targetPlan.topPriority ?? source.title,
        notes: targetPlan.notes ?? `Carried forward to ${targetDateKey}.`,
        blocks: [...targetPlan.blocks, carried],
        updatedAt: now.toISOString(),
      },
      carryForwardCount: 1,
    };
  }

  return { carryForwardCount: 0 };
}

export function todayOpsCardIsInPlan(
  card: PersonalDashboardTodayOpsCard,
  state: PersonalDashboardDailyState | null | undefined,
  dateKey: string
): boolean {
  const plan = state?.todayPlan;
  if (!plan) return false;
  const block = todayOpsPlanBlockFromCard(card, dateKey);
  return plan.blocks.some(
    item =>
      item.id === block.id ||
      (block.sourceId !== null &&
        item.source === block.source &&
        item.sourceId === block.sourceId)
  );
}

function existingTodayPlan(
  state: PersonalDashboardDailyState | null | undefined
): PersonalDashboardTodayPlan {
  return (
    state?.todayPlan ?? {
      topPriority: null,
      notes: null,
      blocks: [],
      updatedAt: null,
    }
  );
}

function todayOpsPlanBlockFromCard(
  card: PersonalDashboardTodayOpsCard,
  dateKey: string
): PersonalDashboardPlanBlock {
  return {
    id: todayOpsPlanBlockId(card, dateKey),
    title: card.title.trim() || "Today Ops item",
    startIso: null,
    endIso: null,
    source: sourceKindForPlanBlock(card),
    sourceId: card.sourceId?.trim() || null,
    status: "planned",
  };
}

function todayOpsPlanBlockId(
  card: PersonalDashboardTodayOpsCard,
  dateKey: string
): string {
  const raw = card.relatedId ?? card.sourceId ?? card.id;
  const safeId = raw.replace(/[^A-Za-z0-9:_-]+/g, "-").slice(0, 70) || "item";
  return `today-ops:${dateKey}:${card.kind}:${safeId}`;
}

function carriedId(
  targetDateKey: string,
  kind: "commitment" | "outcome" | "plan-block",
  sourceId: string
): string {
  const safeId =
    sourceId.replace(/[^A-Za-z0-9:_-]+/g, "-").slice(0, 72) || "item";
  return `carry:${targetDateKey}:${kind}:${safeId}`;
}

function sourceKindForPlanBlock(
  card: PersonalDashboardTodayOpsCard
): PersonalDashboardSourceKind {
  return (PERSONAL_DASHBOARD_SOURCE_KINDS as readonly string[]).includes(
    card.source
  )
    ? (card.source as PersonalDashboardSourceKind)
    : "system";
}

function normalizeExternalUrl(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}
