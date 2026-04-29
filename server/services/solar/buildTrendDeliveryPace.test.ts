import { describe, expect, it } from "vitest";
import { buildTrendDeliveryPace } from "./buildTrendDeliveryPace";
import { buildTransferDeliveryLookupFixture as lookupFor } from "./aggregatorTestFixtures";

// Server-side parity tests for the delivery-pace aggregator.
//
// As of 2026-04-27 there is no `trends.test.ts` on the client side;
// the helper was extracted from `SolarRecDashboard.tsx` without a
// dedicated test. This server-side suite is the only test for the
// shared logic — when the client-side helper is eventually deleted
// (after both AlertsTab and TrendsTab consume the server query
// exclusively), this file becomes the SOT.

type CsvRow = Record<string, string | undefined>;

const NOW = new Date("2025-03-15T12:00:00Z");

function scheduleRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    tracking_system_ref_id: "NON100",
    utility_contract_number: "493",
    year1_quantity_required: "100",
    year1_start_date: "2024-06-01",
    year1_end_date: "2025-05-31",
    ...overrides,
  };
}

describe("buildTrendDeliveryPace (server-side)", () => {
  it("returns empty when no schedule rows provided", () => {
    expect(buildTrendDeliveryPace([], lookupFor(), NOW)).toEqual([]);
  });

  it("emits one row per active utility contract with required + delivered + paces", () => {
    const rows = buildTrendDeliveryPace(
      [scheduleRow()],
      // 2026-04-29: lookup keys are lowercased to match the prod
      // payload shape (server builds via `unitId.toLowerCase()`).
      // `getDeliveredForYear` lowercases the query internally so
      // mixed-case row data (`tracking_system_ref_id: "NON100"`)
      // still hits.
      lookupFor({ non100: { "2024": 50 } }),
      NOW
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.contract).toBe("493");
    expect(row.required).toBe(100);
    expect(row.delivered).toBe(50);
    // expectedPace = (now - start) / (end - start) * 100, capped at 100
    // For 2025-03-15 within 2024-06-01..2025-05-31, ~78%
    expect(row.expectedPace).toBeGreaterThan(70);
    expect(row.expectedPace).toBeLessThan(85);
    // actualPace = 50/100 * 100 = 50, capped at 100
    expect(row.actualPace).toBe(50);
  });

  it("skips year-windows that aren't currently active", () => {
    // year1 window is 2022-2023 (not active relative to 2025-03-15);
    // no year2+ data — the contract has no active row to emit.
    const rows = buildTrendDeliveryPace(
      [
        scheduleRow({
          year1_start_date: "2022-06-01",
          year1_end_date: "2023-05-31",
        }),
      ],
      lookupFor(),
      NOW
    );
    expect(rows).toEqual([]);
  });

  it("aggregates across multiple year-windows sharing a contract id", () => {
    // year1 = 2024-2025 (active for 2025-03-15) → required 100
    // year2 = 2025-2026 (also covers 2025-03-15? no — starts 2025-06-01)
    //   → not active yet; ignored
    // Single active row contributes 100.
    const rows = buildTrendDeliveryPace(
      [
        scheduleRow({
          year1_start_date: "2024-06-01",
          year1_end_date: "2025-05-31",
          year1_quantity_required: "100",
          year2_start_date: "2025-06-01",
          year2_end_date: "2026-05-31",
          year2_quantity_required: "200",
        }),
      ],
      lookupFor(),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].required).toBe(100);
  });

  it("collapses two systems on the same contract into a single aggregate row", () => {
    const rows = buildTrendDeliveryPace(
      [
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
      lookupFor({
        non100: { "2024": 30 },
        non101: { "2024": 20 },
      }),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contract).toBe("493");
    expect(rows[0].required).toBe(160);
    expect(rows[0].delivered).toBe(50);
    // actualPace = 50/160 * 100 = 31.25
    expect(rows[0].actualPace).toBeCloseTo(31.25, 5);
  });

  it("uses 'Unknown' as the contract id when utility_contract_number is missing", () => {
    const rows = buildTrendDeliveryPace(
      [
        scheduleRow({
          utility_contract_number: undefined,
        }),
      ],
      lookupFor({ non100: { "2024": 50 } }),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contract).toBe("Unknown");
  });

  it("ignores rows without a year1_start_date", () => {
    const rows = buildTrendDeliveryPace(
      [
        scheduleRow({
          year1_start_date: "",
          year1_end_date: "",
        }),
      ],
      lookupFor(),
      NOW
    );
    expect(rows).toEqual([]);
  });

  it("ignores rows where year1_quantity_required is zero", () => {
    const rows = buildTrendDeliveryPace(
      [scheduleRow({ year1_quantity_required: "0" })],
      lookupFor(),
      NOW
    );
    expect(rows).toEqual([]);
  });

  it("treats no transfer-lookup entry as zero delivered", () => {
    const rows = buildTrendDeliveryPace(
      [scheduleRow()],
      lookupFor({}),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered).toBe(0);
    expect(rows[0].actualPace).toBe(0);
  });

  it("synthesizes year1_end when missing (start + 1 year)", () => {
    // No end_date supplied — helper falls back to start + 1 year.
    // 2024-06-01 + 1y = 2025-06-01, so 2025-03-15 is still active.
    const rows = buildTrendDeliveryPace(
      [
        scheduleRow({
          year1_start_date: "2024-06-01",
          year1_end_date: undefined,
        }),
      ],
      lookupFor({ non100: { "2024": 25 } }),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].delivered).toBe(25);
  });

  it("sorts result rows by contract id alphabetically", () => {
    const rows = buildTrendDeliveryPace(
      [
        scheduleRow({
          tracking_system_ref_id: "Z",
          utility_contract_number: "777",
        }),
        scheduleRow({
          tracking_system_ref_id: "A",
          utility_contract_number: "123",
        }),
        scheduleRow({
          tracking_system_ref_id: "M",
          utility_contract_number: "555",
        }),
      ],
      lookupFor(),
      NOW
    );
    expect(rows.map((r) => r.contract)).toEqual(["123", "555", "777"]);
  });
});
