import { describe, expect, it } from "vitest";
import {
  buildCompletionGrid,
  cohensDMagnitude,
  colorForCompletion,
  countActive,
  completionRate,
  formatStreak,
  longestStreak,
  type CompletionDay,
} from "./habits.helpers";

function entry(overrides: Partial<{ completed: boolean; isActive: boolean }> = {}) {
  return { completed: false, isActive: true, ...overrides } as any;
}

describe("formatStreak", () => {
  it("renders fire emoji and count for positive streaks", () => {
    expect(formatStreak(7)).toBe("🔥 7");
  });
  it("renders em dash for zero or negative streaks", () => {
    expect(formatStreak(0)).toBe("—");
    expect(formatStreak(-3)).toBe("—");
  });
  it("handles non-finite inputs", () => {
    expect(formatStreak(Number.NaN)).toBe("—");
  });
});

describe("completionRate", () => {
  it("returns 0..1 ratio of completed", () => {
    expect(completionRate([entry({ completed: true }), entry(), entry()])).toBeCloseTo(1 / 3);
    expect(completionRate([entry({ completed: true }), entry({ completed: true })])).toBe(1);
  });
  it("returns 0 for empty list", () => {
    expect(completionRate([])).toBe(0);
  });
});

describe("countActive", () => {
  it("ignores explicit isActive=false entries", () => {
    expect(countActive([entry(), entry({ isActive: false }), entry()])).toBe(2);
  });
  it("treats missing isActive as active", () => {
    const list = [{ completed: false } as any, { completed: false } as any];
    expect(countActive(list)).toBe(2);
  });
});

describe("longestStreak", () => {
  it("returns max across rows", () => {
    expect(
      longestStreak([
        { habitId: "a", name: "A", color: "slate", streak: 3, calendar: [] } as any,
        { habitId: "b", name: "B", color: "slate", streak: 12, calendar: [] } as any,
      ])
    ).toBe(12);
  });
  it("returns 0 on empty", () => {
    expect(longestStreak([])).toBe(0);
  });
});

describe("cohensDMagnitude", () => {
  it("buckets by standard thresholds", () => {
    expect(cohensDMagnitude(null)).toBe("—");
    expect(cohensDMagnitude(0.1)).toBe("negligible");
    expect(cohensDMagnitude(-0.3)).toBe("small");
    expect(cohensDMagnitude(0.6)).toBe("medium");
    expect(cohensDMagnitude(-1.2)).toBe("large");
  });
});

describe("buildCompletionGrid", () => {
  it("returns an empty grid for no days", () => {
    expect(buildCompletionGrid([])).toEqual([]);
  });

  it("arranges days into 7 rows keyed by day-of-week", () => {
    // 2026-04-19 is a Sunday (getDay() === 0)
    const days: CompletionDay[] = [
      { dateKey: "2026-04-19", completed: true }, // Sun → row 0
      { dateKey: "2026-04-20", completed: false }, // Mon → row 1
      { dateKey: "2026-04-21", completed: true }, // Tue → row 2
    ];
    const grid = buildCompletionGrid(days);
    expect(grid).toHaveLength(7);
    expect(grid[0][0].day?.dateKey).toBe("2026-04-19");
    expect(grid[1][0].day?.dateKey).toBe("2026-04-20");
    expect(grid[2][0].day?.dateKey).toBe("2026-04-21");
  });

  it("pads the start when the first day is not a Sunday", () => {
    // 2026-04-22 is a Wednesday → 3 pad cells (rows 0, 1, 2 before it)
    const days: CompletionDay[] = [{ dateKey: "2026-04-22", completed: true }];
    const grid = buildCompletionGrid(days);
    expect(grid[0][0].day).toBeNull();
    expect(grid[1][0].day).toBeNull();
    expect(grid[2][0].day).toBeNull();
    expect(grid[3][0].day?.dateKey).toBe("2026-04-22");
  });

  it("right-pads short rows so all rows share a column count", () => {
    const days: CompletionDay[] = [
      { dateKey: "2026-04-19", completed: true }, // Sun
      { dateKey: "2026-04-20", completed: true }, // Mon
    ];
    const grid = buildCompletionGrid(days);
    const widths = new Set(grid.map((r) => r.length));
    expect(widths.size).toBe(1);
  });
});

describe("colorForCompletion", () => {
  it("emerald for completed, muted for not-completed, transparent for null", () => {
    expect(colorForCompletion(null)).toBe("bg-transparent");
    expect(colorForCompletion({ dateKey: "2026-04-19", completed: false })).toBe("bg-muted");
    expect(colorForCompletion({ dateKey: "2026-04-19", completed: true })).toBe("bg-emerald-600");
  });
});
