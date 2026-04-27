import { describe, expect, it } from "vitest";
import { buildAppPipelineCashFlow } from "./buildAppPipelineCashFlow";
import type { CsvRow } from "./aggregatorHelpers";

// Server-side tests for the cash-flow aggregator. Inputs are
// already-derived (the pure aggregator runs after Part-2 filtering,
// CSG mapping, ICC parsing) so the fixtures construct each map
// directly. Cache + DB plumbing is exercised by the cache wrapper
// tests separately.

const NOW = new Date("2025-04-15T12:00:00Z");

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    Part_2_App_Verification_Date: "2025-02-15",
    ...overrides,
  };
}

function mappingRow(systemId: string, csgId: string): CsvRow {
  return { systemId, csgId };
}

function iccRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    "Total REC Delivery Contract Value": "100000",
    ...overrides,
  };
}

type ContractScanResult = {
  csgId: string;
  vendorFeePercent: number | null;
  overrideVendorFeePercent: number | null;
  additionalCollateralPercent: number | null;
  overrideAdditionalCollateralPercent: number | null;
  ccAuthorizationCompleted: boolean | null;
};

function scanResult(
  csgId: string,
  overrides: Partial<ContractScanResult> = {}
): ContractScanResult {
  return {
    csgId,
    vendorFeePercent: 5,
    overrideVendorFeePercent: null,
    additionalCollateralPercent: 10,
    overrideAdditionalCollateralPercent: null,
    ccAuthorizationCompleted: true,
    ...overrides,
  };
}

describe("buildAppPipelineCashFlow", () => {
  it("returns empty when contractScanResults is empty", () => {
    expect(
      buildAppPipelineCashFlow({
        part2VerifiedAbpRows: [abpRow()],
        abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
        abpIccReport3Rows: [iccRow()],
        contractScanResults: [],
        overrides: {},
        now: NOW,
      })
    ).toEqual([]);
  });

  it("buckets cash flow into the month AFTER Part-2 verification", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({ Part_2_App_Verification_Date: "2025-02-15" }),
      ],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanResult("CSG-1")],
      overrides: {},
      now: NOW,
    });
    // Verification in Feb → cash-flow month is March.
    expect(data).toHaveLength(1);
    expect(data[0].month).toBe("2025-03");
  });

  it("computes vendor fee, additional collateral, and totals from defaults", () => {
    // GCV = 100,000; vfp=5% → 5,000. acp=10% → 10,000.
    // ccAuthorizationCompleted=true → no CC auth collateral.
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanResult("CSG-1")],
      overrides: {},
      now: NOW,
    });
    expect(data[0].vendorFee).toBe(5000);
    expect(data[0].ccAuthCollateral).toBe(0);
    expect(data[0].additionalCollateral).toBe(10000);
    expect(data[0].totalCashFlow).toBe(15000);
    expect(data[0].projectCount).toBe(1);
  });

  it("adds CC auth collateral (5% of GCV) when ccAuthorizationCompleted is false", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [
        scanResult("CSG-1", { ccAuthorizationCompleted: false }),
      ],
      overrides: {},
      now: NOW,
    });
    // 5% of 100,000 = 5,000.
    expect(data[0].ccAuthCollateral).toBe(5000);
    expect(data[0].totalCashFlow).toBe(20000); // 5k + 5k + 10k
  });

  it("applies localOverrides over scan defaults when provided", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanResult("CSG-1")],
      // 7% vfp, 15% acp → 7,000 + 15,000 = 22,000.
      overrides: { "CSG-1": { vfp: 7, acp: 15 } },
      now: NOW,
    });
    expect(data[0].vendorFee).toBe(7000);
    expect(data[0].additionalCollateral).toBe(15000);
    expect(data[0].totalCashFlow).toBe(22000);
  });

  it("falls back to scan override fields when no localOverride is set", () => {
    // Scan has overrideVendorFeePercent = 8 (vs default 5);
    // localOverrides is empty.
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [
        scanResult("CSG-1", { overrideVendorFeePercent: 8 }),
      ],
      overrides: {},
      now: NOW,
    });
    expect(data[0].vendorFee).toBe(8000);
  });

  it("derives gross contract value from quantity × price when total isn't present", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [abpRow()],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [
        // No Total REC Delivery Contract Value — fall back to qty × price.
        // 1000 RECs × 50 = 50,000.
        iccRow({
          "Total REC Delivery Contract Value": undefined,
          "Total Quantity of RECs Contracted": "1000",
          "REC Price": "50",
        }),
      ],
      contractScanResults: [scanResult("CSG-1")],
      overrides: {},
      now: NOW,
    });
    // 5% of 50,000 = 2,500.
    expect(data[0].vendorFee).toBe(2500);
  });

  it("skips ABP rows where the Part-2 date is in the future", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({ Part_2_App_Verification_Date: "2030-02-15" }),
      ],
      abpCsgSystemMappingRows: [mappingRow("APP-1", "CSG-1")],
      abpIccReport3Rows: [iccRow()],
      contractScanResults: [scanResult("CSG-1")],
      overrides: {},
      now: NOW,
    });
    expect(data).toEqual([]);
  });

  it("aggregates multiple projects into the same cash-flow month", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({ Application_ID: "APP-1" }),
        abpRow({ Application_ID: "APP-2" }),
      ],
      abpCsgSystemMappingRows: [
        mappingRow("APP-1", "CSG-1"),
        mappingRow("APP-2", "CSG-2"),
      ],
      abpIccReport3Rows: [
        iccRow({ Application_ID: "APP-1" }),
        iccRow({ Application_ID: "APP-2" }),
      ],
      contractScanResults: [scanResult("CSG-1"), scanResult("CSG-2")],
      overrides: {},
      now: NOW,
    });
    expect(data).toHaveLength(1);
    expect(data[0].projectCount).toBe(2);
    expect(data[0].vendorFee).toBe(10000);
    expect(data[0].additionalCollateral).toBe(20000);
  });

  it("emits prior-year comparison fields", () => {
    const data = buildAppPipelineCashFlow({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          Part_2_App_Verification_Date: "2024-02-15",
        }),
        abpRow({
          Application_ID: "APP-B",
          Part_2_App_Verification_Date: "2025-02-15",
        }),
      ],
      abpCsgSystemMappingRows: [
        mappingRow("APP-A", "CSG-A"),
        mappingRow("APP-B", "CSG-B"),
      ],
      abpIccReport3Rows: [
        iccRow({ Application_ID: "APP-A" }),
        iccRow({ Application_ID: "APP-B" }),
      ],
      contractScanResults: [scanResult("CSG-A"), scanResult("CSG-B")],
      overrides: {},
      now: NOW,
    });
    const mar2025 = data.find((r) => r.month === "2025-03");
    expect(mar2025?.projectCount).toBe(1);
    expect(mar2025?.prevProjectCount).toBe(1);
    expect(mar2025?.prevVendorFee).toBe(5000);
  });
});
