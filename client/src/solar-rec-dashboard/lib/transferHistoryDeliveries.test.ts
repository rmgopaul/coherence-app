import { describe, expect, it } from "vitest";
import {
  buildTransferDeliveryLookup,
  getDeliveredForYear,
  getDeliveredLifetime,
} from "./transferHistoryDeliveries";
import type { CsvRow } from "../state/types";

const transfer = (overrides: Partial<CsvRow> = {}): CsvRow => ({
  "Unit ID": "NON100",
  Quantity: "10",
  Transferor: "Carbon Solutions",
  Transferee: "ComEd",
  "Transfer Completion Date": "2024-08-15",
  ...overrides,
});

describe("buildTransferDeliveryLookup", () => {
  it("returns an empty lookup when no transfers are provided", () => {
    const lookup = buildTransferDeliveryLookup([]);
    expect(lookup.size).toBe(0);
  });

  it("credits a delivery to the energy year containing the completion date", () => {
    // Aug 15, 2024 → month 7 → eyStartYear = 2024 (June 1, 2024 → May 31, 2025)
    const lookup = buildTransferDeliveryLookup([transfer()]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(10);
  });

  it("records a return as a negative entry", () => {
    const lookup = buildTransferDeliveryLookup([
      transfer({ Transferor: "ComEd", Transferee: "Carbon Solutions" }),
    ]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(-10);
  });

  it("ignores transfers where neither side is a utility + carbon solutions pair", () => {
    const lookup = buildTransferDeliveryLookup([
      transfer({ Transferor: "Some Broker LLC", Transferee: "Another Broker LLC" }),
    ]);
    expect(lookup.size).toBe(0);
  });

  it("ignores transfers with a zero quantity", () => {
    const lookup = buildTransferDeliveryLookup([transfer({ Quantity: "0" })]);
    expect(lookup.size).toBe(0);
  });

  it("ignores transfers with a missing Unit ID", () => {
    const lookup = buildTransferDeliveryLookup([transfer({ "Unit ID": "" })]);
    expect(lookup.size).toBe(0);
  });

  it("ignores transfers with an unparseable completion date", () => {
    const lookup = buildTransferDeliveryLookup([
      transfer({ "Transfer Completion Date": "" }),
    ]);
    expect(lookup.size).toBe(0);
  });

  it("buckets a May 31 transfer into the previous energy year", () => {
    // May 31, 2025 → month 4 → eyStartYear = 2024
    const lookup = buildTransferDeliveryLookup([
      transfer({ "Transfer Completion Date": "2025-05-31" }),
    ]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(10);
    expect(getDeliveredForYear(lookup, "NON100", 2025)).toBe(0);
  });

  it("buckets a June 1 transfer into the new energy year", () => {
    // Jun 1, 2025 → month 5 → eyStartYear = 2025
    const lookup = buildTransferDeliveryLookup([
      transfer({ "Transfer Completion Date": "2025-06-01" }),
    ]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(0);
    expect(getDeliveredForYear(lookup, "NON100", 2025)).toBe(10);
  });

  it("sums multiple transfers for the same (unit, year)", () => {
    const lookup = buildTransferDeliveryLookup([
      transfer({ Quantity: "5", "Transfer Completion Date": "2024-07-01" }),
      transfer({ Quantity: "7", "Transfer Completion Date": "2024-09-15" }),
    ]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(12);
  });

  it("matches utility patterns case-insensitively", () => {
    const lookup = buildTransferDeliveryLookup([
      transfer({ Transferor: "CARBON SOLUTIONS LLC", Transferee: "AMEREN ILLINOIS" }),
    ]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(10);
  });

  it("matches tracking ID lookups case-insensitively", () => {
    const lookup = buildTransferDeliveryLookup([transfer({ "Unit ID": "non100" })]);
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(10);
    expect(getDeliveredForYear(lookup, "non100", 2024)).toBe(10);
  });

  it("getDeliveredLifetime sums every energy year bucket for a tracking ID", () => {
    const lookup = buildTransferDeliveryLookup([
      transfer({ Quantity: "5", "Transfer Completion Date": "2023-07-01" }),
      transfer({ Quantity: "10", "Transfer Completion Date": "2024-07-01" }),
      transfer({
        Quantity: "3",
        "Transfer Completion Date": "2024-09-01",
        Transferor: "ComEd",
        Transferee: "Carbon Solutions",
      }),
    ]);
    expect(getDeliveredLifetime(lookup, "NON100")).toBe(12); // 5 + 10 - 3
  });

  it("getDeliveredForYear returns 0 when the tracking ID has no transfers", () => {
    const lookup = buildTransferDeliveryLookup([transfer()]);
    expect(getDeliveredForYear(lookup, "NOT_A_REAL_ID", 2024)).toBe(0);
  });
});
