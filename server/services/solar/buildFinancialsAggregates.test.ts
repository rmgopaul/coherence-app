import { describe, expect, it } from "vitest";
import { buildFinancialsAggregates } from "./buildFinancialsAggregates";
import type { CsvRow } from "./aggregatorHelpers";

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
