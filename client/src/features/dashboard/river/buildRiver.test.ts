import { describe, expect, it } from "vitest";
import { buildRiver } from "./buildRiver";
import type {
  CalendarEvent,
  GmailMessage,
  TodoistTask,
} from "../types";

const NOW = new Date(2026, 3, 20, 10, 0, 0); // 2026-04-20 10:00 local

function calEvent(overrides: Partial<CalendarEvent> & { startIso: string }) {
  const base = {
    id: overrides.id ?? `cal-${overrides.startIso}`,
    summary: overrides.summary ?? "Untitled",
    start: { dateTime: overrides.startIso },
    end: undefined,
    location: overrides.location ?? null,
    htmlLink: overrides.htmlLink ?? null,
  } as unknown as CalendarEvent;
  return base;
}

function task(
  id: string,
  content: string,
  priority: 1 | 2 | 3 | 4,
  dueIso?: string
) {
  return {
    id,
    content,
    priority,
    due: dueIso ? { date: dueIso } : null,
  } as unknown as TodoistTask;
}

function mail(
  id: string,
  internalDate: number,
  subject: string,
  from: string,
  starred = false
) {
  return {
    id,
    threadId: id,
    internalDate: String(internalDate),
    labelIds: ["UNREAD", ...(starred ? ["STARRED"] : [])],
    snippet: "",
    payload: {
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: from },
      ],
    },
  } as unknown as GmailMessage;
}

describe("buildRiver", () => {
  it("returns chronologically sorted items across kinds", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [
        calEvent({ id: "c1", summary: "Standup", startIso: new Date(2026, 3, 20, 9).toISOString() }),
        calEvent({ id: "c2", summary: "Lunch", startIso: new Date(2026, 3, 20, 12).toISOString() }),
      ],
      tasks: [task("t1", "Ship feature", 4, "2026-04-20T16:00:00")],
      inbox: [mail("m1", new Date(2026, 3, 20, 11).getTime(), "Re: status", "Alice")],
    });

    // Order is by ts: 9am Standup → 11am mail → 12pm Lunch → 16:00 task
    expect(items.map((i) => i.kind)).toEqual(["cal", "mail", "cal", "task"]);
    expect(items[0].title).toBe("Standup");
    expect(items[items.length - 1].title).toBe("Ship feature");
  });

  it("scopes to the day window — yesterday + tomorrow are dropped", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [
        calEvent({ id: "y", summary: "Yesterday", startIso: new Date(2026, 3, 19, 9).toISOString() }),
        calEvent({ id: "t", summary: "Today", startIso: new Date(2026, 3, 20, 9).toISOString() }),
        calEvent({ id: "m", summary: "Tomorrow", startIso: new Date(2026, 3, 21, 9).toISOString() }),
      ],
      tasks: [],
      inbox: [],
    });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Today");
  });

  it("sizes priorities right (P1=huge, P4=sm)", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [],
      tasks: [
        task("t1", "P1 task", 4, "2026-04-20T16:00:00"),
        task("t2", "P4 task", 1, "2026-04-20T17:00:00"),
      ],
      inbox: [],
    });
    expect(items[0].size).toBe("huge");
    expect(items[1].size).toBe("sm");
  });

  it("calendar events within ~1h of now get bumped to 'big'", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [
        calEvent({ id: "near", summary: "Near", startIso: new Date(2026, 3, 20, 10, 30).toISOString() }),
        calEvent({ id: "far", summary: "Far", startIso: new Date(2026, 3, 20, 16, 0).toISOString() }),
      ],
      tasks: [],
      inbox: [],
    });
    const near = items.find((i) => i.title === "Near");
    const far = items.find((i) => i.title === "Far");
    expect(near?.size).toBe("big");
    expect(far?.size).toBe("med");
  });

  it("starred mail is 'med', plain mail is 'sm'", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [],
      tasks: [],
      inbox: [
        mail("m1", new Date(2026, 3, 20, 9).getTime(), "Plain", "a@x", false),
        mail("m2", new Date(2026, 3, 20, 10).getTime(), "Starred", "b@x", true),
      ],
    });
    expect(items.find((i) => i.title === "Plain")?.size).toBe("sm");
    expect(items.find((i) => i.title === "Starred")?.size).toBe("med");
  });

  it("caps mail to 8 most recent within the day", () => {
    const inbox = Array.from({ length: 12 }, (_, i) =>
      mail(`m${i}`, new Date(2026, 3, 20, 8 + i).getTime(), `Subject ${i}`, "x@y")
    );
    const items = buildRiver({ now: NOW, calendar: [], tasks: [], inbox });
    expect(items.filter((i) => i.kind === "mail")).toHaveLength(8);
  });

  it("date-only tasks anchor at local noon", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [],
      tasks: [task("t1", "Pay bill", 2, "2026-04-20")],
      inbox: [],
    });
    const item = items[0];
    const d = new Date(item.ts);
    expect(d.getHours()).toBe(12);
    expect(d.getMinutes()).toBe(0);
  });

  it("tasks without a due date land in the noon slot", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [],
      tasks: [task("t1", "Floating", 1)],
      inbox: [],
    });
    expect(new Date(items[0].ts).getHours()).toBe(12);
  });

  it("preserves the original event id in the river id", () => {
    const items = buildRiver({
      now: NOW,
      calendar: [calEvent({ id: "cal-abc", summary: "X", startIso: NOW.toISOString() })],
      tasks: [],
      inbox: [],
    });
    expect(items[0].id).toBe("cal-cal-abc");
  });
});
