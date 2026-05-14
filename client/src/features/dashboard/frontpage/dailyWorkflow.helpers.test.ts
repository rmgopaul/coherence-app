import { describe, expect, it } from "vitest";

import type { PersonalDashboardCommandCenter } from "@shared/personalDashboard";
import {
  buildCommitmentDraft,
  buildCommitmentDrafts,
  buildDailyBriefDraft,
  buildTodayPlanDraft,
  buildOutcomeDrafts,
  dailyWorkflowDraftFromState,
  dateTimeLocalInputFromIso,
  isoFromDateTimeLocalInput,
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
        dueAt: "not-a-date",
        status: "open",
        url: "javascript:alert(1)",
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
      commitments: [
        { title: "Client follow-up", owner: null, dueAt: null, url: null },
      ],
    });
  });

  it("normalizes today plan blocks before save", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.todayPlanStatus = "ready";
    draft.todayPlan.blocks = [
      {
        id: "block-1",
        title: "  Focus block  ",
        startIso: "2026-05-14T15:00:00.000Z",
        endIso: "not-a-date",
        source: "calendar",
        sourceId: " event-1 ",
        status: "active",
      },
      {
        id: "block-2",
        title: "   ",
        startIso: "2026-05-14T18:00:00.000Z",
        endIso: "2026-05-14T19:00:00.000Z",
        source: "system",
        sourceId: "ignored",
        status: "planned",
      },
    ];

    expect(
      normalizeDailyWorkflowDraftForSave(
        draft,
        new Date("2026-05-14T14:00:00.000Z")
      )
    ).toMatchObject({
      todayPlanStatus: "ready",
      todayPlan: {
        blocks: [
          {
            id: "block-1",
            title: "Focus block",
            startIso: "2026-05-14T15:00:00.000Z",
            endIso: null,
            source: "calendar",
            sourceId: "event-1",
            status: "active",
          },
        ],
      },
    });
  });

  it("preserves normalized commitment detail fields before save", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.commitments = [
      {
        id: "commitment-1",
        title: " Client follow-up ",
        source: "gmail",
        sourceId: "thread-1",
        owner: " client@example.com ",
        dueAt: "2026-05-14T15:30:00.000Z",
        status: "waiting",
        url: " https://mail.google.com/mail/u/0/#inbox/thread-1 ",
      },
    ];

    expect(
      normalizeDailyWorkflowDraftForSave(
        draft,
        new Date("2026-05-14T14:00:00.000Z")
      ).commitments[0]
    ).toMatchObject({
      title: "Client follow-up",
      owner: "client@example.com",
      dueAt: "2026-05-14T15:30:00.000Z",
      url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
    });
  });

  it("normalizes outcome metric fields before save", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.outcomes = [
      {
        id: "outcome-1",
        title: "  Send proposal  ",
        status: "active",
        metricLabel: " Progress ",
        target: " Sent today ",
        current: " Drafted ",
      },
      {
        id: "outcome-2",
        title: "   ",
        status: "paused",
        metricLabel: "Ignored",
        target: "Ignored",
        current: "Ignored",
      },
    ];

    expect(
      normalizeDailyWorkflowDraftForSave(
        draft,
        new Date("2026-05-14T14:00:00.000Z")
      ).outcomes
    ).toEqual([
      {
        id: "outcome-1",
        title: "Send proposal",
        status: "active",
        metricLabel: "Progress",
        target: "Sent today",
        current: "Drafted",
      },
    ]);
  });

  it("round-trips local datetime inputs through ISO strings", () => {
    const iso = isoFromDateTimeLocalInput("2026-05-14T09:15");

    expect(iso).toMatch(/^2026-05-14T/);
    expect(dateTimeLocalInputFromIso(iso)).toBe("2026-05-14T09:15");
    expect(isoFromDateTimeLocalInput(" ")).toBeNull();
    expect(dateTimeLocalInputFromIso("not-a-date")).toBe("");
  });
});
