import { describe, expect, it } from "vitest";

import {
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
