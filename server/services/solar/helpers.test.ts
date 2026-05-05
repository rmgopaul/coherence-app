import { describe, it, expect } from "vitest";
import {
  toNullableString,
  toNullableNumber,
  asRecord,
  asRecordArray,
  parseIsoDate,
  normalizeBaseUrl,
  toUtcEpochSeconds,
  formatIsoDate,
  shiftIsoDate,
  shiftIsoDateByYears,
  firstDayOfMonth,
  firstDayOfPreviousMonth,
  lastDayOfPreviousMonth,
  safeRound,
  sumKwh,
  isNotFoundError,
} from "./helpers";

describe("toNullableString", () => {
  it("returns trimmed string for non-empty string", () => {
    expect(toNullableString("  hello  ")).toBe("hello");
  });
  it("returns null for empty string", () => {
    expect(toNullableString("")).toBeNull();
    expect(toNullableString("   ")).toBeNull();
  });
  it("returns null for non-string values", () => {
    expect(toNullableString(null)).toBeNull();
    expect(toNullableString(undefined)).toBeNull();
    expect(toNullableString(42)).toBeNull();
    expect(toNullableString({})).toBeNull();
  });
});

describe("toNullableNumber", () => {
  it("returns number for finite number", () => {
    expect(toNullableNumber(42)).toBe(42);
    expect(toNullableNumber(0)).toBe(0);
    expect(toNullableNumber(-1.5)).toBe(-1.5);
  });
  it("returns null for non-finite numbers", () => {
    expect(toNullableNumber(NaN)).toBeNull();
    expect(toNullableNumber(Infinity)).toBeNull();
    expect(toNullableNumber(-Infinity)).toBeNull();
  });
  it("parses numeric strings", () => {
    expect(toNullableNumber("42")).toBe(42);
    expect(toNullableNumber("3.14")).toBe(3.14);
    expect(toNullableNumber("-1")).toBe(-1);
  });
  it("returns null for non-numeric strings", () => {
    expect(toNullableNumber("abc")).toBeNull();
    expect(toNullableNumber("")).toBeNull();
    expect(toNullableNumber("   ")).toBeNull();
  });
  it("returns null for non-number/non-string values", () => {
    expect(toNullableNumber(null)).toBeNull();
    expect(toNullableNumber(undefined)).toBeNull();
    expect(toNullableNumber({})).toBeNull();
    expect(toNullableNumber([])).toBeNull();
  });
});

describe("asRecord", () => {
  it("returns object as Record", () => {
    const obj = { key: "value" };
    expect(asRecord(obj)).toBe(obj);
  });
  it("returns empty object for null/undefined", () => {
    expect(asRecord(null)).toEqual({});
    expect(asRecord(undefined)).toEqual({});
  });
  it("returns empty object for non-objects", () => {
    expect(asRecord(42)).toEqual({});
    expect(asRecord("string")).toEqual({});
    expect(asRecord(true)).toEqual({});
  });
});

describe("asRecordArray", () => {
  it("filters valid objects from array", () => {
    const arr = [{ a: 1 }, null, { b: 2 }, "string", 42];
    expect(asRecordArray(arr)).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("returns empty array for non-array", () => {
    expect(asRecordArray(null)).toEqual([]);
    expect(asRecordArray({})).toEqual([]);
    expect(asRecordArray("string")).toEqual([]);
  });
  it("returns empty array for array of non-objects", () => {
    expect(asRecordArray([1, "a", null])).toEqual([]);
  });
});

describe("normalizeBaseUrl", () => {
  const DEFAULT = "https://api.example.com";

  it("returns default for empty/null/undefined", () => {
    expect(normalizeBaseUrl("", DEFAULT)).toBe(DEFAULT);
    expect(normalizeBaseUrl(null, DEFAULT)).toBe(DEFAULT);
    expect(normalizeBaseUrl(undefined, DEFAULT)).toBe(DEFAULT);
    expect(normalizeBaseUrl("   ", DEFAULT)).toBe(DEFAULT);
  });
  it("strips trailing slashes", () => {
    expect(normalizeBaseUrl("https://api.com/", DEFAULT)).toBe("https://api.com");
    expect(normalizeBaseUrl("https://api.com///", DEFAULT)).toBe("https://api.com");
  });
  it("returns trimmed URL", () => {
    expect(normalizeBaseUrl("  https://api.com  ", DEFAULT)).toBe("https://api.com");
  });
});

describe("parseIsoDate", () => {
  it("parses valid YYYY-MM-DD", () => {
    expect(parseIsoDate("2024-01-15")).toEqual({ year: 2024, month: 1, day: 15 });
    expect(parseIsoDate("2024-12-31")).toEqual({ year: 2024, month: 12, day: 31 });
  });
  it("returns null for invalid formats", () => {
    expect(parseIsoDate("2024-1-15")).toBeNull();
    expect(parseIsoDate("2024/01/15")).toBeNull();
    expect(parseIsoDate("01-15-2024")).toBeNull();
    expect(parseIsoDate("not a date")).toBeNull();
    expect(parseIsoDate("")).toBeNull();
  });
  it("returns null for out-of-range months/days", () => {
    expect(parseIsoDate("2024-13-01")).toBeNull();
    expect(parseIsoDate("2024-00-01")).toBeNull();
    expect(parseIsoDate("2024-01-32")).toBeNull();
    expect(parseIsoDate("2024-01-00")).toBeNull();
  });
});

describe("toUtcEpochSeconds", () => {
  it("returns start of day in UTC", () => {
    const result = toUtcEpochSeconds("2024-01-01", false);
    expect(result).toBe(Math.floor(new Date("2024-01-01T00:00:00Z").getTime() / 1000));
  });
  it("returns end of day in UTC", () => {
    const result = toUtcEpochSeconds("2024-01-01", true);
    expect(result).toBe(Math.floor(new Date("2024-01-01T23:59:59Z").getTime() / 1000));
  });
  it("throws for invalid date format", () => {
    expect(() => toUtcEpochSeconds("invalid", false)).toThrow("YYYY-MM-DD");
  });
});

describe("formatIsoDate", () => {
  it("formats a Date as YYYY-MM-DD", () => {
    expect(formatIsoDate(new Date(2024, 0, 5))).toBe("2024-01-05");
    expect(formatIsoDate(new Date(2024, 11, 31))).toBe("2024-12-31");
  });
  it("zero-pads single digits", () => {
    expect(formatIsoDate(new Date(2024, 2, 9))).toBe("2024-03-09");
  });
});

describe("shiftIsoDate", () => {
  it("adds days", () => {
    expect(shiftIsoDate("2024-01-15", 5)).toBe("2024-01-20");
    expect(shiftIsoDate("2024-01-30", 5)).toBe("2024-02-04");
  });
  it("subtracts days", () => {
    expect(shiftIsoDate("2024-01-05", -5)).toBe("2023-12-31");
  });
  it("handles month/year boundaries", () => {
    expect(shiftIsoDate("2024-12-31", 1)).toBe("2025-01-01");
  });
  it("throws for invalid input", () => {
    expect(() => shiftIsoDate("invalid", 1)).toThrow("YYYY-MM-DD");
  });
});

describe("shiftIsoDateByYears", () => {
  it("adds years", () => {
    expect(shiftIsoDateByYears("2024-06-15", 1)).toBe("2025-06-15");
  });
  it("subtracts years", () => {
    expect(shiftIsoDateByYears("2024-06-15", -2)).toBe("2022-06-15");
  });
  it("throws for invalid input", () => {
    expect(() => shiftIsoDateByYears("invalid", 1)).toThrow("YYYY-MM-DD");
  });
});

describe("firstDayOfMonth", () => {
  it("returns the first day of the month containing the input date", () => {
    expect(firstDayOfMonth("2024-06-15")).toBe("2024-06-01");
    expect(firstDayOfMonth("2024-06-01")).toBe("2024-06-01");
    expect(firstDayOfMonth("2024-06-30")).toBe("2024-06-01");
  });
  it("handles December (boundary)", () => {
    expect(firstDayOfMonth("2024-12-25")).toBe("2024-12-01");
  });
  it("throws for invalid input", () => {
    expect(() => firstDayOfMonth("invalid")).toThrow("YYYY-MM-DD");
    expect(() => firstDayOfMonth("06/15/2024")).toThrow("YYYY-MM-DD");
  });
});

describe("firstDayOfPreviousMonth", () => {
  it("returns the first of the previous month within the same year", () => {
    expect(firstDayOfPreviousMonth("2024-06-15")).toBe("2024-05-01");
  });
  it("rolls back across the January → December boundary", () => {
    expect(firstDayOfPreviousMonth("2024-01-15")).toBe("2023-12-01");
  });
  it("handles March → February (leap-month boundary)", () => {
    expect(firstDayOfPreviousMonth("2024-03-15")).toBe("2024-02-01");
  });
  it("throws for invalid input", () => {
    expect(() => firstDayOfPreviousMonth("invalid")).toThrow("YYYY-MM-DD");
  });
});

describe("lastDayOfPreviousMonth", () => {
  it("returns the last day of the previous month (31-day prior)", () => {
    expect(lastDayOfPreviousMonth("2024-02-15")).toBe("2024-01-31");
  });
  it("returns Feb 29 in a leap year", () => {
    expect(lastDayOfPreviousMonth("2024-03-15")).toBe("2024-02-29");
  });
  it("returns Feb 28 in a non-leap year", () => {
    expect(lastDayOfPreviousMonth("2023-03-15")).toBe("2023-02-28");
  });
  it("rolls back across the January → December boundary", () => {
    expect(lastDayOfPreviousMonth("2024-01-15")).toBe("2023-12-31");
  });
  it("throws for invalid input", () => {
    expect(() => lastDayOfPreviousMonth("invalid")).toThrow("YYYY-MM-DD");
  });
});

describe("safeRound", () => {
  it("rounds to 3 decimals", () => {
    expect(safeRound(1.23456)).toBe(1.235);
    expect(safeRound(1.234)).toBe(1.234);
    expect(safeRound(0)).toBe(0);
  });
  it("returns null for null/non-finite", () => {
    expect(safeRound(null)).toBeNull();
    expect(safeRound(Infinity)).toBeNull();
    expect(safeRound(NaN)).toBeNull();
  });
});

describe("sumKwh", () => {
  it("sums numeric array and rounds", () => {
    expect(sumKwh([1.111, 2.222, 3.333])).toBe(6.666);
  });
  it("returns null for empty array", () => {
    expect(sumKwh([])).toBeNull();
  });
  it("handles single value", () => {
    expect(sumKwh([42])).toBe(42);
  });
});

describe("isNotFoundError", () => {
  it("matches 404 errors", () => {
    expect(isNotFoundError(new Error("HTTP error (404 Not Found)"))).toBe(true);
  });
  it("matches 'not found' messages", () => {
    expect(isNotFoundError(new Error("System Not Found"))).toBe(true);
  });
  it("returns false for other errors", () => {
    expect(isNotFoundError(new Error("Server error"))).toBe(false);
    expect(isNotFoundError(new Error("Unauthorized"))).toBe(false);
  });
  it("returns false for non-Error values", () => {
    expect(isNotFoundError("not found")).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });
});
