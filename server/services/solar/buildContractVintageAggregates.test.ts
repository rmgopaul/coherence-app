import { describe, expect, it } from "vitest";
import { buildContractVintageAggregates } from "./buildContractVintageAggregates";
import type { TransferDeliveryLookupPayload } from "./buildTransferDeliveryLookup";

// Server-side fixtures for the per-(contract, deliveryStartDate)
// aggregator. The function runs over already-derived inputs (the
// eligibility maps + transfer-delivery lookup); these tests exercise
// the bucketing + math, not the upstream filtering.
//
// The matched client-side structural mirror is the existing
// ContractsTab `contractDeliveryRows` and AnnualReviewTab
// `annualContractVintageRows` useMemos before this PR — anyone
// changing this aggregator should re-read those for parity.

type CsvRow = Record<string, string | undefined>;

function lookupFor(
  byTrackingId: Record<string, Record<string, number>> = {}
): TransferDeliveryLookupPayload {
  return {
    byTrackingId,
    inputVersionHash: "test-hash",
    transferHistoryBatchId: "test-batch",
  };
}

function scheduleRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    tracking_system_ref_id: "NON100",
    utility_contract_number: "493",
    year1_quantity_required: "100",
    year1_start_date: "2024-06-01",
    ...overrides,
  };
}

describe("buildContractVintageAggregates", () => {
  it("emits one row per (contract, deliveryStartDate) with required/delivered/value", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [scheduleRow()],
      eligibleTrackingIds: new Set(["NON100"]),
      recPriceByTrackingId: new Map([["NON100", 50]]),
      isReportingByTrackingId: new Set(["NON100"]),
      transferDeliveryLookup: lookupFor({ NON100: { "2024": 40 } }),
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.contractId).toBe("493");
    expect(r.required).toBe(100);
    expect(r.delivered).toBe(40);
    expect(r.gap).toBe(60);
    expect(r.deliveredPercent).toBe(40);
    expect(r.requiredValue).toBe(100 * 50);
    expect(r.deliveredValue).toBe(40 * 50);
    expect(r.projectCount).toBe(1);
    expect(r.pricedProjectCount).toBe(1);
    expect(r.reportingProjectCount).toBe(1);
    expect(r.reportingProjectPercent).toBe(100);
  });

  it("filters out tracking ids not in the eligibility set", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON999" }),
      ],
      eligibleTrackingIds: new Set(["NON100"]),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].projectCount).toBe(1);
  });

  it("groups multiple systems on the same (contract, deliveryStartDate) into one row", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [
        scheduleRow({
          tracking_system_ref_id: "NON100",
          year1_quantity_required: "100",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON101",
          year1_quantity_required: "60",
          utility_contract_number: "493",
        }),
      ],
      eligibleTrackingIds: new Set(["NON100", "NON101"]),
      recPriceByTrackingId: new Map([["NON100", 50]]),
      isReportingByTrackingId: new Set(["NON101"]),
      transferDeliveryLookup: lookupFor({
        NON100: { "2024": 30 },
        NON101: { "2024": 20 },
      }),
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.projectCount).toBe(2);
    expect(r.pricedProjectCount).toBe(1); // only NON100 has a recPrice
    expect(r.reportingProjectCount).toBe(1); // only NON101 is reporting
    expect(r.required).toBe(160);
    expect(r.delivered).toBe(50);
  });

  it("separates rows on the same contract but different deliveryStartDate", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [
        scheduleRow({
          year1_start_date: "2024-06-01",
          year1_quantity_required: "100",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON101",
          year1_start_date: "2025-06-01",
          year1_quantity_required: "120",
        }),
      ],
      eligibleTrackingIds: new Set(["NON100", "NON101"]),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toHaveLength(2);
    const sorted = [...rows].sort((a, b) =>
      (a.deliveryStartRaw ?? "").localeCompare(b.deliveryStartRaw ?? "")
    );
    expect(sorted[0].deliveryStartRaw).toBe("2024-06-01");
    expect(sorted[1].deliveryStartRaw).toBe("2025-06-01");
  });

  it("falls back to 'Unassigned' when contract id is missing", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [scheduleRow({ utility_contract_number: undefined })],
      eligibleTrackingIds: new Set(["NON100"]),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows[0].contractId).toBe("Unassigned");
  });

  it("treats missing transfer-lookup entry as zero delivered (zero deliveredPercent)", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [scheduleRow()],
      eligibleTrackingIds: new Set(["NON100"]),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor({}),
    });
    expect(rows[0].delivered).toBe(0);
    expect(rows[0].deliveredPercent).toBe(0);
  });

  it("skips rows with no year1_start_date (empty deliveryStartRaw)", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [scheduleRow({ year1_start_date: "" })],
      eligibleTrackingIds: new Set(["NON100"]),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toEqual([]);
  });

  it("skips rows with empty trackingSystemRefId", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "" })],
      eligibleTrackingIds: new Set(),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toEqual([]);
  });

  it("subtracts return transfers from delivered (lookup may carry negative values)", () => {
    // Transfer lookup is the SOT for delivered totals. If a return
    // transfer netted out part of the delivery, the lookup value is
    // already net. The aggregator just reads it.
    const rows = buildContractVintageAggregates({
      scheduleRows: [scheduleRow({ year1_quantity_required: "100" })],
      eligibleTrackingIds: new Set(["NON100"]),
      recPriceByTrackingId: new Map([["NON100", 50]]),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor({ NON100: { "2024": 25 } }),
    });
    expect(rows[0].delivered).toBe(25);
    expect(rows[0].deliveredValue).toBe(25 * 50);
    expect(rows[0].valueGap).toBe(100 * 50 - 25 * 50);
  });

  it("counts pricedProjectCount only for tracking ids with a known recPrice", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON101" }),
        scheduleRow({ tracking_system_ref_id: "NON102" }),
      ],
      eligibleTrackingIds: new Set(["NON100", "NON101", "NON102"]),
      // Only NON100 + NON101 have a recPrice
      recPriceByTrackingId: new Map([
        ["NON100", 50],
        ["NON101", 50],
      ]),
      isReportingByTrackingId: new Set(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].projectCount).toBe(3);
    expect(rows[0].pricedProjectCount).toBe(2);
  });

  it("computes reportingProjectPercent against projectCount, not eligible total", () => {
    const rows = buildContractVintageAggregates({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON101" }),
      ],
      eligibleTrackingIds: new Set(["NON100", "NON101"]),
      recPriceByTrackingId: new Map(),
      isReportingByTrackingId: new Set(["NON100"]),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows[0].reportingProjectCount).toBe(1);
    expect(rows[0].reportingProjectPercent).toBe(50);
  });
});
