import { describe, it, expect } from "vitest";
import {
  toNullableString,
  toNullableNumber,
  asRecord,
  asRecordArray,
  parseIsoDate,
  normalizeBaseUrl,
  toUtcEpochSeconds,
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
