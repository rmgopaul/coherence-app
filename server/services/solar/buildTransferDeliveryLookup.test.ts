/**
 * Server-side transfer delivery lookup — parity tests with the
 * client's transferHistoryDeliveries.test.ts.
 *
 * The client and server both implement the same algorithm: Carbon
 * Solutions ↔ Illinois utility direction filter, June-1 energy-year
 * bucketing, case-insensitive tracking IDs. Server-side aggregators
 * (e.g. `buildSystemSnapshot.ts`) and client-side helpers must agree
 * field-for-field; these tests pin the server side of that contract.
 *
 * These tests exercise `computeTransferDeliveryLookupFromRows`
 * directly (no DB) so they run in the same millisecond-range as
 * the client tests. For a smoke test that also exercises the DB
 * read + cache path, see server/solarRecDatasets.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  computeTransferDeliveryLookupFromRows,
  type TypedTransferRow,
} from "./buildTransferDeliveryLookup";

const BATCH_ID = "batch-for-tests";

function row(overrides: Partial<TypedTransferRow> = {}): TypedTransferRow {
  return {
    transactionId: null,
    unitId: "NON100",
    transferor: "Carbon Solutions",
    transferee: "ComEd",
    transferCompletionDate: "2024-08-15",
    quantity: 10,
    ...overrides,
  };
}

function get(
  lookup: Record<string, Record<string, number>>,
  trackingId: string,
  year: number
): number {
  return lookup[trackingId.toLowerCase()]?.[String(year)] ?? 0;
}

describe("computeTransferDeliveryLookupFromRows", () => {
  it("returns an empty lookup when no transfers are provided", () => {
    const result = computeTransferDeliveryLookupFromRows([], BATCH_ID);
    expect(result.byTrackingId).toEqual({});
    expect(result.inputVersionHash).toBe(BATCH_ID);
  });

  it("credits a delivery to the energy year containing the completion date", () => {
    // Aug 15, 2024 → month 7 → eyStartYear = 2024 (June 1 2024 – May 31 2025)
    const result = computeTransferDeliveryLookupFromRows([row()], BATCH_ID);
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(10);
  });

  it("records a return (utility → Carbon Solutions) as a negative entry", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row({ transferor: "ComEd", transferee: "Carbon Solutions" })],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(-10);
  });

  it("ignores transfers between two non-utility / non-CS parties", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row({ transferor: "Some Broker LLC", transferee: "Another Broker LLC" })],
      BATCH_ID
    );
    expect(Object.keys(result.byTrackingId).length).toBe(0);
  });

  it("ignores transfers with zero quantity", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row({ quantity: 0 })],
      BATCH_ID
    );
    expect(Object.keys(result.byTrackingId).length).toBe(0);
  });

  it("ignores transfers with missing unitId", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row({ unitId: "" })],
      BATCH_ID
    );
    expect(Object.keys(result.byTrackingId).length).toBe(0);
  });

  it("ignores transfers with unparseable completion date", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row({ transferCompletionDate: "" })],
      BATCH_ID
    );
    expect(Object.keys(result.byTrackingId).length).toBe(0);
  });

  it("buckets a May 31 transfer into the previous energy year", () => {
    // May 31 2025 → month 4 → eyStartYear = 2024
    const result = computeTransferDeliveryLookupFromRows(
      [row({ transferCompletionDate: "2025-05-31" })],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(10);
    expect(get(result.byTrackingId, "NON100", 2025)).toBe(0);
  });

  it("buckets a June 1 transfer into the new energy year", () => {
    // Jun 1 2025 → month 5 → eyStartYear = 2025
    const result = computeTransferDeliveryLookupFromRows(
      [row({ transferCompletionDate: "2025-06-01" })],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(0);
    expect(get(result.byTrackingId, "NON100", 2025)).toBe(10);
  });

  it("sums multiple transfers for the same (unit, year)", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [
        row({ quantity: 5, transferCompletionDate: "2024-07-01" }),
        row({ quantity: 7, transferCompletionDate: "2024-09-15" }),
      ],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(12);
  });

  it("matches utility patterns case-insensitively", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [
        row({
          transferor: "CARBON SOLUTIONS LLC",
          transferee: "AMEREN ILLINOIS",
        }),
      ],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(10);
  });

  it("matches tracking ID lookups case-insensitively", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row({ unitId: "non100" })],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(10);
    expect(get(result.byTrackingId, "non100", 2024)).toBe(10);
  });

  it("sums lifetime (positive + negative) across energy years", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [
        row({ quantity: 5, transferCompletionDate: "2023-07-01" }),
        row({ quantity: 10, transferCompletionDate: "2024-07-01" }),
        row({
          quantity: 3,
          transferCompletionDate: "2024-09-01",
          transferor: "ComEd",
          transferee: "Carbon Solutions",
        }),
      ],
      BATCH_ID
    );
    const yearMap = result.byTrackingId["non100"] ?? {};
    const lifetime = Object.values(yearMap).reduce((s, n) => s + n, 0);
    expect(lifetime).toBe(12); // 5 + 10 - 3
  });

  it("preserves the passed-in batchId as inputVersionHash", () => {
    const result = computeTransferDeliveryLookupFromRows(
      [row()],
      "some-other-batch-id"
    );
    expect(result.inputVersionHash).toBe("some-other-batch-id");
    expect(result.transferHistoryBatchId).toBe("some-other-batch-id");
  });

  it("dedupes rows sharing a Transaction ID — guards against GATS date-format drift", () => {
    // This is the exact scenario that inflated NON258210's DY3 by
    // 51 RECs in production: the same 5 GATS transactions were
    // ingested twice because one export wrote completion dates as
    // "03/22/2026 03:46 AM" and another as "3/22/26 3:46". The
    // ingest-time composite-key dedup hashed the raw strings and
    // saw them as distinct rows; this test pins down the
    // compute-time safety net that now catches the miss.
    const result = computeTransferDeliveryLookupFromRows(
      [
        row({
          transactionId: "68860388",
          quantity: 9,
          transferCompletionDate: "03/22/2026 03:46 AM",
          transferor: "Carbon Solutions SREC LLC",
          transferee: "Ameren Illinois Company - ABP",
        }),
        row({
          transactionId: "68860388",
          quantity: 9,
          transferCompletionDate: "3/22/26 3:46",
          transferor: "Carbon Solutions SREC LLC",
          transferee: "Ameren Illinois Company - ABP",
        }),
      ],
      BATCH_ID
    );
    // 03/22/2026 → month 2 → eyStartYear = 2025
    expect(get(result.byTrackingId, "NON100", 2025)).toBe(9);
  });

  it("does NOT dedupe when Transaction ID is empty — rare but preserves legacy data", () => {
    // Rows without a Transaction ID fall through to the old sum
    // behavior so we don't collapse genuinely distinct transfers
    // into a single bucket just because they lack an identifier.
    const result = computeTransferDeliveryLookupFromRows(
      [
        row({ transactionId: null, quantity: 5 }),
        row({ transactionId: "", quantity: 7 }),
      ],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(12);
  });

  it("dedupes across distinct units when Transaction IDs collide — first-write-wins", () => {
    // GATS txIds are globally unique, so a repeated txId on a
    // different unit is also a duplicate entry, not a legit
    // transfer — keep the first one we see.
    const result = computeTransferDeliveryLookupFromRows(
      [
        row({ transactionId: "TX1", unitId: "NON100", quantity: 5 }),
        row({ transactionId: "TX1", unitId: "NON200", quantity: 5 }),
      ],
      BATCH_ID
    );
    expect(get(result.byTrackingId, "NON100", 2024)).toBe(5);
    expect(get(result.byTrackingId, "NON200", 2024)).toBe(0);
  });

  it("handles parseQuantity fallback when quantity is null", () => {
    // Matches the `row.quantity ?? parseQuantity(row.quantity)` path —
    // mostly belt-and-braces for rows persisted without a typed
    // quantity column.
    const result = computeTransferDeliveryLookupFromRows(
      [row({ quantity: null })],
      BATCH_ID
    );
    expect(Object.keys(result.byTrackingId).length).toBe(0);
  });
});
