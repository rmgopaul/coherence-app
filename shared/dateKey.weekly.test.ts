/**
 * Phase E (2026-04-28) — tests for the ISO week-key helpers added
 * to `shared/dateKey.ts` for the AI Weekly Review feature.
 */
import { describe, expect, it } from "vitest";
import {
  toIsoWeekKey,
  weekRangeFromKey,
  dateKeysInRange,
} from "./dateKey";

describe("toIsoWeekKey", () => {
  it("returns '2026-W17' for a Wednesday in mid-April 2026", () => {
    // 2026-04-22 is a Wednesday; ISO week 17 of 2026 runs
    // Mon 2026-04-20 → Sun 2026-04-26.
    expect(toIsoWeekKey(new Date(Date.UTC(2026, 3, 22)))).toBe("2026-W17");
  });

  it("treats Monday as week start", () => {
    expect(toIsoWeekKey(new Date(Date.UTC(2026, 3, 20)))).toBe("2026-W17");
    // The Sunday before is still week 16 in ISO.
    expect(toIsoWeekKey(new Date(Date.UTC(2026, 3, 19)))).toBe("2026-W16");
  });

  it("rolls over correctly at year boundaries (week 1 contains Jan 4)", () => {
    // 2025-12-29 is a Monday; ISO week 1 of 2026 runs from that date
    // because Jan 1 2026 is a Thursday and the week containing the
    // first Thursday is week 1.
    expect(toIsoWeekKey(new Date(Date.UTC(2025, 11, 29)))).toBe("2026-W01");
    expect(toIsoWeekKey(new Date(Date.UTC(2026, 0, 4)))).toBe("2026-W01");
  });

  it("handles week 53 in long years", () => {
    // 2020 had 53 ISO weeks; Dec 31 2020 was a Thursday in W53.
    expect(toIsoWeekKey(new Date(Date.UTC(2020, 11, 31)))).toBe("2020-W53");
  });
});

describe("weekRangeFromKey", () => {
  it("returns Mon→Sun for a typical mid-year week", () => {
    expect(weekRangeFromKey("2026-W17")).toEqual({
      startDateKey: "2026-04-20",
      endDateKey: "2026-04-26",
    });
  });

  it("round-trips with toIsoWeekKey", () => {
    const range = weekRangeFromKey("2026-W17");
    expect(range).not.toBeNull();
    expect(
      toIsoWeekKey(new Date(`${range!.startDateKey}T12:00:00Z`))
    ).toBe("2026-W17");
    expect(
      toIsoWeekKey(new Date(`${range!.endDateKey}T12:00:00Z`))
    ).toBe("2026-W17");
  });

  it("returns null for malformed keys", () => {
    expect(weekRangeFromKey("garbage")).toBeNull();
    expect(weekRangeFromKey("2026-W")).toBeNull();
    expect(weekRangeFromKey("2026-W00")).toBeNull();
    expect(weekRangeFromKey("2026-W54")).toBeNull();
  });

  it("handles week 1 spanning a year boundary", () => {
    // ISO week 1 of 2026 = Mon 2025-12-29 → Sun 2026-01-04.
    expect(weekRangeFromKey("2026-W01")).toEqual({
      startDateKey: "2025-12-29",
      endDateKey: "2026-01-04",
    });
  });
});

describe("dateKeysInRange", () => {
  it("returns inclusive 7-day range", () => {
    expect(dateKeysInRange("2026-04-20", "2026-04-26")).toEqual([
      "2026-04-20",
      "2026-04-21",
      "2026-04-22",
      "2026-04-23",
      "2026-04-24",
      "2026-04-25",
      "2026-04-26",
    ]);
  });

  it("returns single-element array when start == end", () => {
    expect(dateKeysInRange("2026-04-20", "2026-04-20")).toEqual([
      "2026-04-20",
    ]);
  });

  it("returns empty array when end < start", () => {
    expect(dateKeysInRange("2026-04-26", "2026-04-20")).toEqual([]);
  });

  it("returns empty array for malformed inputs", () => {
    expect(dateKeysInRange("garbage", "2026-04-20")).toEqual([]);
    expect(dateKeysInRange("2026-04-20", "garbage")).toEqual([]);
  });

  it("handles month boundaries", () => {
    expect(dateKeysInRange("2026-03-30", "2026-04-02")).toEqual([
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
    ]);
  });
});
