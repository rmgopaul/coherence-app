import { describe, expect, it } from "vitest";
import { buildTrendsProduction } from "./buildTrendsProduction";
import type { CsvRow } from "./aggregatorHelpers";

// Server-side fixtures for the production-trend aggregator. These
// exercise the bucketing + delta + top-10 logic that the original
// `trendProductionMoM` + `trendTopSiteIds` useMemos in `TrendsTab.tsx`
// performed against `convertedReads.rows`. There is no matched
// client-side test (the helper was inline in the tab) — this server
// suite is the SOT for the migrated logic.

function readRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    monitoring_system_id: "site-1",
    monitoring_system_name: "Site 1",
    lifetime_meter_read_wh: "0",
    read_date: "2025-01-15",
    ...overrides,
  };
}

describe("buildTrendsProduction", () => {
  it("returns empty when no rows are provided", () => {
    expect(buildTrendsProduction({ convertedReadsRows: [] })).toEqual({
      chartRows: [],
      topSiteIds: [],
    });
  });

  it("computes month-over-month deltas in kWh from cumulative Wh readings", () => {
    // Lifetime meter reads jump from 1,000,000 Wh → 2,500,000 Wh →
    // 4,000,000 Wh across three months. Deltas (in kWh) for the
    // last two months are 1,500 and 1,500.
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "1000000",
        }),
        readRow({
          read_date: "2025-02-15",
          lifetime_meter_read_wh: "2500000",
        }),
        readRow({
          read_date: "2025-03-15",
          lifetime_meter_read_wh: "4000000",
        }),
      ],
    });
    expect(data.chartRows).toEqual([
      { month: "2025-02", "site-1": 1500 },
      { month: "2025-03", "site-1": 1500 },
    ]);
    expect(data.topSiteIds).toEqual(["site-1"]);
  });

  it("keeps the MAX lifetime read per (site, month) bucket", () => {
    // Two reads in the same month — only the larger should anchor
    // the bucket. Combined with the prior month, the delta should
    // come from the MAX, not the first or last reading.
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "1000000",
        }),
        readRow({
          read_date: "2025-02-05",
          lifetime_meter_read_wh: "1500000",
        }),
        readRow({
          read_date: "2025-02-25",
          lifetime_meter_read_wh: "2500000",
        }),
      ],
    });
    expect(data.chartRows).toEqual([
      { month: "2025-02", "site-1": 1500 },
    ]);
  });

  it("drops non-positive deltas (meter resets / data holes)", () => {
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "5000000",
        }),
        readRow({
          read_date: "2025-02-15",
          // Decreased — meter reset or backfill correction.
          lifetime_meter_read_wh: "4000000",
        }),
        readRow({
          read_date: "2025-03-15",
          lifetime_meter_read_wh: "5000000",
        }),
      ],
    });
    // Only March has a positive delta vs Feb (1,000 kWh).
    expect(data.chartRows).toEqual([{ month: "2025-03", "site-1": 1000 }]);
  });

  it("falls back to monitoring_system_name when monitoring_system_id is empty", () => {
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          monitoring_system_id: "",
          monitoring_system_name: "Fallback Name",
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "1000000",
        }),
        readRow({
          monitoring_system_id: "",
          monitoring_system_name: "Fallback Name",
          read_date: "2025-02-15",
          lifetime_meter_read_wh: "2000000",
        }),
      ],
    });
    expect(data.topSiteIds).toEqual(["Fallback Name"]);
    expect(data.chartRows[0]["Fallback Name"]).toBe(1000);
  });

  it("skips rows with empty/invalid lifetime_meter_read_wh", () => {
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "",
        }),
        readRow({
          read_date: "2025-02-15",
          lifetime_meter_read_wh: "abc",
        }),
        readRow({
          read_date: "2025-03-15",
          lifetime_meter_read_wh: "1000000",
        }),
      ],
    });
    // Only March has a valid reading; without a previous month to
    // delta against, no chart row is emitted.
    expect(data.chartRows).toEqual([]);
  });

  it("skips rows with empty/invalid read_date", () => {
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({ read_date: "", lifetime_meter_read_wh: "1000000" }),
        readRow({ read_date: "garbage", lifetime_meter_read_wh: "2000000" }),
      ],
    });
    expect(data.chartRows).toEqual([]);
  });

  it("limits to top 10 sites by total production and pivots correctly", () => {
    // Build 12 sites, each with one reading in Jan and one in Feb.
    // Site N's Feb-minus-Jan delta is N kWh; top 10 should be sites
    // 12..3.
    //
    // NOTE: Jan readings start at 100,000 Wh (not 0) because the
    // aggregator's `if (rawWh > existing)` guard with `existing`
    // defaulting to 0 silently drops first readings of value 0.
    // That's a pre-existing client behavior we're faithfully
    // preserving in this PR — see the comment block above the
    // `existing` initialization in `buildTrendsProduction`. Real
    // prod readings are always > 0 (cumulative meters), so the
    // edge case rarely matters; cleanup to use `existing ===
    // undefined` is queued as a follow-up.
    const rows: CsvRow[] = [];
    for (let i = 1; i <= 12; i++) {
      rows.push(
        readRow({
          monitoring_system_id: `site-${i}`,
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "100000",
        }),
        readRow({
          monitoring_system_id: `site-${i}`,
          read_date: "2025-02-15",
          lifetime_meter_read_wh: String(100000 + i * 1000),
        })
      );
    }
    const data = buildTrendsProduction({ convertedReadsRows: rows });
    expect(data.topSiteIds).toHaveLength(10);
    // Two smallest sites should be excluded.
    expect(data.topSiteIds).not.toContain("site-1");
    expect(data.topSiteIds).not.toContain("site-2");
    // Largest site should be present.
    expect(data.topSiteIds).toContain("site-12");
    // Chart row has one cell per top-10 site (plus the `month` key).
    expect(Object.keys(data.chartRows[0]).length).toBe(11);
  });

  it("preserves the pre-existing client behavior where first reading == 0 is dropped", () => {
    // Documenting the inherited edge case so a future fix of the
    // `existing` default doesn't silently break this aggregator's
    // contract. If/when the aggregator is changed to use
    // `existing === undefined`, this test should be updated to
    // assert the new (correct) behavior.
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "0",
        }),
        readRow({
          read_date: "2025-02-15",
          lifetime_meter_read_wh: "1000000",
        }),
      ],
    });
    // Jan reading was 0 — silently dropped. Without a Jan reading
    // to delta against, no chart row is emitted for Feb.
    expect(data.chartRows).toEqual([]);
  });

  it("emits chart rows in chronological month order", () => {
    const data = buildTrendsProduction({
      convertedReadsRows: [
        readRow({
          read_date: "2025-03-15",
          lifetime_meter_read_wh: "3000000",
        }),
        readRow({
          read_date: "2025-01-15",
          lifetime_meter_read_wh: "1000000",
        }),
        readRow({
          read_date: "2025-02-15",
          lifetime_meter_read_wh: "2000000",
        }),
      ],
    });
    expect(data.chartRows.map((r) => r.month)).toEqual([
      "2025-02",
      "2025-03",
    ]);
  });
});
