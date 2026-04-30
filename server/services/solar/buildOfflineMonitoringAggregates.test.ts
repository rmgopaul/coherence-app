import { describe, expect, it } from "vitest";
import { buildOfflineMonitoringAggregates } from "./buildOfflineMonitoringAggregates";

type CsvRow = Record<string, string | undefined>;

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    system_id: "SYS-1",
    PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON100",
    tracking_system_ref_id: "",
    Project_Name: "Acme Solar",
    system_name: "",
    Part_2_App_Verification_Date: "2025-03-15",
    ...overrides,
  };
}

function solarAppRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    system_id: "SYS-1",
    Application_ID: "",
    tracking_system_ref_id: "NON100",
    reporting_entity_ref_id: "",
    PJM_GATS_or_MRETS_Unit_ID_Part_2: "",
    system_name: "Acme Solar",
    Project_Name: "",
    online_monitoring: "Enphase",
    online_monitoring_system_id: "ENPH-001",
    online_monitoring_system_name: "AcmeMon",
    online_monitoring_password: "secret",
    last_reported_online_date: "2026-04-15",
    system_online: "Yes",
    ...overrides,
  };
}

describe("buildOfflineMonitoringAggregates", () => {
  it("returns empty arrays + records when both inputs are empty", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [],
      solarApplicationsRows: [],
    });
    expect(out.eligiblePart2ApplicationIds).toEqual([]);
    expect(out.eligiblePart2PortalSystemIds).toEqual([]);
    expect(out.eligiblePart2TrackingIds).toEqual([]);
    expect(out.abpApplicationIdBySystemKey).toEqual({});
    expect(out.monitoringDetailsBySystemKey).toEqual({});
  });

  it("only counts rows that pass isPart2VerifiedAbpRow", () => {
    const verified = abpRow({ Application_ID: "VERIFIED" });
    const unverified = abpRow({
      Application_ID: "NOT-VERIFIED",
      Part_2_App_Verification_Date: "",
    });
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [verified, unverified],
      solarApplicationsRows: [],
    });
    expect(out.eligiblePart2ApplicationIds).toEqual(["VERIFIED"]);
    expect(out.abpApplicationIdBySystemKey["id:VERIFIED"]).toBe("VERIFIED");
    expect(
      out.abpApplicationIdBySystemKey["id:NOT-VERIFIED"]
    ).toBeUndefined();
  });

  it("falls back to tracking_system_ref_id when GATS Unit ID is empty", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "",
          tracking_system_ref_id: "FALLBACK-NON",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.eligiblePart2TrackingIds).toEqual(["FALLBACK-NON"]);
  });

  it("populates abpApplicationIdBySystemKey under all 3 keys when populated", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [abpRow()],
      solarApplicationsRows: [],
    });
    expect(out.abpApplicationIdBySystemKey["id:APP-1"]).toBe("APP-1");
    expect(out.abpApplicationIdBySystemKey["tracking:NON100"]).toBe("APP-1");
    expect(out.abpApplicationIdBySystemKey["name:acme solar"]).toBe("APP-1");
  });

  it("uses system_id as the application-id fallback when Application_ID is empty", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [abpRow({ Application_ID: "", system_id: "SYS-9" })],
      solarApplicationsRows: [],
    });
    expect(out.abpApplicationIdBySystemKey["id:SYS-9"]).toBe("SYS-9");
    expect(out.abpApplicationIdBySystemKey["tracking:NON100"]).toBe("SYS-9");
  });

  it("builds monitoringDetailsBySystemKey with all 15 fields under id/tracking/name keys", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [],
      solarApplicationsRows: [solarAppRow()],
    });
    const idEntry = out.monitoringDetailsBySystemKey["id:SYS-1"];
    expect(idEntry).toBeDefined();
    expect(idEntry!.online_monitoring).toBe("Enphase");
    expect(idEntry!.online_monitoring_system_id).toBe("ENPH-001");
    expect(idEntry!.online_monitoring_password).toBe("secret");
    expect(idEntry!.last_reported_online_date).toBe("2026-04-15");
    expect(idEntry!.system_online).toBe("Yes");
    expect(out.monitoringDetailsBySystemKey["tracking:NON100"]).toEqual(
      idEntry
    );
    expect(out.monitoringDetailsBySystemKey["name:acme solar"]).toEqual(
      idEntry
    );
  });

  it("merges monitoring detail records when two rows share a key (first non-empty wins per field)", () => {
    const first = solarAppRow({
      online_monitoring: "Enphase",
      online_monitoring_password: "",
    });
    const second = solarAppRow({
      online_monitoring: "",
      online_monitoring_password: "secret-from-row-2",
    });
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [],
      solarApplicationsRows: [first, second],
    });
    const merged = out.monitoringDetailsBySystemKey["id:SYS-1"];
    expect(merged!.online_monitoring).toBe("Enphase");
    expect(merged!.online_monitoring_password).toBe("secret-from-row-2");
  });

  it("skips rows with no usable identifier", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [],
      solarApplicationsRows: [
        solarAppRow({
          system_id: "",
          Application_ID: "",
          tracking_system_ref_id: "",
          reporting_entity_ref_id: "",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "",
          system_name: "",
          Project_Name: "",
        }),
      ],
    });
    expect(out.monitoringDetailsBySystemKey).toEqual({});
  });

  it("returns deterministically-sorted eligibility arrays", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({
          Application_ID: "APP-Z",
          system_id: "SYS-Z",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "ZNON",
        }),
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "ANON",
        }),
        abpRow({
          Application_ID: "APP-M",
          system_id: "SYS-M",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "MNON",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.eligiblePart2ApplicationIds).toEqual([
      "APP-A",
      "APP-M",
      "APP-Z",
    ]);
    expect(out.eligiblePart2PortalSystemIds).toEqual([
      "SYS-A",
      "SYS-M",
      "SYS-Z",
    ]);
    expect(out.eligiblePart2TrackingIds).toEqual(["ANON", "MNON", "ZNON"]);
  });
});
