import { describe, expect, it } from "vitest";

import { buildPersonalDashboardWorkflowSuggestions } from "./commandCenter";

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
    expect(suggestions.suggestedOutcomes.map((item) => item.title)).toEqual([
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
