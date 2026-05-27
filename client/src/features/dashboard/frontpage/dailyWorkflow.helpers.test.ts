import { describe, expect, it } from "vitest";

import type { PersonalDashboardCommandCenter } from "@shared/personalDashboard";
import {
  buildCommitmentDraft,
  buildCarryForwardDailyWorkflowPatch,
  buildCommitmentDrafts,
  buildDailyBriefDraft,
  buildEndOfDayReviewSummary,
  buildTodayPlanDraft,
  buildOutcomeDrafts,
  completeAllCommitments,
  createManualDailyWorkflowId,
  dailyWorkflowDraftFromState,
  dateTimeLocalInputFromIso,
  hasDailyBriefDraftContent,
  hasDailyWorkflowDraftContent,
  isoFromDateTimeLocalInput,
  normalizeDailyWorkflowDraftForSave,
  nextDailyWorkflowDateKey,
  refreshDailyBriefDraftFromSources,
  sourceUrlForBriefSourceRef,
  winActiveOutcomes,
  workspaceNoteRowFromBriefSourceRef,
  workspaceNoteRowFromDailyWorkflowItem,
  workspaceNoteRowsFromDailyWorkflowDraft,
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
  todayOps: {
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
          label: "Highest-priority task due today.",
          url: "https://todoist.com/app/task/task-1",
        },
      ],
    },
    cards: [],
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
  },
  workspacePrompts: [],
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
  it("creates collision-resistant manual workflow ids", () => {
    const first = createManualDailyWorkflowId("commitment");
    const second = createManualDailyWorkflowId("commitment");

    expect(first).toMatch(/^commitment:manual:/);
    expect(second).toMatch(/^commitment:manual:/);
    expect(first).not.toBe(second);
  });

  it("detects whether a draft has clearable content", () => {
    const draft = dailyWorkflowDraftFromState(null);
    expect(hasDailyWorkflowDraftContent(draft)).toBe(false);

    draft.dailyBrief.sourceRefs = [
      {
        source: "system",
        id: null,
        label: "Generated from command center",
        url: null,
      },
    ];
    expect(hasDailyWorkflowDraftContent(draft)).toBe(true);
  });

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

  it("refreshes a daily brief from source labels and current dashboard signals", () => {
    const refreshed = refreshDailyBriefDraftFromSources(
      {
        headline: "Old headline",
        summary: null,
        generatedAt: "2026-05-14T12:00:00.000Z",
        sourceRefs: [
          {
            source: "calendar",
            id: "event-1",
            label: "Design review",
            url: "https://calendar.google.com/event",
          },
          {
            source: "todoist",
            id: "task-1",
            label: "Close proposal",
            url: "https://todoist.com/app/task/task-1",
          },
        ],
      },
      commandCenter,
      new Date("2026-05-14T15:00:00.000Z")
    );

    expect(refreshed).toMatchObject({
      headline: "Design review",
      generatedAt: "2026-05-14T15:00:00.000Z",
      sourceRefs: [
        { source: "calendar", id: "event-1", label: "Design review" },
        { source: "todoist", id: "task-1", label: "Close proposal" },
      ],
    });
    expect(refreshed.summary).toContain(
      "Brief sources: 2 sources: Design review; Close proposal."
    );
    expect(refreshed.summary).toContain(
      "Current signals: 3 tasks due today; 2 meetings remaining"
    );
    expect(refreshed.summary).toContain("Right now: Close proposal");
  });

  it("falls back to the command-center priority when refreshing without source labels", () => {
    const refreshed = refreshDailyBriefDraftFromSources(
      {
        headline: " ",
        summary: "  Existing context  ",
        generatedAt: null,
        sourceRefs: [],
      },
      commandCenter,
      new Date("2026-05-14T15:00:00.000Z")
    );

    expect(refreshed.headline).toBe("Close proposal");
    expect(refreshed.summary).toContain("Current signals:");
    expect(refreshed.generatedAt).toBe("2026-05-14T15:00:00.000Z");
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

  it("normalizes daily brief source refs before save", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.dailyBriefStatus = "ready";
    draft.dailyBrief.headline = "  Morning brief  ";
    draft.dailyBrief.sourceRefs = [
      {
        source: "gmail",
        id: " thread-1 ",
        label: "  Client thread  ",
        url: " https://mail.google.com/mail/u/0/#inbox/thread-1 ",
      },
      {
        source: "todoist",
        id: "ignored",
        label: "   ",
        url: "https://todoist.com/app/task/task-1",
      },
      {
        source: "system",
        id: null,
        label: "Unsafe URL",
        url: "javascript:alert(1)",
      },
    ];

    expect(
      normalizeDailyWorkflowDraftForSave(
        draft,
        new Date("2026-05-14T14:00:00.000Z")
      ).dailyBrief
    ).toMatchObject({
      headline: "Morning brief",
      sourceRefs: [
        {
          source: "gmail",
          id: "thread-1",
          label: "Client thread",
          url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
        },
        {
          source: "system",
          id: null,
          label: "Unsafe URL",
          url: null,
        },
      ],
    });
  });

  it("preserves summary and source refs when a brief has no headline", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.dailyBriefStatus = "ready";
    draft.dailyBrief.headline = "  ";
    draft.dailyBrief.summary = "  Client context only  ";
    draft.dailyBrief.sourceRefs = [
      {
        source: "gmail",
        id: " thread-1 ",
        label: "  Client thread  ",
        url: " https://mail.google.com/mail/u/0/#inbox/thread-1 ",
      },
    ];

    const normalized = normalizeDailyWorkflowDraftForSave(
      draft,
      new Date("2026-05-14T14:00:00.000Z")
    );

    expect(hasDailyBriefDraftContent(normalized.dailyBrief)).toBe(true);
    expect(normalized.dailyBriefStatus).toBe("ready");
    expect(normalized.dailyBrief).toMatchObject({
      headline: "",
      summary: "Client context only",
      sourceRefs: [
        {
          source: "gmail",
          id: "thread-1",
          label: "Client thread",
          url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
        },
      ],
    });
  });

  it("applies workflow bulk status actions without mutating terminal rows", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.commitments = [
      {
        id: "commitment-1",
        title: "Follow up",
        source: "gmail",
        sourceId: "thread-1",
        owner: null,
        dueAt: null,
        status: "open",
        url: null,
      },
      {
        id: "commitment-2",
        title: "Already done",
        source: "system",
        sourceId: null,
        owner: null,
        dueAt: null,
        status: "done",
        url: null,
      },
    ];
    draft.outcomes = [
      {
        id: "outcome-1",
        title: "Send proposal",
        status: "active",
        metricLabel: "Progress",
        target: null,
        current: null,
      },
      {
        id: "outcome-2",
        title: "Paused outcome",
        status: "paused",
        metricLabel: null,
        target: null,
        current: null,
      },
    ];

    expect(
      completeAllCommitments(draft.commitments).map(item => item.status)
    ).toEqual(["done", "done"]);
    expect(winActiveOutcomes(draft.outcomes).map(item => item.status)).toEqual([
      "won",
      "paused",
    ]);
  });

  it("summarizes end-of-day review status and attention items", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.commitments = [
      {
        id: "commitment-1",
        title: "Send proposal",
        source: "todoist",
        sourceId: "task-1",
        owner: null,
        dueAt: null,
        status: "done",
        url: null,
      },
      {
        id: "commitment-2",
        title: "Client response",
        source: "gmail",
        sourceId: "thread-1",
        owner: null,
        dueAt: null,
        status: "waiting",
        url: null,
      },
    ];
    draft.outcomes = [
      {
        id: "outcome-1",
        title: "Proposal shipped",
        status: "active",
        metricLabel: "Progress",
        target: "Sent",
        current: null,
      },
    ];
    draft.todayPlan.blocks = [
      {
        id: "block-1",
        title: "Proposal block",
        startIso: null,
        endIso: null,
        source: "system",
        sourceId: null,
        status: "done",
      },
      {
        id: "block-2",
        title: "Review block",
        startIso: null,
        endIso: null,
        source: "system",
        sourceId: null,
        status: "planned",
      },
    ];

    expect(buildEndOfDayReviewSummary(draft)).toMatchObject({
      commitmentCounts: { total: 2, done: 1, waiting: 1 },
      outcomeCounts: { total: 1, active: 1 },
      planBlockCounts: { total: 2, done: 1, planned: 1 },
      needsAttention: [
        "1 waiting commitment",
        "1 active outcome",
        "1 planned block",
      ],
      tone: "attention",
    });
  });

  it("marks end-of-day review clear when tracked items are terminal", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.commitments = [
      {
        id: "commitment-1",
        title: "Done",
        source: "system",
        sourceId: null,
        owner: null,
        dueAt: null,
        status: "done",
        url: null,
      },
    ];
    draft.outcomes = [
      {
        id: "outcome-1",
        title: "Won",
        status: "won",
        metricLabel: "Progress",
        target: null,
        current: null,
      },
    ];
    draft.todayPlan.blocks = [
      {
        id: "block-1",
        title: "Skipped",
        startIso: null,
        endIso: null,
        source: "system",
        sourceId: null,
        status: "skipped",
      },
    ];

    expect(buildEndOfDayReviewSummary(draft)).toMatchObject({
      needsAttention: [],
      tone: "clear",
      summary: "Everything tracked for today has a terminal status.",
    });
  });

  it("builds a deduped carry-forward patch for tomorrow", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.commitments = [
      {
        id: "commitment-1",
        title: "Open commitment",
        source: "todoist",
        sourceId: "task-1",
        owner: null,
        dueAt: "2026-05-14T20:00:00.000Z",
        status: "open",
        url: "https://todoist.com/app/task/task-1",
      },
      {
        id: "commitment-2",
        title: "Done commitment",
        source: "system",
        sourceId: null,
        owner: null,
        dueAt: null,
        status: "done",
        url: null,
      },
    ];
    draft.outcomes = [
      {
        id: "outcome-1",
        title: "Active outcome",
        status: "active",
        metricLabel: "Progress",
        target: null,
        current: "Started",
      },
      {
        id: "outcome-2",
        title: "Won outcome",
        status: "won",
        metricLabel: null,
        target: null,
        current: null,
      },
    ];
    draft.todayPlan.blocks = [
      {
        id: "block-1",
        title: "Planned block",
        startIso: "2026-05-14T20:00:00.000Z",
        endIso: "2026-05-14T21:00:00.000Z",
        source: "calendar",
        sourceId: "event-1",
        status: "planned",
      },
    ];

    const patch = buildCarryForwardDailyWorkflowPatch(
      draft,
      {
        dateKey: "2026-05-15",
        dailyBriefStatus: "not_started",
        dailyBrief: null,
        todayPlanStatus: "not_started",
        todayPlan: null,
        commitments: [
          {
            id: "carry:2026-05-15:commitment:commitment-1",
            title: "Existing carried commitment",
            source: "todoist",
            sourceId: "task-1",
            owner: null,
            dueAt: null,
            status: "open",
            url: null,
          },
        ],
        outcomes: [],
        updatedAt: null,
      },
      "2026-05-14",
      "2026-05-15",
      new Date("2026-05-14T22:00:00.000Z")
    );

    expect(patch.carryForwardCount).toBe(2);
    expect(patch.commitments).toHaveLength(1);
    expect(patch.outcomes).toMatchObject([
      {
        id: "carry:2026-05-15:outcome:outcome-1",
        title: "Active outcome",
        status: "active",
      },
    ]);
    expect(patch.todayPlanStatus).toBe("draft");
    expect(patch.todayPlan).toMatchObject({
      topPriority: "Open commitment",
      notes: "Carried forward from 2026-05-14.",
      blocks: [
        {
          id: "carry:2026-05-15:plan-block:block-1",
          title: "Planned block",
          startIso: null,
          endIso: null,
          status: "planned",
        },
      ],
      updatedAt: "2026-05-14T22:00:00.000Z",
    });
  });

  it("computes the next daily workflow date key", () => {
    expect(nextDailyWorkflowDateKey("2026-05-14")).toBe("2026-05-15");
    expect(nextDailyWorkflowDateKey("2026-12-31")).toBe("2027-01-01");
  });

  it("builds workspace rows only for source-backed Todoist and Calendar items", () => {
    expect(
      workspaceNoteRowFromDailyWorkflowItem({
        id: "commitment-1",
        title: "Close proposal",
        source: "todoist",
        sourceId: " task-1 ",
        owner: null,
        dueAt: "2026-05-14T16:00:00.000Z",
        status: "open",
        url: null,
      })
    ).toMatchObject({
      kind: "todoist",
      taskId: "task-1",
      content: "Close proposal",
      dueDate: "2026-05-14T16:00:00.000Z",
      projectName: null,
    });

    expect(
      workspaceNoteRowFromDailyWorkflowItem({
        id: "block-1",
        title: "Prep call",
        source: "calendar",
        sourceId: "event-1",
        startIso: "2026-05-14T18:00:00.000Z",
        endIso: null,
        status: "planned",
      })
    ).toMatchObject({
      kind: "calendar",
      eventId: "event-1",
      title: "Prep call",
      start: "2026-05-14T18:00:00.000Z",
      location: null,
    });

    expect(
      workspaceNoteRowFromDailyWorkflowItem({
        id: "commitment-2",
        title: "Manual follow-up",
        source: "system",
        sourceId: null,
        owner: null,
        dueAt: null,
        status: "open",
        url: null,
      })
    ).toBeNull();
  });

  it("uses the source ID as a workspace title fallback while a draft title is empty", () => {
    expect(
      workspaceNoteRowFromDailyWorkflowItem({
        id: "commitment-1",
        title: "   ",
        source: "todoist",
        sourceId: "task-1",
        owner: null,
        dueAt: null,
        status: "open",
        url: null,
      })
    ).toMatchObject({
      kind: "todoist",
      content: "task-1",
    });
  });

  it("turns Todoist and Calendar brief sources into workspace rows", () => {
    expect(
      workspaceNoteRowFromBriefSourceRef({
        source: "todoist",
        id: " task-1 ",
        label: " Highest-priority task ",
        url: null,
      })
    ).toMatchObject({
      kind: "todoist",
      taskId: "task-1",
      content: "Highest-priority task",
      taskUrl: "https://app.todoist.com/app/task/task-1",
    });

    expect(
      workspaceNoteRowFromBriefSourceRef({
        source: "calendar",
        id: "event-1",
        label: "Design review",
        url: " https://calendar.google.com/event ",
      })
    ).toMatchObject({
      kind: "calendar",
      eventId: "event-1",
      title: "Design review",
      eventUrl: "https://calendar.google.com/event",
    });
  });

  it("collects every workspace-capable daily workflow row for batched counts", () => {
    const draft = dailyWorkflowDraftFromState(null);
    draft.dailyBrief.sourceRefs = [
      {
        source: "calendar",
        id: "event-1",
        label: "Design review",
        url: "https://calendar.google.com/event",
      },
      {
        source: "gmail",
        id: "thread-1",
        label: "Client thread",
        url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
      },
    ];
    draft.commitments = [
      {
        id: "commitment-1",
        title: "Close proposal",
        source: "todoist",
        sourceId: "task-1",
        owner: null,
        dueAt: null,
        status: "open",
        url: "https://todoist.com/app/task/task-1",
      },
    ];
    draft.todayPlan.blocks = [
      {
        id: "block-1",
        title: "Focus block",
        startIso: null,
        endIso: null,
        source: "system",
        sourceId: null,
        status: "planned",
      },
      {
        id: "block-2",
        title: "Meeting",
        startIso: "2026-05-14T15:00:00.000Z",
        endIso: null,
        source: "calendar",
        sourceId: "event-2",
        status: "planned",
      },
    ];

    expect(workspaceNoteRowsFromDailyWorkflowDraft(draft)).toMatchObject([
      { kind: "calendar", eventId: "event-1" },
      { kind: "todoist", taskId: "task-1" },
      { kind: "calendar", eventId: "event-2" },
    ]);
  });

  it("opens explicit brief-source URLs before deriving Todoist URLs", () => {
    expect(
      sourceUrlForBriefSourceRef({
        source: "todoist",
        id: "task-1",
        label: "Task",
        url: " https://todoist.com/showTask?id=task-1 ",
      })
    ).toBe("https://todoist.com/showTask?id=task-1");

    expect(
      sourceUrlForBriefSourceRef({
        source: "todoist",
        id: "task 1",
        label: "Task",
        url: null,
      })
    ).toBe("https://app.todoist.com/app/task/task%201");

    expect(
      sourceUrlForBriefSourceRef({
        source: "calendar",
        id: "event-1",
        label: "Event",
        url: null,
      })
    ).toBeNull();
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
