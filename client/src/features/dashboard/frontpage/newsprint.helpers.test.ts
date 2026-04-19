import { describe, expect, it } from "vitest";
import type { TodoistTask } from "../types";
import {
  countdownLabel,
  daysAgoLabel,
  eventLocationLabel,
  extractName,
  formatEventTime,
  isTaskOverdue,
  taskPriorityOrder,
} from "./newsprint.helpers";

function makeTask(overrides: Partial<TodoistTask> = {}): TodoistTask {
  // Partial cast — only the fields our helpers touch matter.
  return {
    priority: 1,
    due: null,
    content: "task",
    ...overrides,
  } as unknown as TodoistTask;
}

describe("taskPriorityOrder", () => {
  it("ranks P1 before P4 in ascending order", () => {
    const p1 = makeTask({ priority: 4 });
    const p4 = makeTask({ priority: 1 });
    expect(taskPriorityOrder(p1)).toBeLessThan(taskPriorityOrder(p4));
  });

  it("defaults missing priority to lowest", () => {
    const none = makeTask({ priority: undefined });
    const p1 = makeTask({ priority: 4 });
    expect(taskPriorityOrder(p1)).toBeLessThan(taskPriorityOrder(none));
  });
});

describe("isTaskOverdue", () => {
  const now = new Date("2026-04-19T12:00:00-05:00"); // CST midday

  it("returns false when the task has no due date", () => {
    expect(isTaskOverdue(makeTask({ due: null }), now)).toBe(false);
  });

  it("returns true for a due date before today", () => {
    const task = makeTask({ due: { date: "2026-04-10" } as TodoistTask["due"] });
    expect(isTaskOverdue(task, now)).toBe(true);
  });

  it("returns false for today's due date", () => {
    const task = makeTask({ due: { date: "2026-04-19" } as TodoistTask["due"] });
    expect(isTaskOverdue(task, now)).toBe(false);
  });

  it("returns false for a future due date", () => {
    const task = makeTask({ due: { date: "2026-04-25" } as TodoistTask["due"] });
    expect(isTaskOverdue(task, now)).toBe(false);
  });
});

describe("extractName", () => {
  it("pulls the display name out of a 'Name <email>' string", () => {
    expect(extractName('Jane Doe <jane@example.com>')).toBe("Jane Doe");
  });

  it("strips surrounding quotes from the display name", () => {
    expect(extractName('"Jane Doe" <jane@example.com>')).toBe("Jane Doe");
  });

  it("falls back to the email local-part when no name is present", () => {
    expect(extractName("jane@example.com")).toBe("jane");
  });

  it("falls back to the email local-part when bracket form has empty name", () => {
    expect(extractName("<jane@example.com>")).toBe("jane");
  });

  it("returns a dash for an empty string", () => {
    expect(extractName("")).toBe("—");
  });
});

describe("daysAgoLabel", () => {
  const now = new Date("2026-04-19T12:00:00Z").getTime();

  it("returns empty for undefined input", () => {
    expect(daysAgoLabel(undefined, now)).toBe("");
  });

  it("returns 'today' for same-day timestamps", () => {
    expect(daysAgoLabel("2026-04-19T06:00:00Z", now)).toBe("today");
  });

  it("returns '1d ago' for one day earlier", () => {
    expect(daysAgoLabel("2026-04-18T12:00:00Z", now)).toBe("1d ago");
  });

  it("pluralizes with a unit label", () => {
    expect(daysAgoLabel("2026-04-12T12:00:00Z", now)).toBe("7d ago");
  });
});

describe("eventLocationLabel", () => {
  it("collapses common video-meeting URLs to 'Video'", () => {
    const e = { location: "https://meet.google.com/abc-defg-hij" } as never;
    expect(eventLocationLabel(e)).toBe("Video");
  });

  it("truncates long physical locations", () => {
    const e = { location: "A very very very long street address, Oakland CA" } as never;
    const result = eventLocationLabel(e);
    expect(result).not.toBeNull();
    expect(result!.endsWith("…")).toBe(true);
    expect(result!.length).toBeLessThanOrEqual(26);
  });

  it("returns null when no location is set", () => {
    expect(eventLocationLabel({ location: "" } as never)).toBeNull();
  });
});

describe("formatEventTime", () => {
  it("returns a dash for missing input", () => {
    expect(formatEventTime(null)).toBe("—");
  });

  it("returns a dash for unparseable input", () => {
    expect(formatEventTime("not a date")).toBe("—");
  });
});

describe("countdownLabel", () => {
  const now = new Date("2026-04-19T12:00:00Z").getTime();

  it("returns empty for missing input", () => {
    expect(countdownLabel(undefined, now)).toBe("");
  });

  it("returns minutes only for sub-hour distances", () => {
    const in20 = new Date(now + 20 * 60_000).toISOString();
    expect(countdownLabel(in20, now)).toBe("20m");
  });

  it("formats hours and padded minutes for longer distances", () => {
    const in2h05 = new Date(now + (2 * 60 + 5) * 60_000).toISOString();
    expect(countdownLabel(in2h05, now)).toBe("2h 05m");
  });

  it("clamps to zero for past timestamps", () => {
    const past = new Date(now - 10 * 60_000).toISOString();
    expect(countdownLabel(past, now)).toBe("0m");
  });
});
