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

import {
  __clearInFlightForTests,
} from "./withArtifactCache";
import {
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
    ownershipStatus: "active" | "transferred" | "change-of-ownership" | "terminated" | null;
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
  const part2 = systemRecords.filter((s) => s.isPart2Verified).map((s) => s.csgId);
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
    canonicalSystemsByCsgId: canonicalSystemsByCsgId as FoundationArtifactPayload["canonicalSystemsByCsgId"],
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

/**
 * `streamRowsByPage` mock that dispatches `solarRows` and `abpRows`
 * to the appropriate `onRow` callback by table name. Vitest cannot
 * dispatch on the table object directly so we look at the column
 * projection's keys.
 */
function setupStreamMock(opts: {
  solarRows?: Array<{
    id: string;
    systemId: string | null;
    installedKwAc: number | null;
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
    // Match the empty shape EXCEPT for the reporting anchor (the
    // fixture foundation pins it; that pass-through is the one
    // foundation field this builder forwards verbatim).
    expect(result).toEqual({
      ...EMPTY_SLIM_DASHBOARD_SUMMARY,
      reportingAnchorDateIso: "2026-04-01",
    });
  });

  it("walks foundation.canonicalSystemsByCsgId for ownership tile breakdown over Part-II-eligible systems", async () => {
    const systems = [
      // Part-II eligible: 2 reporting + transferred, 1 reporting + not-transferred,
      // 1 not-reporting + transferred, 1 terminated reporting, 1 terminated not.
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
      // NOT Part-II eligible — must be excluded from tile breakdown.
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
    expect(result.ownershipOverview.notTransferredNotReporting).toBe(0);
    expect(result.ownershipOverview.terminatedReporting).toBe(1);
    expect(result.ownershipOverview.terminatedNotReporting).toBe(1);
    expect(result.ownershipOverview.reportingOwnershipTotal).toBe(3);
    expect(result.ownershipOverview.notReportingOwnershipTotal).toBe(1);
    expect(result.ownershipOverview.terminatedTotal).toBe(2);
  });

  it("stream-folds solarApplications for size buckets + value totals (Part-II-eligible only)", async () => {
    const systems = [
      makeCanonicalSystem("CSG-S", { isReporting: true }),
      makeCanonicalSystem("CSG-L", { isReporting: false }),
      makeCanonicalSystem("CSG-U", { isReporting: true }),
      makeCanonicalSystem("CSG-OUT", { isPart2Verified: false, isReporting: true }),
    ];
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation(systems),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      solarRows: [
        // small + reporting + value
        {
          id: "1",
          systemId: "CSG-S",
          installedKwAc: 8,
          totalContractAmount: 500,
        },
        // large + not-reporting + value
        {
          id: "2",
          systemId: "CSG-L",
          installedKwAc: 50,
          totalContractAmount: 2000,
        },
        // unknown size + reporting + null value
        {
          id: "3",
          systemId: "CSG-U",
          installedKwAc: null,
          totalContractAmount: null,
        },
        // not Part-II-eligible — filtered out completely
        {
          id: "4",
          systemId: "CSG-OUT",
          installedKwAc: 5,
          totalContractAmount: 9999,
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(result.smallSystems).toBe(1);
    expect(result.largeSystems).toBe(1);
    expect(result.unknownSizeSystems).toBe(1);
    expect(result.withValueDataCount).toBe(2);
    expect(result.totalContractedValue).toBe(2500);
    expect(result.contractedValueReporting).toBe(500);
    expect(result.contractedValueNotReporting).toBe(2000);
    expect(result.contractedValueReportingPercent).toBeCloseTo(0.2, 5);
  });

  it("stream-folds abpReport for ABP counts using the legacy date-only filter and dedupe key fallback", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({
      abpRows: [
        // verified + dedupe by systemId
        {
          id: "1",
          applicationId: "APP-1",
          systemId: "PS-1",
          trackingSystemRefId: "TR-1",
          projectName: "Project Alpha",
          part2AppVerificationDate: "2024-06-15",
        },
        // verified + same systemId → same dedupe key, increments count
        // but not dedupe set
        {
          id: "2",
          applicationId: "APP-2",
          systemId: "PS-1",
          trackingSystemRefId: "TR-2",
          projectName: "Project Alpha",
          part2AppVerificationDate: "2024-07-01",
        },
        // verified + no systemId → falls back to tracking
        {
          id: "3",
          applicationId: "APP-3",
          systemId: null,
          trackingSystemRefId: "TR-3",
          projectName: "Project Beta",
          part2AppVerificationDate: "2024-08-01",
        },
        // verified + no systemId/tracking → falls back to applicationId
        {
          id: "4",
          applicationId: "APP-4",
          systemId: null,
          trackingSystemRefId: null,
          projectName: "Project Gamma",
          part2AppVerificationDate: "2024-09-01",
        },
        // NOT verified — empty date string
        {
          id: "5",
          applicationId: "APP-5",
          systemId: "PS-5",
          trackingSystemRefId: null,
          projectName: "Other",
          part2AppVerificationDate: "",
        },
        // NOT verified — null
        {
          id: "6",
          applicationId: "APP-6",
          systemId: "PS-6",
          trackingSystemRefId: null,
          projectName: "Other",
          part2AppVerificationDate: null,
        },
        // NOT verified — out-of-range year
        {
          id: "7",
          applicationId: "APP-7",
          systemId: "PS-7",
          trackingSystemRefId: null,
          projectName: "Other",
          part2AppVerificationDate: "1999-01-01",
        },
      ],
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);

    // Verified rows: 4 (rows 1, 2, 3, 4).
    expect(result.part2VerifiedAbpRowsCount).toBe(4);
    // Distinct dedupe keys: system:PS-1 (rows 1+2), tracking:TR-3 (row 3),
    // application:APP-4 (row 4) → 3.
    expect(result.abpEligibleTotalSystemsCount).toBe(3);
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
          totalContractAmount: 100,
        },
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
  });

  it("stays under the 1 MB dashboard wire budget on prod-shaped foundation + source rows", async () => {
    // 21k Part-II-eligible systems is the prod portfolio. The slim
    // shape is fixed (no per-system fields), so output bytes do not
    // scale with system count. This pins the contract.
    const PROD_SYSTEMS = 21_000;
    const systems = Array.from({ length: PROD_SYSTEMS }, (_, i) =>
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
        totalContractAmount: 1000 + i,
      })),
    });

    const { result } = await getOrBuildSlimDashboardSummary(SCOPE);
    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it("uses the foundation hash as the cache key (slim cache invalidates with foundation)", async () => {
    runnerMocks.getOrBuildFoundation.mockResolvedValue({
      payload: makeFoundation([]),
      fromCache: false,
      fromInflight: false,
      inputVersionHash: HASH,
    });
    setupStreamMock({});

    await getOrBuildSlimDashboardSummary(SCOPE);

    // The cache write uses the foundation hash as inputVersionHash.
    expect(dbMocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
    const writeArgs = dbMocks.upsertComputedArtifact.mock.calls[0][0];
    expect(writeArgs.scopeId).toBe(SCOPE);
    expect(writeArgs.inputVersionHash).toBe(HASH);
    expect(writeArgs.artifactType).toBe("slim-dashboard-summary-v1");
  });

  it("does NOT call getOrBuildFoundation on a slim cache hit", async () => {
    // Cache hit: the slim payload comes back directly. The foundation
    // payload is NOT loaded — this is the whole point of the slim cache.
    dbMocks.getComputedArtifact.mockResolvedValue({
      payload: JSON.stringify(EMPTY_SLIM_DASHBOARD_SUMMARY),
    });

    const { result, fromCache } = await getOrBuildSlimDashboardSummary(SCOPE);

    expect(fromCache).toBe(true);
    expect(result).toEqual(EMPTY_SLIM_DASHBOARD_SUMMARY);
    expect(runnerMocks.getOrBuildFoundation).not.toHaveBeenCalled();
    expect(foundationMocks.streamRowsByPage).not.toHaveBeenCalled();
  });

  it("exports a stable runner version marker", () => {
    expect(SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION).toBe(
      "slim-dashboard-summary-v1"
    );
  });
});

// ---------------------------------------------------------------------------
// Static regression rail: ensure the slim aggregator never imports
// the heavy upstream aggregators. Dropping these imports is a load-
// bearing property of the slim path. If a future PR re-introduces
// the dependency, this test catches it before merge.
// ---------------------------------------------------------------------------

describe("buildSlimDashboardSummary source structure", () => {
  // Strip line comments + block comments so docstrings can mention
  // helpers by name without tripping the import regex.
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
    expect(source).not.toMatch(
      /from\s+["'][^"']*buildOfflineMonitoringAggregates/
    );
    expect(source).not.toMatch(/getOrBuildOverviewSummary\s*\(/);
    expect(source).not.toMatch(/getOrBuildOfflineMonitoringAggregates\s*\(/);
  });

  it("uses streamRowsByPage and not the full-load helpers", () => {
    const source = readSourceCodeOnly();
    expect(source).toMatch(/streamRowsByPage\s*</);
    expect(source).not.toMatch(/loadDatasetRows\s*\(/);
    expect(source).not.toMatch(/loadAllRowsByPage\s*\(/);
  });
});

/** Type-only assertion the slim summary shape stays minimal. */
type _AssertSlimShape = (s: SlimDashboardSummary) => unknown;
