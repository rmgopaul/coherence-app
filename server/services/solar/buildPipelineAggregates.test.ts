import { describe, expect, it } from "vitest";
import {
  buildPipelineCashFlow,
  buildPipelineMonthly,
  type PipelineContractScan,
  type PipelineSnapshotSystem,
} from "./buildPipelineAggregates";

type CsvRow = Record<string, string | undefined>;

// Server-side fixtures for the AppPipelineTab aggregator. The pure
// functions run over already-loaded `CsvRow[]` inputs (the cached
// entrypoint `getOrBuildAppPipelineAggregates` handles the row
// hydration + contract-scan fetch + cache wiring); these tests
// exercise the bucketing + dedupe + cash-flow math, not the
// upstream loading.
//
// "Now" is fixed to 2026-04-15 so future-date filters and prior-
// year comparisons land on stable months across CI runs.

const FIXED_NOW = new Date(2026, 3, 15); // April 15, 2026

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP001",
    Project_Name: "Project Alpha",
    Part_1_submission_date: "2024-01-15",
    Inverter_Size_kW_AC_Part_1: "100",
    Part_2_App_Verification_Date: "2024-03-10",
    Inverter_Size_kW_AC_Part_2: "98",
    ...overrides,
  };
}

function genRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    "GATS Unit ID": "NON100",
    "Date Online": "2024-05-15",
    "AC Size (kW)": "95",
    ...overrides,
  };
}

function mappingRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    "CSG ID": "CSG001",
    "System ID": "APP001",
    ...overrides,
  };
}

function iccRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    "Application ID": "APP001",
    "Total REC Delivery Contract Value": "50000",
    ...overrides,
  };
}

function scanRow(
  overrides: Partial<PipelineContractScan> = {}
): PipelineContractScan {
  return {
    csgId: "CSG001",
    vendorFeePercent: 5,
    overrideVendorFeePercent: null,
    additionalCollateralPercent: 2,
    overrideAdditionalCollateralPercent: null,
    ccAuthorizationCompleted: true,
    ...overrides,
  };
}

function systemRow(
  overrides: Partial<PipelineSnapshotSystem> = {}
): PipelineSnapshotSystem {
  return {
    systemId: "APP001",
    stateApplicationRefId: null,
    trackingSystemRefId: "NON100",
    recPrice: null,
    isReporting: false,
    installedKwAc: 90,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildPipelineMonthly
// ---------------------------------------------------------------------------

describe("buildPipelineMonthly", () => {
  it("returns empty array when there are no input rows", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [],
      generatorDetailsRows: [],
      systems: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("buckets a single Part 1 + Part 2 + Interconnected entry into the right months", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [abpRow()],
      generatorDetailsRows: [genRow()],
      systems: [systemRow()],
      now: FIXED_NOW,
    });

    // Three buckets: Jan (Part 1), Mar (Part 2), May (Interconnected).
    const months = result.map((r) => r.month);
    expect(months).toContain("2024-01");
    expect(months).toContain("2024-03");
    expect(months).toContain("2024-05");

    const jan = result.find((r) => r.month === "2024-01")!;
    expect(jan.part1Count).toBe(1);
    expect(jan.part1KwAc).toBe(100);
    expect(jan.part2Count).toBe(0);

    const mar = result.find((r) => r.month === "2024-03")!;
    expect(mar.part2Count).toBe(1);
    expect(mar.part2KwAc).toBe(98);
    expect(mar.part1Count).toBe(0);

    const may = result.find((r) => r.month === "2024-05")!;
    expect(may.interconnectedCount).toBe(1);
    expect(may.interconnectedKwAc).toBe(95);
  });

  it("dedupes ABP rows by canonical project key (system_id wins over Application_ID)", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [
        abpRow({ Application_ID: "APP001", system_id: "SYS-X" }),
        abpRow({ Application_ID: "APP002", system_id: "SYS-X" }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: FIXED_NOW,
    });
    const jan = result.find((r) => r.month === "2024-01")!;
    expect(jan.part1Count).toBe(1);
    expect(jan.part1KwAc).toBe(100);
  });

  it("filters out rows with future Part 1 / Part 2 / online dates", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [
        abpRow({
          Application_ID: "FUT-1",
          Part_1_submission_date: "2027-01-15",
          Part_2_App_Verification_Date: "2027-03-10",
        }),
      ],
      generatorDetailsRows: [
        genRow({ "GATS Unit ID": "FUT-2", "Date Online": "2027-05-15" }),
      ],
      systems: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("falls back to system.installedKwAc when generator-details has no AC size", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [],
      generatorDetailsRows: [
        genRow({
          "GATS Unit ID": "NON200",
          "Date Online": "2024-05-15",
          "AC Size (kW)": "", // empty — should fall back
        }),
      ],
      systems: [
        systemRow({ trackingSystemRefId: "NON200", installedKwAc: 87 }),
      ],
      now: FIXED_NOW,
    });
    const may = result.find((r) => r.month === "2024-05")!;
    expect(may.interconnectedCount).toBe(1);
    expect(may.interconnectedKwAc).toBe(87);
  });

  it("populates prior-year comparison fields", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [
        abpRow({
          Application_ID: "A1",
          system_id: "SYS-A1",
          Part_1_submission_date: "2024-01-15",
        }),
        abpRow({
          Application_ID: "A2",
          system_id: "SYS-A2",
          Part_1_submission_date: "2025-01-15",
          Inverter_Size_kW_AC_Part_1: "150",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: FIXED_NOW,
    });
    const jan2025 = result.find((r) => r.month === "2025-01")!;
    expect(jan2025.part1Count).toBe(1);
    expect(jan2025.part1KwAc).toBe(150);
    expect(jan2025.prevPart1Count).toBe(1);
    expect(jan2025.prevPart1KwAc).toBe(100);
  });

  it("dedupes interconnected entries by GATS Unit ID — first row wins", () => {
    const result = buildPipelineMonthly({
      abpReportRows: [],
      generatorDetailsRows: [
        genRow({ "Date Online": "2024-05-15", "AC Size (kW)": "95" }),
        // Same tracking ID, different month + AC size → ignored.
        genRow({ "Date Online": "2024-08-15", "AC Size (kW)": "120" }),
      ],
      systems: [],
      now: FIXED_NOW,
    });
    const may = result.find((r) => r.month === "2024-05");
    const aug = result.find((r) => r.month === "2024-08");
    expect(may?.interconnectedCount).toBe(1);
    expect(may?.interconnectedKwAc).toBe(95);
    expect(aug).toBeUndefined();
  });

  it("returns rows sorted ascending by month", () => {
    // Explicitly clear Part 2 dates so only Part 1 produces buckets,
    // keeping the assertion focused on month-order rather than
    // co-bucketing.
    const result = buildPipelineMonthly({
      abpReportRows: [
        abpRow({
          Application_ID: "A1",
          system_id: "SYS-A1",
          Part_1_submission_date: "2024-12-15",
          Part_2_App_Verification_Date: "",
        }),
        abpRow({
          Application_ID: "A2",
          system_id: "SYS-A2",
          Part_1_submission_date: "2024-01-15",
          Part_2_App_Verification_Date: "",
        }),
        abpRow({
          Application_ID: "A3",
          system_id: "SYS-A3",
          Part_1_submission_date: "2024-06-15",
          Part_2_App_Verification_Date: "",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: FIXED_NOW,
    });
    expect(result.map((r) => r.month)).toEqual([
      "2024-01",
      "2024-06",
      "2024-12",
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildPipelineCashFlow
// ---------------------------------------------------------------------------

describe("buildPipelineCashFlow", () => {
  it("returns empty array when contractScanResults is empty", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("buckets cash flow into the month after Part 2 verification (March → April)", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanRow()],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toHaveLength(1);
    const r = result[0];
    expect(r.month).toBe("2024-04");
    // 5% of $50,000 = $2,500 vendor fee
    expect(r.vendorFee).toBe(2500);
    // CC auth completed → no CC auth collateral
    expect(r.ccAuthCollateral).toBe(0);
    // 2% of $50,000 = $1,000 additional collateral
    expect(r.additionalCollateral).toBe(1000);
    expect(r.totalCashFlow).toBe(3500);
    expect(r.projectCount).toBe(1);
  });

  it("applies CC auth collateral (5% of GCV) when scan.ccAuthorizationCompleted === false", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanRow({ ccAuthorizationCompleted: false })],
      overrides: [],
      now: FIXED_NOW,
    });
    const r = result[0];
    // 5% of $50,000 = $2,500
    expect(r.ccAuthCollateral).toBe(2500);
    expect(r.totalCashFlow).toBe(2500 + 2500 + 1000);
  });

  it("local override beats scan override beats scan default (vendor fee)", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [
        scanRow({ vendorFeePercent: 5, overrideVendorFeePercent: 8 }),
      ],
      overrides: [{ csgId: "CSG001", vfp: 12, acp: null }],
      now: FIXED_NOW,
    });
    // 12% local override wins: 12% of $50,000 = $6,000
    expect(result[0].vendorFee).toBe(6000);
  });

  it("scan override beats scan default when no local override is provided", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [
        scanRow({ vendorFeePercent: 5, overrideVendorFeePercent: 8 }),
      ],
      overrides: [],
      now: FIXED_NOW,
    });
    // 8% override wins: 8% of $50,000 = $4,000
    expect(result[0].vendorFee).toBe(4000);
  });

  it("falls back to recQuantity * recPrice when grossContractValue is missing", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [
        {
          "Application ID": "APP001",
          "Total Quantity of RECs Contracted": "200",
          "REC Price": "100",
          // GCV column intentionally absent
        },
      ],
      contractScanResults: [scanRow()],
      overrides: [],
      now: FIXED_NOW,
    });
    // 200 * 100 = $20,000 GCV → 5% = $1,000 vendor fee
    expect(result[0].vendorFee).toBe(1000);
  });

  it("skips rows where the CSG mapping is missing", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [], // no mapping → skip
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanRow()],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("skips rows where the scan result is missing for the mapped CSG ID", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanRow({ csgId: "OTHER-CSG" })],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("skips rows where the ICC report has no entry for the application", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [], // no ICC entry → skip
      contractScanResults: [scanRow()],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("filters out rows whose Part 2 date is in the future", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({ Part_2_App_Verification_Date: "2027-03-10" }),
      ],
      abpCsgSystemMappingRows: [mappingRow()],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanRow()],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toEqual([]);
  });

  it("aggregates multiple projects into a single month bucket and sums them", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({ Application_ID: "APP001" }),
        abpRow({ Application_ID: "APP002" }),
      ],
      abpCsgSystemMappingRows: [
        mappingRow({ "System ID": "APP001", "CSG ID": "CSG001" }),
        mappingRow({ "System ID": "APP002", "CSG ID": "CSG002" }),
      ],
      abpIccReport3Rows: [
        iccRow({ "Application ID": "APP001" }),
        iccRow({ "Application ID": "APP002" }),
      ],
      contractScanResults: [
        scanRow({ csgId: "CSG001" }),
        scanRow({ csgId: "CSG002" }),
      ],
      overrides: [],
      now: FIXED_NOW,
    });
    expect(result).toHaveLength(1);
    expect(result[0].projectCount).toBe(2);
    // 2 × $2,500 vendor fee = $5,000
    expect(result[0].vendorFee).toBe(5000);
  });

  it("populates prior-year comparison fields when months align", () => {
    const result = buildPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP001",
          Part_2_App_Verification_Date: "2024-03-10",
        }),
        abpRow({
          Application_ID: "APP002",
          system_id: "SYS-002",
          Part_2_App_Verification_Date: "2025-03-10",
        }),
      ],
      abpCsgSystemMappingRows: [
        mappingRow({ "System ID": "APP001", "CSG ID": "CSG001" }),
        mappingRow({ "System ID": "APP002", "CSG ID": "CSG002" }),
      ],
      abpIccReport3Rows: [
        iccRow({ "Application ID": "APP001" }),
        iccRow({ "Application ID": "APP002" }),
      ],
      contractScanResults: [
        scanRow({ csgId: "CSG001" }),
        scanRow({ csgId: "CSG002" }),
      ],
      overrides: [],
      now: FIXED_NOW,
    });
    const apr2025 = result.find((r) => r.month === "2025-04")!;
    expect(apr2025.projectCount).toBe(1);
    expect(apr2025.prevProjectCount).toBe(1);
    expect(apr2025.prevVendorFee).toBe(2500);
  });
});
