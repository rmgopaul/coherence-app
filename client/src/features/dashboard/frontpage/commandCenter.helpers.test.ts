import { describe, expect, it } from "vitest";

import type {
  PersonalDashboardDailyProgress,
  PersonalDashboardWorkspacePrompt,
} from "@shared/personalDashboard";
import {
  buildWorkflowReviewPrompts,
  workspacePromptToWorkspaceNoteRow,
} from "./commandCenter.helpers";

const baseProgress: PersonalDashboardDailyProgress = {
  dailyBriefStatus: "ready",
  todayPlanStatus: "ready",
  headline: "Morning brief",
  topPriority: "Close proposal",
  updatedAt: "2026-05-14T14:00:00.000Z",
  commitments: {
    total: 2,
    open: 1,
    waiting: 0,
    blocked: 0,
    done: 1,
  },
  outcomes: {
    total: 1,
    active: 1,
    paused: 0,
    won: 0,
    missed: 0,
  },
  tone: "planned",
};

describe("commandCenter helpers", () => {
  it("prioritizes missing workflow setup prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        dailyBriefStatus: "not_started",
        todayPlanStatus: "not_started",
      })
    ).toEqual(["Commit today's plan"]);
  });

  it("surfaces failed daily brief review before setup prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        dailyBriefStatus: "failed",
        todayPlanStatus: "not_started",
      })
    ).toEqual(["Review failed daily brief", "Commit today's plan"]);
  });

  it("summarizes blocked, waiting, and missed review prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        commitments: {
          total: 4,
          open: 0,
          waiting: 2,
          blocked: 1,
          done: 1,
        },
        outcomes: {
          total: 3,
          active: 0,
          paused: 0,
          won: 1,
          missed: 2,
        },
      })
    ).toEqual([
      "Review 1 blocked commitment",
      "Check 2 waiting commitments",
      "Review 2 missed outcomes",
    ]);
  });

  it("surfaces end-of-day closure prompts", () => {
    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        todayPlanStatus: "completed",
        tone: "complete",
      })
    ).toEqual(["Close 1 active outcome"]);

    expect(
      buildWorkflowReviewPrompts({
        ...baseProgress,
        todayPlanStatus: "completed",
        outcomes: {
          total: 1,
          active: 0,
          paused: 0,
          won: 1,
          missed: 0,
        },
        tone: "complete",
      })
    ).toEqual(["Ready for end-of-day review"]);
  });

  it("converts Todoist workspace prompts into linked-note creation rows", () => {
    const prompt: PersonalDashboardWorkspacePrompt = {
      id: "workspace:todoist:task-1",
      kind: "todoist",
      sourceId: "task-1",
      title: "Close proposal",
      sourceUrl: null,
      reason: "High-priority Todoist task has no linked workspace note.",
      actionLabel: "Create working note",
      href: "/notes?taskId=task-1",
    };

    expect(workspacePromptToWorkspaceNoteRow(prompt)).toEqual({
      kind: "todoist",
      taskId: "task-1",
      content: "Close proposal",
      taskUrl: "https://app.todoist.com/app/task/task-1",
      dueDate: null,
      projectName: null,
    });
  });

  it("converts Calendar workspace prompts into linked-note creation rows", () => {
    const prompt: PersonalDashboardWorkspacePrompt = {
      id: "workspace:calendar:event-1",
      kind: "calendar",
      sourceId: "event-1",
      title: "Design review",
      sourceUrl: "https://calendar.google.com/event",
      reason: "Upcoming calendar event has no linked workspace note.",
      actionLabel: "Prep meeting note",
      href: "/notes?eventId=event-1",
    };

    expect(workspacePromptToWorkspaceNoteRow(prompt)).toEqual({
      kind: "calendar",
      eventId: "event-1",
      title: "Design review",
      eventUrl: "https://calendar.google.com/event",
      start: null,
      location: null,
      recurringEventId: null,
      iCalUID: null,
    });
  });
});
