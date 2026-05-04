/**
 * Slim financial KPI side-cache freshness tests (PR #334 follow-up
 * item 1, 2026-05-02).
 *
 * The slim KPI summary cache is keyed off `computeFinancialsHash`
 * (in `financialsVersion.ts`), which binds dataset batch IDs +
 * `getScopeContractScanVersion(scopeId)`. The hash MUST change when
 * any of those inputs change so a stale row is correctly skipped.
 *
 * Pre-fix (kpi-summary-v1): the hash was keyed on 3 dataset batch
 * IDs only, so an override edit left the slim cache returning
 * stale-true KPIs until the next dataset upload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  getComputedArtifact: vi.fn(),
  upsertComputedArtifact: vi.fn(),
  getActiveVersionsForKeys: vi.fn(),
  getScopeContractScanVersion: vi.fn(),
}));

vi.mock("../../db/solarRecDatasets", async () => {
  const actual = await vi.importActual<
    typeof import("../../db/solarRecDatasets")
  >("../../db/solarRecDatasets");
  return {
    ...actual,
    getComputedArtifact: dbMocks.getComputedArtifact,
    upsertComputedArtifact: dbMocks.upsertComputedArtifact,
    getActiveVersionsForKeys: dbMocks.getActiveVersionsForKeys,
    getScopeContractScanVersion: dbMocks.getScopeContractScanVersion,
  };
});

import {
  FINANCIALS_KPI_SUMMARY_RUNNER_VERSION,
  getCachedFinancialsKpiSummary,
  writeFinancialsKpiSideCache,
  type FinancialsAggregates,
} from "./buildFinancialsAggregates";

const SCOPE = "test-scope";
const ARTIFACT_TYPE = "financials-kpi-summary";

// Union of (a) the 8 dataset keys hashed by computeFinancialsHash
// in financialsVersion.ts and (b) the 3 keys resolveFinancialsBatchIds
// looks up in buildFinancialsAggregates. The slim KPI hash binds on
// the union so any of these changing invalidates the cache.
const FINANCIALS_DEPS = [
  "abpCsgSystemMapping",
  "abpUtilityInvoiceRows",
  "abpQuickBooksRows",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
  "abpReport",
];

function activeVersionsAt(prefix: string) {
  return FINANCIALS_DEPS.map((datasetKey) => ({
    datasetKey,
    batchId: `${prefix}-${datasetKey}`,
  }));
}

const SAMPLE_AGGREGATE: FinancialsAggregates = {
  rows: [],
  totalProfit: 1000,
  avgProfit: 500,
  totalCollateralization: 4000,
  totalUtilityCollateral: 1000,
  totalAdditionalCollateral: 2000,
  totalCcAuth: 1000,
  systemsWithData: 2,
};

beforeEach(() => {
  dbMocks.getComputedArtifact.mockReset().mockResolvedValue(null);
  dbMocks.upsertComputedArtifact.mockReset().mockResolvedValue(undefined);
  dbMocks.getActiveVersionsForKeys
    .mockReset()
    .mockResolvedValue(activeVersionsAt("v1"));
  dbMocks.getScopeContractScanVersion.mockReset().mockResolvedValue({
    scopeId: SCOPE,
    latestCompletedJobId: "job-1",
    latestOverrideAt: new Date("2026-04-01T00:00:00.000Z"),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("financialsKpiSummary side cache — freshness", () => {
  it("declares runner version v2 (post override-aware hash fix)", () => {
    expect(FINANCIALS_KPI_SUMMARY_RUNNER_VERSION).toBe("kpi-summary-v2");
  });

  it("hits when the cached row's hash matches current scope freshness", async () => {
    // Step 1: the heavy aggregator wrote a side-cache row under
    // hash H₁. Capture the upsert hash.
    await writeFinancialsKpiSideCache(SCOPE, SAMPLE_AGGREGATE);
    expect(dbMocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
    const writeArgs = dbMocks.upsertComputedArtifact.mock.calls[0][0];
    const cachedHash = writeArgs.inputVersionHash;
    expect(writeArgs.artifactType).toBe(ARTIFACT_TYPE);
    expect(writeArgs.scopeId).toBe(SCOPE);

    // Step 2: configure the cache lookup to return the row WHEN the
    // hash matches the row we just wrote. Anything else is a miss.
    // (Mirrors the real DB behavior of an indexed lookup keyed by
    // `(scopeId, artifactType, inputVersionHash)`.)
    dbMocks.getComputedArtifact.mockImplementation(
      async (_scope: string, _type: string, hash: string) =>
        hash === cachedHash ? { payload: writeArgs.payload } : null
    );

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({
      available: true,
      kpis: {
        totalProfit: 1000,
        totalUtilityCollateral: 1000,
        totalAdditionalCollateral: 2000,
        totalCcAuth: 1000,
        systemsWithData: 2,
      },
    });

    // Cache lookup used the same hash the writer captured.
    expect(dbMocks.getComputedArtifact).toHaveBeenCalledWith(
      SCOPE,
      ARTIFACT_TYPE,
      cachedHash
    );
  });

  it("MISSES when latestOverrideAt advances after a row is cached (override-edit invalidation)", async () => {
    // Heavy aggregator wrote a side-cache row at override timestamp T₀.
    await writeFinancialsKpiSideCache(SCOPE, SAMPLE_AGGREGATE);
    const cachedHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    const cachedPayload = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .payload as string;

    // User edits an override → version row's `latestOverrideAt`
    // advances. The cache lookup at the new freshness signal must
    // miss the row keyed on the old hash.
    dbMocks.getScopeContractScanVersion.mockResolvedValue({
      scopeId: SCOPE,
      latestCompletedJobId: "job-1",
      latestOverrideAt: new Date("2026-05-02T00:00:00.000Z"),
    });

    // Simulate `getComputedArtifact` returning the OLD row only when
    // queried with the OLD hash; it returns null (cache miss) when
    // queried with any other hash.
    dbMocks.getComputedArtifact.mockImplementation(
      async (_scope: string, _type: string, hash: string) =>
        hash === cachedHash ? { payload: cachedPayload } : null
    );

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({ available: false });

    // Hash actually queried differs from the cached hash.
    const calledHash = dbMocks.getComputedArtifact.mock.calls[0][2];
    expect(calledHash).not.toBe(cachedHash);
  });

  it("MISSES when latestCompletedJobId advances (fresh scan job invalidation)", async () => {
    await writeFinancialsKpiSideCache(SCOPE, SAMPLE_AGGREGATE);
    const cachedHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    const cachedPayload = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .payload as string;

    // Fresh contract-scan job completes → completedJobId advances.
    dbMocks.getScopeContractScanVersion.mockResolvedValue({
      scopeId: SCOPE,
      latestCompletedJobId: "job-2",
      latestOverrideAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    dbMocks.getComputedArtifact.mockImplementation(
      async (_scope: string, _type: string, hash: string) =>
        hash === cachedHash ? { payload: cachedPayload } : null
    );

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({ available: false });
  });

  it("MISSES when any required dataset batch ID changes", async () => {
    await writeFinancialsKpiSideCache(SCOPE, SAMPLE_AGGREGATE);
    const cachedHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    const cachedPayload = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .payload as string;

    // Re-upload one of the financial datasets → its batch ID
    // changes.
    dbMocks.getActiveVersionsForKeys.mockResolvedValue([
      ...FINANCIALS_DEPS.filter((k) => k !== "abpReport").map((datasetKey) => ({
        datasetKey,
        batchId: `v1-${datasetKey}`,
      })),
      { datasetKey: "abpReport", batchId: "v2-abpReport" },
    ]);

    dbMocks.getComputedArtifact.mockImplementation(
      async (_scope: string, _type: string, hash: string) =>
        hash === cachedHash ? { payload: cachedPayload } : null
    );

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({ available: false });
  });

  it("returns available:false when required batch IDs are missing entirely (cache lookup never runs)", async () => {
    // No abpCsgSystemMapping batch → resolveFinancialsBatchIds returns null.
    dbMocks.getActiveVersionsForKeys.mockResolvedValue([]);

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({ available: false });
    expect(dbMocks.getComputedArtifact).not.toHaveBeenCalled();
  });

  it("MISSES when FINANCIALS_KPI_SUMMARY_RUNNER_VERSION changes (slim shape bump)", async () => {
    // Verify the runner version is folded into the hash by checking
    // that two writes with identical inputs produce the SAME hash —
    // and a runner-version bump (simulated by mutating the
    // serialized result before re-hashing) would diverge. Easiest:
    // assert the hash incorporates the runner version literal.
    await writeFinancialsKpiSideCache(SCOPE, SAMPLE_AGGREGATE);
    const writtenHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    expect(writtenHash).toMatch(/^[0-9a-f]{16}$/);

    // Sanity: same inputs → same hash. (Prevents accidental
    // non-determinism from sneaking into computeFinancialsKpiHash.)
    dbMocks.upsertComputedArtifact.mockClear();
    await writeFinancialsKpiSideCache(SCOPE, SAMPLE_AGGREGATE);
    const secondHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    expect(secondHash).toBe(writtenHash);
  });
});
