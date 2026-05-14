import { describe, expect, it } from "vitest";
import {
  getCurrentGatsReportingWindow,
  getReportingWindowForNamedMonth,
  lastBusinessDayOfMonth,
  windowIdForDate,
} from "./gatsReportingWindow";

describe("lastBusinessDayOfMonth", () => {
  it("April 2026 ends on a Thursday — returns April 30", () => {
    const d = lastBusinessDayOfMonth(2026, 4);
    // April 30, 2026 is a Thursday.
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth() + 1).toBe(4);
    expect(d.getDate()).toBe(30);
    expect(d.getDay()).toBe(4);
  });

  it("May 2026 ends on a Sunday — walks back to Friday May 29", () => {
    // May 31, 2026 is a Sunday → step back to Friday May 29.
    const d = lastBusinessDayOfMonth(2026, 5);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth() + 1).toBe(5);
    expect(d.getDate()).toBe(29);
    expect(d.getDay()).toBe(5);
  });

  it("October 2026 ends on a Saturday — walks back to Friday Oct 30", () => {
    // October 31, 2026 is a Saturday → step back to Friday Oct 30.
    const d = lastBusinessDayOfMonth(2026, 10);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth() + 1).toBe(10);
    expect(d.getDate()).toBe(30);
    expect(d.getDay()).toBe(5);
  });

  it("February 2025 (non-leap) ends on Friday Feb 28", () => {
    const d = lastBusinessDayOfMonth(2025, 2);
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth() + 1).toBe(2);
    expect(d.getDate()).toBe(28);
    expect(d.getDay()).toBe(5);
  });

  it("February 2024 (leap) ends on Thursday Feb 29", () => {
    const d = lastBusinessDayOfMonth(2024, 2);
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth() + 1).toBe(2);
    expect(d.getDate()).toBe(29);
    expect(d.getDay()).toBe(4);
  });

  it("throws on month out of range", () => {
    expect(() => lastBusinessDayOfMonth(2026, 13)).toThrow();
    expect(() => lastBusinessDayOfMonth(2026, 0)).toThrow();
  });
});

describe("getCurrentGatsReportingWindow", () => {
  it("today = 2026-05-14 → April Generation Window (4/16–5/15)", () => {
    // April 30, 2026 (Thu) ≤ May 14 < May 29, 2026 (Fri).
    const w = getCurrentGatsReportingWindow(new Date(2026, 4, 14, 12, 0, 0));
    expect(w.id).toBe("2026-04");
    expect(w.label).toBe("April Generation Window");
    expect(w.namedYear).toBe(2026);
    expect(w.namedMonth).toBe(4);
    expect(w.generationEntryDateIso).toBe("2026-04-01");
    expect(w.windowStartIso).toBe("2026-04-16");
    expect(w.windowEndIso).toBe("2026-05-15");
    expect(w.openDateIso).toBe("2026-04-30");
  });

  it("today = 2026-04-29 → March Generation Window (still before April 30 open)", () => {
    const w = getCurrentGatsReportingWindow(new Date(2026, 3, 29, 12, 0, 0));
    expect(w.id).toBe("2026-03");
    expect(w.label).toBe("March Generation Window");
    expect(w.generationEntryDateIso).toBe("2026-03-01");
    expect(w.windowStartIso).toBe("2026-03-16");
    expect(w.windowEndIso).toBe("2026-04-15");
  });

  it("today = 2026-04-30 (the open date itself) → April Generation Window", () => {
    const w = getCurrentGatsReportingWindow(new Date(2026, 3, 30, 0, 0, 0));
    expect(w.id).toBe("2026-04");
    expect(w.openDateIso).toBe("2026-04-30");
  });

  it("today = 2026-05-29 (May open date) → May Generation Window", () => {
    const w = getCurrentGatsReportingWindow(new Date(2026, 4, 29, 12, 0, 0));
    expect(w.id).toBe("2026-05");
    expect(w.label).toBe("May Generation Window");
    expect(w.windowStartIso).toBe("2026-05-16");
    expect(w.windowEndIso).toBe("2026-06-15");
    expect(w.openDateIso).toBe("2026-05-29");
  });

  it("today = 2026-12-31 → December Generation Window (wraps year on next-month end)", () => {
    // December 31, 2026 is a Thursday → last business day. Window
    // spans 12/16–1/15 of the next year.
    const w = getCurrentGatsReportingWindow(new Date(2026, 11, 31, 12, 0, 0));
    expect(w.id).toBe("2026-12");
    expect(w.label).toBe("December Generation Window");
    expect(w.windowStartIso).toBe("2026-12-16");
    expect(w.windowEndIso).toBe("2027-01-15");
  });

  it("today = 2026-01-05 → December (prior year) Generation Window", () => {
    // Before January's last business day → previous month's window.
    // Previous month wraps to 2025-12.
    const w = getCurrentGatsReportingWindow(new Date(2026, 0, 5, 12, 0, 0));
    expect(w.id).toBe("2025-12");
    expect(w.label).toBe("December Generation Window");
    expect(w.windowStartIso).toBe("2025-12-16");
    expect(w.windowEndIso).toBe("2026-01-15");
  });

  it("strips time-of-day — midnight on open date counts as inside window", () => {
    // 2026-04-30 at 00:00 should still register as the April window.
    const midnight = new Date(2026, 3, 30, 0, 0, 0);
    expect(getCurrentGatsReportingWindow(midnight).id).toBe("2026-04");
    // Same date, 23:59 — also April.
    const eod = new Date(2026, 3, 30, 23, 59, 59);
    expect(getCurrentGatsReportingWindow(eod).id).toBe("2026-04");
  });
});

describe("windowIdForDate", () => {
  it("16th of named month → windowId for that month", () => {
    expect(windowIdForDate("2026-04-16")).toBe("2026-04");
  });

  it("20th of named month → windowId for that month", () => {
    expect(windowIdForDate("2026-04-20")).toBe("2026-04");
  });

  it("end of named month → windowId for that month", () => {
    expect(windowIdForDate("2026-04-30")).toBe("2026-04");
  });

  it("15th of next month (end of window) → windowId for previous month", () => {
    expect(windowIdForDate("2026-05-15")).toBe("2026-04");
  });

  it("1st of next month → windowId for previous month (still in prev window)", () => {
    expect(windowIdForDate("2026-05-01")).toBe("2026-04");
  });

  it("16th of next month (start of NEW window)", () => {
    expect(windowIdForDate("2026-05-16")).toBe("2026-05");
  });

  it("January 10 → previous December (year wrap)", () => {
    expect(windowIdForDate("2026-01-10")).toBe("2025-12");
  });

  it("December 20 → December (no wrap)", () => {
    expect(windowIdForDate("2026-12-20")).toBe("2026-12");
  });

  it("returns null on invalid input", () => {
    expect(windowIdForDate("not-a-date")).toBeNull();
    expect(windowIdForDate("2026-13-01")).toBeNull();
    expect(windowIdForDate("")).toBeNull();
  });
});

describe("getReportingWindowForNamedMonth", () => {
  it("returns full descriptor for April 2026", () => {
    const w = getReportingWindowForNamedMonth(2026, 4);
    expect(w.id).toBe("2026-04");
    expect(w.label).toBe("April Generation Window");
    expect(w.openDateIso).toBe("2026-04-30");
  });
});
