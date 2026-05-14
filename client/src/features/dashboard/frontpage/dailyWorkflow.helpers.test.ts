import { describe, expect, it } from "vitest";

import type { PersonalDashboardCommandCenter } from "@shared/personalDashboard";
import {
  buildCommitmentDraft,
  buildCommitmentDrafts,
  buildDailyBriefDraft,
  buildTodayPlanDraft,
  buildOutcomeDrafts,
  dailyWorkflowDraftFromState,
  normalizeDailyWorkflowDraftForSave,
} from "./dailyWorkflow.helpers";

const commandCenter: PersonalDashboardCommandCenter = {
  _runnerVersion: "personal-command-center-v1",
  generatedAt: "2026-05-14T12:00:00.000Z",
  dateKey: "2026-05-14",
  userId: 1,
  metrics: {
    tasksDueToday: 3,
    tasksCompletedToday: 1,
    meetingsRemaining: 2,
    inboxToTriage: 4,
    waitingOnCount: 2,
    dockReminderCount: 1,
    activeDockCount: 1,
  },
  rightNow: {
    title: "Close proposal",
    kind: "todoist",
    sourceId: "task-1",
    sourceUrl: "https://todoist.com/app/task/task-1",
    reason: "Highest-priority task due today.",
  },
  dailyWorkflow: {
    suggestedCommitments: [],
    suggestedOutcomes: [],
  },
  dailyProgress: {
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
  integrations: [],
  dailyBrief: {
    status: "server_ready",
    reason: "Ready",
  },
  todayPlan: {
    status: "server_ready",
    reason: "Ready",
  },
  weeklyReview: {
    headline: null,
    weekKey: null,
    status: null,
    generatedAt: null,
  },
  insight: {
    status: null,
    generatedAt: null,
  },
  sourceFreshness: [],
};

describe("dailyWorkflow helpers", () => {
  it("seeds brief and plan drafts from command-center signals", () => {
    const now = new Date("2026-05-14T13:00:00.000Z");

    expect(buildDailyBriefDraft(commandCenter, now)).toMatchObject({
      headline: "Close proposal",
      summary:
        "3 tasks due today; 2 meetings remaining; 4 inbox items to triage; 2 waiting-on threads",
      generatedAt: "2026-05-14T13:00:00.000Z",
      sourceRefs: [{ source: "todoist", id: "task-1" }],
    });

    expect(buildTodayPlanDraft(commandCenter, now)).toMatchObject({
      topPriority: "Close proposal",
      blocks: [{ title: "Close proposal", source: "todoist" }],
      updatedAt: "2026-05-14T13:00:00.000Z",
    });

    expect(buildCommitmentDraft(commandCenter, now)).toMatchObject({
      title: "Close proposal",
      source: "todoist",
      sourceId: "task-1",
      status: "open",
    });
  });

  it("prefers command-center workflow suggestions when seeding lists", () => {
    const now = new Date("2026-05-14T13:00:00.000Z");
    const suggested: PersonalDashboardCommandCenter = {
      ...commandCenter,
      dailyWorkflow: {
        suggestedCommitments: [
          {
            id: "waiting-on:thread-1",
            title: "Follow up: Contract approval",
            source: "gmail",
            sourceId: "thread-1",
            owner: "client@example.com",
            dueAt: null,
            status: "waiting",
            url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
          },
        ],
        suggestedOutcomes: [
          {
            id: "task-outcome:task-2",
            title: "Finish model review",
            status: "active",
            metricLabel: "Task",
            target: "Complete today",
            current: null,
          },
        ],
      },
    };

    expect(buildCommitmentDrafts(suggested, now)).toEqual(
      suggested.dailyWorkflow.suggestedCommitments
    );
    expect(buildOutcomeDrafts(suggested, now)).toEqual(
      suggested.dailyWorkflow.suggestedOutcomes
    );
  });

  it("normalizes empty and whitespace-only draft fields before save", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.dailyBriefStatus = "ready";
    draft.dailyBrief.headline = "  ";
    draft.todayPlanStatus = "ready";
    draft.todayPlan.topPriority = "  ";
    draft.commitments = [
      {
        id: "commitment-1",
        title: "  Client follow-up  ",
        source: "system",
        sourceId: null,
        owner: "  ",
        dueAt: null,
        status: "open",
        url: null,
      },
    ];

    expect(
      normalizeDailyWorkflowDraftForSave(
        draft,
        new Date("2026-05-14T14:00:00.000Z")
      )
    ).toMatchObject({
      dailyBriefStatus: "not_started",
      todayPlanStatus: "not_started",
      commitments: [{ title: "Client follow-up", owner: null }],
    });
  });
});
