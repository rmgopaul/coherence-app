import { describe, expect, it } from "vitest";

import {
  noteLinkInputForWorkspaceRow,
  workspaceNotesRoute,
  type WorkspaceNoteRow,
} from "./useWorkspaceNotes";

describe("workspaceNotesRoute", () => {
  it("targets task-linked notes for Todoist rows", () => {
    const row: WorkspaceNoteRow = {
      kind: "todoist",
      taskId: "task 1",
      content: "Mail contracts",
      taskUrl: "https://todoist.com/showTask?id=task%201",
    };

    expect(workspaceNotesRoute(row)).toBe("/notes?taskId=task%201");
  });

  it("targets event-linked notes for Calendar rows", () => {
    const row: WorkspaceNoteRow = {
      kind: "calendar",
      eventId: "evt/1",
      title: "Stand-up",
      eventUrl: "https://calendar.google.com/calendar/u/0/r/eventedit/evt",
    };

    expect(workspaceNotesRoute(row)).toBe("/notes?eventId=evt%2F1");
  });
});

describe("noteLinkInputForWorkspaceRow", () => {
  it("normalizes Todoist rows into note-link input", () => {
    const row: WorkspaceNoteRow = {
      kind: "todoist",
      taskId: "task-1",
      content: "Mail contracts",
      taskUrl: "https://todoist.com/showTask?id=task-1",
      dueDate: "Today",
      projectName: "Admin",
    };

    expect(noteLinkInputForWorkspaceRow(row, "note-1")).toEqual({
      noteId: "note-1",
      linkType: "todoist_task",
      externalId: "task-1",
      sourceUrl: "https://todoist.com/showTask?id=task-1",
      sourceTitle: "Mail contracts",
      metadata: {
        dueDate: "Today",
        projectName: "Admin",
      },
    });
  });

  it("normalizes Calendar rows with recurring identity metadata", () => {
    const row: WorkspaceNoteRow = {
      kind: "calendar",
      eventId: "event-1",
      title: "Weekly stand-up",
      eventUrl: "https://calendar.google.com/calendar/u/0/r/eventedit/event-1",
      start: "2026-05-14T10:00:00-05:00",
      location: "Zoom",
      recurringEventId: "series-1",
      iCalUID: "uid-1",
    };

    expect(noteLinkInputForWorkspaceRow(row, "note-1")).toEqual({
      noteId: "note-1",
      linkType: "google_calendar_event",
      externalId: "event-1",
      seriesId: "series-1",
      occurrenceStartIso: "2026-05-14T10:00:00-05:00",
      sourceUrl: "https://calendar.google.com/calendar/u/0/r/eventedit/event-1",
      sourceTitle: "Weekly stand-up",
      metadata: {
        location: "Zoom",
        recurringEventId: "series-1",
        iCalUID: "uid-1",
      },
    });
  });

  it("clips source titles to the addLink input limit", () => {
    const longTitle = "x".repeat(300);
    const row: WorkspaceNoteRow = {
      kind: "todoist",
      taskId: "task-1",
      content: longTitle,
      taskUrl: "https://todoist.com/showTask?id=task-1",
    };

    expect(
      noteLinkInputForWorkspaceRow(row, "note-1").sourceTitle
    ).toHaveLength(255);
  });
});
