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

  it("populates abpAcSizeKwBySystemKey under all 3 keys (first-non-null wins)", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({
          Application_ID: "APP-1",
          system_id: "SYS-1",
          Inverter_Size_kW_AC_Part_2: "10.5",
          Project_Name: "Acme",
        }),
        // Same identity, but different value — should be ignored
        // (first-non-null per key wins).
        abpRow({
          Application_ID: "APP-1",
          Inverter_Size_kW_AC_Part_2: "99.9",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.abpAcSizeKwBySystemKey["id:APP-1"]).toBe(10.5);
    expect(out.abpAcSizeKwBySystemKey["tracking:NON100"]).toBe(10.5);
    expect(out.abpAcSizeKwBySystemKey["name:acme"]).toBe(10.5);
  });

  it("builds abpAcSizeKwByApplicationId from `Application_ID || application_id`", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        // Upper-case Application_ID present
        abpRow({ Application_ID: "APP-A", Inverter_Size_kW_AC_Part_2: "5" }),
        // Only lower-case application_id set — should still feed
        // the application-id Map.
        abpRow({
          Application_ID: "",
          system_id: "",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "TRACK-B",
          application_id: "APP-B",
          Inverter_Size_kW_AC_Part_2: "7.5",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.abpAcSizeKwByApplicationId).toEqual({
      "APP-A": 5,
      "APP-B": 7.5,
    });
  });

  it("keeps the EARLIEST part-2 verification date per application id", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2025-06-01",
        }),
        abpRow({
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2025-03-15",
        }),
        abpRow({
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2025-09-30",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.abpPart2VerificationDateByApplicationId["APP-1"]).toBe(
      "2025-03-15"
    );
  });

  it("counts unique part-2 dedupe keys for abpEligibleTotalSystemsCount", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        // Same portalSystemId as the next row — same dedupe key.
        abpRow({ Application_ID: "APP-1", system_id: "SYS-1" }),
        abpRow({ Application_ID: "APP-2", system_id: "SYS-1" }),
        // New portalSystemId — distinct dedupe key.
        abpRow({ Application_ID: "APP-3", system_id: "SYS-3" }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.abpEligibleTotalSystemsCount).toBe(2);
    expect(out.part2VerifiedAbpRowsCount).toBe(3);
  });

  it("collects part2VerifiedSystemIds from `Application_ID || system_id`", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({ Application_ID: "APP-A", system_id: "SYS-A" }),
        abpRow({ Application_ID: "", system_id: "SYS-B" }),
        // Unverified — excluded
        abpRow({
          Application_ID: "APP-C",
          system_id: "SYS-C",
          Part_2_App_Verification_Date: "",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.part2VerifiedSystemIds).toEqual(["APP-A", "SYS-B"]);
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

  // ==========================================================================
  // Phase 3.1 — foundation-defined eligibility
  // ==========================================================================

  it("uses foundation eligibility when provided (overrides legacy date-only filter)", () => {
    const dateValid = abpRow({ Application_ID: "FOUND-OK" });
    const dateValidButFoundationBlocked = abpRow({
      Application_ID: "FOUND-BLOCKED",
    });
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [dateValid, dateValidButFoundationBlocked],
      solarApplicationsRows: [],
      // Both rows would pass the legacy date-only filter; only
      // FOUND-OK passes the foundation's stricter check (e.g. the
      // other had a blocked status text).
      eligibleApplicationIds: new Set(["FOUND-OK"]),
    });
    expect(out.eligiblePart2ApplicationIds).toEqual(["FOUND-OK"]);
    expect(out.part2VerifiedAbpRowsCount).toBe(1);
  });

  it("foundation eligibility excludes rows with valid dates that the foundation rejects", () => {
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({ Application_ID: "VALID-DATE-1" }),
        abpRow({ Application_ID: "VALID-DATE-2" }),
      ],
      solarApplicationsRows: [],
      eligibleApplicationIds: new Set<string>(),
    });
    expect(out.eligiblePart2ApplicationIds).toEqual([]);
    expect(out.part2VerifiedAbpRowsCount).toBe(0);
  });

  it("falls back to legacy date filter when no foundation set is provided", () => {
    // Backward compat — existing 13 tests rely on this path.
    const out = buildOfflineMonitoringAggregates({
      abpReportRows: [
        abpRow({ Application_ID: "VERIFIED" }),
        abpRow({
          Application_ID: "NOT-VERIFIED",
          Part_2_App_Verification_Date: "",
        }),
      ],
      solarApplicationsRows: [],
    });
    expect(out.eligiblePart2ApplicationIds).toEqual(["VERIFIED"]);
  });
});
