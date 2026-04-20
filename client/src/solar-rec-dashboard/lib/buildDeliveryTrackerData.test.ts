import { describe, expect, it } from "vitest";
import { buildDeliveryTrackerData } from "./buildDeliveryTrackerData";
import type { CsvRow } from "../state/types";

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

describe("buildDeliveryTrackerData", () => {
  it("credits delivery when schedule has dates and transfer falls in range", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow()],
      transferRows: [transferRow()],
    });
    expect(data.scheduleCount).toBe(1);
    expect(data.totalTransfers).toBe(1);
    expect(data.unmatchedTransfers).toBe(0);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0].obligated).toBe(10);
    expect(data.rows[0].delivered).toBe(4);
    expect(data.rows[0].gap).toBe(6);
  });

  it("regression guard: Schedule-B-style row without dates still emits obligation", () => {
    // Before the Phase 0 scheduleBScanner fix, Schedule-B-synthesized rows
    // had only year{N}_quantity_required. They must still contribute to
    // obligation totals even without dates (they simply won't receive
    // transfer credits).
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
          year1_end_date: "2024-12-31", // truncated year, transfer is in Jan 2025
        }),
      ],
      transferRows: [transferRow({ "Transfer Completion Date": "2025-01-15" })],
    });
    // completionDate (2025-01) is month 0 → eyStartYear = 2024 → matches
    // the year1_start_date year. Fallback matcher credits it.
    expect(data.totalTransfers).toBe(1);
    expect(data.unmatchedTransfers).toBe(0);
    expect(data.rows[0].delivered).toBe(4);
  });

  it("contract aggregation totals equal per-row sums", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100", year1_quantity_required: "10" }),
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

  it("ignores transfers whose transferee is not a utility", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow()],
      transferRows: [
        transferRow({ Transferee: "Some Broker LLC" }),
      ],
    });
    expect(data.totalTransfers).toBe(0);
    expect(data.rows[0].delivered).toBe(0);
  });

  it("counts unmatched transfers when unit ID has no schedule entry", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "NON100" })],
      transferRows: [transferRow({ "Unit ID": "NON999" })],
    });
    expect(data.totalTransfers).toBe(1);
    expect(data.unmatchedTransfers).toBe(1);
    expect(data.rows[0].delivered).toBe(0);
  });

  it("surfaces transfer unit IDs that lack a Schedule B obligation", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "NON100" })],
      transferRows: [
        transferRow({ "Unit ID": "NON100" }), // matched
        transferRow({ "Unit ID": "NON999" }), // unmatched
        transferRow({ "Unit ID": "NON888" }), // unmatched
        transferRow({ "Unit ID": "NON999" }), // duplicate, should dedupe
      ],
    });
    expect(data.transfersMissingObligation).toEqual([
      { trackingId: "NON888", transferCount: 1 },
      { trackingId: "NON999", transferCount: 2 },
    ]);
  });

  it("does not list matched systems in transfersMissingObligation", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow()],
      transferRows: [transferRow()],
    });
    expect(data.transfersMissingObligation).toEqual([]);
    expect(data.transfersUnmatchedByYear).toEqual([]);
  });

  it("surfaces year-mismatched transfers separately from missing Schedule B", () => {
    // Schedule B exists but its year window is 2024-06-01..2025-05-31.
    // Two transfers are unmatched:
    //   - 2022 transfer → BEFORE earliest year_start → pre_delivery_schedule
    //   - 2030 transfer → AFTER year_end, no energy-year match →
    //     year_mismatch residual
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow({ tracking_system_ref_id: "NON100" })],
      transferRows: [
        transferRow({
          "Unit ID": "NON100",
          "Transfer Completion Date": "2022-08-15",
        }),
        transferRow({
          "Unit ID": "NON100",
          "Transfer Completion Date": "2030-08-15",
        }),
      ],
    });
    // unmatchedTransfers excludes pre_delivery_schedule transfers.
    // Only the year_mismatch (2030) transfer counts toward it.
    expect(data.unmatchedTransfers).toBe(1);
    expect(data.transfersMissingObligation).toEqual([]);
    expect(data.transfersPreDeliverySchedule).toEqual([
      { trackingId: "NON100", transferCount: 1 },
    ]);
    expect(data.transfersUnmatchedByYear).toEqual([
      { trackingId: "NON100", transferCount: 1 },
    ]);
  });

  it("flags Schedule Bs with year boundaries outside 2019-2042", () => {
    const data = buildDeliveryTrackerData({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON_OK" }),
        scheduleRow({
          tracking_system_ref_id: "NON_BAD",
          system_name: "Bad Parse System",
          year1_start_date: "2012-06-01",
          year1_end_date: "2013-05-31",
        }),
      ],
      transferRows: [],
    });
    expect(data.schedulesWithYearsOutsideBounds).toHaveLength(1);
    expect(data.schedulesWithYearsOutsideBounds[0].trackingId).toBe("NON_BAD");
    expect(data.schedulesWithYearsOutsideBounds[0].systemName).toBe(
      "Bad Parse System",
    );
    expect(data.schedulesWithYearsOutsideBounds[0].outOfBoundsYears).toEqual([
      { yearLabel: "2012-2013", startYear: 2012, endYear: 2013 },
    ]);
  });

  it("returns empty when transfers arrive before schedules (hydration guard)", () => {
    // Regression: during progressive hydration, transferHistory can
    // land before deliveryScheduleBase. Previously the compute would
    // mark every transfer as unmatched (scheduleCount=0 →
    // systemSchedules empty), producing a transient 6k↔250k flicker
    // on the Delivery Tracker card. Short-circuit to empty when the
    // schedule side hasn't arrived yet.
    const data = buildDeliveryTrackerData({
      scheduleRows: [],
      transferRows: [
        transferRow({ "Unit ID": "ABC" }),
        transferRow({ "Unit ID": "DEF" }),
        transferRow({ "Unit ID": "GHI" }),
      ],
    });
    expect(data.unmatchedTransfers).toBe(0);
    expect(data.totalTransfers).toBe(0);
    expect(data.rows).toHaveLength(0);
    expect(data.contracts).toHaveLength(0);
  });

  it("still computes when schedules are present but transfers empty (legit state)", () => {
    // Inverse of the guard: Schedule B alone is sufficient to emit
    // obligations. Do not collapse this case to empty.
    const data = buildDeliveryTrackerData({
      scheduleRows: [scheduleRow()],
      transferRows: [],
    });
    expect(data.scheduleCount).toBe(1);
    expect(data.contracts).toHaveLength(1);
    expect(data.rows[0].obligated).toBe(10);
    expect(data.rows[0].delivered).toBe(0);
  });
});
