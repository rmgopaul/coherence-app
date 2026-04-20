import { describe, expect, it } from "vitest";
import {
  clockLabel,
  countOverdue,
  deriveCommandHeadline,
  pickNextEvent,
  pickUpcomingAfter,
} from "./command.helpers";
import type { CalendarEvent, TodoistTask } from "../types";

const NOW = new Date(2026, 3, 20, 14, 0, 0);
const NOW_MS = NOW.getTime();

function task(
  id: string,
  content: string,
  priority: 1 | 2 | 3 | 4,
  due?: string | null
): TodoistTask {
  return {
    id,
    content,
    priority,
    due: due ? { date: due } : null,
  } as unknown as TodoistTask;
}

function calEvent(id: string, summary: string, dateTime: string): CalendarEvent {
  return { id, summary, start: { dateTime } } as unknown as CalendarEvent;
}

describe("clockLabel", () => {
  it("formats with HH:MM:SS, uppercased", () => {
    const out = clockLabel(NOW);
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2}/);
    expect(out).toBe(out.toUpperCase());
  });
});

describe("countOverdue", () => {
  it("counts tasks dated strictly before today", () => {
    const out = countOverdue(
      [
        task("a", "yesterday", 1, "2026-04-19"),
        task("b", "today", 1, "2026-04-20"),
        task("c", "older", 1, "2026-04-01"),
      ],
      NOW
    );
    expect(out).toBe(2);
  });

  it("ignores tasks without a due date", () => {
    expect(
      countOverdue([task("a", "no due", 1)], NOW)
    ).toBe(0);
  });

  it("treats date+time strings by their date prefix", () => {
    expect(
      countOverdue(
        [task("a", "yesterday lunch", 1, "2026-04-19T12:30:00")],
        NOW
      )
    ).toBe(1);
  });

  it("returns 0 for an empty list", () => {
    expect(countOverdue([], NOW)).toBe(0);
  });
});

describe("deriveCommandHeadline", () => {
  it("uses the kingOfDay title + reason when present", () => {
    const out = deriveCommandHeadline({
      kingOfDay: { title: "Ship A", reason: "today" },
      tasks: [],
      now: NOW,
    });
    expect(out.headline).toBe("Ship A");
    expect(out.reason).toBe("today");
  });

  it("falls back to the first task's content + overdue-aware reason", () => {
    const out = deriveCommandHeadline({
      kingOfDay: null,
      tasks: [
        task("a", "Top task", 4, "2026-04-20"),
        task("b", "Old task", 2, "2026-04-19"),
      ],
      now: NOW,
    });
    expect(out.headline).toBe("Top task");
    expect(out.reason).toBe("1 overdue — fix the bleed first.");
  });

  it("falls back to 'ALL CLEAR' + 'ship something small.' when nothing", () => {
    const out = deriveCommandHeadline({
      kingOfDay: null,
      tasks: [],
      now: NOW,
    });
    expect(out.headline).toBe("ALL CLEAR");
    expect(out.reason).toBe("ship something small.");
  });

  it("uses king reason even when overdue tasks exist", () => {
    const out = deriveCommandHeadline({
      kingOfDay: { title: "X", reason: "explicit" },
      tasks: [task("a", "old", 1, "2026-04-19")],
      now: NOW,
    });
    expect(out.reason).toBe("explicit");
  });
});

describe("pickNextEvent", () => {
  it("returns the first future event + minsUntil", () => {
    const out = pickNextEvent(
      [
        calEvent("past", "Past", new Date(2026, 3, 20, 9).toISOString()),
        calEvent("next", "Next", new Date(2026, 3, 20, 14, 30).toISOString()),
      ],
      NOW_MS
    );
    expect(out.event?.id).toBe("next");
    expect(out.minsUntil).toBe(30);
  });

  it("returns nulls when nothing upcoming", () => {
    const out = pickNextEvent(
      [calEvent("past", "Past", new Date(2026, 3, 20, 9).toISOString())],
      NOW_MS
    );
    expect(out).toEqual({ event: null, minsUntil: null });
  });

  it("returns event with null minsUntil for unparsable start", () => {
    const out = pickNextEvent(
      [{
        id: "weird",
        summary: "weird",
        start: { dateTime: undefined, date: undefined },
      } as unknown as CalendarEvent],
      NOW_MS
    );
    expect(out.event).toBeNull();
  });
});

describe("pickUpcomingAfter", () => {
  it("returns up to N future events excluding the named id", () => {
    const out = pickUpcomingAfter(
      [
        calEvent("a", "A", new Date(2026, 3, 20, 14, 30).toISOString()),
        calEvent("b", "B", new Date(2026, 3, 20, 15).toISOString()),
        calEvent("c", "C", new Date(2026, 3, 20, 16).toISOString()),
      ],
      "a",
      NOW_MS,
      4
    );
    expect(out.map((e) => e.id)).toEqual(["b", "c"]);
  });

  it("filters out past events", () => {
    const out = pickUpcomingAfter(
      [
        calEvent("past", "P", new Date(2026, 3, 20, 9).toISOString()),
        calEvent("future", "F", new Date(2026, 3, 20, 15).toISOString()),
      ],
      null,
      NOW_MS
    );
    expect(out.map((e) => e.id)).toEqual(["future"]);
  });

  it("respects the limit", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      calEvent(`e${i}`, `e${i}`, new Date(2026, 3, 20, 15 + i).toISOString())
    );
    expect(pickUpcomingAfter(events, null, NOW_MS, 3)).toHaveLength(3);
  });
});
