import { describe, expect, it } from "vitest";
import {
  applyFinancialsPage,
  buildFinancialsAggregates,
  buildFinancialsDebug,
  type FinancialsProfitRow,
} from "./buildFinancialsAggregates";
import type { CsvRow } from "./aggregatorHelpers";

function makeRow(
  overrides: Partial<FinancialsProfitRow> = {}
): FinancialsProfitRow {
  return {
    systemName: "System X",
    applicationId: "APP-X",
    csgId: "CSG-X",
    grossContractValue: 100000,
    vendorFeePercent: 5,
    vendorFeeAmount: 5000,
    utilityCollateral: 5000,
    additionalCollateralPercent: 10,
    additionalCollateralAmount: 10000,
    ccAuth5Percent: 0,
    applicationFee: 0,
    totalDeductions: 20000,
    profit: 5000,
    totalCollateralization: 15000,
    needsReview: false,
    reviewReason: "",
    hasOverride: false,
    ...overrides,
  };
}

describe("buildFinancialsAggregates", () => {
  it("joins mapped ABP, ICC, and scan rows into financial profit rows", () => {
    const result = buildFinancialsAggregates({
      mappingRows: [
        {
          csgId: "CSG-1",
          systemId: "APP-1",
        },
      ],
      iccRows: [
        {
          "Application ID": "APP-1",
          "Total REC Delivery Contract Value": "$100,000.00",
          "Total Quantity of RECs Contracted": "100",
          "REC Price": "1000",
        },
      ],
      abpRows: [
        {
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2024-03-15",
          Part_1_Submission_Date: "2024-05-01",
        },
      ],
      scanResults: [
        {
          csgId: "CSG-1",
          systemName: "System One",
          vendorFeePercent: 5,
          additionalCollateralPercent: 10,
          ccAuthorizationCompleted: false,
          acSizeKw: 400,
        },
      ],
    });

    expect(result).toMatchObject({
      totalProfit: 5000,
      avgProfit: 5000,
      totalCollateralization: 20000,
      totalUtilityCollateral: 5000,
      totalAdditionalCollateral: 10000,
      totalCcAuth: 5000,
      systemsWithData: 1,
    });
    expect(result.rows[0]).toMatchObject({
      systemName: "System One",
      applicationId: "APP-1",
      csgId: "CSG-1",
      grossContractValue: 100000,
      vendorFeePercent: 5,
      vendorFeeAmount: 5000,
      utilityCollateral: 5000,
      additionalCollateralPercent: 10,
      additionalCollateralAmount: 10000,
      ccAuth5Percent: 5000,
      applicationFee: 4000,
      totalDeductions: 29000,
      profit: 5000,
      totalCollateralization: 20000,
      needsReview: false,
      reviewReason: "",
      hasOverride: false,
    });
  });

  it("returns the EMPTY_FINANCIALS sentinel when scanResults is empty", () => {
    const result = buildFinancialsAggregates({
      mappingRows: [{ csgId: "CSG-1", systemId: "APP-1" }],
      iccRows: [
        {
          "Application ID": "APP-1",
          "Total REC Delivery Contract Value": "$100,000.00",
        },
      ],
      abpRows: [
        { Application_ID: "APP-1", Part_2_App_Verification_Date: "2024-03-15" },
      ],
      scanResults: [],
    });

    expect(result).toEqual({
      rows: [],
      totalProfit: 0,
      avgProfit: 0,
      totalCollateralization: 0,
      totalUtilityCollateral: 0,
      totalAdditionalCollateral: 0,
      totalCcAuth: 0,
      systemsWithData: 0,
    });
  });

  it("uses pre-cutoff application fee math for Part 1 dates before 2024-06-01", () => {
    // Part 1 submitted 2024-05-01 → pre-cutoff branch:
    //   applicationFee = min(10 * acSizeKw, 5000)
    // For acSizeKw=1000 → 10*1000 = 10000, capped at 5000.
    const result = buildFinancialsAggregates({
      mappingRows: [{ csgId: "CSG-1", systemId: "APP-1" }],
      iccRows: [
        {
          "Application ID": "APP-1",
          "Total REC Delivery Contract Value": "$100,000.00",
        },
      ],
      abpRows: [
        {
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2024-03-15",
          Part_1_Submission_Date: "2024-05-01",
        },
      ],
      scanResults: [
        {
          csgId: "CSG-1",
          vendorFeePercent: 5,
          additionalCollateralPercent: 0,
          ccAuthorizationCompleted: true,
          acSizeKw: 1000,
        },
      ],
    });

    expect(result.rows[0]).toMatchObject({
      applicationFee: 5000, // capped at the pre-cutoff ceiling
      ccAuth5Percent: 0, // ccAuthorizationCompleted=true skips the 5%
    });
  });

  it("does not apply the CC auth 5% surcharge when ccAuthorizationCompleted is true", () => {
    // Same shape as the happy-path test but with ccAuthorizationCompleted=true.
    // Expected difference: ccAuth5Percent=0 (instead of 5000), totalDeductions
    // and totalCollateralization shrink by the same 5000 each.
    const result = buildFinancialsAggregates({
      mappingRows: [{ csgId: "CSG-1", systemId: "APP-1" }],
      iccRows: [
        {
          "Application ID": "APP-1",
          "Total REC Delivery Contract Value": "$100,000.00",
        },
      ],
      abpRows: [
        {
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2024-03-15",
          Part_1_Submission_Date: "2024-05-01",
        },
      ],
      scanResults: [
        {
          csgId: "CSG-1",
          vendorFeePercent: 5,
          additionalCollateralPercent: 10,
          ccAuthorizationCompleted: true,
          acSizeKw: 400,
        },
      ],
    });

    expect(result.rows[0]).toMatchObject({
      ccAuth5Percent: 0,
      totalCollateralization: 15000, // utility 5000 + additional 10000, no CC auth
      totalDeductions: 24000, // 5000 vfp + 5000 utility + 10000 addl + 0 CC + 4000 fee
    });
    expect(result.totalCcAuth).toBe(0);
  });

  it("prefers scan overrides and flags high collateralization for review", () => {
    const baseAbpRow: CsvRow = {
      Application_ID: "APP-1",
      Part_2_App_Verification_Date: "2024-03-15",
      Part_1_Submission_Date: "2024-06-15",
    };

    const result = buildFinancialsAggregates({
      mappingRows: [{ "CSG ID": "CSG-1", "System ID": "APP-1" }],
      iccRows: [
        {
          Application_ID: "APP-1",
          "Contracted SRECs": "100",
          "REC Price": "$1,000",
        },
      ],
      abpRows: [baseAbpRow],
      scanResults: [
        {
          csgId: "CSG-1",
          vendorFeePercent: 5,
          overrideVendorFeePercent: 8,
          additionalCollateralPercent: 10,
          overrideAdditionalCollateralPercent: 35,
          ccAuthorizationCompleted: false,
          acSizeKw: 1000,
          overriddenAt: "2026-04-29T12:00:00.000Z",
        },
      ],
    });

    expect(result.rows[0]).toMatchObject({
      vendorFeePercent: 8,
      vendorFeeAmount: 8000,
      additionalCollateralPercent: 35,
      additionalCollateralAmount: 35000,
      ccAuth5Percent: 5000,
      applicationFee: 15000,
      totalDeductions: 68000,
      profit: 8000,
      totalCollateralization: 45000,
      needsReview: true,
      reviewReason: "Collateral is 45.0% of GCV",
      hasOverride: true,
    });
  });
});

describe("buildFinancialsDebug", () => {
  it("returns zero counts/empty samples for empty input", () => {
    const debug = buildFinancialsDebug({
      mappingRows: [],
      iccRows: [],
      abpRows: [],
      scanResults: [],
      financialCsgIds: [],
    });
    expect(debug.counts).toEqual({
      part2VerifiedAbpRows: 0,
      mappingRows: 0,
      iccReport3Rows: 0,
      financialCsgIdsCount: 0,
      scanResultsReturned: 0,
    });
    expect(debug.chain).toEqual({
      iterated: 0,
      withAppId: 0,
      withCsgId: 0,
      withScan: 0,
      withIcc: 0,
      final: 0,
    });
    expect(debug.samples.mappingCsgIds).toEqual([]);
    expect(debug.icc.headers).toEqual([]);
  });

  it("walks the join chain and counts per-step attrition", () => {
    const debug = buildFinancialsDebug({
      mappingRows: [
        { csgId: "CSG-1", systemId: "APP-1" },
        { csgId: "CSG-2", systemId: "APP-2" },
      ],
      iccRows: [
        {
          "Application ID": "APP-1",
          "Total REC Delivery Contract Value": "$100,000.00",
        },
      ],
      abpRows: [
        {
          Application_ID: "APP-1",
          Part_2_App_Verification_Date: "2024-03-15",
        },
        {
          Application_ID: "APP-2",
          Part_2_App_Verification_Date: "2024-04-01",
        },
        {
          // Not part2-verified — excluded from chain.iterated
          Application_ID: "APP-3",
        },
      ],
      scanResults: [{ csgId: "CSG-1" }],
      financialCsgIds: ["CSG-1", "CSG-2"],
    });

    expect(debug.counts.part2VerifiedAbpRows).toBe(2);
    expect(debug.counts.mappingRows).toBe(2);
    expect(debug.counts.iccReport3Rows).toBe(1);
    expect(debug.counts.financialCsgIdsCount).toBe(2);
    expect(debug.counts.scanResultsReturned).toBe(1);

    expect(debug.chain.iterated).toBe(2);
    expect(debug.chain.withAppId).toBe(2);
    expect(debug.chain.withCsgId).toBe(2);
    expect(debug.chain.withScan).toBe(1); // only CSG-1
    expect(debug.chain.withIcc).toBe(1); // only APP-1
    expect(debug.chain.final).toBe(1); // CSG-1 + APP-1
  });

  it("derives ICC headers + field-found arrays from the first row's keys", () => {
    const debug = buildFinancialsDebug({
      mappingRows: [],
      iccRows: [
        {
          "Application ID": "APP-1",
          "Total REC Delivery Contract Value": "$100,000.00",
          "Some Other Header": "ignored",
        },
      ],
      abpRows: [],
      scanResults: [],
      financialCsgIds: [],
    });
    expect(debug.icc.headers).toContain("Application ID");
    expect(debug.icc.headers).toContain("Total REC Delivery Contract Value");
    expect(debug.icc.appIdFieldFound).toEqual(["Application ID"]);
    expect(debug.icc.contractValueFieldFound).toEqual([
      "Total REC Delivery Contract Value",
    ]);
  });

  it("caps each sample array at 5 entries", () => {
    const mappingRows: CsvRow[] = [];
    for (let i = 0; i < 10; i += 1) {
      mappingRows.push({ csgId: `CSG-${i}`, systemId: `APP-${i}` });
    }
    const debug = buildFinancialsDebug({
      mappingRows,
      iccRows: [],
      abpRows: [],
      scanResults: [],
      financialCsgIds: mappingRows.map((r) => r.csgId as string),
    });
    expect(debug.samples.mappingCsgIds).toHaveLength(5);
    expect(debug.samples.mappingAppIds).toHaveLength(5);
  });
});

/**
 * Page reader (2026-05-13 — wire-shape pagination)
 *
 * `applyFinancialsPage` slices an already-loaded `FinancialsProfitRow[]`
 * into bounded pages with optional sort + filter. The proc layer
 * (`getDashboardFinancialsPage`) reads the cached aggregate via
 * `getOrBuildFinancialsAggregates` and delegates the slice to this
 * pure helper — testing it here avoids spinning up the cache layer.
 */
describe("applyFinancialsPage", () => {
  const rows: FinancialsProfitRow[] = [
    makeRow({ csgId: "C-A", systemName: "Alpha", profit: 5000, needsReview: false }),
    makeRow({ csgId: "C-B", systemName: "Bravo", profit: 8000, needsReview: true, reviewReason: "high coll" }),
    makeRow({ csgId: "C-C", systemName: "Charlie", profit: 3000, needsReview: false }),
    makeRow({ csgId: "C-D", systemName: "Delta", profit: 9500, needsReview: true, reviewReason: "high coll" }),
    makeRow({ csgId: "C-E", systemName: "Echo", profit: 2000, needsReview: false }),
  ];

  it("defaults to profit desc when sortKey/sortDir omitted", () => {
    const page = applyFinancialsPage(rows, {});
    expect(page.rows.map((r) => r.profit)).toEqual([9500, 8000, 5000, 3000, 2000]);
  });

  it("returns totalCount=length of source, regardless of filters", () => {
    const all = applyFinancialsPage(rows, {});
    expect(all.totalCount).toBe(5);

    const filtered = applyFinancialsPage(rows, {
      filterNeedsReview: true,
    });
    expect(filtered.totalCount).toBe(5);
    expect(filtered.totalFiltered).toBe(2);
  });

  it("filterNeedsReview=true returns only needsReview rows", () => {
    const page = applyFinancialsPage(rows, { filterNeedsReview: true });
    expect(page.rows.every((r) => r.needsReview)).toBe(true);
    expect(page.rows.map((r) => r.csgId).sort()).toEqual(["C-B", "C-D"]);
  });

  it("filterNeedsReview=false returns only unflagged rows", () => {
    const page = applyFinancialsPage(rows, { filterNeedsReview: false });
    expect(page.rows.every((r) => !r.needsReview)).toBe(true);
    expect(page.rows.map((r) => r.csgId).sort()).toEqual(["C-A", "C-C", "C-E"]);
  });

  it("filterNeedsReview=null/undefined returns all rows", () => {
    expect(applyFinancialsPage(rows, { filterNeedsReview: null }).totalFiltered).toBe(5);
    expect(applyFinancialsPage(rows, {}).totalFiltered).toBe(5);
  });

  it("free-text search filters across systemName + applicationId + csgId", () => {
    const page = applyFinancialsPage(rows, { search: "bravo" });
    expect(page.rows.map((r) => r.csgId)).toEqual(["C-B"]);
    expect(page.totalFiltered).toBe(1);
  });

  it("free-text search is case-insensitive", () => {
    const page = applyFinancialsPage(rows, { search: "ALPHA" });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].systemName).toBe("Alpha");
  });

  it("flaggedCount counts ALL needsReview rows (independent of filters)", () => {
    const page = applyFinancialsPage(rows, { filterNeedsReview: false });
    expect(page.flaggedCount).toBe(2);
  });

  it("sort by systemName ascending uses locale-aware numeric comparison", () => {
    const numbered: FinancialsProfitRow[] = [
      makeRow({ csgId: "n1", systemName: "Project 2" }),
      makeRow({ csgId: "n2", systemName: "Project 10" }),
      makeRow({ csgId: "n3", systemName: "Project 1" }),
    ];
    const page = applyFinancialsPage(numbered, {
      sortKey: "systemName",
      sortDir: "asc",
    });
    expect(page.rows.map((r) => r.systemName)).toEqual([
      "Project 1",
      "Project 2",
      "Project 10",
    ]);
  });

  it("paginates with no gaps when walking the cursor chain", () => {
    const big: FinancialsProfitRow[] = Array.from({ length: 250 }, (_, i) =>
      makeRow({ csgId: `csg-${i}`, profit: i, systemName: `Sys ${i}` })
    );
    const collected: FinancialsProfitRow[] = [];
    let cursor: number | null = null;
    let pages = 0;
    while (pages < 100) {
      const page: ReturnType<typeof applyFinancialsPage> = applyFinancialsPage(big, {
        cursor,
        limit: 100,
        sortKey: "profit",
        sortDir: "asc",
      });
      collected.push(...page.rows);
      pages += 1;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(collected).toHaveLength(250);
    // Sort by profit asc → profits should be 0..249 in order.
    expect(collected.map((r) => r.profit)).toEqual(
      Array.from({ length: 250 }, (_, i) => i)
    );
    // No duplicates.
    expect(new Set(collected.map((r) => r.csgId)).size).toBe(250);
    // Page count: ceil(250 / 100) = 3.
    expect(pages).toBe(3);
  });

  it("nextCursor === null when at end of stream AND hasMore=false", () => {
    const page = applyFinancialsPage(rows, { cursor: 100, limit: 10 });
    expect(page.rows).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  it("nextCursor matches the next offset when more rows remain", () => {
    const page = applyFinancialsPage(rows, { cursor: 0, limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).toBe(2);
    expect(page.hasMore).toBe(true);
  });

  it("clamps limit to [1, 500]", () => {
    const big: FinancialsProfitRow[] = Array.from({ length: 1500 }, (_, i) =>
      makeRow({ csgId: `csg-${i}`, profit: i })
    );
    // Limit beyond 500 → capped at 500.
    const overLimit = applyFinancialsPage(big, { limit: 9999 });
    expect(overLimit.rows.length).toBe(500);
    // Limit below 1 → capped at 1.
    const underLimit = applyFinancialsPage(big, { limit: 0 });
    expect(underLimit.rows.length).toBe(1);
  });

  it("combining filterNeedsReview + sort + search produces consistent slice", () => {
    const page = applyFinancialsPage(rows, {
      filterNeedsReview: true,
      sortKey: "profit",
      sortDir: "desc",
      search: "delta",
    });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0].csgId).toBe("C-D");
    expect(page.totalFiltered).toBe(1);
    expect(page.totalCount).toBe(5);
    expect(page.flaggedCount).toBe(2);
  });
});
