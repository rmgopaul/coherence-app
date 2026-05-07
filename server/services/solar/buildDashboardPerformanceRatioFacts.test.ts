/**
 * Tests for the dashboard performance-ratio fact-table builder
 * (Phase 2 PR-G-2).
 *
 * Two layers tested:
 *   1. Pure transformation `buildPerformanceRatioFactRows` —
 *      `PerformanceRatioRow[]` → fact rows. Unit tests, no mocks
 *      needed.
 *   2. Runner step + registration — uses `vi.hoisted` mocks for
 *      the DB upsert/delete helpers, the existing
 *      `getOrBuildPerformanceRatio` aggregator, and
 *      `upsertComputedArtifact` (slim summary side cache).
 *
 * Mirrors the test infra from
 * `buildDashboardChangeOwnershipFacts.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  upsertPerformanceRatioFacts: vi.fn(),
  deleteOrphanedPerformanceRatioFacts: vi.fn(),
  getOrBuildPerformanceRatio: vi.fn(),
  upsertComputedArtifact: vi.fn(),
}));

vi.mock("../../db/dashboardPerformanceRatioFacts", () => ({
  upsertPerformanceRatioFacts: mocks.upsertPerformanceRatioFacts,
  deleteOrphanedPerformanceRatioFacts:
    mocks.deleteOrphanedPerformanceRatioFacts,
  // Other exports unused by the builder; provide stubs.
  getPerformanceRatioFactsPage: vi.fn(),
  getPerformanceRatioFactsByKeys: vi.fn(),
  getPerformanceRatioFactsCount: vi.fn(),
}));

vi.mock("./buildPerformanceRatioAggregates", async () => {
  const actual = await vi.importActual<
    typeof import("./buildPerformanceRatioAggregates")
  >("./buildPerformanceRatioAggregates");
  return {
    ...actual,
    getOrBuildPerformanceRatio: mocks.getOrBuildPerformanceRatio,
  };
});

vi.mock("../../db/solarRecDatasets", async () => {
  const actual = await vi.importActual<
    typeof import("../../db/solarRecDatasets")
  >("../../db/solarRecDatasets");
  return {
    ...actual,
    upsertComputedArtifact: mocks.upsertComputedArtifact,
  };
});

import {
  __resetPerformanceRatioBuildStepRegistrationForTests,
  buildPerformanceRatioFactRows,
  buildPerformanceRatioSummaryPayload,
  PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE,
  PERFORMANCE_RATIO_SUMMARY_VERSION_KEY,
  performanceRatioBuildStep,
  registerPerformanceRatioBuildStep,
} from "./buildDashboardPerformanceRatioFacts";
import {
  getDashboardBuildSteps,
  setDashboardBuildSteps,
} from "./dashboardBuildJobRunner";
import type { PerformanceRatioRow } from "@shared/solarRecPerformanceRatio";

beforeEach(() => {
  for (const key of Object.keys(mocks) as (keyof typeof mocks)[]) {
    mocks[key].mockReset();
  }
  mocks.upsertPerformanceRatioFacts.mockResolvedValue(undefined);
  mocks.deleteOrphanedPerformanceRatioFacts.mockResolvedValue(0);
  mocks.upsertComputedArtifact.mockResolvedValue(undefined);
  setDashboardBuildSteps([]);
  __resetPerformanceRatioBuildStepRegistrationForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  setDashboardBuildSteps([]);
  __resetPerformanceRatioBuildStepRegistrationForTests();
});

// ────────────────────────────────────────────────────────────────────
// Pure transformation tests
// ────────────────────────────────────────────────────────────────────

function makeRow(
  overrides: Partial<PerformanceRatioRow> = {}
): PerformanceRatioRow {
  return {
    key: "converted-1-sys-1",
    convertedReadKey: "converted-1",
    matchType: "Monitoring + System ID",
    monitoring: "Enphase",
    monitoringSystemId: "ms-1",
    monitoringSystemName: "Acme PV",
    readDate: new Date("2026-04-01"),
    readDateRaw: "2026-04-01",
    lifetimeReadWh: 12_345_678,
    trackingSystemRefId: "tr-1",
    systemId: "sys-1",
    stateApplicationRefId: "abp-1",
    systemName: "Acme Solar",
    installerName: "Acme Solar",
    monitoringPlatform: "Enphase",
    portalAcSizeKw: 7.5,
    abpAcSizeKw: 7.6,
    part2VerificationDate: new Date("2024-06-15"),
    baselineReadWh: 1_000_000,
    baselineDate: new Date("2024-06-15"),
    baselineSource: "Generator Details",
    productionDeltaWh: 11_345_678,
    expectedProductionWh: 10_000_000,
    performanceRatioPercent: 113.4567,
    contractValue: 25_000,
    ...overrides,
  };
}

describe("buildPerformanceRatioFactRows (pure transformation)", () => {
  it("returns one fact row per PerformanceRatioRow", () => {
    const rows = buildPerformanceRatioFactRows({
      scopeId: "scope-1",
      buildId: "bld-1",
      rows: [
        makeRow({ key: "converted-1-sys-a" }),
        makeRow({ key: "converted-2-sys-b" }),
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.key).sort()).toEqual([
      "converted-1-sys-a",
      "converted-2-sys-b",
    ]);
  });

  it("stamps every row with the supplied scopeId + buildId", () => {
    const rows = buildPerformanceRatioFactRows({
      scopeId: "scope-X",
      buildId: "bld-Y",
      rows: [makeRow()],
    });
    expect(rows[0].scopeId).toBe("scope-X");
    expect(rows[0].buildId).toBe("bld-Y");
  });

  it("uses PerformanceRatioRow.key as the fact-row key (PK)", () => {
    const rows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ key: "custom-key-456" })],
    });
    expect(rows[0].key).toBe("custom-key-456");
  });

  it("maps display fields 1:1", () => {
    const source = makeRow({
      matchType: "Monitoring + System ID + System Name",
      monitoring: "SolarEdge",
      monitoringSystemId: "se-99",
      monitoringSystemName: "Customer Home PV",
      readDateRaw: "2026-05-01",
      trackingSystemRefId: "tr-99",
      systemId: "sys-99",
      stateApplicationRefId: "abp-99",
      systemName: "Customer LLC",
      installerName: "Sunshine Installers",
      monitoringPlatform: "SolarEdge",
      baselineSource: "Generation Entry",
    });
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [source],
    });
    expect(row.matchType).toBe("Monitoring + System ID + System Name");
    expect(row.monitoring).toBe("SolarEdge");
    expect(row.monitoringSystemId).toBe("se-99");
    expect(row.monitoringSystemName).toBe("Customer Home PV");
    expect(row.readDateRaw).toBe("2026-05-01");
    expect(row.trackingSystemRefId).toBe("tr-99");
    expect(row.systemId).toBe("sys-99");
    expect(row.stateApplicationRefId).toBe("abp-99");
    expect(row.systemName).toBe("Customer LLC");
    expect(row.installerName).toBe("Sunshine Installers");
    expect(row.monitoringPlatform).toBe("SolarEdge");
    expect(row.baselineSource).toBe("Generation Entry");
  });

  it("converts numeric decimals to string form (Drizzle decimal contract)", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          lifetimeReadWh: 12_345_678,
          baselineReadWh: 1_000_000,
          productionDeltaWh: 11_345_678,
          expectedProductionWh: 10_000_000,
          performanceRatioPercent: 113.4567,
          portalAcSizeKw: 7.5,
          abpAcSizeKw: 7.6,
          contractValue: 25_000,
        }),
      ],
    });
    expect(row.lifetimeReadWh).toBe("12345678");
    expect(row.baselineReadWh).toBe("1000000");
    expect(row.productionDeltaWh).toBe("11345678");
    expect(row.expectedProductionWh).toBe("10000000");
    expect(row.performanceRatioPercent).toBe("113.4567");
    expect(row.portalAcSizeKw).toBe("7.5");
    expect(row.abpAcSizeKw).toBe("7.6");
    expect(row.contractValue).toBe("25000");
  });

  it("nullifies non-finite numeric values (NaN / Infinity) for nullable columns", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          baselineReadWh: NaN as number,
          productionDeltaWh: Infinity as number,
          expectedProductionWh: -Infinity as number,
          performanceRatioPercent: NaN as number,
          portalAcSizeKw: NaN as number,
          abpAcSizeKw: NaN as number,
        }),
      ],
    });
    expect(row.baselineReadWh).toBeNull();
    expect(row.productionDeltaWh).toBeNull();
    expect(row.expectedProductionWh).toBeNull();
    expect(row.performanceRatioPercent).toBeNull();
    expect(row.portalAcSizeKw).toBeNull();
    expect(row.abpAcSizeKw).toBeNull();
  });

  it("DROPS the row when a required-non-null field (lifetimeReadWh / contractValue) is non-finite", () => {
    // The schema declares lifetimeReadWh + contractValue NOT NULL.
    // Persisting a row with null in those columns would corrupt
    // the fact table; the builder filters such rows out so the
    // upsert succeeds with the surviving rows.
    const rows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({ key: "good-row", lifetimeReadWh: 100 }),
        makeRow({ key: "bad-lifetime", lifetimeReadWh: NaN as number }),
        makeRow({ key: "bad-contract", contractValue: Infinity as number }),
      ],
    });
    expect(rows.map(r => r.key)).toEqual(["good-row"]);
  });

  it("passes through null nullable numeric values as null", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          baselineReadWh: null,
          productionDeltaWh: null,
          expectedProductionWh: null,
          performanceRatioPercent: null,
          portalAcSizeKw: null,
          abpAcSizeKw: null,
        }),
      ],
    });
    expect(row.baselineReadWh).toBeNull();
    expect(row.productionDeltaWh).toBeNull();
    expect(row.expectedProductionWh).toBeNull();
    expect(row.performanceRatioPercent).toBeNull();
    expect(row.portalAcSizeKw).toBeNull();
    expect(row.abpAcSizeKw).toBeNull();
  });

  it("passes through null Dates as null", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          readDate: null,
          baselineDate: null,
          part2VerificationDate: null,
        }),
      ],
    });
    expect(row.readDate).toBeNull();
    expect(row.baselineDate).toBeNull();
    expect(row.part2VerificationDate).toBeNull();
  });

  it("returns [] when the input rows array is empty", () => {
    const rows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [],
    });
    expect(rows).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Slim summary payload builder tests
// ────────────────────────────────────────────────────────────────────

describe("buildPerformanceRatioSummaryPayload", () => {
  const builtAt = new Date("2026-05-07T17:00:00Z");

  it("forwards aggregate counters verbatim", () => {
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "bld-1",
      builtAt,
      aggregate: {
        convertedReadCount: 991_000,
        matchedConvertedReads: 12_500,
        unmatchedConvertedReads: 800_000,
        invalidConvertedReads: 178_500,
      },
      factRows: [],
    });
    expect(payload.convertedReadCount).toBe(991_000);
    expect(payload.matchedConvertedReads).toBe(12_500);
    expect(payload.unmatchedConvertedReads).toBe(800_000);
    expect(payload.invalidConvertedReads).toBe(178_500);
  });

  it("derives matchedSystemCount from the unique trackingSystemRefId set in fact rows", () => {
    const factRows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          key: "converted-1-sys-a",
          trackingSystemRefId: "tr-a",
        }),
        makeRow({
          key: "converted-1-sys-b",
          trackingSystemRefId: "tr-b",
        }),
        makeRow({
          key: "converted-2-sys-a",
          trackingSystemRefId: "tr-a",
        }),
      ],
    });
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "b",
      builtAt,
      aggregate: {
        convertedReadCount: 3,
        matchedConvertedReads: 2,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      },
      factRows,
    });
    expect(payload.matchedSystemCount).toBe(2);
  });

  it("matchedSystemCount=0 when no fact rows", () => {
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "b",
      builtAt,
      aggregate: {
        convertedReadCount: 0,
        matchedConvertedReads: 0,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      },
      factRows: [],
    });
    expect(payload.matchedSystemCount).toBe(0);
  });

  it("stamps buildId, aggregatorVersion, and builtAt as ISO string", () => {
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "bld-Z",
      builtAt: new Date("2026-05-07T17:00:00Z"),
      aggregate: {
        convertedReadCount: 0,
        matchedConvertedReads: 0,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      },
      factRows: [],
    });
    expect(payload.buildId).toBe("bld-Z");
    expect(payload.aggregatorVersion).toMatch(/performance-ratio/);
    expect(payload.builtAt).toBe("2026-05-07T17:00:00.000Z");
  });
});

// ────────────────────────────────────────────────────────────────────
// Runner-step orchestration tests
// ────────────────────────────────────────────────────────────────────

function makeAggregate(rowsOverride?: PerformanceRatioRow[]) {
  return {
    rows: rowsOverride ?? [
      makeRow({ key: "converted-1-sys-1" }),
      makeRow({
        key: "converted-2-sys-2",
        trackingSystemRefId: "tr-2",
      }),
    ],
    convertedReadCount: 100,
    matchedConvertedReads: 2,
    unmatchedConvertedReads: 50,
    invalidConvertedReads: 48,
    fromCache: false,
  };
}

describe("performanceRatioBuildStep — orchestration", () => {
  it("aggregator → upsert → orphan-sweep → summary order with correct args", async () => {
    mocks.getOrBuildPerformanceRatio.mockResolvedValue(makeAggregate());
    mocks.deleteOrphanedPerformanceRatioFacts.mockResolvedValue(7);

    await performanceRatioBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    expect(mocks.getOrBuildPerformanceRatio).toHaveBeenCalledWith("scope-A");
    expect(mocks.upsertPerformanceRatioFacts).toHaveBeenCalledTimes(1);
    const [upsertedRows] = mocks.upsertPerformanceRatioFacts.mock.calls[0];
    expect(upsertedRows).toHaveLength(2);
    expect(upsertedRows[0].buildId).toBe("bld-1");
    expect(upsertedRows[0].scopeId).toBe("scope-A");
    expect(mocks.deleteOrphanedPerformanceRatioFacts).toHaveBeenCalledWith(
      "scope-A",
      "bld-1"
    );

    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
    const [summaryArgs] = mocks.upsertComputedArtifact.mock.calls[0];
    expect(summaryArgs.scopeId).toBe("scope-A");
    expect(summaryArgs.artifactType).toBe(
      PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE
    );
    expect(summaryArgs.inputVersionHash).toBe(
      PERFORMANCE_RATIO_SUMMARY_VERSION_KEY
    );
    const summary = JSON.parse(summaryArgs.payload);
    expect(summary.convertedReadCount).toBe(100);
    expect(summary.matchedConvertedReads).toBe(2);
    expect(summary.matchedSystemCount).toBe(2);
    expect(summary.buildId).toBe("bld-1");

    // Order check: upsert BEFORE orphan-sweep BEFORE summary write.
    const upsertOrder =
      mocks.upsertPerformanceRatioFacts.mock.invocationCallOrder[0];
    const sweepOrder =
      mocks.deleteOrphanedPerformanceRatioFacts.mock.invocationCallOrder[0];
    const summaryOrder =
      mocks.upsertComputedArtifact.mock.invocationCallOrder[0];
    expect(upsertOrder).toBeLessThan(sweepOrder);
    expect(sweepOrder).toBeLessThan(summaryOrder);
  });

  it("writes a zero-counter summary on cold-cache (snapshot empty) builds", async () => {
    // Cold-cache scenario: the underlying snapshot is still building
    // so the aggregator returns 0 matched rows + 0 counters. The
    // step still writes the (empty) summary so the client renders
    // 0 rather than `available: false`. The next build replaces it.
    mocks.getOrBuildPerformanceRatio.mockResolvedValue({
      rows: [],
      convertedReadCount: 0,
      matchedConvertedReads: 0,
      unmatchedConvertedReads: 0,
      invalidConvertedReads: 0,
      fromCache: false,
    });

    await performanceRatioBuildStep.run({
      scopeId: "scope-B",
      buildId: "bld-cold",
      signal: new AbortController().signal,
    });

    expect(mocks.upsertPerformanceRatioFacts).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPerformanceRatioFacts.mock.calls[0][0]).toEqual([]);
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(1);
    const summary = JSON.parse(
      mocks.upsertComputedArtifact.mock.calls[0][0].payload
    );
    expect(summary.convertedReadCount).toBe(0);
    expect(summary.matchedConvertedReads).toBe(0);
    expect(summary.matchedSystemCount).toBe(0);
  });

  it("propagates upsert failures (runner converts to errorMessage)", async () => {
    mocks.getOrBuildPerformanceRatio.mockResolvedValue(makeAggregate());
    mocks.upsertPerformanceRatioFacts.mockRejectedValue(
      new Error("upsert blew up")
    );

    await expect(
      performanceRatioBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/upsert blew up/);
    expect(
      mocks.deleteOrphanedPerformanceRatioFacts
    ).not.toHaveBeenCalled();
    expect(mocks.upsertComputedArtifact).not.toHaveBeenCalled();
  });

  it("propagates orphan-sweep failures (does NOT swallow into summary write)", async () => {
    mocks.getOrBuildPerformanceRatio.mockResolvedValue(makeAggregate());
    mocks.deleteOrphanedPerformanceRatioFacts.mockRejectedValue(
      new Error("sweep failed")
    );

    await expect(
      performanceRatioBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/sweep failed/);
    expect(mocks.upsertComputedArtifact).not.toHaveBeenCalled();
  });

  it("aborts before aggregate fetch when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      performanceRatioBuildStep.run({
        scopeId: "s",
        buildId: "b",
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(mocks.getOrBuildPerformanceRatio).not.toHaveBeenCalled();
    expect(mocks.upsertPerformanceRatioFacts).not.toHaveBeenCalled();
    expect(mocks.upsertComputedArtifact).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// Step registration
// ────────────────────────────────────────────────────────────────────

describe("registerPerformanceRatioBuildStep", () => {
  it("appends the step to the runner's empty steps array on first call", async () => {
    expect(getDashboardBuildSteps()).toEqual([]);
    await registerPerformanceRatioBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(1);
    expect(steps[0].name).toBe("performanceRatioFacts");
    expect(steps[0]).toBe(performanceRatioBuildStep);
  });

  it("is idempotent: subsequent calls do NOT duplicate the step", async () => {
    await registerPerformanceRatioBuildStep();
    await registerPerformanceRatioBuildStep();
    await registerPerformanceRatioBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });

  it("preserves prior steps already in the array (e.g. systemFacts)", async () => {
    const priorStep = {
      name: "systemFacts",
      run: vi.fn().mockResolvedValue(undefined),
    };
    setDashboardBuildSteps([priorStep]);
    await registerPerformanceRatioBuildStep();
    const steps = getDashboardBuildSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0]).toBe(priorStep);
    expect(steps[1].name).toBe("performanceRatioFacts");
  });

  it("does NOT re-append when a step with the same name is already in the array", async () => {
    setDashboardBuildSteps([
      {
        name: "performanceRatioFacts",
        run: async () => {},
      },
    ]);
    await registerPerformanceRatioBuildStep();
    expect(getDashboardBuildSteps()).toHaveLength(1);
  });
});
