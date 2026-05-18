import { describe, expect, it } from "vitest";

import type { CalendarEvent, GmailMessage, TodoistTask } from "../types";
import {
  calendarBriefSourceOptions,
  gmailBriefSourceOptions,
  sourceRefPatchFromPickerOption,
  todoistBriefSourceOptions,
} from "./briefSourcePicker.helpers";

describe("brief source picker helpers", () => {
  it("builds meaningful Todoist source options from due-today tasks", () => {
    const options = todoistBriefSourceOptions([
      {
        id: "task-1",
        content: "Send proposal",
        description: "",
        projectId: "project-1",
        priority: 4,
        labels: [],
      },
    ] as TodoistTask[]);

    expect(options).toEqual([
      {
        key: "todoist:task-1",
        source: "todoist",
        id: "task-1",
        label: "Send proposal",
        url: "https://todoist.com/showTask?id=task-1",
        display: "Send proposal",
      },
    ]);
  });

  it("builds Gmail options from recent message subject lines", () => {
    const options = gmailBriefSourceOptions([
      {
        id: "msg-1",
        threadId: "thread-1",
        snippet: "Please review",
        internalDate: "1760000000000",
        payload: {
          headers: [
            { name: "From", value: "Client <client@example.com>" },
            { name: "Subject", value: "Contract review" },
          ],
        },
      },
    ] as GmailMessage[]);

    expect(options[0]).toMatchObject({
      key: "gmail:thread-1",
      source: "gmail",
      id: "thread-1",
      label: "Contract review",
      url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
      display: "Contract review - Client <client@example.com>",
    });
  });

  it("keeps calendar options within the next six months", () => {
    const now = new Date("2026-05-17T12:00:00.000Z");
    const options = calendarBriefSourceOptions(
      [
        {
          id: "event-1",
          summary: "Pipeline review",
          htmlLink: "https://calendar.google.com/event?eid=event-1",
          start: { dateTime: "2026-06-01T15:00:00.000Z" },
        },
        {
          id: "event-2",
          summary: "Too far away",
          start: { dateTime: "2026-12-01T15:00:00.000Z" },
        },
      ] as CalendarEvent[],
      now
    );

    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      key: "calendar:event-1",
      source: "calendar",
      id: "event-1",
      label: "Pipeline review",
      url: "https://calendar.google.com/event?eid=event-1",
    });
    expect(options[0].display).toContain("Pipeline review - ");
  });

  it("converts selected options into stored source refs without leaking display-only text", () => {
    expect(
      sourceRefPatchFromPickerOption({
        key: "gmail:thread-1",
        source: "gmail",
        id: "thread-1",
        label: "Contract review",
        url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
        display: "Contract review - Client <client@example.com>",
      })
    ).toEqual({
      id: "thread-1",
      label: "Contract review",
      url: "https://mail.google.com/mail/u/0/#inbox/thread-1",
    });
  });
});
