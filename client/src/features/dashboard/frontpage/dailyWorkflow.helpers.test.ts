import { describe, expect, it } from "vitest";

import type { PersonalDashboardCommandCenter } from "@shared/personalDashboard";
import {
  buildCommitmentDraft,
  buildDailyBriefDraft,
  buildTodayPlanDraft,
  dailyWorkflowDraftFromState,
  normalizeDailyWorkflowDraftForSave,
} from "./dailyWorkflow.helpers";

const commandCenter: PersonalDashboardCommandCenter = {
  _runnerVersion: "personal-dashboard-command-center-v1",
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
  },
  rightNow: {
    title: "Close proposal",
    kind: "todoist",
    sourceId: "task-1",
    sourceUrl: "https://todoist.com/app/task/task-1",
    reason: "Highest-priority task due today.",
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
