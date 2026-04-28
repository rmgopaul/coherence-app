import { describe, expect, it } from "vitest";
import { buildDataQualityReconciliation } from "./buildDataQualityReconciliation";

type CsvRow = Record<string, string | undefined>;

function scheduleRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    tracking_system_ref_id: "NON100",
    ...overrides,
  };
}

function convertedRead(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    monitoring_system_id: "NON100",
    ...overrides,
  };
}

describe("buildDataQualityReconciliation", () => {
  it("returns empty arrays + null match rate for empty inputs", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [],
      convertedReadsRows: [],
    });
    expect(result.inScheduleNotMonitoring).toEqual([]);
    expect(result.inMonitoringNotSchedule).toEqual([]);
    expect(result.matchedPercent).toBeNull();
  });

  it("matches a one-row pair → 100% match rate, no mismatches", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "NON100" })],
      convertedReadsRows: [convertedRead({ monitoring_system_id: "NON100" })],
    });
    expect(result.inScheduleNotMonitoring).toEqual([]);
    expect(result.inMonitoringNotSchedule).toEqual([]);
    expect(result.matchedPercent).toBe(100);
  });

  it("captures a schedule-only id when convertedReads is missing it", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON101" }),
      ],
      convertedReadsRows: [convertedRead({ monitoring_system_id: "NON100" })],
    });
    expect(result.inScheduleNotMonitoring).toEqual(["non101"]);
    expect(result.inMonitoringNotSchedule).toEqual([]);
    // Union = 2; matched = 1 → 50%
    expect(result.matchedPercent).toBe(50);
  });

  it("captures a monitoring-only id when schedule is missing it", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "NON100" })],
      convertedReadsRows: [
        convertedRead({ monitoring_system_id: "NON100" }),
        convertedRead({ monitoring_system_id: "NON200" }),
      ],
    });
    expect(result.inScheduleNotMonitoring).toEqual([]);
    expect(result.inMonitoringNotSchedule).toEqual(["non200"]);
    expect(result.matchedPercent).toBe(50);
  });

  it("normalizes IDs to lowercase before comparing", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "NON-Alpha" })],
      convertedReadsRows: [
        convertedRead({ monitoring_system_id: "non-alpha" }),
      ],
    });
    expect(result.inScheduleNotMonitoring).toEqual([]);
    expect(result.inMonitoringNotSchedule).toEqual([]);
    expect(result.matchedPercent).toBe(100);
  });

  it("falls back to system_id when tracking_system_ref_id is empty", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "", system_id: "FALLBACK-1" }),
      ],
      convertedReadsRows: [
        convertedRead({ monitoring_system_id: "FALLBACK-1" }),
      ],
    });
    expect(result.matchedPercent).toBe(100);
  });

  it("skips rows with no usable id", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "" }),
        scheduleRow({ tracking_system_ref_id: "NON100" }),
      ],
      convertedReadsRows: [
        convertedRead({ monitoring_system_id: "" }),
        convertedRead({ monitoring_system_id: "NON100" }),
      ],
    });
    expect(result.inScheduleNotMonitoring).toEqual([]);
    expect(result.inMonitoringNotSchedule).toEqual([]);
    expect(result.matchedPercent).toBe(100);
  });

  it("dedupes repeat ids within a single dataset", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON101" }),
      ],
      convertedReadsRows: [
        convertedRead({ monitoring_system_id: "NON100" }),
        convertedRead({ monitoring_system_id: "NON100" }),
      ],
    });
    expect(result.inScheduleNotMonitoring).toEqual(["non101"]);
    expect(result.inMonitoringNotSchedule).toEqual([]);
    // Union = {non100, non101} = 2; matched = 1 → 50%
    expect(result.matchedPercent).toBe(50);
  });

  it("handles a real-world mismatch shape — partial overlap on both sides", () => {
    const result = buildDataQualityReconciliation({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "A" }),
        scheduleRow({ tracking_system_ref_id: "B" }),
        scheduleRow({ tracking_system_ref_id: "C" }),
      ],
      convertedReadsRows: [
        convertedRead({ monitoring_system_id: "B" }),
        convertedRead({ monitoring_system_id: "C" }),
        convertedRead({ monitoring_system_id: "D" }),
      ],
    });
    expect(result.inScheduleNotMonitoring.sort()).toEqual(["a"]);
    expect(result.inMonitoringNotSchedule.sort()).toEqual(["d"]);
    // Union = 4; matched = 2 → 50%
    expect(result.matchedPercent).toBe(50);
  });
});
