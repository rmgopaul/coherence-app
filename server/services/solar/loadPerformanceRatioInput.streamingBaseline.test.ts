/**
 * Parity test for the streaming accountSolarGeneration → baseline
 * accumulator (2026-05-08 OOM fix).
 *
 * Background: `srDsAccountSolarGeneration` has 17M+ rows on prod;
 * the legacy `loadPerformanceRatioStaticInput` materialized that
 * full table via `loadDatasetRows` and OOMed the build worker.
 * The streaming fix processes the table page-by-page through
 * `applyAccountSolarGenerationPageToBaselineMap`, which mirrors
 * the per-row logic of `buildGenerationBaselineByTrackingId`'s
 * accountSolarGeneration branch.
 *
 * This test pins the parity: chunking the same input row set into
 * arbitrary page sizes and reducing through the streaming helper
 * MUST produce a Map equal to the bulk
 * `buildGenerationBaselineByTrackingId([], allRows)` output. A
 * regression that broke the merge rule (latest date wins; on
 * ties, "Generation Entry" outranks "Account Solar Generation")
 * would be silently catastrophic — every Performance Ratio
 * computation downstream uses this baseline as the lifetime-wh
 * anchor. Source-level rail not enough.
 */
import { describe, expect, it } from "vitest";
import { applyAccountSolarGenerationPageToBaselineMap } from "./loadPerformanceRatioInput";
import { buildGenerationBaselineByTrackingId } from "../../../shared/solarRecPerformanceRatio";
import type { CsvRow } from "./aggregatorHelpers";

/**
 * Build a synthetic accountSolarGeneration row. The aggregator
 * reads `GATS Gen ID`, `Last Meter Read (kWh)`, `Last Meter Read
 * Date`, `Month of Generation` — those are the fields we exercise.
 */
function makeRow(
  trackingSystemRefId: string,
  meterReadKwh: number | null,
  date: string | null,
  monthOfGeneration: string | null = null
): CsvRow {
  const row: Record<string, string | undefined> = {
    "GATS Gen ID": trackingSystemRefId,
  };
  if (meterReadKwh !== null) {
    row["Last Meter Read (kWh)"] = String(meterReadKwh);
  }
  if (date !== null) {
    row["Last Meter Read Date"] = date;
  }
  if (monthOfGeneration !== null) {
    row["Month of Generation"] = monthOfGeneration;
  }
  return row as unknown as CsvRow;
}

function chunked<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function mapsEqual(
  a: Map<string, { valueWh: number; date: Date | null; source: string }>,
  b: Map<string, { valueWh: number; date: Date | null; source: string }>
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, va] of a) {
    const vb = b.get(k);
    if (!vb) return false;
    if (va.valueWh !== vb.valueWh) return false;
    if (va.source !== vb.source) return false;
    const aTime = va.date?.getTime() ?? null;
    const bTime = vb.date?.getTime() ?? null;
    if (aTime !== bTime) return false;
  }
  return true;
}

describe("applyAccountSolarGenerationPageToBaselineMap (streaming parity)", () => {
  it("produces the same Map as the bulk builder when called once with all rows", () => {
    const rows = [
      makeRow("TR-1", 1000, "2025-01-15"),
      makeRow("TR-2", 2000, "2025-03-01"),
      makeRow("TR-1", 1500, "2025-06-10"), // newer; should win
    ];
    const bulk = buildGenerationBaselineByTrackingId([], rows);
    const streamed = new Map();
    applyAccountSolarGenerationPageToBaselineMap(streamed, rows);
    expect(mapsEqual(bulk, streamed)).toBe(true);
    expect(streamed.size).toBe(2);
    expect(streamed.get("TR-1")?.valueWh).toBe(1500 * 1000); // kWh → Wh
  });

  it("produces the same Map when chunked into pages of 1, 2, 3, … rows", () => {
    const rows = [
      makeRow("TR-1", 1000, "2025-01-15"),
      makeRow("TR-2", 2500, "2025-02-20"),
      makeRow("TR-1", 1500, "2025-06-10"),
      makeRow("TR-3", 800, "2025-04-01"),
      makeRow("TR-1", 1200, "2025-04-15"), // older than 06-10; should NOT win
      makeRow("TR-2", 3000, "2025-08-01"), // newer; should win
      makeRow("TR-4", 100, null),
      makeRow("TR-5", 200, null, "2025-05-01"),
    ];
    const bulk = buildGenerationBaselineByTrackingId([], rows);
    for (const pageSize of [1, 2, 3, 4, 7, 100]) {
      const streamed = new Map();
      for (const page of chunked(rows, pageSize)) {
        applyAccountSolarGenerationPageToBaselineMap(streamed, page);
      }
      expect(
        mapsEqual(bulk, streamed),
        `pageSize=${pageSize} mismatch`
      ).toBe(true);
    }
  });

  it("preserves the Generation-Entry-wins tiebreaker when account-solar-gen rows are streamed in", () => {
    // Pre-populate the map with a Generation Entry baseline at the
    // same date — the account-solar-gen tiebreaker should leave
    // it intact (Generation Entry rank > Account Solar Generation).
    // Headers: `Unit ID` for trackingSystemRefId, `Last Meter Read
    // (kWh)` from `GENERATION_BASELINE_VALUE_HEADERS`,
    // `Last Meter Read Date` from `GENERATION_BASELINE_DATE_HEADERS`.
    const generationEntryRows: CsvRow[] = [
      {
        "Unit ID": "TR-X",
        "Last Meter Read (kWh)": "5000",
        "Last Meter Read Date": "2025-04-30",
      } as unknown as CsvRow,
    ];
    const accountSolarRows = [
      makeRow("TR-X", 5000, "2025-04-30"), // 5000 kWh = 5_000_000 Wh, same date
    ];
    const bulk = buildGenerationBaselineByTrackingId(
      generationEntryRows,
      accountSolarRows
    );
    const streamed = buildGenerationBaselineByTrackingId(
      generationEntryRows,
      []
    );
    applyAccountSolarGenerationPageToBaselineMap(streamed, accountSolarRows);
    expect(mapsEqual(bulk, streamed)).toBe(true);
    // Both should resolve to "Generation Entry" since GE rank > ASG rank
    // when dates are equal.
    expect(streamed.get("TR-X")?.source).toBe("Generation Entry");
  });

  it("skips rows with missing GATS Gen ID, missing meter read value", () => {
    const rows = [
      makeRow("", 1000, "2025-01-15") as CsvRow, // missing tracking id
      makeRow("TR-1", null, "2025-02-01"), // missing meter read
      makeRow("TR-2", 999, "2025-03-15"), // valid
    ];
    const streamed = new Map();
    applyAccountSolarGenerationPageToBaselineMap(streamed, rows);
    expect(streamed.size).toBe(1);
    expect(streamed.get("TR-2")?.valueWh).toBe(999_000);
  });

  it("returns an empty map for an empty page", () => {
    const streamed = new Map();
    applyAccountSolarGenerationPageToBaselineMap(streamed, []);
    expect(streamed.size).toBe(0);
  });
});
