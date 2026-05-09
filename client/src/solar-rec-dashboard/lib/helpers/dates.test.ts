import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./dates";

describe("formatRelativeTime", () => {
  // 2026-05-09T18:30:00Z — frozen reference for every case below.
  const NOW_MS = Date.parse("2026-05-09T18:30:00Z");

  it('returns "just now" for diffs under 10 seconds', () => {
    expect(formatRelativeTime(NOW_MS, NOW_MS)).toBe("just now");
    expect(formatRelativeTime(NOW_MS - 5_000, NOW_MS)).toBe("just now");
    expect(formatRelativeTime(NOW_MS - 9_999, NOW_MS)).toBe("just now");
  });

  it("clamps future timestamps (clock skew) to just now", () => {
    expect(formatRelativeTime(NOW_MS + 60_000, NOW_MS)).toBe("just now");
  });

  it("returns Ns ago for diffs under 60 seconds", () => {
    expect(formatRelativeTime(NOW_MS - 10_000, NOW_MS)).toBe("10s ago");
    expect(formatRelativeTime(NOW_MS - 30_000, NOW_MS)).toBe("30s ago");
    expect(formatRelativeTime(NOW_MS - 59_999, NOW_MS)).toBe("59s ago");
  });

  it("returns Nm ago for diffs under 60 minutes", () => {
    expect(formatRelativeTime(NOW_MS - 60_000, NOW_MS)).toBe("1m ago");
    expect(formatRelativeTime(NOW_MS - 5 * 60_000, NOW_MS)).toBe("5m ago");
    // 59m 59s — still 59m bucket because we floor.
    expect(formatRelativeTime(NOW_MS - (60 * 60_000 - 1), NOW_MS)).toBe(
      "59m ago",
    );
  });

  it("returns Nh ago for diffs under 24 hours", () => {
    expect(formatRelativeTime(NOW_MS - 60 * 60_000, NOW_MS)).toBe("1h ago");
    expect(formatRelativeTime(NOW_MS - 2 * 60 * 60_000, NOW_MS)).toBe(
      "2h ago",
    );
    expect(formatRelativeTime(NOW_MS - 23 * 60 * 60_000, NOW_MS)).toBe(
      "23h ago",
    );
  });

  it("returns Nd ago for diffs at or above 24 hours", () => {
    expect(formatRelativeTime(NOW_MS - 24 * 60 * 60_000, NOW_MS)).toBe(
      "1d ago",
    );
    expect(formatRelativeTime(NOW_MS - 7 * 24 * 60 * 60_000, NOW_MS)).toBe(
      "7d ago",
    );
  });

  it("accepts an ISO string input (matches the Performance Ratio summary's builtAt shape)", () => {
    const oneHourAgoIso = new Date(NOW_MS - 60 * 60_000).toISOString();
    expect(formatRelativeTime(oneHourAgoIso, NOW_MS)).toBe("1h ago");
  });

  it("accepts a Date instance input", () => {
    const oneHourAgoDate = new Date(NOW_MS - 60 * 60_000);
    expect(formatRelativeTime(oneHourAgoDate, NOW_MS)).toBe("1h ago");
  });

  it("returns null for nullish inputs", () => {
    expect(formatRelativeTime(null, NOW_MS)).toBeNull();
    expect(formatRelativeTime(undefined, NOW_MS)).toBeNull();
  });

  it("returns null for unparseable strings", () => {
    expect(formatRelativeTime("not-a-date", NOW_MS)).toBeNull();
    expect(formatRelativeTime("", NOW_MS)).toBeNull();
  });

  it("returns null for non-finite numeric inputs", () => {
    expect(formatRelativeTime(Number.NaN, NOW_MS)).toBeNull();
    expect(formatRelativeTime(Number.POSITIVE_INFINITY, NOW_MS)).toBeNull();
  });
});
