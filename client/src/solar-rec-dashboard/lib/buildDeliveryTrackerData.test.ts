import { describe, expect, it } from "vitest";
import { buildDeliveryTrackerData } from "./buildDeliveryTrackerData";
import type { CsvRow } from "./mergeScheduleRows";

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
});
