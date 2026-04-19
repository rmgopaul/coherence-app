import { describe, expect, it } from "vitest";
import { __test__ } from "./kingOfDay";

const { daysOverdue } = __test__;

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
