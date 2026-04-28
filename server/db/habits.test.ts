/**
 * Phase E (2026-04-28) — tests for the habit-history bulk grouping
 * helper. Pure function, no mocks needed.
 */
import { describe, expect, it } from "vitest";
import { groupCompletionsByHabitId } from "./habits";

describe("groupCompletionsByHabitId", () => {
  it("returns an empty record for empty input", () => {
    expect(groupCompletionsByHabitId([])).toEqual({});
  });

  it("groups rows by habitId, preserving input order within each group", () => {
    const rows = [
      { habitId: "h1", dateKey: "2026-04-20", completed: true },
      { habitId: "h2", dateKey: "2026-04-21", completed: false },
      { habitId: "h1", dateKey: "2026-04-22", completed: true },
      { habitId: "h2", dateKey: "2026-04-22", completed: true },
    ];
    const result = groupCompletionsByHabitId(rows);
    expect(Object.keys(result).sort()).toEqual(["h1", "h2"]);
    expect(result.h1).toEqual([
      { habitId: "h1", dateKey: "2026-04-20", completed: true },
      { habitId: "h1", dateKey: "2026-04-22", completed: true },
    ]);
    expect(result.h2).toEqual([
      { habitId: "h2", dateKey: "2026-04-21", completed: false },
      { habitId: "h2", dateKey: "2026-04-22", completed: true },
    ]);
  });

  it("creates a single bucket when all rows share a habitId", () => {
    const rows = [
      { habitId: "h1", dateKey: "2026-04-20", completed: true },
      { habitId: "h1", dateKey: "2026-04-21", completed: true },
    ];
    const result = groupCompletionsByHabitId(rows);
    expect(Object.keys(result)).toEqual(["h1"]);
    expect(result.h1).toHaveLength(2);
  });

  it("is generic over the row shape — extra fields pass through", () => {
    interface Wide {
      habitId: string;
      dateKey: string;
      completed: boolean;
      userId: number;
      extra: string;
    }
    const rows: Wide[] = [
      {
        habitId: "h1",
        dateKey: "2026-04-20",
        completed: true,
        userId: 7,
        extra: "x",
      },
    ];
    const result = groupCompletionsByHabitId(rows);
    expect(result.h1?.[0].userId).toBe(7);
    expect(result.h1?.[0].extra).toBe("x");
  });

  it("handles rows with empty-string habitIds defensively (no crash)", () => {
    const rows = [
      { habitId: "", dateKey: "2026-04-20", completed: true },
      { habitId: "h1", dateKey: "2026-04-21", completed: true },
    ];
    const result = groupCompletionsByHabitId(rows);
    expect(Object.keys(result).sort()).toEqual(["", "h1"]);
    expect(result[""]?.length).toBe(1);
  });
});
