import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDeliveryTrackerData,
  createDeliveryTrackerAccumulator,
} from "./buildDeliveryTrackerData";

// These fixtures mirror the ones in
// `client/src/solar-rec-dashboard/lib/buildDeliveryTrackerData.test.ts`
// 1:1. The two test files exist in lockstep — if you change the
// server-side aggregator's behavior, update both. The CI suite
// running both files is the divergence detector for the duplicated
// implementation (see `buildDeliveryTrackerData.ts` for why the
// implementation is duplicated rather than imported from client/).

type CsvRow = Record<string, string | undefined>;

const scheduleRow = (overrides: Partial<CsvRow> = {}): CsvRow => ({
  tracking_system_ref_id: "NON100",
  system_name: "Test System",
  utility_contract_number: "493",
  year1_quantity_required: "10",
  year1_start_date: "2024-06-01",
  year1_end_date: "2025-05-31",
  ...overrides,
});

const transferRow = (overrides: Partial<CsvRow> = {}): CsvRow => ({
  "Unit ID": "NON100",
  Quantity: "4",
  Transferor: "Carbon Solutions",
  Transferee: "ComEd",
  "Transfer Completion Date": "2024-08-15",
  ...overrides,
});

describe("buildDeliveryTrackerData (server-side parity)", () => {
  it("server entrypoint uses paged transferHistory reads and a compact detail preview", () => {
    const source = readFileSync(
      resolve(__dirname, "buildDeliveryTrackerData.ts"),
      "utf8"
    );
    expect(source).toContain("deliveryTracker_compact_v2");
    expect(source).toContain("DELIVERY_TRACKER_DETAIL_PREVIEW_LIMIT");
    expect(source).toContain("loadDatasetRowsPage(");
    expect(source).not.toMatch(/loadDatasetRows\([\s\S]{0,160}srDsTransferHistory/);
    expect(source).not.toContain("Promise.all([");
  });

  it("credits delivery when schedule has dates and transfer falls in range", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow()],
      transferRows: [transferRow()],
    });
    expect(data.scheduleCount).toBe(1);
    expect(data.totalTransfers).toBe(1);
    expect(data.unmatchedTransfers).toBe(0);
    expect(data.rows).toHaveLength(1);
    expect(data.detailRowCount).toBe(1);
    expect(data.detailRowsTruncated).toBe(false);
    expect(data.rows[0].obligated).toBe(10);
    expect(data.rows[0].delivered).toBe(4);
    expect(data.rows[0].gap).toBe(6);
  });

  it("can cap returned detail rows while keeping full contract totals", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({
          tracking_system_ref_id: "NON100",
          year1_quantity_required: "10",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON101",
          year1_quantity_required: "20",
          utility_contract_number: "493",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON200",
          year1_quantity_required: "5",
          utility_contract_number: "500",
        }),
      ],
      transferRows: [],
      options: { detailRowLimit: 2 },
    });

    expect(data.rows).toHaveLength(2);
    expect(data.detailRowCount).toBe(3);
    expect(data.detailRowsTruncated).toBe(true);
    expect(data.detailRowLimit).toBe(2);
    const contract493 = data.contracts.find((c) => c.contractId === "493");
    const contract500 = data.contracts.find((c) => c.contractId === "500");
    expect(contract493?.totalObligated).toBe(30);
    expect(contract500?.totalObligated).toBe(5);
  });

  it("streaming accumulator matches the array-based helper", () => {
    const scheduleRows = [scheduleRow()];
    const transferRows = [
      transferRow({ Quantity: "5" }),
      transferRow({
        Quantity: "2",
        Transferor: "ComEd",
        Transferee: "Carbon Solutions",
        "Transfer Completion Date": "2024-09-15",
      }),
    ];
    const arrayResult = buildDeliveryTrackerData({
      scheduleRows,
      transferRows,
    });
    const accumulator = createDeliveryTrackerAccumulator(scheduleRows);
    transferRows.forEach((row) => accumulator.processTransferRow(row));
    expect(accumulator.finish()).toEqual(arrayResult);
  });

  it("writes full detail CSV from the accumulator even when preview rows are capped", async () => {
    const accumulator = createDeliveryTrackerAccumulator(
      [
        scheduleRow({
          tracking_system_ref_id: "NON100",
          year1_quantity_required: "10",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON101",
          year1_quantity_required: "20",
          utility_contract_number: "493",
        }),
      ],
      { detailRowLimit: 1 }
    );
    accumulator.processTransferRow(transferRow({ Quantity: "4" }));

    const preview = accumulator.finish();
    expect(preview.rows).toHaveLength(1);
    expect(preview.detailRowCount).toBe(2);
    expect(preview.detailRowsTruncated).toBe(true);

    const artifact = await accumulator.writeDetailCsvFile(
      "2026-05-06T12:34:56.000Z"
    );
    try {
      expect(artifact.fileName).toBe(
        "delivery-tracker-detail-20260506123456.csv"
      );
      expect(artifact.rowCount).toBe(2);
      expect(artifact.csvBytes).toBeGreaterThan(0);
      expect(artifact.filePath).toBeDefined();
      const csv = readFileSync(artifact.filePath!, "utf8");
      expect(csv).toContain(
        "system_name,unit_id,contract,year,start_date,end_date,obligated,delivered,gap"
      );
      expect(csv).toContain("Test System,NON100,493,2024-2025");
      expect(csv).toContain("Test System,NON101,493,2024-2025");
    } finally {
      await artifact.cleanup?.();
    }
  });

  it("regression guard: Schedule-B-style row without dates still emits obligation", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        {
          tracking_system_ref_id: "NON200",
          system_name: "No Dates System",
          utility_contract_number: "500",
          year1_quantity_required: "7",
        },
      ],
      transferRows: [],
    });
    expect(data.scheduleCount).toBe(1);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].obligated).toBe(7);
    expect(data.rows[0].delivered).toBe(0);
  });

  it("falls back to energy-year boundary matching when exact date range misses", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({
          year1_start_date: "2024-06-01",
          year1_end_date: "2024-12-31",
        }),
      ],
      transferRows: [
        transferRow({ "Transfer Completion Date": "2025-01-15" }),
      ],
    });
    expect(data.totalTransfers).toBe(1);
    expect(data.unmatchedTransfers).toBe(0);
    expect(data.rows[0].delivered).toBe(4);
  });

  it("contract aggregation totals equal per-row sums", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({
          tracking_system_ref_id: "NON100",
          year1_quantity_required: "10",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON101",
          year1_quantity_required: "20",
          utility_contract_number: "493",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON200",
          year1_quantity_required: "5",
          utility_contract_number: "500",
        }),
      ],
      transferRows: [],
    });
    expect(data.contracts).toHaveLength(2);
    const contract493 = data.contracts.find((c) => c.contractId === "493");
    const contract500 = data.contracts.find((c) => c.contractId === "500");
    expect(contract493?.systems).toBe(2);
    expect(contract493?.totalObligated).toBe(30);
    expect(contract500?.systems).toBe(1);
    expect(contract500?.totalObligated).toBe(5);
  });

  it("classifies transfer with no matching schedule as missing-obligation", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [],
      transferRows: [],
    });
    expect(data.totalTransfers).toBe(0);
    // Hydration guard: empty schedules + empty transfers = empty data
    expect(data.transfersMissingObligation).toEqual([]);
  });

  it("hydration guard: schedules empty but transfers present returns empty", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [],
      transferRows: [transferRow()],
    });
    // The guard returns the frozen EMPTY_DELIVERY_TRACKER_DATA
    expect(data.scheduleCount).toBe(0);
    expect(data.totalTransfers).toBe(0);
    expect(data.transfersMissingObligation).toEqual([]);
  });

  it("transfer with no matching schedule lands in transfersMissingObligation", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
      ],
      transferRows: [
        transferRow({ "Unit ID": "NON999" }), // not in any schedule
      ],
    });
    expect(data.totalTransfers).toBe(1);
    expect(data.unmatchedTransfers).toBe(1);
    expect(data.transfersMissingObligation).toHaveLength(1);
    expect(data.transfersMissingObligation[0].trackingId).toBe("NON999");
    expect(data.transfersMissingObligation[0].transferCount).toBe(1);
  });

  it("transfer before earliest schedule year goes to pre-delivery bucket (not unmatched)", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({
          year1_start_date: "2024-06-01",
          year1_end_date: "2025-05-31",
        }),
      ],
      transferRows: [
        transferRow({ "Transfer Completion Date": "2023-06-15" }),
      ],
    });
    expect(data.totalTransfers).toBe(1);
    // Pre-delivery is NOT counted toward unmatchedTransfers (the
    // summary-card counter — this preservation is the explicit reason
    // for the dedicated bucket).
    expect(data.unmatchedTransfers).toBe(0);
    expect(data.transfersPreDeliverySchedule).toHaveLength(1);
    expect(data.transfersPreDeliverySchedule[0].trackingId).toBe("NON100");
  });

  it("flags scraped Schedule Bs with year boundaries outside [2019, 2042]", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({
          year1_start_date: "2017-01-01",
          year1_end_date: "2017-12-31",
        }),
      ],
      transferRows: [],
    });
    expect(data.schedulesWithYearsOutsideBounds).toHaveLength(1);
    expect(data.schedulesWithYearsOutsideBounds[0].trackingId).toBe("NON100");
    expect(
      data.schedulesWithYearsOutsideBounds[0].outOfBoundsYears[0].startYear
    ).toBe(2017);
  });

  it("subtracts return transfers from delivered", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow({ year1_quantity_required: "10" })],
      transferRows: [
        transferRow({ Quantity: "5" }),
        transferRow({
          Quantity: "2",
          Transferor: "ComEd",
          Transferee: "Carbon Solutions",
          "Transfer Completion Date": "2024-09-15",
        }),
      ],
    });
    // 5 delivered, then -2 return → 3 net delivered.
    expect(data.totalTransfers).toBe(2);
    expect(data.rows[0].delivered).toBe(3);
  });

  it("ignores non-utility transfers", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow()],
      transferRows: [
        transferRow({
          Transferor: "Carbon Solutions",
          Transferee: "Random Broker LLC", // not a utility
        }),
      ],
    });
    expect(data.totalTransfers).toBe(0);
    expect(data.rows[0].delivered).toBe(0);
  });
});
