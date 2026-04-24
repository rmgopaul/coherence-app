import { describe, expect, it } from "vitest";
import { formatDateInput, formatTodayKey, toDateKey } from "./dateKey";

describe("toDateKey", () => {
  it("formats a local-time date as YYYY-MM-DD", () => {
    const date = new Date(2026, 3, 7, 10, 0, 0); // April 7, 2026 10:00 local
    expect(toDateKey(date)).toBe("2026-04-07");
  });

  it("zero-pads single-digit month and day", () => {
    const date = new Date(2026, 0, 3);
    expect(toDateKey(date)).toBe("2026-01-03");
  });

  it("uses the given IANA zone when `tz` is provided", () => {
    // 2026-04-07T03:00:00Z = 2026-04-06 in America/Chicago (UTC-5 during CDT).
    const utc = new Date("2026-04-07T03:00:00Z");
    expect(toDateKey(utc, "America/Chicago")).toBe("2026-04-06");
    // Same instant in UTC is April 7.
    expect(toDateKey(utc, "UTC")).toBe("2026-04-07");
  });
});

describe("formatTodayKey", () => {
  it("returns a YYYY-MM-DD string shaped correctly", () => {
    expect(formatTodayKey()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("accepts a tz argument", () => {
    expect(formatTodayKey("UTC")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatDateInput", () => {
  it("produces the YYYY-MM-DD form an <input type=\"date\"> expects", () => {
    const date = new Date(2026, 11, 31);
    expect(formatDateInput(date)).toBe("2026-12-31");
  });
});
