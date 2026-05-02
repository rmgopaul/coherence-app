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
  const actual = await vi.importActual<typeof import("./foundationRunner")>(
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
  }> = {}
) {
  return {
    csgId,
    abpIds: [`ABP-${csgId}`],
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
  const part2 = systemRecords
    .filter((s) => s.isPart2Verified)
    .map((s) => s.csgId);
  const reporting = systemRecords
    .filter((s) => s.isReporting && !s.isTerminated)
    .map((s) => s.csgId);
  const terminated = systemRecords.filter((s) => s.isTerminated).length;
  const totalNonTerminated = systemRecords.length - terminated;
  return {
    schemaVersion: 1,
    definitionVersion: 4,
    foundationHash: HASH,
    builtAt: new Date(0).toISOString(),
    reportingAnchorDateIso: "2026-04-01",
    inputVersions: {
      solarApplications: { batchId: "solar-batch", rowCount: systemRecords.length },
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
        (s) => s.isPart2Verified && s.isReporting && !s.isTerminated
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

function setupStreamMock(opts: {
  solarRows?: Array<{
    id: string;
    systemId: string | null;
    installedKwAc: number | null;
    installedKwDc: number | null;
    totalContractAmount: number | null;
  }>;
  abpRows?: Array<{
    id: string;
    applicationId: string | null;
    systemId: string | null;
    trackingSystemRefId: string | null;
    projectName: string | null;
    part2AppVerificationDate: string | null;
  }>;
}) {
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

  it("tags the result with kind:'slim' so consumers can branch on shape", async () => {
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

  it("computes the 9-bucket ownership tile breakdown over Part-II-eligible systems", async () => {
    const systems = [
      makeCanonicalSystem("CSG-1", { isReporting: true, ownershipStatus: "transferred" }),
      makeCanonicalSystem("CSG-2", { isReporting: true, ownershipStatus: "transferred" }),
      makeCanonicalSystem("CSG-3", { isReporting: true, ownershipStatus: "active" }),
      makeCanonicalSystem("CSG-4", { isReporting: false, ownershipStatus: "transferred" }),
      makeCanonicalSystem("CSG-5", { isTerminated: true, isReporting: true, ownershipStatus: "terminated" }),
      makeCanonicalSystem("CSG-6", { isTerminated: true, isReporting: false, ownershipStatus: "terminated" }),
      // NOT Part-II eligible — must be excluded.
      makeCanonicalSystem("CSG-7", { isPart2Verified: false, isReporting: true, ownershipStatus: "active" }),
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
    expect(result.ownershipOverview.notTransferredNotReporting).toBe(0);
    expect(result.ownershipOverview.terminatedReporting).toBe(1);
    expect(result.ownershipOverview.terminatedNotReporting).toBe(1);
    expect(result.ownershipOverview.reportingOwnershipTotal).toBe(3);
    expect(result.ownershipOverview.notReportingOwnershipTotal).toBe(1);
    expect(result.ownershipOverview.terminatedTotal).toBe(2);
  });

  it("sums cumulativeKwAcPart2 + cumulativeKwDcPart2 over Part-II-eligible systems only", async () => {
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
        { id: "1", systemId: "CSG-A", installedKwAc: 8, installedKwDc: 10, totalContractAmount: 100 },
        { id: "2", systemId: "CSG-B", installedKwAc: 25, installedKwDc: 30, totalContractAmount: 200 },
        // Outside Part-II: must NOT contribute.
        { id: "3", systemId: "CSG-OUT", installedKwAc: 999, installedKwDc: 999, totalContractAmount: 9999 },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.cumulativeKwAcPart2).toBe(8 + 25);
    expect(result.cumulativeKwDcPart2).toBe(10 + 30);
  });

  it("computes sizeBreakdownRows with per-bucket reporting/percent/contracted-value", async () => {
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
        { id: "1", systemId: "CSG-S-R", installedKwAc: 8, installedKwDc: null, totalContractAmount: 100 },
        { id: "2", systemId: "CSG-S-N", installedKwAc: 9, installedKwDc: null, totalContractAmount: 200 },
        { id: "3", systemId: "CSG-L-R", installedKwAc: 50, installedKwDc: null, totalContractAmount: 1000 },
        { id: "4", systemId: "CSG-U-N", installedKwAc: null, installedKwDc: null, totalContractAmount: 50 },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    const small = result.sizeBreakdownRows.find((r) => r.bucket === "<=10 kW AC")!;
    const large = result.sizeBreakdownRows.find((r) => r.bucket === ">10 kW AC")!;
    const unknown = result.sizeBreakdownRows.find((r) => r.bucket === "Unknown")!;

    expect(small.total).toBe(2);
    expect(small.reporting).toBe(1);
    expect(small.notReporting).toBe(1);
    expect(small.reportingPercent).toBeCloseTo(0.5, 5);
    expect(small.contractedValue).toBe(300);

    expect(large.total).toBe(1);
    expect(large.reporting).toBe(1);
    expect(large.contractedValue).toBe(1000);

    expect(unknown.total).toBe(1);
    expect(unknown.notReporting).toBe(1);
    expect(unknown.contractedValue).toBe(50);
  });

  it("derives Change-Ownership counts + chart rows + cooNotTransferredNotReportingCurrentCount from foundation status", async () => {
    const systems = [
      // Part-II eligible
      makeCanonicalSystem("CSG-1", { isReporting: true, ownershipStatus: "transferred" }),
      makeCanonicalSystem("CSG-2", { isReporting: false, ownershipStatus: "transferred" }),
      makeCanonicalSystem("CSG-3", { isReporting: true, ownershipStatus: "change-of-ownership" }),
      makeCanonicalSystem("CSG-4", { isReporting: false, ownershipStatus: "change-of-ownership" }),
      makeCanonicalSystem("CSG-5", { isTerminated: true, isReporting: true, ownershipStatus: "terminated" }),
      makeCanonicalSystem("CSG-6", { isTerminated: true, isReporting: false, ownershipStatus: "terminated" }),
      // active = no change → not in change-ownership counts
      makeCanonicalSystem("CSG-7", { isReporting: true, ownershipStatus: "active" }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    const co = result.changeOwnership;

    const find = (status: string) =>
      co.summary.counts.find((c) => c.status === status)!.count;
    expect(find("Transferred and Reporting")).toBe(1);
    expect(find("Transferred and Not Reporting")).toBe(1);
    expect(find("Change of Ownership - Not Transferred and Reporting")).toBe(1);
    expect(find("Change of Ownership - Not Transferred and Not Reporting")).toBe(1);
    expect(find("Terminated and Reporting")).toBe(1);
    expect(find("Terminated and Not Reporting")).toBe(1);
    expect(co.summary.total).toBe(6);
    expect(co.summary.reporting).toBe(3);
    expect(co.summary.notReporting).toBe(3);
    expect(co.cooNotTransferredNotReportingCurrentCount).toBe(1); // CSG-4

    // Stacked chart: terminated excluded; CSG-7 active also excluded
    // because change-of-ownership chart counts only ownership-changed
    // systems? Wait: the heavy aggregator's chart includes ALL systems
    // (project-matched), bucketing by reporting × {notTransferred,
    // transferred, changeOwnership}. Slim mirrors that — including
    // "active" as "notTransferred". Let me verify the chart bucket:
    const reportingRow = co.ownershipStackedChartRows.find(
      (r) => r.label === "Reporting"
    )!;
    const notReportingRow = co.ownershipStackedChartRows.find(
      (r) => r.label === "Not Reporting"
    )!;
    // Reporting bucket: CSG-1 transferred, CSG-3 change-ownership, CSG-7 active (notTransferred). CSG-5 excluded (terminated).
    expect(reportingRow.transferred).toBe(1);
    expect(reportingRow.changeOwnership).toBe(1);
    expect(reportingRow.notTransferred).toBe(1);
    // Not Reporting bucket: CSG-2 transferred, CSG-4 change-ownership. CSG-6 excluded.
    expect(notReportingRow.transferred).toBe(1);
    expect(notReportingRow.changeOwnership).toBe(1);
    expect(notReportingRow.notTransferred).toBe(0);
  });

  it("change-ownership counts list is in CHANGE_OWNERSHIP_STATUS_ORDER", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    expect(result.changeOwnership.summary.counts.map((c) => c.status)).toEqual(
      CHANGE_OWNERSHIP_STATUS_ORDER
    );
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
        { id: "1", systemId: "CSG-1", installedKwAc: 5, installedKwDc: null, totalContractAmount: 100 },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    const keys = new Set(Object.keys(result));

    // High-cardinality eligibility ID arrays — not on slim.
    expect(keys.has("eligiblePart2ApplicationIds")).toBe(false);
    expect(keys.has("eligiblePart2PortalSystemIds")).toBe(false);
    expect(keys.has("eligiblePart2TrackingIds")).toBe(false);
    // Per-system maps — not on slim.
    expect(keys.has("abpApplicationIdBySystemKey")).toBe(false);
    expect(keys.has("abpAcSizeKwBySystemKey")).toBe(false);
    expect(keys.has("monitoringDetailsBySystemKey")).toBe(false);
    expect(keys.has("abpAcSizeKwByApplicationId")).toBe(false);
    expect(keys.has("abpPart2VerificationDateByApplicationId")).toBe(false);
    // Heavy export rows — not on slim.
    expect(keys.has("ownershipRows")).toBe(false);
    expect(keys.has("part2VerifiedSystemIds")).toBe(false);
    // Heavy delivered-value fields — explicitly absent (UI uses null
    // rendering rather than silent zeros).
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
    expect(writeArgs.artifactType).toBe("slim-dashboard-summary-v2");
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

  it("bumps the runner version marker when the contract changes", () => {
    expect(SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION).toMatch(
      /^slim-dashboard-summary-v\d+$/
    );
  });
});

// ---------------------------------------------------------------------------
// Source structure regression rails — block any future PR from
// pulling in the heavy aggregators.
// ---------------------------------------------------------------------------

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
    expect(source).not.toMatch(/from\s+["'][^"']*buildOverviewSummaryAggregates/);
    expect(source).not.toMatch(/from\s+["'][^"']*buildOfflineMonitoringAggregates/);
    expect(source).not.toMatch(/from\s+["'][^"']*buildChangeOwnershipAggregates/);
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
});

/** Type-only assertion the slim shape carries the discriminated kind. */
type _AssertSlimKind = (s: SlimDashboardSummary) => "slim";
const _kindFn: _AssertSlimKind = (s) => s.kind;
void _kindFn;
