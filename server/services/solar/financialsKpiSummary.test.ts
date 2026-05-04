/**
 * Slim financial KPI side-cache freshness tests.
 *
 * The slim KPI summary cache is keyed off `computeFinancialsHash`
 * (in `financialsVersion.ts`), which binds dataset batch IDs +
 * `getScopeContractScanVersion(scopeId)`. The hash MUST change when
 * any of those inputs change so a stale row is correctly skipped.
 *
 * PR #337 follow-up item 2 (2026-05-04) — the writer now takes a
 * `capturedFinancialsHash` argument (sampled BEFORE the heavy
 * build) and refuses to upsert if the hash drifted during the
 * build. That race-safety guard is exercised below.
 *
 * PR #337 follow-up item 3 — `abpReport` is now part of
 * `FINANCIALS_CSV_DEPS`, so an `abpReport` re-upload alone bumps
 * the canonical hash and invalidates the slim cache.
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
import { computeFinancialsHash } from "./financialsVersion";

const SCOPE = "test-scope";
const ARTIFACT_TYPE = "financials-kpi-summary";

// Mirrors the canonical FINANCIALS_CSV_DEPS in financialsVersion.ts
// (PR #337 follow-up item 3 included `abpReport`). Test fixtures
// must include the same set so resolveFinancialsBatchIds finds the
// 3 it cares about AND computeFinancialsHash sees a complete map.
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

/**
 * Helper: write a side-cache row using the CURRENT freshness hash
 * as the captured hash. Mirrors the heavy aggregator's typical
 * "sample, build (instantly in tests), upsert" flow when no
 * concurrent edit happens.
 */
async function writeAtCurrentFreshness(): Promise<{
  cachedHash: string;
  cachedPayload: string;
}> {
  const captured = await computeFinancialsHash(SCOPE);
  await writeFinancialsKpiSideCache(SCOPE, captured, SAMPLE_AGGREGATE);
  expect(dbMocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
  const writeArgs = dbMocks.upsertComputedArtifact.mock.calls[0][0];
  return {
    cachedHash: writeArgs.inputVersionHash as string,
    cachedPayload: writeArgs.payload as string,
  };
}

describe("financialsKpiSummary side cache — freshness", () => {
  it("declares runner version v3 (post abpReport canonical hash + race-safe writer)", () => {
    expect(FINANCIALS_KPI_SUMMARY_RUNNER_VERSION).toBe("kpi-summary-v3");
  });

  it("hits when the cached row's hash matches current scope freshness", async () => {
    const { cachedHash, cachedPayload } = await writeAtCurrentFreshness();
    dbMocks.getComputedArtifact.mockImplementation(
      async (_scope: string, _type: string, hash: string) =>
        hash === cachedHash ? { payload: cachedPayload } : null
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
    expect(dbMocks.getComputedArtifact).toHaveBeenCalledWith(
      SCOPE,
      ARTIFACT_TYPE,
      cachedHash
    );
  });

  it("MISSES when latestOverrideAt advances after a row is cached (override-edit invalidation)", async () => {
    const { cachedHash, cachedPayload } = await writeAtCurrentFreshness();

    dbMocks.getScopeContractScanVersion.mockResolvedValue({
      scopeId: SCOPE,
      latestCompletedJobId: "job-1",
      latestOverrideAt: new Date("2026-05-02T00:00:00.000Z"),
    });

    dbMocks.getComputedArtifact.mockImplementation(
      async (_scope: string, _type: string, hash: string) =>
        hash === cachedHash ? { payload: cachedPayload } : null
    );

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({ available: false });

    const calledHash = dbMocks.getComputedArtifact.mock.calls[0][2];
    expect(calledHash).not.toBe(cachedHash);
  });

  it("MISSES when latestCompletedJobId advances (fresh scan job invalidation)", async () => {
    const { cachedHash, cachedPayload } = await writeAtCurrentFreshness();

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

  it("MISSES when any required dataset batch ID changes — including abpReport alone", async () => {
    const { cachedHash, cachedPayload } = await writeAtCurrentFreshness();

    // Re-upload only `abpReport` → its batch ID advances. Pre-PR
    // #337 follow-up item 3, this would NOT have invalidated the
    // slim cache because computeFinancialsHash didn't include
    // abpReport. Now it does.
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
    dbMocks.getActiveVersionsForKeys.mockResolvedValue([]);

    const result = await getCachedFinancialsKpiSummary(SCOPE);
    expect(result).toEqual({ available: false });
    expect(dbMocks.getComputedArtifact).not.toHaveBeenCalled();
  });

  it("computeFinancialsKpiHash is deterministic (same inputs → same hash)", async () => {
    const captured = await computeFinancialsHash(SCOPE);
    await writeFinancialsKpiSideCache(SCOPE, captured, SAMPLE_AGGREGATE);
    const writtenHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    expect(writtenHash).toMatch(/^[0-9a-f]{16}$/);

    dbMocks.upsertComputedArtifact.mockClear();
    await writeFinancialsKpiSideCache(SCOPE, captured, SAMPLE_AGGREGATE);
    const secondHash = dbMocks.upsertComputedArtifact.mock.calls[0][0]
      .inputVersionHash as string;
    expect(secondHash).toBe(writtenHash);
  });
});

describe("financialsKpiSummary side cache — race safety (PR #337 item 2)", () => {
  it("SKIPS the upsert when the canonical hash advanced between capture and write (override-mid-build)", async () => {
    // Capture the hash that the heavy aggregator would have sampled
    // BEFORE its build started.
    const capturedHash = await computeFinancialsHash(SCOPE);

    // Now simulate a concurrent override edit landing during the
    // build: latestOverrideAt advances. The current freshness hash
    // diverges from the captured one.
    dbMocks.getScopeContractScanVersion.mockResolvedValue({
      scopeId: SCOPE,
      latestCompletedJobId: "job-1",
      latestOverrideAt: new Date("2026-05-04T12:00:00.000Z"),
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await writeFinancialsKpiSideCache(SCOPE, capturedHash, SAMPLE_AGGREGATE);

    expect(dbMocks.upsertComputedArtifact).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/freshness changed mid-build/);
  });

  it("SKIPS the upsert when a dataset batch advanced mid-build", async () => {
    const capturedHash = await computeFinancialsHash(SCOPE);

    // Concurrent dataset re-upload bumps abpReport's batch ID.
    dbMocks.getActiveVersionsForKeys.mockResolvedValue([
      ...FINANCIALS_DEPS.filter((k) => k !== "abpReport").map((datasetKey) => ({
        datasetKey,
        batchId: `v1-${datasetKey}`,
      })),
      { datasetKey: "abpReport", batchId: "v2-abpReport" },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await writeFinancialsKpiSideCache(SCOPE, capturedHash, SAMPLE_AGGREGATE);

    expect(dbMocks.upsertComputedArtifact).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("WRITES when the canonical hash is unchanged between capture and write", async () => {
    const capturedHash = await computeFinancialsHash(SCOPE);
    await writeFinancialsKpiSideCache(SCOPE, capturedHash, SAMPLE_AGGREGATE);
    expect(dbMocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
  });
});
