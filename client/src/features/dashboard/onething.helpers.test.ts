import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveOneThing, pickAfterThat } from "./onething.helpers";
import type { CalendarEvent, TodoistTask } from "./types";

const NOW = new Date(2026, 3, 20, 10, 0, 0);
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

function calEvent(
  id: string,
  summary: string,
  startIso: string | null,
  startDate: string | null = null
): CalendarEvent {
  return {
    id,
    summary,
    start: startIso ? { dateTime: startIso } : { date: startDate ?? "" },
  } as unknown as CalendarEvent;
}

describe("deriveOneThing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the server king when present", () => {
    const out = deriveOneThing({
      kingOfDay: { title: "Ship Schedule B", reason: "blocking everything", source: "manual" },
      tasks: { dueToday: [] },
    });
    expect(out.title).toBe("Ship Schedule B");
    expect(out.reason).toBe("blocking everything");
    expect(out.meta.sourceLabel).toBe("PINNED");
  });

  it("labels source as AI when source=ai", () => {
    const out = deriveOneThing({
      kingOfDay: { title: "X", reason: null, source: "ai" },
      tasks: { dueToday: [] },
    });
    expect(out.meta.sourceLabel).toBe("AI · KING OF DAY");
    expect(out.reason).toBe("today's headline");
  });

  it("labels source as AUTO when source=auto", () => {
    const out = deriveOneThing({
      kingOfDay: { title: "X", reason: null, source: "auto" },
      tasks: { dueToday: [] },
    });
    expect(out.meta.sourceLabel).toBe("AUTO · KING OF DAY");
  });

  it("falls back to most-overdue task when no king", () => {
    const out = deriveOneThing({
      kingOfDay: null,
      tasks: {
        dueToday: [
          task("a", "today P1", 4, "2026-04-20"),
          task("b", "yesterday P3", 2, "2026-04-19"),
        ],
      },
    });
    expect(out.title).toBe("yesterday P3");
    expect(out.reason).toBe("overdue — finish this first.");
    expect(out.meta.sourceLabel).toBe("TODOIST");
  });

  it("falls back to highest-priority today task when nothing overdue", () => {
    const out = deriveOneThing({
      kingOfDay: null,
      tasks: {
        dueToday: [
          task("a", "P3 today", 2, "2026-04-20"),
          task("b", "P1 today", 4, "2026-04-20"),
        ],
      },
    });
    expect(out.title).toBe("P1 today");
    expect(out.reason).toBe("P1 today — start here.");
    expect(out.meta.sourceLabel).toBe("TODOIST");
  });

  it("returns the empty state when nothing burning", () => {
    const out = deriveOneThing({ kingOfDay: null, tasks: { dueToday: [] } });
    expect(out.title).toBe("nothing burning.");
    expect(out.reason).toBe("pick one and ship it.");
    expect(out.meta.sourceLabel).toBe("EMPTY");
  });

  it("server king with no source label still resolves", () => {
    const out = deriveOneThing({
      kingOfDay: { title: "X", reason: "y", source: null },
      tasks: { dueToday: [] },
    });
    expect(out.meta.sourceLabel).toBe("AUTO · KING OF DAY");
  });
});

describe("pickAfterThat", () => {
  it("returns the next 3 future events sorted ascending", () => {
    const out = pickAfterThat(
      [
        calEvent("a", "Standup", new Date(2026, 3, 20, 9, 0).toISOString()),
        calEvent("b", "Lunch", new Date(2026, 3, 20, 12, 0).toISOString()),
        calEvent("c", "Coffee", new Date(2026, 3, 20, 11, 0).toISOString()),
        calEvent("d", "Walk", new Date(2026, 3, 20, 16, 0).toISOString()),
      ],
      NOW_MS
    );
    expect(out.map((e) => e.id)).toEqual(["c", "b", "d"]);
  });

  it("filters out past events", () => {
    const out = pickAfterThat(
      [
        calEvent("past", "Earlier", new Date(2026, 3, 20, 9, 0).toISOString()),
        calEvent("future", "Later", new Date(2026, 3, 20, 15, 0).toISOString()),
      ],
      NOW_MS
    );
    expect(out.map((e) => e.id)).toEqual(["future"]);
  });

  it("ignores events with malformed start times", () => {
    const out = pickAfterThat(
      [
        calEvent("bad", "Bad", "not-a-date"),
        calEvent("good", "Good", new Date(2026, 3, 20, 15, 0).toISOString()),
      ],
      NOW_MS
    );
    expect(out.map((e) => e.id)).toEqual(["good"]);
  });

  it("respects custom limits", () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      calEvent(`e${i}`, `e${i}`, new Date(2026, 3, 20, 11 + i).toISOString())
    );
    expect(pickAfterThat(events, NOW_MS, 2)).toHaveLength(2);
    expect(pickAfterThat(events, NOW_MS, 5)).toHaveLength(5);
  });

  it("returns an empty array when no upcoming events", () => {
    expect(pickAfterThat([], NOW_MS)).toEqual([]);
  });
});
