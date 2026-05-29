import { describe, expect, it } from "vitest";
import type { FoundationArtifactPayload } from "../../../shared/solarRecFoundation";
import {
  buildOverviewSummary,
  buildOverviewSummaryWithFoundationOverlay,
  extractSnapshotSystemsForSummary,
  OVERVIEW_SUMMARY_RUNNER_VERSION,
  shouldCacheOverviewSummaryResult,
  type SnapshotSystemForSummary,
} from "./buildOverviewSummaryAggregates";

type CsvRow = Record<string, string | undefined>;

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    system_id: "SYS-1",
    PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON100",
    tracking_system_ref_id: "",
    Project_Name: "Acme Solar",
    system_name: "",
    Part_2_App_Verification_Date: "2025-03-15",
    ...overrides,
  };
}

function system(overrides: Partial<SnapshotSystemForSummary> = {}): SnapshotSystemForSummary {
  return {
    key: "sys-1",
    systemId: "SYS-1",
    stateApplicationRefId: "APP-1",
    trackingSystemRefId: "NON100",
    systemName: "Acme Solar",
    sizeBucket: ">10 kW AC",
    isReporting: true,
    isTransferred: false,
    isTerminated: false,
    contractType: "Standard",
    contractStatusText: "Active",
    latestReportingDate: new Date("2026-04-01"),
    contractedDate: new Date("2024-01-01"),
    zillowStatus: null,
    zillowSoldDate: null,
    totalContractAmount: 100_000,
    contractedValue: null,
    deliveredValue: 25_000,
    ...overrides,
  };
}

function foundationForOverviewHeadlineCounts(): FoundationArtifactPayload {
  return {
    schemaVersion: 1,
    definitionVersion: 4,
    foundationHash: "test-hash",
    builtAt: new Date(0).toISOString(),
    reportingAnchorDateIso: "2026-04-01",
    inputVersions: {
      solarApplications: { batchId: "solar-batch", rowCount: 3 },
      abpReport: { batchId: "abp-batch", rowCount: 3 },
      generationEntry: { batchId: null, rowCount: 0 },
      accountSolarGeneration: { batchId: null, rowCount: 0 },
      annualProductionEstimates: { batchId: null, rowCount: 0 },
      contractedDate: { batchId: null, rowCount: 0 },
      convertedReads: { batchId: null, rowCount: 0 },
      deliveryScheduleBase: { batchId: null, rowCount: 0 },
      transferHistory: { batchId: null, rowCount: 0 },
      generatorDetails: { batchId: null, rowCount: 0 },
      abpCsgSystemMapping: { batchId: null, rowCount: 0 },
      abpProjectApplicationRows: { batchId: null, rowCount: 0 },
      abpPortalInvoiceMapRows: { batchId: null, rowCount: 0 },
      abpCsgPortalDatabaseRows: { batchId: null, rowCount: 0 },
      abpQuickBooksRows: { batchId: null, rowCount: 0 },
      abpUtilityInvoiceRows: { batchId: null, rowCount: 0 },
      abpIccReport2Rows: { batchId: null, rowCount: 0 },
      abpIccReport3Rows: { batchId: null, rowCount: 0 },
    },
    canonicalSystemsByCsgId: {
      "SYS-1": {
        csgId: "SYS-1",
        abpIds: ["APP-1"],
        isTerminated: false,
        isPart2Verified: true,
        isReporting: true,
        ownershipStatus: "active",
        integrityWarningCodes: [],
      },
      "SYS-2": {
        csgId: "SYS-2",
        abpIds: ["APP-2"],
        isTerminated: false,
        isPart2Verified: true,
        isReporting: false,
        ownershipStatus: "active",
        integrityWarningCodes: [],
      },
      "SYS-OUT": {
        csgId: "SYS-OUT",
        abpIds: ["APP-OUT"],
        isTerminated: false,
        isPart2Verified: false,
        isReporting: true,
        ownershipStatus: "active",
        integrityWarningCodes: [],
      },
    },
    part2EligibleCsgIds: ["SYS-1", "SYS-2"],
    reportingCsgIds: ["SYS-1", "SYS-OUT"],
    summaryCounts: {
      totalSystems: 3,
      terminated: 0,
      part2Verified: 2,
      reporting: 2,
      part2VerifiedAndReporting: 1,
    },
    integrityWarnings: [],
    populatedDatasets: ["solarApplications", "abpReport"],
  };
}

describe("buildOverviewSummary", () => {
  it("returns zero counts + empty rows for empty input", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [],
      systems: [],
    });
    expect(out.totalSystems).toBe(0);
    expect(out.reportingSystems).toBe(0);
    expect(out.reportingPercent).toBeNull();
    expect(out.ownershipRows).toEqual([]);
    expect(out.totalContractedValue).toBe(0);
  });

  it("classifies a matched-system row into Not Transferred and Reporting", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [abpRow()],
      systems: [system()],
    });
    expect(out.totalSystems).toBe(1);
    expect(out.reportingSystems).toBe(1);
    expect(out.reportingPercent).toBe(100);
    expect(out.ownershipOverview.notTransferredReporting).toBe(1);
    expect(out.ownershipOverview.reportingOwnershipTotal).toBe(1);
    expect(out.ownershipRows).toHaveLength(1);
    expect(out.ownershipRows[0]!.source).toBe("Matched System");
    // B3-cleanup: assertion on `ownershipStatus` retired; `standing`
    // is the risk-tier axis. "Standard" contractType + reporting →
    // Active — Good Standing (intact + reporting).
    expect(out.ownershipRows[0]!.standing).toBe("Active — Good Standing");
  });

  it("emits a Part II Unmatched row when no system matches", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [abpRow()],
      systems: [],
    });
    expect(out.totalSystems).toBe(1);
    expect(out.reportingSystems).toBe(0);
    expect(out.ownershipOverview.notTransferredNotReporting).toBe(1);
    expect(out.ownershipRows).toHaveLength(1);
    expect(out.ownershipRows[0]!.source).toBe("Part II Unmatched");
    expect(out.ownershipRows[0]!.systemName).toBe("Acme Solar");
  });

  it("dedupes part-2 rows via resolvePart2ProjectIdentity", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [
        abpRow({ Application_ID: "APP-1" }),
        // Same portalSystemId → same dedupe key, even with a different
        // application ID.
        abpRow({ Application_ID: "APP-1-DUP" }),
      ],
      systems: [system()],
    });
    expect(out.totalSystems).toBe(1);
    expect(out.ownershipRows).toHaveLength(1);
  });

  it("classifies Terminated overrides Transferred overrides Reporting", () => {
    // Three matched scenarios on three rows → counts each into the
    // appropriate ownership-overview bucket. Distinct
    // tracking IDs + project names so the systems don't cross-match
    // through the trackingId/name indices.
    const out = buildOverviewSummary({
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
        abpRow({
          Application_ID: "APP-C",
          system_id: "SYS-C",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-C",
          Project_Name: "Project C",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          isReporting: true,
          isTransferred: false,
          isTerminated: false,
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          isReporting: true,
          isTransferred: true,
          isTerminated: false,
        }),
        system({
          key: "sys-c",
          systemId: "SYS-C",
          stateApplicationRefId: "APP-C",
          trackingSystemRefId: "NON-C",
          systemName: "Project C",
          isReporting: false,
          isTransferred: true,
          isTerminated: true,
        }),
      ],
    });
    expect(out.ownershipOverview.notTransferredReporting).toBe(1);
    expect(out.ownershipOverview.transferredReporting).toBe(1);
    expect(out.ownershipOverview.terminatedNotReporting).toBe(1);
    expect(out.ownershipOverview.terminatedTotal).toBe(1);
    expect(out.totalSystems).toBe(3);
    expect(out.reportingSystems).toBe(2);
  });

  // PR B3a (reviewer #1): positive assertion that standingOverview is
  // populated. Exercises 3 of the 4 top tiers + drill-in counts via
  // distinct contractTypes that resolve through shared deriveStanding.
  // Intact + Reporting → "Active — Good Standing".
  // "IL ABP - Transferred" + Reporting → "Active — Good Standing (Assigned)".
  // "IL ABP - Terminated" → "Closed — RECs Repaid (Good Standing)".
  it("emits standingOverview rolled up by tier + per-Standing counts", () => {
    const out = buildOverviewSummary({
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
        abpRow({
          Application_ID: "APP-C",
          system_id: "SYS-C",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-C",
          Project_Name: "Project C",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          contractType: "Standard",
          isReporting: true,
          isTransferred: false,
          isTerminated: false,
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          contractType: "IL ABP - Transferred",
          isReporting: true,
          isTransferred: true,
          isTerminated: false,
        }),
        system({
          key: "sys-c",
          systemId: "SYS-C",
          stateApplicationRefId: "APP-C",
          trackingSystemRefId: "NON-C",
          systemName: "Project C",
          contractType: "IL ABP - Terminated",
          isReporting: false,
          isTransferred: false,
          isTerminated: true,
        }),
      ],
    });
    // Per-row standing.
    const rowsByName = new Map(
      out.ownershipRows.map((row) => [row.systemName, row]),
    );
    expect(rowsByName.get("Project A")?.standing).toBe(
      "Active — Good Standing",
    );
    expect(rowsByName.get("Project B")?.standing).toBe(
      "Active — Good Standing (Assigned)",
    );
    expect(rowsByName.get("Project C")?.standing).toBe(
      "Closed — RECs Repaid (Good Standing)",
    );
    // Tier rollups: 2 Active + 0 At Risk + 1 Closed + 0 Unknown = 3.
    expect(out.standingOverview.activeTotal).toBe(2);
    expect(out.standingOverview.atRiskTotal).toBe(0);
    expect(out.standingOverview.closedTotal).toBe(1);
    expect(out.standingOverview.unknownTotal).toBe(0);
    // Per-Standing drill-in.
    expect(
      out.standingOverview.perStanding["Active — Good Standing"],
    ).toBe(1);
    expect(
      out.standingOverview.perStanding["Active — Good Standing (Assigned)"],
    ).toBe(1);
    expect(
      out.standingOverview.perStanding[
        "Closed — RECs Repaid (Good Standing)"
      ],
    ).toBe(1);
    // Invariant: sum of all perStanding === ownershipRows.length.
    const perStandingSum = Object.values(out.standingOverview.perStanding)
      .reduce((sum, count) => sum + count, 0);
    expect(perStandingSum).toBe(out.ownershipRows.length);
  });

  it("counts size buckets from scopedPart2Systems", () => {
    const out = buildOverviewSummary({
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
        abpRow({
          Application_ID: "APP-C",
          system_id: "SYS-C",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-C",
          Project_Name: "Project C",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          sizeBucket: "<=10 kW AC",
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          sizeBucket: ">10 kW AC",
        }),
        system({
          key: "sys-c",
          systemId: "SYS-C",
          stateApplicationRefId: "APP-C",
          trackingSystemRefId: "NON-C",
          systemName: "Project C",
          sizeBucket: "Unknown",
        }),
      ],
    });
    expect(out.smallSystems).toBe(1);
    expect(out.largeSystems).toBe(1);
    expect(out.unknownSizeSystems).toBe(1);
  });

  it("sums contracted/delivered value from scoped systems with non-zero values", () => {
    const out = buildOverviewSummary({
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
        // System with all zeros — excluded from withValueData
        abpRow({
          Application_ID: "APP-Z",
          system_id: "SYS-Z",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-Z",
          Project_Name: "Project Z",
        }),
      ],
      systems: [
        system({
          key: "sys-a",
          systemId: "SYS-A",
          stateApplicationRefId: "APP-A",
          trackingSystemRefId: "NON-A",
          systemName: "Project A",
          totalContractAmount: 100_000,
          deliveredValue: 30_000,
          isReporting: true,
        }),
        system({
          key: "sys-b",
          systemId: "SYS-B",
          stateApplicationRefId: "APP-B",
          trackingSystemRefId: "NON-B",
          systemName: "Project B",
          totalContractAmount: 50_000,
          deliveredValue: 0,
          isReporting: false,
        }),
        system({
          key: "sys-z",
          systemId: "SYS-Z",
          stateApplicationRefId: "APP-Z",
          trackingSystemRefId: "NON-Z",
          systemName: "Project Z",
          totalContractAmount: 0,
          contractedValue: 0,
          deliveredValue: 0,
        }),
      ],
    });
    expect(out.withValueDataCount).toBe(2);
    expect(out.totalContractedValue).toBe(150_000);
    expect(out.totalDeliveredValue).toBe(30_000);
    expect(out.totalGap).toBe(120_000);
    expect(out.contractedValueReporting).toBe(100_000);
    expect(out.contractedValueNotReporting).toBe(50_000);
  });

  it("falls back to contractedValue when totalContractAmount is null", () => {
    const out = buildOverviewSummary({
      part2VerifiedAbpRows: [abpRow()],
      systems: [
        system({
          totalContractAmount: null,
          contractedValue: 75_000,
          deliveredValue: 0,
          isReporting: true,
        }),
      ],
    });
    expect(out.totalContractedValue).toBe(75_000);
  });

  it("uses foundation Part-II CSG counts for headline totals after overlay", () => {
    const out = buildOverviewSummaryWithFoundationOverlay(
      foundationForOverviewHeadlineCounts(),
      [
        system({
          key: "sys-1",
          systemId: "SYS-1",
          stateApplicationRefId: "APP-1",
          trackingSystemRefId: "NON-1",
          systemName: "Project 1",
        }),
        system({
          key: "sys-2",
          systemId: "SYS-2",
          stateApplicationRefId: "APP-2",
          trackingSystemRefId: "NON-2",
          systemName: "Project 2",
          isReporting: true,
        }),
        system({
          key: "sys-out",
          systemId: "SYS-OUT",
          stateApplicationRefId: "APP-OUT",
          trackingSystemRefId: "NON-OUT",
          systemName: "Outside Part II",
          isReporting: true,
        }),
      ],
      [
        abpRow({
          Application_ID: "APP-1",
          system_id: "SYS-1",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-1",
          Project_Name: "Project 1",
        }),
        abpRow({
          Application_ID: "APP-2",
          system_id: "SYS-2",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-2",
          Project_Name: "Project 2",
        }),
        abpRow({
          Application_ID: "APP-X",
          system_id: "SYS-X",
          PJM_GATS_or_MRETS_Unit_ID_Part_2: "NON-X",
          Project_Name: "Unmatched Part II row",
        }),
      ]
    );

    expect(out.ownershipRows).toHaveLength(3);
    expect(out.totalSystems).toBe(2);
    expect(out.reportingSystems).toBe(1);
    expect(out.reportingPercent).toBe(50);
  });
});

describe("extractSnapshotSystemsForSummary", () => {
  it("skips entries that are not objects or lack a key", () => {
    const out = extractSnapshotSystemsForSummary([
      null,
      undefined,
      "string-not-allowed",
      { key: "" }, // empty key fails the guard
      {
        key: "sys-1",
        systemId: "SYS-1",
        systemName: "Solar A",
        sizeBucket: "<=10 kW AC",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe("sys-1");
    expect(out[0]!.sizeBucket).toBe("<=10 kW AC");
  });

  it("falls back to safe defaults for missing/wrong-typed fields", () => {
    const [extracted] = extractSnapshotSystemsForSummary([
      { key: "sys-1" },
    ]);
    expect(extracted!.systemId).toBeNull();
    expect(extracted!.sizeBucket).toBe("Unknown");
    // B3-cleanup: `ownershipStatus` retired from the snapshot
    // subset; nothing to assert here.
    expect(extracted!.isReporting).toBe(false);
    expect(extracted!.totalContractAmount).toBeNull();
    expect(extracted!.latestReportingDate).toBeNull();
  });

  it("parses ISO date strings into Date objects", () => {
    const [extracted] = extractSnapshotSystemsForSummary([
      {
        key: "sys-1",
        latestReportingDate: "2026-04-15T00:00:00.000Z",
        contractedDate: "2024-06-01T00:00:00.000Z",
      },
    ]);
    expect(extracted!.latestReportingDate).toBeInstanceOf(Date);
    expect(extracted!.contractedDate?.getUTCFullYear()).toBe(2024);
  });
});

/**
 * 2026-05-13 — predicate that decides whether a freshly-computed
 * overview-summary result should be persisted to the
 * `solarRecComputedArtifacts` cache. Same heuristic as the sibling
 * builders. For overview the "schedule rows total" analog is
 * `abpReportRows.length` (the primary iterable input);
 * `snapshot.systems.length` plays the eligibility-diagnostic role.
 */
describe("shouldCacheOverviewSummaryResult", () => {
  it("caches genuinely-empty results when abpReport input was empty", () => {
    expect(
      shouldCacheOverviewSummaryResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 0,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(true);
  });

  it("REFUSES to cache when abpReport rows exist but snapshot returned 0 systems", () => {
    // The poison vector: snapshot degraded under heap pressure →
    // 0 systems → no ownership rows emitted despite a 28k-row
    // abpReport. Pre-fix this would have cached `ownershipRows: []`
    // and broken the Overview tab until the next batch upload.
    expect(
      shouldCacheOverviewSummaryResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 28_000,
        eligibleTrackingIdCount: 0,
      })
    ).toBe(false);
  });

  it("REFUSES to cache 0-row results when inputs were populated (the bug-fix case)", () => {
    expect(
      shouldCacheOverviewSummaryResult({
        rowsEmitted: 0,
        scheduleRowsTotal: 28_000,
        eligibleTrackingIdCount: 4_500,
      })
    ).toBe(false);
  });

  it("caches non-empty results regardless of input shape", () => {
    expect(
      shouldCacheOverviewSummaryResult({
        rowsEmitted: 4_500,
        scheduleRowsTotal: 28_000,
        eligibleTrackingIdCount: 4_500,
      })
    ).toBe(true);
  });
});

describe("overview-summary runner version", () => {
  it("carries a runner version bundled into the cache hash", () => {
    // 2026-05-13 (@3): bumped after adding `shouldCache:` gate
    // (HIGH-2 follow-up). Invalidates @2 cache entries that may
    // have been poisoned by the pre-fix `ownershipRows: []` path.
    expect(OVERVIEW_SUMMARY_RUNNER_VERSION).toBe(
      "phase-3.1-overview-foundation@3"
    );
  });
});
