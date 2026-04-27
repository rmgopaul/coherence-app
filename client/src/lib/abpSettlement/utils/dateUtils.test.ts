import { describe, it, expect } from "vitest";
import { buildMonthKey, isCompleteMonthKey } from "./dateUtils";

describe("buildMonthKey", () => {
  it("formats a date as YYYY-MM in local time", () => {
    expect(buildMonthKey(new Date(2026, 0, 15))).toBe("2026-01");
    expect(buildMonthKey(new Date(2026, 9, 1))).toBe("2026-10");
    expect(buildMonthKey(new Date(2026, 11, 31))).toBe("2026-12");
  });

  it("zero-pads single-digit months", () => {
    expect(buildMonthKey(new Date(2026, 2, 5))).toBe("2026-03");
  });
});

describe("isCompleteMonthKey", () => {
  it("accepts well-formed YYYY-MM strings (01–12)", () => {
    for (const m of [
      "01",
      "02",
      "03",
      "04",
      "05",
      "06",
      "07",
      "08",
      "09",
      "10",
      "11",
      "12",
    ]) {
      expect(isCompleteMonthKey(`2026-${m}`)).toBe(true);
    }
  });

  it("trims whitespace before checking", () => {
    expect(isCompleteMonthKey(" 2026-03 ")).toBe(true);
    expect(isCompleteMonthKey("\t2026-03\n")).toBe(true);
  });

  // Mid-typing values that the AbpInvoiceSettlement page sees while
  // a user types a new month — Task 2.3's contamination repro hinges
  // on these returning false so the persistence useEffect skips the
  // write.
  it("rejects mid-typing values", () => {
    expect(isCompleteMonthKey("")).toBe(false);
    expect(isCompleteMonthKey("2")).toBe(false);
    expect(isCompleteMonthKey("20")).toBe(false);
    expect(isCompleteMonthKey("202")).toBe(false);
    expect(isCompleteMonthKey("2026")).toBe(false);
    expect(isCompleteMonthKey("2026-")).toBe(false);
    expect(isCompleteMonthKey("2026-0")).toBe(false);
    expect(isCompleteMonthKey("2026-1")).toBe(false);
  });

  it("rejects out-of-range months (00, 13+)", () => {
    expect(isCompleteMonthKey("2026-00")).toBe(false);
    expect(isCompleteMonthKey("2026-13")).toBe(false);
    expect(isCompleteMonthKey("2026-99")).toBe(false);
  });

  it("rejects malformed strings that match length but not pattern", () => {
    expect(isCompleteMonthKey("2026/03")).toBe(false);
    expect(isCompleteMonthKey("26-03-26")).toBe(false);
    expect(isCompleteMonthKey("abcd-ef")).toBe(false);
    expect(isCompleteMonthKey("2026-3")).toBe(false); // single-digit month
    expect(isCompleteMonthKey("2026-03-15")).toBe(false); // YYYY-MM-DD
  });
});
