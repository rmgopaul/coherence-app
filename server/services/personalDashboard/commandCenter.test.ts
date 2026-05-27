import { describe, expect, it } from "vitest";

import type { PersonalDashboardDailyState } from "@shared/personalDashboard";
import {
  buildPersonalDashboardDailyProgress,
  buildPersonalDashboardTodayOps,
  buildPersonalDashboardWorkflowSuggestions,
  buildPersonalDashboardWorkspacePrompts,
} from "./commandCenter";

function emptyDailyState(dateKey: string): PersonalDashboardDailyState {
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

describe("buildPersonalDashboardWorkflowSuggestions", () => {
  it("builds waiting commitments and top task outcomes from source signals", () => {
    const suggestions = buildPersonalDashboardWorkflowSuggestions({
      dateKey: "2026-05-14",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rightNow: {
        title: "Close proposal",
        kind: "todoist",
        sourceId: "task-2",
        sourceUrl: "https://todoist.com/app/task/task-2",
        reason: "Highest-priority task due today.",
      },
      waitingOn: [
        {
          threadId: "thread-1",
          subject: "Contract approval",
          to: "client@example.com",
        },
      ],
      tasks: [
        {
          id: "task-low",
          content: "Lower-priority task",
          priority: 1,
          due: { date: "2026-05-14" },
        },
        {
          id: "task-2",
          content: "Close proposal",
          priority: 4,
          due: { datetime: "2026-05-14T15:00:00.000Z" },
        },
        {
          id: "task-3",
          content: "Review contract",
          priority: 3,
          due: { datetime: "2026-05-14T09:00:00.000Z" },
        },
      ],
    });

    expect(suggestions.suggestedCommitments).toMatchObject([
      {
        id: "waiting-on:thread-1",
        title: "Follow up: Contract approval",
        source: "gmail",
        sourceId: "thread-1",
        owner: "client@example.com",
        status: "waiting",
        url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
      },
      {
        id: "right-now:todoist:task-2",
        title: "Close proposal",
        source: "todoist",
        sourceId: "task-2",
        status: "open",
      },
    ]);
    expect(suggestions.suggestedOutcomes.map(item => item.title)).toEqual([
      "Close proposal",
      "Review contract",
      "Lower-priority task",
    ]);
  });

  it("falls back to the right-now signal when no task outcomes exist", () => {
    const suggestions = buildPersonalDashboardWorkflowSuggestions({
      dateKey: "2026-05-14",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rightNow: {
        title: "Prep for board update",
        kind: "calendar",
        sourceId: "event-1",
        sourceUrl: null,
        reason: "Next scheduled commitment.",
      },
      waitingOn: [],
      tasks: [],
    });

    expect(suggestions.suggestedOutcomes).toEqual([
      {
        id: "fallback-outcome:2026-05-14:1778760000000",
        title: "Prep for board update",
        status: "active",
        metricLabel: "Progress",
        target: "Done today",
        current: null,
      },
    ]);
  });

  it("does not invent Gmail links or blank titles for incomplete source rows", () => {
    const suggestions = buildPersonalDashboardWorkflowSuggestions({
      dateKey: "2026-05-14",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rightNow: null,
      waitingOn: [{ subject: "   ", from: " partner@example.com " }],
      tasks: [{ id: "task-empty", content: "   ", priority: 4 }],
    });

    expect(suggestions.suggestedCommitments).toEqual([
      {
        id: "waiting-on:2026-05-14:0",
        title: "Follow up: Waiting-on thread",
        source: "gmail",
        sourceId: null,
        owner: "partner@example.com",
        dueAt: null,
        status: "waiting",
        url: null,
      },
    ]);
    expect(suggestions.suggestedOutcomes[0]).toMatchObject({
      id: "task-outcome:task-empty",
      title: "Outcome 1",
    });
  });
});

describe("buildPersonalDashboardWorkspacePrompts", () => {
  it("surfaces calendar, Todoist, and right-now workspace opportunities without links", () => {
    const prompts = buildPersonalDashboardWorkspacePrompts({
      now: new Date("2026-05-14T12:00:00.000Z"),
      rightNow: {
        title: "Close proposal",
        kind: "todoist",
        sourceId: "task-2",
        sourceUrl: "https://todoist.com/app/task/task-2",
        reason: "Highest-priority task due today.",
      },
      calendarEvents: [
        {
          id: "event-1",
          summary: "Client prep",
          htmlLink: "https://calendar.google.com/event?eid=event-1",
          start: { dateTime: "2026-05-14T13:00:00.000Z" },
        },
      ],
      tasks: [
        {
          id: "task-2",
          content: "Close proposal",
          priority: 4,
          url: "https://todoist.com/app/task/task-2",
        },
      ],
      noteCounts: {
        todoist: {},
        calendar: {},
      },
    });

    expect(prompts).toMatchObject([
      {
        kind: "calendar",
        sourceId: "event-1",
        actionLabel: "Prep meeting note",
        href: "/notes?eventId=event-1",
      },
      {
        kind: "todoist",
        sourceId: "task-2",
        actionLabel: "Create working note",
        href: "/notes?taskId=task-2",
      },
    ]);
  });

  it("omits candidates that already have linked notes", () => {
    const prompts = buildPersonalDashboardWorkspacePrompts({
      now: new Date("2026-05-14T12:00:00.000Z"),
      rightNow: null,
      calendarEvents: [
        {
          id: "event-1",
          summary: "Client prep",
          start: { dateTime: "2026-05-14T13:00:00.000Z" },
        },
      ],
      tasks: [
        {
          id: "task-2",
          content: "Close proposal",
          priority: 4,
        },
      ],
      noteCounts: {
        todoist: { "task-2": 1 },
        calendar: { "event-1": 2 },
      },
    });

    expect(prompts).toEqual([]);
  });

  it("uses Open workspace for a distinct right-now workspace prompt", () => {
    const prompts = buildPersonalDashboardWorkspacePrompts({
      now: new Date("2026-05-14T12:00:00.000Z"),
      rightNow: {
        title: "Prep board update",
        kind: "calendar",
        sourceId: "event-now",
        sourceUrl: null,
        reason: "Next scheduled commitment.",
      },
      calendarEvents: [],
      tasks: [],
      noteCounts: {
        todoist: {},
        calendar: {},
      },
    });

    expect(prompts).toMatchObject([
      {
        kind: "calendar",
        sourceId: "event-now",
        actionLabel: "Open workspace",
        href: "/notes?eventId=event-now",
      },
    ]);
  });
});

describe("buildPersonalDashboardTodayOps", () => {
  it("ranks right-now, next meeting, waiting-on threads, and high-priority tasks", () => {
    const dateKey = "2026-05-14";
    const dailyState = emptyDailyState(dateKey);
    const todayOps = buildPersonalDashboardTodayOps({
      dateKey,
      now: new Date("2026-05-14T12:00:00.000Z"),
      metrics: {
        tasksDueToday: 4,
        tasksCompletedToday: 1,
        meetingsRemaining: 2,
        inboxToTriage: 8,
        waitingOnCount: 4,
        dockReminderCount: 0,
        activeDockCount: 0,
      },
      rightNow: {
        title: "Close proposal",
        kind: "todoist",
        sourceId: "task-now",
        sourceUrl: "https://todoist.com/app/task/task-now",
        reason: "Highest-priority task due today.",
      },
      workspacePrompts: [
        {
          id: "workspace:calendar:event-1",
          kind: "calendar",
          sourceId: "event-1",
          title: "Client prep",
          sourceUrl: "https://calendar.google.com/event?eid=event-1",
          reason: "Upcoming calendar event has no linked workspace note.",
          actionLabel: "Prep meeting note",
          href: "/notes?eventId=event-1",
        },
      ],
      waitingOn: [
        { threadId: "thread-1", subject: "Contract approval", to: "A" },
        { threadId: "thread-2", subject: "Scope answer", to: "B" },
        { threadId: "thread-3", subject: "Invoice detail", to: "C" },
        { threadId: "thread-4", subject: "Overflow", to: "D" },
      ],
      tasks: [
        { id: "task-1", content: "Critical review", priority: 4 },
        { id: "task-2", content: "High-priority cleanup", priority: 3 },
      ],
      dailyState,
      dailyProgress: buildPersonalDashboardDailyProgress(dailyState),
    });

    expect(todayOps.cards).toHaveLength(6);
    expect(todayOps.cards.map(card => card.kind)).toEqual([
      "right_now",
      "workspace_prompt",
      "waiting_on",
      "waiting_on",
      "waiting_on",
      "todoist",
    ]);
    expect(todayOps.cards.map(card => card.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(todayOps.autoBrief).toMatchObject({
      headline: "Close proposal",
      generatedAt: "2026-05-14T12:00:00.000Z",
    });
    expect(todayOps.autoBrief.sourceRefs).toHaveLength(5);
  });

  it("builds an auto brief without requiring saved daily state", () => {
    const dateKey = "2026-05-14";
    const dailyState = emptyDailyState(dateKey);
    const todayOps = buildPersonalDashboardTodayOps({
      dateKey,
      now: new Date("2026-05-14T12:00:00.000Z"),
      metrics: {
        tasksDueToday: 0,
        tasksCompletedToday: 0,
        meetingsRemaining: 0,
        inboxToTriage: 0,
        waitingOnCount: 0,
        dockReminderCount: 0,
        activeDockCount: 0,
      },
      rightNow: null,
      workspacePrompts: [],
      waitingOn: [],
      tasks: [],
      dailyState,
      dailyProgress: buildPersonalDashboardDailyProgress(dailyState),
    });

    expect(todayOps.cards).toEqual([]);
    expect(todayOps.autoBrief.headline).toBe("Today Ops is clear");
    expect(todayOps.autoBrief.summaryBullets).toContain(
      "0 tasks due today; 0 completed tasks."
    );
  });

  it("includes unresolved saved daily state in cards and progress", () => {
    const dateKey = "2026-05-14";
    const dailyState: PersonalDashboardDailyState = {
      ...emptyDailyState(dateKey),
      todayPlanStatus: "ready",
      todayPlan: {
        topPriority: "Close proposal",
        notes: null,
        updatedAt: "2026-05-14T12:05:00.000Z",
        blocks: [
          {
            id: "block-1",
            title: "Draft client note",
            startIso: null,
            endIso: null,
            source: "system",
            sourceId: null,
            status: "planned",
          },
          {
            id: "block-2",
            title: "Already done",
            startIso: null,
            endIso: null,
            source: "system",
            sourceId: null,
            status: "done",
          },
        ],
      },
      commitments: [
        {
          id: "commitment-1",
          title: "Follow up with client",
          source: "gmail",
          sourceId: "thread-1",
          owner: null,
          dueAt: null,
          status: "waiting",
          url: null,
        },
        {
          id: "commitment-2",
          title: "Closed",
          source: "system",
          sourceId: null,
          owner: null,
          dueAt: null,
          status: "done",
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
        {
          id: "outcome-2",
          title: "Won already",
          status: "won",
          metricLabel: "Progress",
          target: "Done today",
          current: "Done",
        },
      ],
    };
    const progress = buildPersonalDashboardDailyProgress(dailyState);
    const todayOps = buildPersonalDashboardTodayOps({
      dateKey,
      now: new Date("2026-05-14T12:00:00.000Z"),
      metrics: {
        tasksDueToday: 0,
        tasksCompletedToday: 0,
        meetingsRemaining: 0,
        inboxToTriage: 0,
        waitingOnCount: 0,
        dockReminderCount: 0,
        activeDockCount: 0,
      },
      rightNow: null,
      workspacePrompts: [],
      waitingOn: [],
      tasks: [],
      dailyState,
      dailyProgress: progress,
    });

    expect(todayOps.cards.map(card => card.kind)).toEqual([
      "saved_commitment",
      "saved_outcome",
      "saved_plan_block",
    ]);
    expect(todayOps.progress).toMatchObject({
      commitments: { total: 2, waiting: 1, done: 1 },
      outcomes: { total: 2, active: 1, won: 1 },
      topPriority: "Close proposal",
    });
  });
});

describe("buildPersonalDashboardDailyProgress", () => {
  it("summarizes saved daily workflow counts and labels", () => {
    expect(
      buildPersonalDashboardDailyProgress({
        dailyBriefStatus: "ready",
        dailyBrief: {
          headline: "Protect client delivery",
          summary: null,
          generatedAt: "2026-05-14T12:00:00.000Z",
          sourceRefs: [],
        },
        todayPlanStatus: "ready",
        todayPlan: {
          topPriority: "Close proposal",
          notes: null,
          blocks: [],
          updatedAt: "2026-05-14T12:05:00.000Z",
        },
        commitments: [
          {
            id: "commitment-1",
            title: "Client follow-up",
            source: "gmail",
            sourceId: "thread-1",
            owner: "client@example.com",
            dueAt: null,
            status: "waiting",
            url: null,
          },
          {
            id: "commitment-2",
            title: "Review scope",
            source: "system",
            sourceId: null,
            owner: null,
            dueAt: null,
            status: "done",
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
          {
            id: "outcome-2",
            title: "Draft reviewed",
            status: "won",
            metricLabel: "Progress",
            target: "Done today",
            current: "Done",
          },
        ],
        updatedAt: "2026-05-14T12:10:00.000Z",
      })
    ).toMatchObject({
      dailyBriefStatus: "ready",
      todayPlanStatus: "ready",
      headline: "Protect client delivery",
      topPriority: "Close proposal",
      updatedAt: "2026-05-14T12:10:00.000Z",
      commitments: {
        total: 2,
        open: 0,
        waiting: 1,
        blocked: 0,
        done: 1,
      },
      outcomes: {
        total: 2,
        active: 1,
        paused: 0,
        won: 1,
        missed: 0,
      },
      tone: "planned",
    });
  });

  it("marks failed, blocked, or missed workflow state as attention", () => {
    expect(
      buildPersonalDashboardDailyProgress({
        dailyBriefStatus: "failed",
        dailyBrief: null,
        todayPlanStatus: "draft",
        todayPlan: null,
        commitments: [
          {
            id: "commitment-1",
            title: "Blocked item",
            source: "system",
            sourceId: null,
            owner: null,
            dueAt: null,
            status: "blocked",
            url: null,
          },
        ],
        outcomes: [
          {
            id: "outcome-1",
            title: "Missed outcome",
            status: "missed",
            metricLabel: null,
            target: null,
            current: null,
          },
        ],
        updatedAt: null,
      }).tone
    ).toBe("attention");
  });

  it("distinguishes empty and completed workflow state", () => {
    expect(
      buildPersonalDashboardDailyProgress({
        dailyBriefStatus: "not_started",
        dailyBrief: null,
        todayPlanStatus: "not_started",
        todayPlan: null,
        commitments: [],
        outcomes: [],
        updatedAt: null,
      }).tone
    ).toBe("empty");

    expect(
      buildPersonalDashboardDailyProgress({
        dailyBriefStatus: "not_started",
        dailyBrief: {
          headline: "",
          summary: "Client context only",
          generatedAt: "2026-05-14T12:00:00.000Z",
          sourceRefs: [],
        },
        todayPlanStatus: "not_started",
        todayPlan: null,
        commitments: [],
        outcomes: [],
        updatedAt: "2026-05-14T12:10:00.000Z",
      }).tone
    ).toBe("planned");

    expect(
      buildPersonalDashboardDailyProgress({
        dailyBriefStatus: "ready",
        dailyBrief: null,
        todayPlanStatus: "completed",
        todayPlan: null,
        commitments: [
          {
            id: "commitment-1",
            title: "Done item",
            source: "system",
            sourceId: null,
            owner: null,
            dueAt: null,
            status: "done",
            url: null,
          },
        ],
        outcomes: [
          {
            id: "outcome-1",
            title: "Won item",
            status: "won",
            metricLabel: null,
            target: null,
            current: null,
          },
        ],
        updatedAt: "2026-05-14T17:00:00.000Z",
      }).tone
    ).toBe("complete");
  });
});
