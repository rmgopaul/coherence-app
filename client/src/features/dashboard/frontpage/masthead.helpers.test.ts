import { describe, expect, it } from "vitest";
import {
  computeIssueNumber,
  computeVolume,
  formatBroadsheetDate,
  getTimezoneAbbreviation,
  toRomanNumeral,
} from "./masthead.helpers";

describe("toRomanNumeral", () => {
  it("converts small integers", () => {
    expect(toRomanNumeral(1)).toBe("I");
    expect(toRomanNumeral(4)).toBe("IV");
    expect(toRomanNumeral(9)).toBe("IX");
    expect(toRomanNumeral(14)).toBe("XIV");
    expect(toRomanNumeral(20)).toBe("XX");
  });

  it("returns an em-dash for non-positive or non-finite input", () => {
    expect(toRomanNumeral(0)).toBe("—");
    expect(toRomanNumeral(-3)).toBe("—");
    expect(toRomanNumeral(Number.NaN)).toBe("—");
    expect(toRomanNumeral(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("computeVolume", () => {
  it("renders years since 2012 as Roman", () => {
    expect(computeVolume(new Date("2026-04-19T12:00:00Z"))).toBe("XIV");
    expect(computeVolume(new Date("2024-01-01T12:00:00Z"))).toBe("XII");
    expect(computeVolume(new Date("2013-01-01T12:00:00Z"))).toBe("I");
  });

  it("clamps below 1 and above XX", () => {
    expect(computeVolume(new Date("2010-01-01T12:00:00Z"))).toBe("I");
    expect(computeVolume(new Date("2099-01-01T12:00:00Z"))).toBe("XX");
  });
});

describe("computeIssueNumber", () => {
  it("counts days since the user's account creation", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    const created = new Date("2026-04-10T00:00:00Z");
    expect(computeIssueNumber(now, created)).toBe("010");
  });

  it("accepts an ISO string", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    expect(computeIssueNumber(now, "2025-04-20T00:00:00Z")).toBe("365");
  });

  it("falls back to the project launch when createdAt is missing", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    // 2012-01-01 → 2026-04-20 ≈ 5223 days
    expect(computeIssueNumber(now, null)).toBe("5223");
    expect(computeIssueNumber(now, undefined)).toBe("5223");
    expect(computeIssueNumber(now, "")).toBe("5223");
    expect(computeIssueNumber(now, "not-a-date")).toBe("5223");
  });

  it("never returns less than 001 or more than 9999", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    expect(computeIssueNumber(now, now)).toBe("001"); // same day
    expect(computeIssueNumber(now, "1900-01-01T00:00:00Z")).toBe("9999");
  });

  it("zero-pads small numbers to 3 digits", () => {
    const now = new Date("2026-04-20T00:00:00Z");
    expect(computeIssueNumber(now, "2026-04-19T00:00:00Z")).toBe("001");
    expect(computeIssueNumber(now, "2026-04-12T00:00:00Z")).toBe("008");
  });
});

describe("formatBroadsheetDate", () => {
  it("renders DAY · MON D · YYYY in caps", () => {
    // 2026-04-19 is a Sunday in local time when constructed via Y, M, D.
    const d = new Date(2026, 3, 19);
    expect(formatBroadsheetDate(d)).toBe("SUN · APR 19 · 2026");
  });
});

describe("getTimezoneAbbreviation", () => {
  it("returns a non-empty short label", () => {
    const abbr = getTimezoneAbbreviation(new Date());
    expect(abbr.length).toBeGreaterThan(0);
    // Must start with a letter (either a name like "CST" or "GMT+/-").
    expect(/^[A-Z]/.test(abbr)).toBe(true);
  });
});
