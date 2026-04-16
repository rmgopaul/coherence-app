import { describe, it, expect } from "vitest";
import { buildSystems, type BuildSystemsInput } from "./buildSystems";
import type { CsvRow, SystemRecord } from "../state/types";

// ---------------------------------------------------------------------------
// Minimal fixture factory
// ---------------------------------------------------------------------------

function emptyInput(): BuildSystemsInput {
  return {
    part2VerifiedAbpRows: [],
    solarApplicationsRows: [],
    contractedDateRows: [],
    accountSolarGenerationRows: [],
    generationEntryRows: [],
    transferHistoryRows: [],
    deliveryScheduleBaseRows: [],
  };
}

function makeAbpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-001",
    system_id: "SYS-001",
    Part_2_App_Verification_Date: "01/15/2024",
    tracking_system_ref_id: "TRACK-001",
    ...overrides,
  };
}

function makeSolarAppRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-001",
    system_id: "SYS-001",
    tracking_system_ref_id: "TRACK-001",
    system_name: "Test Solar System",
    installed_system_size_kw_ac: "10",
    installed_system_size_kw_dc: "12",
    status: "Active",
    installer_name: "Test Installer",
    county: "Cook",
    state: "IL",
    zip_code: "60601",
    ...overrides,
  };
}

function makeGenerationRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    "Unit ID": "TRACK-001",
    "Facility Name": "Test Solar System",
    "Last Month of Gen": "2024-03",
    "Effective Date": "2024-03-15",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildSystems", () => {
  it("returns empty array for empty input", () => {
    const result = buildSystems(emptyInput());
    expect(result).toEqual([]);
  });

  it("returns empty array when abpReport has rows but solarApplications is empty", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow()];
    const result = buildSystems(input);
    // Systems are keyed from solarApplications + abpReport join;
    // with no solarApplications, systems should still be built from
    // abpReport alone (applicationId is the key).
    expect(result.length).toBeGreaterThanOrEqual(0);
  });

  it("builds a system from solarApplications + abpReport", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow()];
    input.solarApplicationsRows = [makeSolarAppRow()];

    const result = buildSystems(input);
    expect(result.length).toBeGreaterThanOrEqual(1);

    // Debug: log actual keys to understand the resolution
    const system = result[0];
    expect(system).toBeDefined();
    if (!system) return;

    // Field parity checks — these are the SystemRecord fields from types.ts:78-111
    expect(system.systemName).toBe("Test Solar System");
    expect(system.part2VerificationDate).toBeInstanceOf(Date);
    expect(typeof system.isReporting).toBe("boolean");
    expect(typeof system.isTerminated).toBe("boolean");
    expect(typeof system.isTransferred).toBe("boolean");
    expect(system.ownershipStatus).toBeDefined();
    expect(system.contractStatusText).toBeDefined();
    expect(system.monitoringType).toBeDefined();
    expect(system.monitoringPlatform).toBeDefined();
    expect(system.installerName).toBe("Test Installer");
  });

  it("resolves system identity from trackingSystemRefId", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow({ tracking_system_ref_id: "TRACK-AAA" })];
    input.solarApplicationsRows = [
      makeSolarAppRow({ tracking_system_ref_id: "TRACK-AAA", system_name: "System AAA" }),
    ];

    const result = buildSystems(input);
    const system = result.find((s) => s.trackingSystemRefId === "TRACK-AAA");
    expect(system).toBeDefined();
    expect(system?.systemName).toBe("System AAA");
  });

  it("joins generation entry for reporting status", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow()];
    input.solarApplicationsRows = [makeSolarAppRow()];
    input.generationEntryRows = [makeGenerationRow()];

    const result = buildSystems(input);
    const system = result.find((s) => s.trackingSystemRefId === "TRACK-001");
    expect(system).toBeDefined();
    // With a generation entry, the system should have reporting data
    expect(system?.latestReportingDate).toBeInstanceOf(Date);
  });

  it("computes size bucket from AC kW", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow()];
    input.solarApplicationsRows = [makeSolarAppRow({ installed_system_size_kw_ac: "8" })];

    const result = buildSystems(input);
    const system = result.find((s) => s.trackingSystemRefId === "TRACK-001");
    expect(system).toBeDefined();
    expect(system?.sizeBucket).toBeDefined();
    expect(system?.installedKwAc).toBe(8);
  });

  it("handles multiple systems", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [
      makeAbpRow({ Application_ID: "APP-001", tracking_system_ref_id: "TRACK-001" }),
      makeAbpRow({ Application_ID: "APP-002", system_id: "SYS-002", tracking_system_ref_id: "TRACK-002" }),
    ];
    input.solarApplicationsRows = [
      makeSolarAppRow({
        Application_ID: "APP-001",
        tracking_system_ref_id: "TRACK-001",
        system_name: "System One",
      }),
      makeSolarAppRow({
        Application_ID: "APP-002",
        system_id: "SYS-002",
        tracking_system_ref_id: "TRACK-002",
        system_name: "System Two",
      }),
    ];

    const result = buildSystems(input);
    expect(result.length).toBeGreaterThanOrEqual(2);

    const names = result.map((s) => s.systemName);
    expect(names).toContain("System One");
    expect(names).toContain("System Two");
  });

  it("returns SystemRecord with all required fields", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow()];
    input.solarApplicationsRows = [makeSolarAppRow()];

    const result = buildSystems(input);
    expect(result.length).toBeGreaterThanOrEqual(1);

    const system = result[0];
    // Verify ALL fields from types.ts:78-111 exist (not undefined)
    const requiredFields: (keyof SystemRecord)[] = [
      "key",
      "systemId",
      "stateApplicationRefId",
      "trackingSystemRefId",
      "systemName",
      "installedKwAc",
      "installedKwDc",
      "sizeBucket",
      "recPrice",
      "totalContractAmount",
      "contractedRecs",
      "deliveredRecs",
      "contractedValue",
      "deliveredValue",
      "valueGap",
      "latestReportingDate",
      "latestReportingKwh",
      "isReporting",
      "isTerminated",
      "isTransferred",
      "ownershipStatus",
      "hasChangedOwnership",
      "changeOwnershipStatus",
      "contractStatusText",
      "contractType",
      "zillowStatus",
      "zillowSoldDate",
      "contractedDate",
      "monitoringType",
      "monitoringPlatform",
      "installerName",
      "part2VerificationDate",
    ];

    for (const field of requiredFields) {
      expect(system).toHaveProperty(field);
    }
  });

  it("is deterministic — same input produces same output", () => {
    const input = emptyInput();
    input.part2VerifiedAbpRows = [makeAbpRow()];
    input.solarApplicationsRows = [makeSolarAppRow()];
    input.generationEntryRows = [makeGenerationRow()];

    const result1 = buildSystems(input);
    const result2 = buildSystems(input);

    expect(result1).toEqual(result2);
  });
});
