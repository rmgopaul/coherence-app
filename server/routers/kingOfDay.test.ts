import { describe, expect, it } from "vitest";
import { __test__ } from "./kingOfDay";
import type { DockItem } from "../../drizzle/schema";

const {
  daysOverdue,
  dockItemKingTitle,
  parseEmailSentDateMs,
  isWaitingOnOlderThanThreshold,
  waitingOnAgeDays,
  isTodoistTaskStillActive,
} = __test__;

function makeDockItem(overrides: Partial<DockItem> = {}): DockItem {
  return {
    id: "d-1",
    userId: 1,
    source: "url",
    url: "https://example.com/path",
    urlCanonical: "https://example.com/path",
    title: null,
    meta: null,
    pinnedAt: null,
    x: null,
    y: null,
    tilt: null,
    color: null,
    createdAt: new Date("2026-04-20T10:00:00Z"),
    updatedAt: new Date("2026-04-20T10:00:00Z"),
    ...overrides,
  } as DockItem;
}

function makeTask(
  due:
    | string
    | { date: string; datetime?: string; string?: string }
    | null,
  overrides: Record<string, unknown> = {}
) {
  const dueObj =
    typeof due === "string"
      ? { date: due, string: due }
      : due ?? undefined;
  return {
    id: "t-1",
    content: "task",
    description: "",
    projectId: "p-1",
    priority: 1,
    labels: [],
    ...overrides,
    due: dueObj,
  } as unknown as Parameters<typeof daysOverdue>[0];
}

describe("daysOverdue", () => {
  const fixedNow = new Date("2026-04-19T12:00:00-05:00"); // CST midday

  it("returns 0 for a task without a due date", () => {
    expect(daysOverdue(makeTask(null), fixedNow)).toBe(0);
  });

  it("returns 0 for today's due date", () => {
    expect(daysOverdue(makeTask("2026-04-19"), fixedNow)).toBe(0);
  });

  it("returns 0 for a future due date", () => {
    expect(daysOverdue(makeTask("2026-04-25"), fixedNow)).toBe(0);
  });

  it("returns the integer day count for past due dates", () => {
    expect(daysOverdue(makeTask("2026-04-18"), fixedNow)).toBe(1);
    expect(daysOverdue(makeTask("2026-04-12"), fixedNow)).toBe(7);
  });

  it("parses YYYY-MM-DD as local midnight (not UTC)", () => {
    // `new Date("2026-04-19")` is UTC midnight; in CST that's
    // 2026-04-18 19:00, which the naive implementation would flag
    // as overdue today. The parser must read the date-only string
    // as a local date so today's task is never overdue.
    expect(daysOverdue(makeTask("2026-04-19"), fixedNow)).toBe(0);
  });

  it("handles datetime-form due values", () => {
    expect(
      daysOverdue(
        makeTask({
          datetime: "2026-04-15T14:00:00Z",
          date: "2026-04-15",
          string: "",
        }),
        fixedNow
      )
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("dockItemKingTitle (Task 10.2)", () => {
  it("prefers a non-empty title", () => {
    expect(
      dockItemKingTitle(makeDockItem({ title: "Q2 launch checklist" }))
    ).toBe("Q2 launch checklist");
  });

  it("trims whitespace before considering a title empty", () => {
    expect(
      dockItemKingTitle(
        makeDockItem({
          title: "   ",
          url: "https://docs.google.com/document/d/abc",
        })
      )
    ).toBe("docs.google.com/document/d/abc");
  });

  it("falls back to host + path when title is null", () => {
    expect(
      dockItemKingTitle(
        makeDockItem({
          title: null,
          url: "https://app.todoist.com/app/task/12345",
        })
      )
    ).toBe("app.todoist.com/app/task/12345");
  });

  it("drops the path segment when the URL is just a host", () => {
    expect(
      dockItemKingTitle(
        makeDockItem({ title: null, url: "https://example.com/" })
      )
    ).toBe("example.com");
  });

  it("falls back to truncated raw URL when the URL is unparseable", () => {
    expect(
      dockItemKingTitle(
        makeDockItem({ title: null, url: "not a url at all" })
      )
    ).toBe("not a url at all");
  });

  it("caps URL-derived titles at 80 chars", () => {
    const longPath = "/p".repeat(100);
    const result = dockItemKingTitle(
      makeDockItem({ title: null, url: `https://example.com${longPath}` })
    );
    expect(result.length).toBeLessThanOrEqual(80);
  });
});

describe("parseEmailSentDateMs (Task 10.2)", () => {
  it("returns null for null/undefined/empty", () => {
    expect(parseEmailSentDateMs(null)).toBeNull();
    expect(parseEmailSentDateMs(undefined)).toBeNull();
    expect(parseEmailSentDateMs("")).toBeNull();
  });

  it("parses an RFC 5322 Gmail Date header", () => {
    const ms = parseEmailSentDateMs(
      "Mon, 19 Apr 2026 14:30:00 -0500"
    );
    expect(ms).toBeTypeOf("number");
    expect(ms).toBe(new Date("2026-04-19T14:30:00-05:00").getTime());
  });

  it("returns null for unparseable strings", () => {
    expect(parseEmailSentDateMs("not a date")).toBeNull();
  });
});

describe("isWaitingOnOlderThanThreshold (Task 10.2)", () => {
  const now = new Date("2026-04-20T12:00:00-05:00");

  it("returns false for a row sent today", () => {
    expect(
      isWaitingOnOlderThanThreshold(
        { date: "Mon, 20 Apr 2026 09:00:00 -0500" },
        now
      )
    ).toBe(false);
  });

  it("returns false for a row sent exactly 7 days ago", () => {
    // The threshold is strictly greater than 7 days — exactly 7
    // days is NOT yet "old enough" to surface as a king candidate.
    expect(
      isWaitingOnOlderThanThreshold(
        { date: "Mon, 13 Apr 2026 12:00:00 -0500" },
        now
      )
    ).toBe(false);
  });

  it("returns true for a row sent 8 days ago", () => {
    expect(
      isWaitingOnOlderThanThreshold(
        { date: "Sun, 12 Apr 2026 12:00:00 -0500" },
        now
      )
    ).toBe(true);
  });

  it("returns true for a row sent 30 days ago", () => {
    expect(
      isWaitingOnOlderThanThreshold(
        { date: "Sat, 21 Mar 2026 12:00:00 -0500" },
        now
      )
    ).toBe(true);
  });

  it("returns false (defensive) when the date is unparseable", () => {
    expect(
      isWaitingOnOlderThanThreshold({ date: "garbage" }, now)
    ).toBe(false);
  });

  it("returns false (defensive) when the date field is missing", () => {
    expect(isWaitingOnOlderThanThreshold({}, now)).toBe(false);
  });
});

describe("waitingOnAgeDays (Task 10.2)", () => {
  const now = new Date("2026-04-20T12:00:00-05:00");

  it("returns 0 for a row sent today", () => {
    expect(
      waitingOnAgeDays(
        { date: "Mon, 20 Apr 2026 09:00:00 -0500" },
        now
      )
    ).toBe(0);
  });

  it("returns the integer day count for older rows", () => {
    expect(
      waitingOnAgeDays(
        { date: "Sun, 12 Apr 2026 12:00:00 -0500" },
        now
      )
    ).toBe(8);
  });

  it("returns 0 for unparseable dates", () => {
    expect(waitingOnAgeDays({ date: "huh?" }, now)).toBe(0);
  });
});

describe("isTodoistTaskStillActive (Task 10.2)", () => {
  it("returns true when the taskId is null/empty (nothing to unpin)", () => {
    expect(isTodoistTaskStillActive(null, [])).toBe(true);
    expect(isTodoistTaskStillActive(undefined, [{ id: "x" }])).toBe(true);
    expect(isTodoistTaskStillActive("", [{ id: "x" }])).toBe(true);
  });

  it("returns true when the active list contains the taskId", () => {
    expect(
      isTodoistTaskStillActive("t-1", [
        { id: "t-2" },
        { id: "t-1" },
        { id: "t-3" },
      ])
    ).toBe(true);
  });

  it("returns false when the active list does not contain the taskId", () => {
    expect(
      isTodoistTaskStillActive("t-1", [{ id: "t-2" }, { id: "t-3" }])
    ).toBe(false);
  });

  it("returns false on an empty active list", () => {
    expect(isTodoistTaskStillActive("t-1", [])).toBe(false);
  });

  it("matches by exact id string (not loose-equality)", () => {
    expect(isTodoistTaskStillActive("123", [{ id: "1234" }])).toBe(false);
  });
});
