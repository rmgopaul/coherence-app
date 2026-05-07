/**
 * Parity tests for the streaming abpReport + solarApplications
 * page accumulators (2026-05-08 OOM hardening follow-up).
 *
 * Same shape as
 * `loadPerformanceRatioInput.streamingBaseline.test.ts`: chunk
 * an arbitrary input row set into pages of varying size, reduce
 * through the streaming accumulator, and assert equality with
 * the bulk builder's output. Pins the per-row semantics (first-
 * non-null wins / latest-date wins / first-non-empty merge) so
 * a future refactor can't drop a branch silently.
 */
import { describe, expect, it } from "vitest";
import {
  applyAbpReportPageToAcSizeKwMap,
  applyAbpReportPageToPart2VerificationDateMap,
  applySolarApplicationsPageToMonitoringDetailsMap,
} from "./loadPerformanceRatioInput";
import type { CsvRow } from "./aggregatorHelpers";

function chunked<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function makeAbpRow(overrides: Record<string, string | undefined>): CsvRow {
  return overrides as unknown as CsvRow;
}

function makeSolarAppRow(
  overrides: Record<string, string | undefined>
): CsvRow {
  return overrides as unknown as CsvRow;
}

// ---------------------------------------------------------------------------
// applyAbpReportPageToAcSizeKwMap — first-non-null wins
// ---------------------------------------------------------------------------

describe("applyAbpReportPageToAcSizeKwMap (streaming parity)", () => {
  it("preserves first-non-null-wins semantics across chunked pages", () => {
    const rows: CsvRow[] = [
      makeAbpRow({ Application_ID: "APP-1", Inverter_Size_kW_AC_Part_2: "5.0" }),
      makeAbpRow({ Application_ID: "APP-2", Inverter_Size_kW_AC_Part_2: "10.0" }),
      makeAbpRow({ Application_ID: "APP-1", Inverter_Size_kW_AC_Part_2: "999" }), // ignored — first-non-null wins
      makeAbpRow({ Application_ID: "APP-3", Inverter_Size_kW_AC_Part_2: "" }), // ignored — null parse
      makeAbpRow({ Application_ID: "APP-3", Inverter_Size_kW_AC_Part_2: "7.5" }), // first non-null for APP-3
    ];

    for (const pageSize of [1, 2, 3, 100]) {
      const streamed = new Map<string, number>();
      for (const page of chunked(rows, pageSize)) {
        applyAbpReportPageToAcSizeKwMap(streamed, page);
      }
      expect(streamed.size, `pageSize=${pageSize}`).toBe(3);
      expect(streamed.get("APP-1")).toBe(5);
      expect(streamed.get("APP-2")).toBe(10);
      expect(streamed.get("APP-3")).toBe(7.5);
    }
  });

  it("skips rows with missing Application_ID or invalid AC value", () => {
    const rows: CsvRow[] = [
      makeAbpRow({ Application_ID: "", Inverter_Size_kW_AC_Part_2: "5.0" }),
      makeAbpRow({ Application_ID: "APP-X", Inverter_Size_kW_AC_Part_2: "" }),
      makeAbpRow({ Application_ID: "APP-Y", Inverter_Size_kW_AC_Part_2: "8.0" }),
    ];
    const streamed = new Map<string, number>();
    applyAbpReportPageToAcSizeKwMap(streamed, rows);
    expect(streamed.size).toBe(1);
    expect(streamed.get("APP-Y")).toBe(8);
  });

  it("falls back to lowercase application_id when Application_ID is empty", () => {
    const streamed = new Map<string, number>();
    applyAbpReportPageToAcSizeKwMap(streamed, [
      makeAbpRow({ application_id: "APP-LOW", Inverter_Size_kW_AC_Part_2: "3.5" }),
    ]);
    expect(streamed.get("APP-LOW")).toBe(3.5);
  });
});

// ---------------------------------------------------------------------------
// applyAbpReportPageToPart2VerificationDateMap — latest-date wins
// ---------------------------------------------------------------------------

describe("applyAbpReportPageToPart2VerificationDateMap (streaming parity)", () => {
  it("preserves latest-date-wins semantics across chunked pages", () => {
    const rows: CsvRow[] = [
      makeAbpRow({
        Application_ID: "APP-1",
        Part_2_App_Verification_Date: "2024-01-15",
      }),
      makeAbpRow({
        Application_ID: "APP-1",
        Part_2_App_Verification_Date: "2024-06-30", // newer — should win
      }),
      makeAbpRow({
        Application_ID: "APP-2",
        Part_2_App_Verification_Date: "2024-04-01",
      }),
      makeAbpRow({
        Application_ID: "APP-1",
        Part_2_App_Verification_Date: "2024-03-01", // older — should NOT win
      }),
    ];

    for (const pageSize of [1, 2, 4]) {
      const streamed = new Map<string, Date>();
      for (const page of chunked(rows, pageSize)) {
        applyAbpReportPageToPart2VerificationDateMap(streamed, page);
      }
      expect(streamed.size, `pageSize=${pageSize}`).toBe(2);
      expect(streamed.get("APP-1")?.toISOString().slice(0, 10)).toBe(
        "2024-06-30"
      );
      expect(streamed.get("APP-2")?.toISOString().slice(0, 10)).toBe(
        "2024-04-01"
      );
    }
  });

  it("skips rows with missing app id or unparseable date", () => {
    const streamed = new Map<string, Date>();
    applyAbpReportPageToPart2VerificationDateMap(streamed, [
      makeAbpRow({ Application_ID: "", Part_2_App_Verification_Date: "2024-01-01" }),
      makeAbpRow({ Application_ID: "APP-X", Part_2_App_Verification_Date: "" }),
      makeAbpRow({
        Application_ID: "APP-X",
        Part_2_App_Verification_Date: "not-a-date",
      }),
      makeAbpRow({
        Application_ID: "APP-Y",
        Part_2_App_Verification_Date: "2024-05-15",
      }),
    ]);
    expect(streamed.size).toBe(1);
    expect(streamed.get("APP-Y")?.toISOString().slice(0, 10)).toBe(
      "2024-05-15"
    );
  });
});

// ---------------------------------------------------------------------------
// applySolarApplicationsPageToMonitoringDetailsMap — first-non-empty merge
// ---------------------------------------------------------------------------

describe("applySolarApplicationsPageToMonitoringDetailsMap (streaming parity)", () => {
  it("merges per-key fields across pages — first-non-empty wins per field", () => {
    const rows: CsvRow[] = [
      makeSolarAppRow({
        system_id: "SYS-1",
        online_monitoring: "Enphase",
        online_monitoring_system_id: "",
      }),
      makeSolarAppRow({
        system_id: "SYS-1",
        online_monitoring: "WrongValue", // already set by first row, NOT overwritten
        online_monitoring_system_id: "MS-100", // first-non-empty — wins
      }),
      makeSolarAppRow({
        system_id: "SYS-2",
        online_monitoring: "SolarEdge",
      }),
    ];

    for (const pageSize of [1, 2, 3]) {
      const streamed = new Map();
      for (const page of chunked(rows, pageSize)) {
        applySolarApplicationsPageToMonitoringDetailsMap(streamed, page);
      }
      const sys1 = streamed.get("id:SYS-1");
      expect(sys1, `pageSize=${pageSize}`).toBeDefined();
      expect(sys1.online_monitoring).toBe("Enphase");
      expect(sys1.online_monitoring_system_id).toBe("MS-100");
      const sys2 = streamed.get("id:SYS-2");
      expect(sys2.online_monitoring).toBe("SolarEdge");
    }
  });

  it("indexes by id, tracking, AND name keys", () => {
    const streamed = new Map();
    applySolarApplicationsPageToMonitoringDetailsMap(streamed, [
      makeSolarAppRow({
        system_id: "SYS-1",
        tracking_system_ref_id: "TRK-1",
        system_name: "Acme Solar",
        online_monitoring: "Enphase",
      }),
    ]);
    expect(streamed.has("id:SYS-1")).toBe(true);
    expect(streamed.has("tracking:TRK-1")).toBe(true);
    expect(streamed.has("name:acme solar")).toBe(true);
    expect(streamed.get("name:acme solar").online_monitoring).toBe("Enphase");
  });

  it("skips rows missing all of (system_id, tracking, name)", () => {
    const streamed = new Map();
    applySolarApplicationsPageToMonitoringDetailsMap(streamed, [
      makeSolarAppRow({ online_monitoring: "Orphan" }),
    ]);
    expect(streamed.size).toBe(0);
  });

  it("returns an empty map for an empty page", () => {
    const streamed = new Map();
    applySolarApplicationsPageToMonitoringDetailsMap(streamed, []);
    expect(streamed.size).toBe(0);
  });
});
