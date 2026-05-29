import { describe, expect, it } from "vitest";
import { makeFoundationSystem } from "./aggregatorTestFixtures";
import {
  buildChangeOwnership,
  CHANGE_OWNERSHIP_RUNNER_VERSION,
  extractSnapshotSystemsForChangeOwnership,
  foundationChangeOwnershipOverlay,
  shouldCacheChangeOwnershipResult,
  type SnapshotSystemForChangeOwnership,
} from "./buildChangeOwnershipAggregates";

type CsvRow = Record<string, string | undefined>;

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    system_id: "SYS-1",
    PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-1",
    tracking_system_ref_id: "",
    Project_Name: "Project 1",
    system_name: "",
    Part_2_App_Verification_Date: "2025-03-15",
    ...overrides,
  };
}

function system(
  overrides: Partial<SnapshotSystemForChangeOwnership> = {}
): SnapshotSystemForChangeOwnership {
  return {
    key: "sys-1",
    systemId: "SYS-1",
    stateApplicationRefId: "APP-1",
    trackingSystemRefId: "NON-1",
    systemName: "Project 1",
    installedKwAc: 12,
    isReporting: true,
    isTransferred: false,
    isTerminated: false,
    contractType: "Standard",
    contractedDate: new Date("2024-01-01"),
    zillowStatus: null,
    zillowSoldDate: null,
    latestReportingDate: new Date("2026-04-01"),
    hasChangedOwnership: false,
    changeOwnershipStatus: null,
    totalContractAmount: 100_000,
    contractedValue: null,
    ...overrides,
  };
}

describe("buildChangeOwnership", () => {
  it("returns empty aggregate for empty input", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [],
      systems: [],
    });
    expect(out.rows).toEqual([]);
    expect(out.summary.total).toBe(0);
    expect(out.cooNotTransferredNotReportingCurrentCount).toBe(0);
    expect(out.ownershipStackedChartRows).toHaveLength(2);
    expect(out.ownershipStackedChartRows[0]!.label).toBe("Reporting");
    expect(out.ownershipStackedChartRows[1]!.label).toBe("Not Reporting");
  });

  it("excludes systems whose hasChangedOwnership is false", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [abpRow()],
      systems: [system({ hasChangedOwnership: false })],
    });
    expect(out.rows).toEqual([]);
  });

  it("includes a Change of Ownership - Not Transferred and Reporting row", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [abpRow()],
      systems: [
        system({
          hasChangedOwnership: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
          isReporting: true,
        }),
      ],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.changeOwnershipStatus).toBe(
      "Change of Ownership - Not Transferred and Reporting"
    );
    expect(out.rows[0]!.key).toBe("coo:system:SYS-1");
    expect(out.summary.total).toBe(1);
    expect(out.summary.reporting).toBe(1);
    expect(out.summary.contractedValueTotal).toBe(100_000);
    expect(out.cooNotTransferredNotReportingCurrentCount).toBe(0);
  });

  it("rolls up ALL-terminated matches as Terminated regardless of any nonTerminated branches", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [abpRow()],
      systems: [
        system({
          isTerminated: true,
          isReporting: true,
          hasChangedOwnership: true,
          changeOwnershipStatus: "Terminated and Reporting",
        }),
      ],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]!.changeOwnershipStatus).toBe("Terminated");
    expect(out.rows[0]!.isTerminated).toBe(true);
    // Stacked chart: terminated systems are excluded from buckets.
    expect(out.ownershipStackedChartRows[0]!.notTransferred).toBe(0);
    expect(out.ownershipStackedChartRows[0]!.transferred).toBe(0);
    expect(out.ownershipStackedChartRows[0]!.changeOwnership).toBe(0);
  });

  it("counts COO Not Transferred and Not Reporting current count", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "Project A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "Project B",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          hasChangedOwnership: true,
          isReporting: false,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Not Reporting",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          hasChangedOwnership: true,
          isReporting: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
        }),
      ],
    });
    expect(out.cooNotTransferredNotReportingCurrentCount).toBe(1);
    expect(out.summary.total).toBe(2);
    expect(out.summary.reporting).toBe(1);
  });

  it("sorts rows by systemName ascending case-insensitive", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-Z",
          system_id: "SYS-Z",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-Z",
          Project_Name: "zebra solar",
        }),
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "Apple Solar",
        }),
      ],
      systems: [
        system({
          key: "sys-z",
          systemId: "SYS-Z",
          stateApplicationRefId: "APP-Z",
          trackingSystemRefId: "NON-Z",
          systemName: "zebra solar",
          hasChangedOwnership: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
        }),
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Apple Solar",
          hasChangedOwnership: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
        }),
      ],
    });
    expect(out.rows.map((r) => r.systemName)).toEqual([
      "Apple Solar",
      "zebra solar",
    ]);
  });

  it("populates ownershipStackedChartRows with non-terminated matched systems", () => {
    // 1 system: Reporting + ChangeOwnership-Not-Transferred → reporting.changeOwnership=1
    // 1 system: NotReporting + Transferred → notReporting.transferred=1
    // 1 system: unmatched → notReporting.notTransferred=1
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-1",
          system_id: "SYS-1",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-1",
          Project_Name: "P1",
        }),
        abpRow({
          Application_ID: "APP-2",
          system_id: "SYS-2",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-2",
          Project_Name: "P2",
        }),
        abpRow({
          Application_ID: "APP-3",
          system_id: "SYS-3",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-3",
          Project_Name: "P3",
        }),
      ],
      systems: [
        system({
          key: "sys-1",
          systemId: "SYS-1",
          stateApplicationRefId: "APP-1",
          trackingSystemRefId: "NON-1",
          systemName: "P1",
          isReporting: true,
          isTransferred: false,
          isTerminated: false,
          hasChangedOwnership: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
        }),
        system({
          key: "sys-2",
          systemId: "SYS-2",
          stateApplicationRefId: "APP-2",
          trackingSystemRefId: "NON-2",
          systemName: "P2",
          isReporting: false,
          isTransferred: true,
          isTerminated: false,
        }),
        // No system for APP-3 → unmatched
      ],
    });
    expect(out.ownershipStackedChartRows[0]!.changeOwnership).toBe(1);
    expect(out.ownershipStackedChartRows[1]!.transferred).toBe(1);
    expect(out.ownershipStackedChartRows[1]!.notTransferred).toBe(1);
  });

  it("dedupes part-2 rows by dedupeKey", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({ Application_ID: "APP-1" }),
        // Same portalSystemId → same dedupeKey
        abpRow({ Application_ID: "APP-1-DUP" }),
      ],
      systems: [
        system({
          hasChangedOwnership: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
        }),
      ],
    });
    expect(out.rows).toHaveLength(1);
    expect(out.summary.total).toBe(1);
  });

  it("contracted value sums use totalContractAmount with contractedValue fallback", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "B",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "A",
          totalContractAmount: 100_000,
          contractedValue: null,
          hasChangedOwnership: true,
          isReporting: true,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Reporting",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "B",
          totalContractAmount: null,
          contractedValue: 50_000,
          hasChangedOwnership: true,
          isReporting: false,
          changeOwnershipStatus:
            "Change of Ownership - Not Transferred and Not Reporting",
        }),
      ],
    });
    expect(out.summary.contractedValueTotal).toBe(150_000);
    expect(out.summary.contractedValueReporting).toBe(100_000);
    expect(out.summary.contractedValueNotReporting).toBe(50_000);
  });

  it("computes per-status counts ordered by CHANGE_OWNERSHIP_ORDER", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "B",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "A",
          hasChangedOwnership: true,
          isTransferred: true,
          isReporting: true,
          changeOwnershipStatus: "Transferred and Reporting",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "B",
          hasChangedOwnership: true,
          isTerminated: true,
          isReporting: false,
          changeOwnershipStatus: "Terminated and Not Reporting",
        }),
      ],
    });
    const statuses = out.summary.counts.map((c) => c.status);
    expect(statuses).toEqual([
      "Transferred and Reporting",
      "Transferred and Not Reporting",
      "Terminated",
      "Change of Ownership - Not Transferred and Reporting",
      "Change of Ownership - Not Transferred and Not Reporting",
    ]);
    expect(out.summary.counts[0]!.count).toBe(1);
    // "Terminated" matches any rows whose status starts with "Terminated"
    expect(out.summary.counts[2]!.count).toBe(1);
  });

  // PR B3a (reviewer #1): positive assertion that summary.standingCounts
  // is populated alongside the legacy counts. Same 2-system fixture
  // shape, with explicit contractTypes that resolve through shared
  // deriveStanding.
  //  - "IL ABP - Transferred" + reporting → "Active — Good Standing (Assigned)" → tier Active
  //  - "IL ABP - Terminated" → "Closed — RECs Repaid (Good Standing)" → tier Closed
  it("emits standingCounts rolled up by tier + per-Standing drill-in", () => {
    const out = buildChangeOwnership({
      part2VerifiedAbpRows: [
        abpRow({
          Application_ID: "APP-A",
          system_id: "SYS-A",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-A",
          Project_Name: "A",
        }),
        abpRow({
          Application_ID: "APP-B",
          system_id: "SYS-B",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-B",
          Project_Name: "B",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "A",
          contractType: "IL ABP - Transferred",
          hasChangedOwnership: true,
          isTransferred: true,
          isReporting: true,
          changeOwnershipStatus: "Transferred and Reporting",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "B",
          contractType: "IL ABP - Terminated",
          hasChangedOwnership: true,
          isTerminated: true,
          isReporting: false,
          changeOwnershipStatus: "Terminated and Not Reporting",
        }),
      ],
    });
    // Per-row standing.
    const rowsByName = new Map(out.rows.map((row) => [row.systemName, row]));
    expect(rowsByName.get("A")?.standing).toBe(
      "Active — Good Standing (Assigned)",
    );
    expect(rowsByName.get("B")?.standing).toBe(
      "Closed — RECs Repaid (Good Standing)",
    );
    // Tier totals: 1 Active + 0 At Risk + 1 Closed + 0 Unknown = 2.
    expect(out.summary.standingCounts.tierTotals).toEqual({
      Active: 1,
      "At Risk": 0,
      Closed: 1,
      Unknown: 0,
    });
    // 9 perStanding entries always present, in canonical order.
    expect(out.summary.standingCounts.perStanding).toHaveLength(9);
    const drillIn = new Map(
      out.summary.standingCounts.perStanding.map((c) => [c.standing, c]),
    );
    expect(drillIn.get("Active — Good Standing (Assigned)")?.count).toBe(1);
    expect(drillIn.get("Active — Good Standing (Assigned)")?.percent).toBe(50);
    expect(
      drillIn.get("Closed — RECs Repaid (Good Standing)")?.count,
    ).toBe(1);
    // Invariant: sum of perStanding counts === total.
    const perStandingSum = out.summary.standingCounts.perStanding.reduce(
      (sum, c) => sum + c.count,
      0,
    );
    expect(perStandingSum).toBe(out.summary.total);
  });
});

describe("extractSnapshotSystemsForChangeOwnership", () => {
  it("skips entries without a key", () => {
    const out = extractSnapshotSystemsForChangeOwnership([
      null,
      { key: "" },
      { key: "sys-1", systemName: "Solar A" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("sys-1");
  });

  it("falls back to safe defaults", () => {
    const [extracted] = extractSnapshotSystemsForChangeOwnership([
      { key: "sys-1" },
    ]);
    expect(extracted!.installedKwAc).toBeNull();
    expect(extracted!.hasChangedOwnership).toBe(false);
    expect(extracted!.changeOwnershipStatus).toBeNull();
    // B3-cleanup: `ownershipStatus` retired from the snapshot subset.
  });

  it("validates changeOwnershipStatus to the enumerated literals", () => {
    const [valid] = extractSnapshotSystemsForChangeOwnership([
      { key: "sys-1", changeOwnershipStatus: "Transferred and Reporting" },
    ]);
    expect(valid!.changeOwnershipStatus).toBe("Transferred and Reporting");

    const [invalid] = extractSnapshotSystemsForChangeOwnership([
      { key: "sys-2", changeOwnershipStatus: "Not a real status" },
    ]);
    expect(invalid!.changeOwnershipStatus).toBeNull();
  });
});

// ============================================================================
// Phase 3.1 — foundationChangeOwnershipOverlay
// ============================================================================

describe("foundationChangeOwnershipOverlay", () => {
  it("active → hasChangedOwnership=false, changeOwnershipStatus=null", () => {
    const out = foundationChangeOwnershipOverlay(
      makeFoundationSystem({ ownershipStatus: "active", isReporting: true })
    );
    expect(out).toEqual({
      hasChangedOwnership: false,
      changeOwnershipStatus: null,
    });
  });

  it("null lifecycle → hasChangedOwnership=false (defensive)", () => {
    const out = foundationChangeOwnershipOverlay(
      makeFoundationSystem({ ownershipStatus: null })
    );
    expect(out.hasChangedOwnership).toBe(false);
    expect(out.changeOwnershipStatus).toBeNull();
  });

  it("terminated + reporting → 'Terminated and Reporting'", () => {
    const out = foundationChangeOwnershipOverlay(
      makeFoundationSystem({
        ownershipStatus: "terminated",
        isTerminated: true,
        isReporting: true,
      })
    );
    expect(out.hasChangedOwnership).toBe(true);
    expect(out.changeOwnershipStatus).toBe("Terminated and Reporting");
  });

  it("transferred + not reporting → 'Transferred and Not Reporting'", () => {
    const out = foundationChangeOwnershipOverlay(
      makeFoundationSystem({
        ownershipStatus: "transferred",
        isReporting: false,
      })
    );
    expect(out.hasChangedOwnership).toBe(true);
    expect(out.changeOwnershipStatus).toBe("Transferred and Not Reporting");
  });

  it("change-of-ownership + reporting → 'Change of Ownership - Not Transferred and Reporting'", () => {
    const out = foundationChangeOwnershipOverlay(
      makeFoundationSystem({
        ownershipStatus: "change-of-ownership",
        isReporting: true,
      })
    );
    expect(out.hasChangedOwnership).toBe(true);
    expect(out.changeOwnershipStatus).toBe(
      "Change of Ownership - Not Transferred and Reporting"
    );
  });

  it("change-of-ownership + not reporting → '...and Not Reporting' suffix", () => {
    const out = foundationChangeOwnershipOverlay(
      makeFoundationSystem({
        ownershipStatus: "change-of-ownership",
        isReporting: false,
      })
    );
    expect(out.changeOwnershipStatus).toBe(
      "Change of Ownership - Not Transferred and Not Reporting"
    );
  });
});

/**
 * 2026-05-13 — predicate that decides whether a freshly-computed
 * change-ownership result should be persisted to the
 * `solarRecComputedArtifacts` cache. Same heuristic as the sibling
 * builders. For change-ownership the "schedule rows total" analog
 * is `abpReportRows.length`; `snapshot.systems.length` plays the
 * eligibility-diagnostic role.
 */
describe("shouldCacheChangeOwnershipResult", () => {
  it("caches genuinely-empty results when abpReport input was empty", () => {
    expect(
      shouldCacheChangeOwnershipResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(true);
  });

  it("REFUSES to cache when abpReport rows exist but snapshot returned 0 systems", () => {
    // The poison vector: snapshot degraded under heap pressure →
    // 0 systems → no change-ownership rows emitted despite a
    // 28k-row abpReport. Pre-fix this would have cached `rows: []`
    // and broken the ChangeOwnership tab + the Overview stacked
    // chart until the next batch upload.
    expect(
      shouldCacheChangeOwnershipResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 28_000,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(false);
  });

  it("REFUSES to cache 0-row results when inputs were populated (the bug-fix case)", () => {
    expect(
      shouldCacheChangeOwnershipResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 28_000,
        eligibleTrackingIdCount: 4_500,
      })
    ).toBe(false);
  });

  it("caches non-empty results regardless of input shape", () => {
    expect(
      shouldCacheChangeOwnershipResult({
        rowsEmitted: 1_200,
        scheduleRowsTotal: 28_000,
        eligibleTrackingIdCount: 4_500,
      })
    ).toBe(true);
  });
});

describe("change-ownership runner version", () => {
  it("carries a runner version bundled into the cache hash", () => {
    // 2026-05-13 (@2): bumped after adding `shouldCache:` gate
    // (HIGH-2 follow-up). Invalidates @1 cache entries that may
    // have been poisoned by the pre-fix `rows: []` path.
    expect(CHANGE_OWNERSHIP_RUNNER_VERSION).toBe(
      "phase-3.1-changeownership-foundation@2"
    );
  });
});
