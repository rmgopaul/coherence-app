import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FoundationArtifactPayload } from "../../../shared/solarRecFoundation";

const dbMocks = vi.hoisted(() => ({
  getComputedArtifact: vi.fn(),
  upsertComputedArtifact: vi.fn(),
}));

const foundationMocks = vi.hoisted(() => ({
  loadInputVersions: vi.fn(),
  computeFoundationHash: vi.fn(),
  streamRowsByPage: vi.fn(),
}));

const runnerMocks = vi.hoisted(() => ({
  getOrBuildFoundation: vi.fn(),
}));

vi.mock("../../db/solarRecDatasets", async () => {
  const actual = await vi.importActual<
    typeof import("../../db/solarRecDatasets")
  >("../../db/solarRecDatasets");
  return {
    ...actual,
    getComputedArtifact: dbMocks.getComputedArtifact,
    upsertComputedArtifact: dbMocks.upsertComputedArtifact,
  };
});

vi.mock("./buildFoundationArtifact", async () => {
  const actual = await vi.importActual<
    typeof import("./buildFoundationArtifact")
  >("./buildFoundationArtifact");
  return {
    ...actual,
    loadInputVersions: foundationMocks.loadInputVersions,
    computeFoundationHash: foundationMocks.computeFoundationHash,
    streamRowsByPage: foundationMocks.streamRowsByPage,
  };
});

vi.mock("./foundationRunner", async () => {
  const actual =
    await vi.importActual<typeof import("./foundationRunner")>(
      "./foundationRunner"
    );
  return {
    ...actual,
    getOrBuildFoundation: runnerMocks.getOrBuildFoundation,
  };
});

import { __clearInFlightForTests } from "./withArtifactCache";
import {
  CHANGE_OWNERSHIP_STATUS_ORDER,
  EMPTY_SLIM_DASHBOARD_SUMMARY,
  SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION,
  type SlimDashboardSummary,
  getOrBuildSlimDashboardSummary,
} from "./buildSlimDashboardSummary";

const SCOPE = "test-scope";
const HASH = "deadbeefcafe";

function makeCanonicalSystem(
  csgId: string,
  overrides: Partial<{
    isReporting: boolean;
    isTerminated: boolean;
    isPart2Verified: boolean;
    ownershipStatus:
      | "active"
      | "transferred"
      | "change-of-ownership"
      | "terminated"
      | null;
    abpIds: string[];
  }> = {}
) {
  return {
    csgId,
    abpIds: overrides.abpIds ?? [`ABP-${csgId}`],
    isTerminated: overrides.isTerminated ?? false,
    isPart2Verified: overrides.isPart2Verified ?? true,
    isReporting: overrides.isReporting ?? false,
    ownershipStatus: overrides.ownershipStatus ?? "active",
    integrityWarningCodes: [],
  };
}

function makeFoundation(
  systemRecords: ReturnType<typeof makeCanonicalSystem>[]
): FoundationArtifactPayload {
  const canonicalSystemsByCsgId: Record<
    string,
    ReturnType<typeof makeCanonicalSystem>
  > = {};
  for (const s of systemRecords) canonicalSystemsByCsgId[s.csgId] = s;
  // Mirrors the foundation builder's contract
  // (`buildFoundationArtifact.ts:606`): a terminated system is
  // NEVER in `part2EligibleCsgIds`, regardless of whether
  // `isPart2Verified` was set on its canonical record. Test
  // fixtures that pretend otherwise model a state production
  // can't reach. PR #334 follow-up item 4 (option B, 2026-05-02).
  const part2 = systemRecords
    .filter(s => s.isPart2Verified && !s.isTerminated)
    .map(s => s.csgId);
  const reporting = systemRecords
    .filter(s => s.isReporting && !s.isTerminated)
    .map(s => s.csgId);
  const terminated = systemRecords.filter(s => s.isTerminated).length;
  const totalNonTerminated = systemRecords.length - terminated;
  return {
    schemaVersion: 1,
    definitionVersion: 4,
    foundationHash: HASH,
    builtAt: new Date(0).toISOString(),
    reportingAnchorDateIso: "2026-04-01",
    inputVersions: {
      solarApplications: {
        batchId: "solar-batch",
        rowCount: systemRecords.length,
      },
      abpReport: { batchId: "abp-batch", rowCount: 4 },
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
    canonicalSystemsByCsgId:
      canonicalSystemsByCsgId as FoundationArtifactPayload["canonicalSystemsByCsgId"],
    part2EligibleCsgIds: part2,
    reportingCsgIds: reporting,
    summaryCounts: {
      totalSystems: totalNonTerminated,
      terminated,
      part2Verified: part2.length,
      reporting: reporting.length,
      part2VerifiedAndReporting: systemRecords.filter(
        s => s.isPart2Verified && s.isReporting && !s.isTerminated
      ).length,
    },
    integrityWarnings: [],
    populatedDatasets: ["solarApplications", "abpReport"],
  };
}

beforeEach(() => {
  dbMocks.getComputedArtifact.mockReset().mockResolvedValue(null);
  dbMocks.upsertComputedArtifact.mockReset().mockResolvedValue(undefined);
  foundationMocks.loadInputVersions.mockReset();
  foundationMocks.computeFoundationHash.mockReset().mockReturnValue(HASH);
  foundationMocks.streamRowsByPage.mockReset();
  runnerMocks.getOrBuildFoundation.mockReset();
  __clearInFlightForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  __clearInFlightForTests();
});

type SolarRow = {
  id: string;
  systemId: string | null;
  installedKwAc: number | null;
  installedKwDc: number | null;
  totalContractAmount: number | null;
  rawRow?: string | null;
};

type AbpRow = {
  id: string;
  applicationId: string | null;
  systemId: string | null;
  trackingSystemRefId: string | null;
  projectName: string | null;
  part2AppVerificationDate: string | null;
};

function setupStreamMock(opts: { solarRows?: SolarRow[]; abpRows?: AbpRow[] }) {
  foundationMocks.streamRowsByPage.mockImplementation(
    async (
      _scopeId: string,
      _batchId: string,
      _table: unknown,
      selectCols: Record<string, unknown>,
      onRow: (row: Record<string, unknown>) => void
    ) => {
      if ("totalContractAmount" in selectCols) {
        for (const r of opts.solarRows ?? []) onRow(r);
      } else if ("part2AppVerificationDate" in selectCols) {
        for (const r of opts.abpRows ?? []) onRow(r);
      }
    }
  );
}

/**
 * Build a Part-II-verified ABP row whose applicationId matches the
 * canonical system's first abpId. The slim's project-matching path
 * uses applicationId → reverse map first.
 */
function abpRowFor(
  csgId: string,
  abpRowId = `abp-${csgId}`,
  date = "2024-06-15"
): AbpRow {
  return {
    id: abpRowId,
    applicationId: `ABP-${csgId}`,
    systemId: null,
    trackingSystemRefId: null,
    projectName: `Project ${csgId}`,
    part2AppVerificationDate: date,
  };
}

describe("getOrBuildSlimDashboardSummary", () => {
  it("returns the empty shape when foundation has no systems and no source data", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    expect(result).toEqual({
      ...EMPTY_SLIM_DASHBOARD_SUMMARY,
      reportingAnchorDateIso: "2026-04-01",
    });
  });

  it("tags the result with kind:'slim'", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    expect(result.kind).toBe("slim");
  });

  it("returns percentage points (0–100), not 0–1 ratios", async () => {
    // 4 systems, 2 reporting → 50% reporting.
    const systems = [
      makeCanonicalSystem("CSG-1", { isReporting: true }),
      makeCanonicalSystem("CSG-2", { isReporting: true }),
      makeCanonicalSystem("CSG-3", { isReporting: false }),
      makeCanonicalSystem("CSG-4", { isReporting: false }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-1",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
        {
          id: "2",
          systemId: "CSG-2",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
        {
          id: "3",
          systemId: "CSG-3",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
        {
          id: "4",
          systemId: "CSG-4",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.reportingPercent).toBe(50);
    expect(result.contractedValueReportingPercent).toBe(50);
    expect(
      result.sizeBreakdownRows.find(r => r.bucket === "<=10 kW AC")!
        .reportingPercent
    ).toBe(50);
  });

  it("uses canonical Part-II verified CSG counts for Overview headline totals", async () => {
    const systems = [
      makeCanonicalSystem("CSG-1", { isReporting: true }),
      makeCanonicalSystem("CSG-2", { isReporting: false }),
      makeCanonicalSystem("CSG-OUT", {
        isPart2Verified: false,
        isReporting: true,
      }),
      makeCanonicalSystem("CSG-TERM", {
        isTerminated: true,
        isReporting: true,
        ownershipStatus: "terminated",
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.totalSystems).toBe(2);
    expect(result.reportingSystems).toBe(1);
    expect(result.reportingPercent).toBe(50);
    expect(result.part2VerifiedSystems).toBe(2);
    expect(result.part2VerifiedAndReportingSystems).toBe(1);
    expect(result.terminatedSystems).toBe(1);
  });

  it("dedupes Solar Applications rows by CSG ID — duplicate rows do not double-count", async () => {
    // One Part-II-eligible CSG with TWO duplicate solar rows.
    const systems = [makeCanonicalSystem("CSG-DUP", { isReporting: true })];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        // First row wins — its values are what slim aggregates.
        {
          id: "1",
          systemId: "CSG-DUP",
          installedKwAc: 8,
          installedKwDc: 10,
          totalContractAmount: 100,
        },
        // Second row is a duplicate — must be skipped entirely.
        {
          id: "2",
          systemId: "CSG-DUP",
          installedKwAc: 999,
          installedKwDc: 999,
          totalContractAmount: 99999,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // Counts: only 1 system in size breakdown.
    expect(result.smallSystems).toBe(1);
    expect(result.largeSystems).toBe(0);
    // kW + value: only the first row's amounts.
    expect(result.cumulativeKwAcPart2).toBe(8);
    expect(result.cumulativeKwDcPart2).toBe(10);
    expect(result.totalContractedValue).toBe(100);
    expect(result.contractedValueReporting).toBe(100);
    expect(result.withValueDataCount).toBe(1);
  });

  it("falls back to Solar Applications rawRow aliases when typed size/value columns are null", async () => {
    const systems = [makeCanonicalSystem("CSG-RAW", { isReporting: true })];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-RAW",
          installedKwAc: null,
          installedKwDc: null,
          totalContractAmount: null,
          rawRow: JSON.stringify({
            installed_system_size_kw_ac: "15",
            installed_system_size_kw_dc: "18.4",
            total_contract_amount: "$25,664.73",
          }),
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.largeSystems).toBe(1);
    expect(result.unknownSizeSystems).toBe(0);
    expect(result.cumulativeKwAcPart2).toBe(15);
    expect(result.cumulativeKwDcPart2).toBe(18.4);
    expect(result.totalContractedValue).toBe(25664.73);
    expect(result.contractedValueReporting).toBe(25664.73);
  });

  it("computes ownership tile breakdown over Part-II-eligible non-terminated systems; terminated fields stay 0 per slim contract (PR #334 follow-up item 4 option B)", async () => {
    // The foundation builder excludes terminated systems from
    // `part2EligibleCsgIds` even when `isPart2Verified` is true.
    // Slim's ownership-tile walk iterates only the eligible set,
    // so terminated counts are STRUCTURALLY 0 on the slim path.
    // Heavy aggregators expose Part-II-scoped terminated counts
    // separately; the UI must render an explicit "—" placeholder
    // until heavy loads.
    const systems = [
      makeCanonicalSystem("CSG-1", {
        isReporting: true,
        ownershipStatus: "transferred",
      }),
      makeCanonicalSystem("CSG-2", {
        isReporting: true,
        ownershipStatus: "transferred",
      }),
      makeCanonicalSystem("CSG-3", {
        isReporting: true,
        ownershipStatus: "active",
      }),
      makeCanonicalSystem("CSG-4", {
        isReporting: false,
        ownershipStatus: "transferred",
      }),
      // CSG-5 / CSG-6 are terminated. Test fixture's makeFoundation
      // mirrors the production rule: terminated ⇒ excluded from
      // part2EligibleCsgIds. They count toward the portfolio
      // `terminatedSystems` field instead.
      makeCanonicalSystem("CSG-5", {
        isTerminated: true,
        isReporting: true,
        ownershipStatus: "terminated",
      }),
      makeCanonicalSystem("CSG-6", {
        isTerminated: true,
        isReporting: false,
        ownershipStatus: "terminated",
      }),
      makeCanonicalSystem("CSG-7", {
        isPart2Verified: false,
        isReporting: true,
        ownershipStatus: "active",
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.ownershipOverview.transferredReporting).toBe(2);
    expect(result.ownershipOverview.notTransferredReporting).toBe(1);
    expect(result.ownershipOverview.transferredNotReporting).toBe(1);
    // Terminated fields are NOT in `SlimOwnershipOverview` —
    // PR #337 follow-up item 6 dropped the always-0 placeholders
    // so consumers can no longer accidentally read them.
    expect(Object.keys(result.ownershipOverview).sort()).toEqual([
      "notReportingOwnershipTotal",
      "notTransferredNotReporting",
      "notTransferredReporting",
      "reportingOwnershipTotal",
      "transferredNotReporting",
      "transferredReporting",
    ]);
    // Portfolio terminated count surfaces here instead.
    expect(result.terminatedSystems).toBe(2);
  });

  it("sums cumulativeKwAcPart2 + cumulativeKwDcPart2 over Part-II-eligible systems", async () => {
    const systems = [
      makeCanonicalSystem("CSG-A", { isReporting: true }),
      makeCanonicalSystem("CSG-B", { isReporting: false }),
      makeCanonicalSystem("CSG-OUT", { isPart2Verified: false }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-A",
          installedKwAc: 8,
          installedKwDc: 10,
          totalContractAmount: 100,
        },
        {
          id: "2",
          systemId: "CSG-B",
          installedKwAc: 25,
          installedKwDc: 30,
          totalContractAmount: 200,
        },
        {
          id: "3",
          systemId: "CSG-OUT",
          installedKwAc: 999,
          installedKwDc: 999,
          totalContractAmount: 9999,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.cumulativeKwAcPart2).toBe(33);
    expect(result.cumulativeKwDcPart2).toBe(40);
    expect(result.dcDataAvailableCount).toBe(2);
    expect(result.dcEligibleSystemCount).toBe(2);
  });

  it("returns cumulativeKwDcPart2: null when no Part-II-eligible system has DC data", async () => {
    const systems = [
      makeCanonicalSystem("CSG-A", { isReporting: true }),
      makeCanonicalSystem("CSG-B", { isReporting: true }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        // All Part-II rows have null DC; UI must distinguish "no
        // data" from "real zero."
        {
          id: "1",
          systemId: "CSG-A",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
        {
          id: "2",
          systemId: "CSG-B",
          installedKwAc: 9,
          installedKwDc: null,
          totalContractAmount: 200,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.cumulativeKwDcPart2).toBeNull();
    expect(result.dcDataAvailableCount).toBe(0);
    expect(result.dcEligibleSystemCount).toBe(2);
  });

  it("computes sizeBreakdownRows with per-bucket reporting/value totals", async () => {
    const systems = [
      makeCanonicalSystem("CSG-S-R", { isReporting: true }),
      makeCanonicalSystem("CSG-S-N", { isReporting: false }),
      makeCanonicalSystem("CSG-L-R", { isReporting: true }),
      makeCanonicalSystem("CSG-U-N", { isReporting: false }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-S-R",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
        {
          id: "2",
          systemId: "CSG-S-N",
          installedKwAc: 9,
          installedKwDc: null,
          totalContractAmount: 200,
        },
        {
          id: "3",
          systemId: "CSG-L-R",
          installedKwAc: 50,
          installedKwDc: null,
          totalContractAmount: 1000,
        },
        {
          id: "4",
          systemId: "CSG-U-N",
          installedKwAc: null,
          installedKwDc: null,
          totalContractAmount: 50,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    const small = result.sizeBreakdownRows.find(
      r => r.bucket === "<=10 kW AC"
    )!;
    expect(small.total).toBe(2);
    expect(small.reporting).toBe(1);
    expect(small.notReporting).toBe(1);
    expect(small.reportingPercent).toBe(50);
    expect(small.contractedValue).toBe(300);
  });

  it("computes PROJECT-LEVEL Change-Ownership counts using ABP-row dedupe + applicationId match", async () => {
    // One ABP project (Project Alpha) maps to TWO CSGs (CSG-1 +
    // CSG-2). Both rows share applicationId ABP-1 (the foundation's
    // abpIds[] for both systems contains ABP-1). The slim should
    // count this as ONE project, not two.
    const systems = [
      makeCanonicalSystem("CSG-1", {
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-1"],
      }),
      makeCanonicalSystem("CSG-2", {
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-1"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-1",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 100,
        },
        {
          id: "2",
          systemId: "CSG-2",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 200,
        },
      ],
      abpRows: [
        // Two ABP rows for the same project (same applicationId).
        // Dedupe key falls back to applicationId since systemId/
        // tracking are null. Both rows dedupe to "application:ABP-1".
        {
          id: "abp-1",
          applicationId: "ABP-1",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Project Alpha",
          part2AppVerificationDate: "2024-06-15",
        },
        {
          id: "abp-2",
          applicationId: "ABP-1",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Project Alpha",
          part2AppVerificationDate: "2024-06-16",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // ONE project (deduped), classified as Transferred and Reporting
    // because the matched system is transferred + reporting.
    expect(result.changeOwnership.summary.total).toBe(1);
    const transferredReporting = result.changeOwnership.summary.counts.find(
      c => c.status === "Transferred and Reporting"
    )!;
    expect(transferredReporting.count).toBe(1);
  });

  it("rejects ABP rows whose only matched system is foundation-terminated (PR #334 follow-up item 4 option B)", async () => {
    // Production foundation excludes terminated systems from
    // `part2EligibleCsgIds`. An ABP row with a valid Part-II date
    // mapped only to such a system fails slim's foundation Part-II
    // gate (`isPart2Verified && part2EligibleSet.has(csgId)`) and
    // contributes nothing to Change Ownership. The PRE-fix slim
    // builder modeled an impossible "terminated AND Part-II-eligible"
    // foundation state and emitted "Terminated" status counts;
    // option B removes that unreachable branch and verifies the
    // gate's correct rejection here.
    //
    // The CHANGE_OWNERSHIP_STATUS_ORDER 5-status contract still
    // INCLUDES "Terminated" — heavy aggregators populate it from a
    // broader system snapshot. On slim, that bucket stays at 0.
    const systems = [
      makeCanonicalSystem("CSG-T-R", {
        isTerminated: true,
        isReporting: true,
        ownershipStatus: "terminated",
        abpIds: ["ABP-1"],
      }),
      makeCanonicalSystem("CSG-T-N", {
        isTerminated: true,
        isReporting: false,
        ownershipStatus: "terminated",
        abpIds: ["ABP-2"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [],
      abpRows: [
        {
          id: "abp-1",
          applicationId: "ABP-1",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P1",
          part2AppVerificationDate: "2024-06-15",
        },
        {
          id: "abp-2",
          applicationId: "ABP-2",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P2",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // ABP rows accepted by the date-only diagnostic counter.
    expect(result.part2VerifiedAbpRowsCount).toBe(2);
    // But foundation Part-II gate rejects both → no Change
    // Ownership classification.
    expect(result.changeOwnership.summary.total).toBe(0);
    const terminated = result.changeOwnership.summary.counts.find(
      c => c.status === "Terminated"
    )!;
    expect(terminated.count).toBe(0);
    // Status-order contract preserved (5 statuses, virtual
    // Terminated bucket present).
    expect(result.changeOwnership.summary.counts.map(c => c.status)).toEqual(
      CHANGE_OWNERSHIP_STATUS_ORDER
    );
    // Portfolio terminated count surfaces correctly.
    expect(result.terminatedSystems).toBe(2);
  });

  it("counts active matched projects in the stacked chart's notTransferred bucket", async () => {
    const systems = [
      makeCanonicalSystem("CSG-Active", {
        isReporting: true,
        ownershipStatus: "active",
        abpIds: ["ABP-A"],
      }),
      makeCanonicalSystem("CSG-Trans", {
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-T"],
      }),
      makeCanonicalSystem("CSG-COO", {
        isReporting: false,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-C"],
      }),
      // Terminated — must be EXCLUDED from the stacked chart per
      // the heavy aggregator's contract.
      makeCanonicalSystem("CSG-Term", {
        isTerminated: true,
        isReporting: true,
        ownershipStatus: "terminated",
        abpIds: ["ABP-X"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [],
      abpRows: [
        {
          id: "1",
          applicationId: "ABP-A",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P",
          part2AppVerificationDate: "2024-06-15",
        },
        {
          id: "2",
          applicationId: "ABP-T",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P",
          part2AppVerificationDate: "2024-06-15",
        },
        {
          id: "3",
          applicationId: "ABP-C",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P",
          part2AppVerificationDate: "2024-06-15",
        },
        {
          id: "4",
          applicationId: "ABP-X",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    const reporting = result.changeOwnership.ownershipStackedChartRows.find(
      r => r.label === "Reporting"
    )!;
    const notReporting = result.changeOwnership.ownershipStackedChartRows.find(
      r => r.label === "Not Reporting"
    )!;
    // Active matched project → notTransferred; Transferred →
    // transferred; Change-of-Ownership → changeOwnership; Terminated
    // is EXCLUDED.
    expect(reporting.notTransferred).toBe(1);
    expect(reporting.transferred).toBe(1);
    expect(reporting.changeOwnership).toBe(0);
    expect(notReporting.changeOwnership).toBe(1);
    expect(notReporting.notTransferred).toBe(0);
    expect(notReporting.transferred).toBe(0);
  });

  it("counts cooNotTransferredNotReportingCurrentCount only for change-of-ownership, not-reporting projects", async () => {
    const systems = [
      makeCanonicalSystem("CSG-1", {
        isReporting: false,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-1"],
      }),
      makeCanonicalSystem("CSG-2", {
        isReporting: true,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-2"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [],
      abpRows: [
        {
          id: "1",
          applicationId: "ABP-1",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P",
          part2AppVerificationDate: "2024-06-15",
        },
        {
          id: "2",
          applicationId: "ABP-2",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "P",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    expect(
      result.changeOwnership.cooNotTransferredNotReportingCurrentCount
    ).toBe(1);
  });

  it("does NOT include high-cardinality fields in the slim shape", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([
        makeCanonicalSystem("CSG-1", { isReporting: true }),
      ]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-1",
          installedKwAc: 5,
          installedKwDc: null,
          totalContractAmount: 100,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    const keys = new Set(Object.keys(result));

    expect(keys.has("eligiblePart2ApplicationIds")).toBe(false);
    expect(keys.has("eligiblePart2PortalSystemIds")).toBe(false);
    expect(keys.has("eligiblePart2TrackingIds")).toBe(false);
    expect(keys.has("abpApplicationIdBySystemKey")).toBe(false);
    expect(keys.has("abpAcSizeKwBySystemKey")).toBe(false);
    expect(keys.has("monitoringDetailsBySystemKey")).toBe(false);
    expect(keys.has("ownershipRows")).toBe(false);
    expect(keys.has("part2VerifiedSystemIds")).toBe(false);
    expect(keys.has("totalDeliveredValue")).toBe(false);
    expect(keys.has("totalGap")).toBe(false);
    expect(keys.has("deliveredValuePercent")).toBe(false);
  });

  it("stays under the 1 MB dashboard wire budget on prod-shaped input (21k systems)", async () => {
    const PROD = 21_000;
    const systems = Array.from({ length: PROD }, (_, i) =>
      makeCanonicalSystem(`CSG-${i}`, {
        isReporting: i % 2 === 0,
        ownershipStatus: i % 7 === 0 ? "transferred" : "active",
      })
    );
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: systems.map((s, i) => ({
        id: `${i}`,
        systemId: s.csgId,
        installedKwAc: 8 + (i % 30),
        installedKwDc: 10 + (i % 30),
        totalContractAmount: 1000 + i,
      })),
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it("uses the foundation hash as the cache key", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    await getOrBuildSlimDashboardSummary(SCOPE);

    expect(dbMocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
    const writeArgs = dbMocks.upsertComputedArtifact.mock.calls[0][0];
    expect(writeArgs.scopeId).toBe(SCOPE);
    expect(writeArgs.inputVersionHash).toBe(HASH);
    expect(writeArgs.artifactType).toBe(SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION);
  });

  it("does NOT call getOrBuildFoundation on a slim cache hit", async () => {
    dbMocks.getComputedArtifact.mockResolvedValue({
      payload: JSON.stringify(EMPTY_SLIM_DASHBOARD_SUMMARY),
    });

    const { result, fromCache } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(fromCache).toBe(true);
    expect(result).toEqual(EMPTY_SLIM_DASHBOARD_SUMMARY);
    expect(runnerMocks.getOrBuildFoundation).not.toHaveBeenCalled();
    expect(foundationMocks.streamRowsByPage).not.toHaveBeenCalled();
  });

  it("uses runner version v8 (Part-II headline total semantics)", () => {
    expect(SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION).toBe(
      "slim-dashboard-summary-v8"
    );
  });

  it("accepts Excel-serial part2AppVerificationDate (parity with foundation eligibility — PR #334 follow-up item 3)", async () => {
    // Production CSV ingest sometimes emits Excel serial dates
    // (5-digit integers in the 20000–80000 range) instead of
    // calendar-formatted strings. The foundation builder's
    // `isPart2VerifiedAbpRow` helper accepts them via
    // `parsePart2VerificationDate`. Slim now does too — otherwise
    // foundation-eligible projects silently disappear from slim's
    // Change Ownership counts. Pre-fix slim used `new Date("45292")`
    // which parses as year 45292 → out of [2009, 2100] → row
    // dropped → silent count drift.
    //
    // 45292 = 2024-01-01 in Excel-serial-1900-mode (epoch
    // 1899-12-30 + 45292 days).
    const systems = [
      makeCanonicalSystem("CSG-EXCEL", {
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-EXCEL"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-EXCEL",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 5000,
        },
      ],
      abpRows: [
        {
          id: "abp-1",
          applicationId: "ABP-EXCEL",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Excel-Serial Project",
          part2AppVerificationDate: "45292",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.part2VerifiedAbpRowsCount).toBe(1);
    expect(result.changeOwnership.summary.total).toBe(1);
    const transferredReporting = result.changeOwnership.summary.counts.find(
      c => c.status === "Transferred and Reporting"
    )!;
    expect(transferredReporting.count).toBe(1);
  });

  it("rejects out-of-range calendar dates (parity with foundation parser)", async () => {
    // The shared parser keeps the [2009, 2100] window. A row dated
    // 2008-12-31 must NOT count under either parser.
    const systems = [
      makeCanonicalSystem("CSG-OLD", {
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-OLD"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [],
      abpRows: [
        {
          id: "abp-old",
          applicationId: "ABP-OLD",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Old project",
          part2AppVerificationDate: "2008-12-31",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    expect(result.part2VerifiedAbpRowsCount).toBe(0);
    expect(result.changeOwnership.summary.total).toBe(0);
  });

  it("ABP row whose matched system has isPart2Verified=false does NOT contribute to Change Ownership", async () => {
    // Foundation has the system but with isPart2Verified=false. The
    // legacy date-only ABP filter would still count this row; the
    // foundation Part-II gate must drop it.
    const systems = [
      makeCanonicalSystem("CSG-NOT-VERIFIED", {
        isPart2Verified: false,
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-NV"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-NOT-VERIFIED",
          installedKwAc: 8,
          installedKwDc: 10,
          totalContractAmount: 5000,
        },
      ],
      abpRows: [
        {
          id: "abp-nv",
          applicationId: "ABP-NV",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Project Not Verified",
          // Valid date — date-only filter would PASS this row.
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // Diagnostic legacy counters still tick — that's their job.
    expect(result.part2VerifiedAbpRowsCount).toBe(1);
    expect(result.abpEligibleTotalSystemsCount).toBe(1);
    // But Change Ownership numbers are zero — the foundation gate
    // dropped the row before classification.
    expect(result.changeOwnership.summary.total).toBe(0);
    expect(result.changeOwnership.summary.reporting).toBe(0);
    expect(result.changeOwnership.summary.contractedValueTotal).toBe(0);
    expect(
      result.changeOwnership.summary.contractedValueProjectsWithDataCount
    ).toBe(0);
    expect(
      result.changeOwnership.summary.contractedValueProjectsMissingDataCount
    ).toBe(0);
    // No stacked-chart contribution either.
    const reportingChart =
      result.changeOwnership.ownershipStackedChartRows.find(
        r => r.label === "Reporting"
      )!;
    expect(reportingChart.transferred).toBe(0);
    expect(reportingChart.notTransferred).toBe(0);
    expect(reportingChart.changeOwnership).toBe(0);
  });

  it("ABP row mapping to foundation-excluded system (not in part2EligibleCsgIds) does NOT contribute", async () => {
    // System has isPart2Verified=true on its record but is NOT in
    // foundation.part2EligibleCsgIds. The slim builder must check
    // BOTH (defensive — foundation invariant ties them, but the
    // eligibility set is the canonical truth that drives KPI gates).
    const systems = [
      makeCanonicalSystem("CSG-EXCLUDED", {
        isPart2Verified: true,
        isReporting: true,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-X"],
      }),
    ];
    const foundation = makeFoundation(systems);
    // Force the eligibility set to be empty even though the per-
    // system isPart2Verified flag says true. This simulates the
    // foundation excluding the CSG (e.g. ABP status filter would
    // catch it upstream).
    foundation.part2EligibleCsgIds = [];
    foundation.summaryCounts.part2Verified = 0;
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: foundation,
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [],
      abpRows: [
        {
          id: "abp-x",
          applicationId: "ABP-X",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Excluded",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.changeOwnership.summary.total).toBe(0);
    expect(result.changeOwnership.summary.reporting).toBe(0);
  });

  it("multi-map: one ABP applicationId mapped to two CSGs (transferred + change-of-ownership) classifies the project from BOTH systems", async () => {
    // ABP-MULTI maps to CSG-T (transferred) AND CSG-C (change-of-
    // ownership). Single-map would silently drop one. Multi-map
    // must see both, and project classification picks
    // "Change of Ownership" (it outranks "Transferred" when both
    // are present, mirroring heavy aggregator priority).
    const systems = [
      makeCanonicalSystem("CSG-T", {
        isReporting: true,
        ownershipStatus: "transferred",
        abpIds: ["ABP-MULTI"],
      }),
      makeCanonicalSystem("CSG-C", {
        isReporting: true,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-MULTI"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-T",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 1000,
        },
        {
          id: "2",
          systemId: "CSG-C",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 2000,
        },
      ],
      abpRows: [
        {
          id: "abp-multi",
          applicationId: "ABP-MULTI",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Multi-System Project",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // ONE project; classified as Change of Ownership (CoO outranks
    // Transferred when both are present in the matched eligible set).
    expect(result.changeOwnership.summary.total).toBe(1);
    const cooReporting = result.changeOwnership.summary.counts.find(
      c => c.status === "Change of Ownership - Not Transferred and Reporting"
    )!;
    expect(cooReporting.count).toBe(1);
    const xferReporting = result.changeOwnership.summary.counts.find(
      c => c.status === "Transferred and Reporting"
    )!;
    // Single-map bug would have classified this as Transferred.
    expect(xferReporting.count).toBe(0);
  });

  it("preserves reporting state for non-terminated change-ownership projects (regression rail for project-level reporting tracking)", async () => {
    // Regression rail. PR #332 follow-up tracked
    // `projectReportingByDedupe` independently from status text so
    // a Change-Ownership-NOT-TRANSFERRED-and-Reporting project
    // increments `summary.reporting`. Pre-fix the slim derived
    // reporting count by counting status strings ending in
    // "and Reporting", which would NOT have caught a future status
    // mapping change. The original test used a terminated-reporting
    // project to demonstrate the bug, but per PR #334 follow-up
    // item 4 (option B) terminated systems are excluded from slim
    // Part-II eligibility — the test now asserts the same behavior
    // on a non-terminated CoO project, which IS a reachable
    // production state.
    const systems = [
      makeCanonicalSystem("CSG-COO-REPORTING", {
        isReporting: true,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-CR"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        {
          id: "1",
          systemId: "CSG-COO-REPORTING",
          installedKwAc: 8,
          installedKwDc: null,
          totalContractAmount: 7500,
        },
      ],
      abpRows: [
        {
          id: "abp-cr",
          applicationId: "ABP-CR",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "CoO Project Reporting",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // Status: Change of Ownership reporting variant.
    const cooReporting = result.changeOwnership.summary.counts.find(
      c => c.status === "Change of Ownership - Not Transferred and Reporting"
    )!;
    expect(cooReporting.count).toBe(1);
    // Reporting state derived from per-project flag, not status text.
    expect(result.changeOwnership.summary.reporting).toBe(1);
    expect(result.changeOwnership.summary.notReporting).toBe(0);
    // Value totals: reporting bucket carries the amount.
    expect(result.changeOwnership.summary.contractedValueTotal).toBe(7500);
    expect(result.changeOwnership.summary.contractedValueReporting).toBe(7500);
    expect(result.changeOwnership.summary.contractedValueNotReporting).toBe(0);
    expect(
      result.changeOwnership.summary.contractedValueProjectsWithDataCount
    ).toBe(1);
    expect(
      result.changeOwnership.summary.contractedValueProjectsMissingDataCount
    ).toBe(0);
  });

  it("tracks Change Ownership value coverage when no matched system has a recorded totalContractAmount", async () => {
    // CoO project with NO solarApplications row → no recorded
    // amount in `solarContractedValueByCsg`. Pre-fix: silently summed
    // as 0. Post-fix: counted on
    // `contractedValueProjectsMissingDataCount` and excluded from
    // `contractedValueTotal`.
    const systems = [
      makeCanonicalSystem("CSG-NO-AMOUNT", {
        isReporting: false,
        ownershipStatus: "change-of-ownership",
        abpIds: ["ABP-NA"],
      }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [], // no solarApplications row → no amount.
      abpRows: [
        {
          id: "abp-na",
          applicationId: "ABP-NA",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "No-amount project",
          part2AppVerificationDate: "2024-06-15",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.changeOwnership.summary.total).toBe(1);
    expect(result.changeOwnership.summary.contractedValueTotal).toBe(0);
    expect(
      result.changeOwnership.summary.contractedValueProjectsWithDataCount
    ).toBe(0);
    expect(
      result.changeOwnership.summary.contractedValueProjectsMissingDataCount
    ).toBe(1);
  });
});

describe("buildSlimDashboardSummary source structure", () => {
  function readSourceCodeOnly(): string {
    const filePath = resolve(__dirname, "buildSlimDashboardSummary.ts");
    const raw = readFileSync(filePath, "utf8");
    return raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  }

  it("does not import the heavy upstream aggregators", () => {
    const source = readSourceCodeOnly();
    expect(source).not.toMatch(
      /from\s+["'][^"']*buildOverviewSummaryAggregates/
    );
    expect(source).not.toMatch(
      /from\s+["'][^"']*buildOfflineMonitoringAggregates/
    );
    expect(source).not.toMatch(
      /from\s+["'][^"']*buildChangeOwnershipAggregates/
    );
    expect(source).not.toMatch(/from\s+["'][^"']*buildSystemSnapshot/);
  });

  it("does not call getOrBuild* of the heavy aggregators", () => {
    const source = readSourceCodeOnly();
    expect(source).not.toMatch(/getOrBuildOverviewSummary\s*\(/);
    expect(source).not.toMatch(/getOrBuildOfflineMonitoringAggregates\s*\(/);
    expect(source).not.toMatch(/getOrBuildChangeOwnership\s*\(/);
    expect(source).not.toMatch(/getOrBuildSystemSnapshot\s*\(/);
  });

  it("uses streamRowsByPage and not the full-load helpers", () => {
    const source = readSourceCodeOnly();
    expect(source).toMatch(/streamRowsByPage\s*</);
    expect(source).not.toMatch(/loadDatasetRows\s*\(/);
    expect(source).not.toMatch(/loadAllRowsByPage\s*\(/);
  });

  it("uses toPercentValue for all percent fields (no raw / division)", () => {
    const source = readSourceCodeOnly();
    expect(source).toMatch(
      /import\s+\{[^}]*toPercentValue[^}]*\}\s+from\s+["']\.\/aggregatorHelpers["']/
    );
    // No naked ratio assignment to a *Percent field. Match patterns
    // like `xPercent = a / b` or `xPercent: a / b`.
    expect(source).not.toMatch(
      /[A-Za-z]+Percent\s*[=:]\s*[A-Za-z_.[\]]+\s*\/\s*[A-Za-z_.[\]]+/
    );
  });
});

/** Type-only assertion the slim shape carries the discriminated kind. */
type _AssertSlimKind = (s: SlimDashboardSummary) => "slim";
const _kindFn: _AssertSlimKind = s => s.kind;
void _kindFn;
