import { describe, expect, it } from "vitest";

import type {
  PersonalDashboardDailyState,
  PersonalDashboardTodayOps,
  PersonalDashboardTodayOpsCard,
} from "@shared/personalDashboard";
import {
  buildTodayOpsAddCardToPlanPatch,
  buildTodayOpsCommitPlanPatch,
  buildTodayOpsMarkDonePatch,
  isTodayOpsSafePrimaryAction,
  todayOpsLinkedNotesBadgeCanCreate,
  todayOpsCardIsInPlan,
  todayOpsCardToWorkspaceNoteRow,
  todayOpsWorkspaceSignalActionKeys,
} from "./todayOps.helpers";

function emptyDailyState(dateKey = "2026-05-14"): PersonalDashboardDailyState {
  return {
    dateKey,
    dailyBriefStatus: "not_started",
    dailyBrief: null,
    todayPlanStatus: "not_started",
    todayPlan: null,
    commitments: [],
    outcomes: [],
    updatedAt: null,
  };
}

const topCard: PersonalDashboardTodayOpsCard = {
  id: "todoist:task-1",
  rank: 1,
  kind: "todoist",
  title: "Close proposal",
  reason: "Priority 4 Todoist task due today.",
  source: "todoist",
  sourceId: "task-1",
  sourceUrl: "https://todoist.com/app/task/task-1",
  status: "open",
  primaryAction: "open_source",
  workspaceTarget: {
    kind: "todoist",
    taskId: "task-1",
    title: "Close proposal",
    url: "https://todoist.com/app/task/task-1",
  },
  relatedId: "task-1",
};

const todayOps: PersonalDashboardTodayOps = {
  autoBrief: {
    headline: "Close proposal",
    summaryBullets: [
      "3 tasks due today; 1 completed task.",
      "2 meetings remaining.",
    ],
    generatedAt: "2026-05-14T12:00:00.000Z",
    sourceRefs: [
      {
        source: "todoist",
        id: "task-1",
        label: "Priority 4 Todoist task due today.",
        url: "https://todoist.com/app/task/task-1",
      },
    ],
  },
  cards: [topCard],
  progress: {
    dailyBriefStatus: "not_started",
    todayPlanStatus: "not_started",
    headline: null,
    topPriority: null,
    updatedAt: null,
    commitments: {
      total: 0,
      open: 0,
      waiting: 0,
      blocked: 0,
      done: 0,
    },
    outcomes: {
      total: 0,
      active: 0,
      paused: 0,
      won: 0,
      missed: 0,
    },
    tone: "empty",
  },
};

describe("Today Ops helpers", () => {
  it("commits the auto brief and uses the top ranked card as today's priority", () => {
    const state: PersonalDashboardDailyState = {
      ...emptyDailyState(),
      todayPlan: {
        topPriority: "Stale manual priority",
        notes: null,
        updatedAt: null,
        blocks: [
          {
            id: "existing-block",
            title: "Existing advanced editor block",
            startIso: null,
            endIso: null,
            source: "system",
            sourceId: null,
            status: "planned",
          },
        ],
      },
    };

    expect(
      buildTodayOpsCommitPlanPatch(
        todayOps,
        state,
        new Date("2026-05-14T13:00:00.000Z")
      )
    ).toMatchObject({
      dailyBriefStatus: "ready",
      dailyBrief: {
        headline: "Close proposal",
        summary: "3 tasks due today; 1 completed task.\n2 meetings remaining.",
      },
      todayPlanStatus: "ready",
      todayPlan: {
        topPriority: "Close proposal",
        blocks: [{ id: "existing-block" }],
        updatedAt: "2026-05-14T13:00:00.000Z",
      },
    });
  });

  it("adds a ranked card to today's plan without duplicating the same source", () => {
    const state = emptyDailyState();
    const firstPatch = buildTodayOpsAddCardToPlanPatch(
      topCard,
      state,
      "2026-05-14",
      new Date("2026-05-14T13:00:00.000Z")
    );

    expect(firstPatch.todayPlanStatus).toBe("draft");
    expect(firstPatch.todayPlan?.topPriority).toBe("Close proposal");
    expect(firstPatch.todayPlan?.blocks).toMatchObject([
      {
        title: "Close proposal",
        source: "todoist",
        sourceId: "task-1",
        status: "planned",
      },
    ]);

    const stateWithBlock: PersonalDashboardDailyState = {
      ...state,
      todayPlan: firstPatch.todayPlan ?? null,
    };
    const duplicatePatch = buildTodayOpsAddCardToPlanPatch(
      topCard,
      stateWithBlock,
      "2026-05-14",
      new Date("2026-05-14T13:05:00.000Z")
    );
    expect(duplicatePatch.todayPlan?.blocks).toHaveLength(1);
    expect(todayOpsCardIsInPlan(topCard, stateWithBlock, "2026-05-14")).toBe(
      true
    );
  });

  it("marks saved daily-state items done locally", () => {
    const state: PersonalDashboardDailyState = {
      ...emptyDailyState(),
      todayPlanStatus: "ready",
      todayPlan: {
        topPriority: "Close proposal",
        notes: null,
        updatedAt: null,
        blocks: [
          {
            id: "block-1",
            title: "Draft note",
            startIso: null,
            endIso: null,
            source: "system",
            sourceId: null,
            status: "planned",
          },
        ],
      },
      commitments: [
        {
          id: "commitment-1",
          title: "Follow up",
          source: "gmail",
          sourceId: "thread-1",
          owner: null,
          dueAt: null,
          status: "waiting",
          url: null,
        },
      ],
      outcomes: [
        {
          id: "outcome-1",
          title: "Proposal sent",
          status: "active",
          metricLabel: "Progress",
          target: "Done today",
          current: null,
        },
      ],
    };

    expect(
      buildTodayOpsMarkDonePatch(
        { ...topCard, kind: "saved_commitment", relatedId: "commitment-1" },
        state,
        new Date("2026-05-14T13:00:00.000Z")
      )?.commitments?.[0].status
    ).toBe("done");
    expect(
      buildTodayOpsMarkDonePatch(
        { ...topCard, kind: "saved_outcome", relatedId: "outcome-1" },
        state,
        new Date("2026-05-14T13:00:00.000Z")
      )?.outcomes?.[0].status
    ).toBe("won");
    expect(
      buildTodayOpsMarkDonePatch(
        { ...topCard, kind: "saved_plan_block", relatedId: "block-1" },
        state,
        new Date("2026-05-14T13:00:00.000Z")
      )?.todayPlan?.blocks[0].status
    ).toBe("done");
  });

  it("maps workspace targets and allows only Today Ops v1 safe primary actions", () => {
    expect(todayOpsCardToWorkspaceNoteRow(topCard)).toMatchObject({
      kind: "todoist",
      taskId: "task-1",
      content: "Close proposal",
    });

    for (const action of [
      "open_source",
      "create_workspace_note",
      "add_to_plan",
      "mark_done_local",
      "carry_forward_local",
    ]) {
      expect(isTodayOpsSafePrimaryAction(action)).toBe(true);
    }
    for (const externalAction of [
      "defer-todoist",
      "archive-gmail",
      "create-calendar-event",
      "send-gmail-draft",
    ]) {
      expect(isTodayOpsSafePrimaryAction(externalAction)).toBe(false);
    }
  });

  it("keeps create-note as a single primary action for workspace cards", () => {
    const workspaceCard: PersonalDashboardTodayOpsCard = {
      ...topCard,
      primaryAction: "create_workspace_note",
    };

    expect(todayOpsLinkedNotesBadgeCanCreate(workspaceCard)).toBe(false);
    expect(todayOpsWorkspaceSignalActionKeys(workspaceCard)).toEqual([
      "open-workspace-notes",
      "attach-existing-note",
    ]);
    expect(todayOpsLinkedNotesBadgeCanCreate(topCard)).toBe(true);
    expect(todayOpsWorkspaceSignalActionKeys(topCard)).toContain(
      "create-workspace-note"
    );
  });
});
