import { describe, expect, it } from "vitest";
import {
  buildPerformanceSourceRows,
  shouldCachePerformanceSourceRowsResult,
} from "./buildPerformanceSourceRows";
import { buildTransferDeliveryLookupFixture as lookupFor } from "./aggregatorTestFixtures";
import type { SnapshotSystem } from "./aggregatorHelpers";

// Server-side fixtures for the `performanceSourceRows` aggregator.
// The function runs over already-derived inputs (eligibility set +
// systems map + transfer-delivery lookup); these tests exercise the
// row-build + transfer-history overlay + first-transfer-year scan.
// The cached entrypoint `getOrBuildPerformanceSourceRows` is
// integration-tested in the smoke-verification phase of the PR;
// these tests cover the pure logic.

type CsvRow = Record<string, string | undefined>;

function scheduleRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    tracking_system_ref_id: "NON100",
    utility_contract_number: "493",
    system_name: "Smith Solar Farm",
    batch_id: "BATCH-1",
    year1_quantity_required: "100",
    year1_quantity_delivered: "0",
    year1_start_date: "2024-06-01",
    year1_end_date: "2025-05-31",
    ...overrides,
  };
}

function snapshotSystem(
  overrides: Partial<SnapshotSystem> = {}
): SnapshotSystem {
  return {
    systemId: "SYS-1",
    stateApplicationRefId: null,
    trackingSystemRefId: "NON100",
    systemName: "NON100 Snapshot Name",
    recPrice: 50,
    isReporting: true,
    ...overrides,
  };
}

describe("buildPerformanceSourceRows", () => {
  it("emits one row per eligible Schedule B row with transfer-history-derived delivered values", () => {
    const sys = snapshotSystem({ trackingSystemRefId: "NON100" });
    const rows = buildPerformanceSourceRows({
      scheduleRows: [scheduleRow()],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map([["NON100", sys]]),
      // Server lookup keys are lowercased (see
      // buildTransferDeliveryLookup.ts:242); the aggregator looks up
      // via `.toLowerCase()` to match.
      transferDeliveryLookup: lookupFor({ non100: { "2024": 35 } }),
    });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.trackingSystemRefId).toBe("NON100");
    expect(r.contractId).toBe("493");
    expect(r.systemId).toBe("SYS-1");
    expect(r.recPrice).toBe(50);
    expect(r.firstTransferEnergyYear).toBe(2024);
    expect(r.years).toHaveLength(1);
    expect(r.years[0].required).toBe(100);
    // delivered comes from the transfer lookup (2024→35), NOT from
    // year1_quantity_delivered=0 in the schedule row.
    expect(r.years[0].delivered).toBe(35);
  });

  it("prefers row.system_name over snapshot.systemName over trackingId", () => {
    const sys = snapshotSystem({
      trackingSystemRefId: "NON100",
      systemName: "Snapshot Name",
    });
    const sysNoName = snapshotSystem({
      trackingSystemRefId: "NON101",
      systemName: "",
    });
    const rows = buildPerformanceSourceRows({
      scheduleRows: [
        scheduleRow({
          tracking_system_ref_id: "NON100",
          system_name: "Row Name",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON101",
          system_name: "",
          utility_contract_number: "494",
        }),
        scheduleRow({
          tracking_system_ref_id: "NON102",
          system_name: "",
          utility_contract_number: "495",
        }),
      ],
      eligibleTrackingIds: new Set(["NON100", "NON101", "NON102"]),
      systemsByTrackingId: new Map([
        ["NON100", sys],
        ["NON101", sysNoName],
        // NON102: not in the systems map at all.
      ]),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].systemName).toBe("Row Name");
    expect(rows[1].systemName).toBe("NON101");
    expect(rows[2].systemName).toBe("NON102");
  });

  it("filters out tracking IDs not in the eligibility set", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "NON100" }),
        scheduleRow({ tracking_system_ref_id: "NON999" }),
      ],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].trackingSystemRefId).toBe("NON100");
  });

  it("skips rows with no parseable Schedule years", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [
        scheduleRow({
          year1_quantity_required: "",
          year1_quantity_delivered: "",
          year1_start_date: "",
          year1_end_date: "",
        }),
      ],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toEqual([]);
  });

  it("falls back to 'Unassigned' when contract id is missing", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [scheduleRow({ utility_contract_number: "" })],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].contractId).toBe("Unassigned");
  });

  it("treats missing transfer entries as 0 delivered", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [scheduleRow()],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor(), // no entry for NON100
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].years[0].delivered).toBe(0);
    expect(rows[0].firstTransferEnergyYear).toBeNull();
  });

  it("derives firstTransferEnergyYear from the earliest positive transfer", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [scheduleRow()],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor({
        non100: {
          // 2022 has 0 (zero transfers don't count); 2023 is the
          // earliest positive year.
          "2022": 0,
          "2023": 12,
          "2024": 35,
          "2025": 88,
        },
      }),
    });
    expect(rows[0].firstTransferEnergyYear).toBe(2023);
  });

  it("uses the rowIndex (NOT post-filter index) in the row key for stable React reconciliation", () => {
    // Build a 3-row schedule where the middle row is filtered out by
    // eligibility — the surviving rows' keys should reflect their
    // ORIGINAL positions (0 and 2), so that re-renders with a slight
    // change to the middle row don't reshuffle the visible keys.
    const rows = buildPerformanceSourceRows({
      scheduleRows: [
        scheduleRow({ tracking_system_ref_id: "A" }),
        scheduleRow({ tracking_system_ref_id: "B" }),
        scheduleRow({ tracking_system_ref_id: "C" }),
      ],
      eligibleTrackingIds: new Set(["A", "C"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows.map((r) => r.key)).toEqual(["A-0", "C-2"]);
  });

  it("falls back to state_certification_number when batch_id is missing", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [
        scheduleRow({
          batch_id: "",
          state_certification_number: "STATE-CERT-42",
        }),
      ],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor(),
    });
    expect(rows[0].batchId).toBe("STATE-CERT-42");
  });

  it("zeros delivered for years with no parseable startDate", () => {
    const rows = buildPerformanceSourceRows({
      scheduleRows: [
        scheduleRow({
          year1_start_date: "garbage",
          // year2 is fully populated
          year2_quantity_required: "50",
          year2_quantity_delivered: "0",
          year2_start_date: "2025-06-01",
          year2_end_date: "2026-05-31",
        }),
      ],
      eligibleTrackingIds: new Set(["NON100"]),
      systemsByTrackingId: new Map(),
      transferDeliveryLookup: lookupFor({
        non100: { "2024": 999, "2025": 50 },
      }),
    });
    expect(rows[0].years).toHaveLength(2);
    // `buildScheduleYearEntries` sorts by startDate, with no-startDate
    // entries pushed to the end. So:
    //   years[0] = year2 (startDate 2025-06-01) — matches 2025=50
    //   years[1] = year1 (no startDate)         — falls to delivered=0
    expect(rows[0].years[0].yearIndex).toBe(2);
    expect(rows[0].years[0].delivered).toBe(50);
    expect(rows[0].years[1].yearIndex).toBe(1);
    expect(rows[0].years[1].delivered).toBe(0);
  });
});

/**
 * 2026-05-11 — predicate that decides whether a freshly-computed
 * result should be persisted to the `solarRecComputedArtifacts`
 * cache. Used by `getOrBuildPerformanceSourceRows` via
 * `withArtifactCache.shouldCache`. The key behaviour: a 0-row result
 * with non-empty inputs is "suspicious" and must NOT be cached;
 * otherwise we'd serve the empty forever until the next input-batch
 * change.
 */
describe("shouldCachePerformanceSourceRowsResult", () => {
  it("caches genuinely-empty results when the schedule input was empty", () => {
    expect(
      shouldCachePerformanceSourceRowsResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(true);
  });

  it("REFUSES to cache when schedule rows exist but eligibility is empty (2026-05-12 tighter)", () => {
    // The prior predicate cached this case as "genuine empty
    // because no eligible IDs". Prod 2026-05-13 showed exactly
    // this shape poisoned the cache: deliveryScheduleBase had
    // 24k rows + abpReport had 28k rows, but a transient
    // recompute produced `eligibleTrackingIdCount=0` (snapshot
    // degraded mid-build, or a join missed under heap pressure),
    // the predicate let the empty array cache, and every
    // subsequent call served the poisoned empty payload forever.
    // New behaviour: any 0-row result with non-empty schedule
    // input is refused — let the next call retry and surface
    // fresh diagnostics.
    expect(
      shouldCachePerformanceSourceRowsResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 1000,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(false);
  });

  it("REFUSES to cache 0-row results when inputs were populated (the bug-fix case)", () => {
    // Pre-fix this case poisoned the cache: the recompute hit mid-
    // flight heap pressure (or some other transient), produced an
    // empty array, withArtifactCache wrote it, and every subsequent
    // request served `[]` forever (until the next batch upload bumped
    // the input hash). Now the predicate returns false → cache write
    // is skipped → next request retries the recompute.
    expect(
      shouldCachePerformanceSourceRowsResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 22_000,
      })
    ).toBe(false);
  });

  it("caches non-empty results regardless of input shape", () => {
    expect(
      shouldCachePerformanceSourceRowsResult({
        rowsEmitted: 1,
        scheduleRowsTotal: 1,
        eligibleTrackingIdCount: 1,
      })
    ).toBe(true);
    expect(
      shouldCachePerformanceSourceRowsResult({
        rowsEmitted: 50_000,
        scheduleRowsTotal: 24_000,
        eligibleTrackingIdCount: 22_000,
      })
    ).toBe(true);
  });

  it("caches the all-empty case (scheduleRowsTotal === 0 — truly nothing to aggregate)", () => {
    // The ONLY "cache the empty result" path post-tighten: no
    // schedule rows at all → empty output is structurally
    // guaranteed regardless of eligibility shape. Pinning the
    // sole acceptable cache-empty branch.
    expect(
      shouldCachePerformanceSourceRowsResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 42_000,
      })
    ).toBe(true);
  });
});
