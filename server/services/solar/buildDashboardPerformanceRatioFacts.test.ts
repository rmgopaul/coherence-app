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
  pruneSupersededPerformanceRatioFacts: vi.fn(),
  upsertComputedArtifact: vi.fn(),
  resolvePerformanceRatioBatchIds: vi.fn(),
  loadPerformanceRatioStaticInput: vi.fn(),
  forEachPerformanceRatioConvertedReadPage: vi.fn(),
}));

vi.mock("../../db/dashboardPerformanceRatioFacts", () => ({
  upsertPerformanceRatioFacts: mocks.upsertPerformanceRatioFacts,
  pruneSupersededPerformanceRatioFacts:
    mocks.pruneSupersededPerformanceRatioFacts,
  // Other exports unused by the builder; provide stubs.
  getPerformanceRatioFactsPage: vi.fn(),
  getPerformanceRatioFactsByKeys: vi.fn(),
  getPerformanceRatioFactsCount: vi.fn(),
  getPerformanceRatioFactsAggregates: vi.fn(),
  getPerformanceRatioMonitoringOptions: vi.fn(),
}));

vi.mock("./loadPerformanceRatioInput", async () => {
  const actual = await vi.importActual<
    typeof import("./loadPerformanceRatioInput")
  >("./loadPerformanceRatioInput");
  return {
    ...actual,
    resolvePerformanceRatioBatchIds: mocks.resolvePerformanceRatioBatchIds,
    loadPerformanceRatioStaticInput: mocks.loadPerformanceRatioStaticInput,
    forEachPerformanceRatioConvertedReadPage:
      mocks.forEachPerformanceRatioConvertedReadPage,
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
  createPerformanceRatioStreamingAccumulators,
  accumulatePerformanceRatioPage,
  PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE,
  PERFORMANCE_RATIO_SUMMARY_VERSION_KEY,
  PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE,
  PERFORMANCE_RATIO_BEST_PER_SYSTEM_ARTIFACT_TYPE,
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
  mocks.pruneSupersededPerformanceRatioFacts.mockResolvedValue(0);
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

describe("buildPerformanceRatioSummaryPayload (Option C)", () => {
  const builtAt = new Date("2026-05-07T17:00:00Z");

  function makeEmptyAccumulators() {
    return createPerformanceRatioStreamingAccumulators();
  }

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
      accumulators: makeEmptyAccumulators(),
    });
    expect(payload.convertedReadCount).toBe(991_000);
    expect(payload.matchedConvertedReads).toBe(12_500);
    expect(payload.unmatchedConvertedReads).toBe(800_000);
    expect(payload.invalidConvertedReads).toBe(178_500);
  });

  it("derives matchedSystemCount from the streaming accumulator's unique trackingSystemRefId set", () => {
    const accumulators = makeEmptyAccumulators();
    accumulatePerformanceRatioPage(accumulators, [
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
    ]);
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "b",
      builtAt,
      aggregate: {
        convertedReadCount: 3,
        matchedConvertedReads: 2,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      },
      accumulators,
    });
    expect(payload.matchedSystemCount).toBe(2);
    expect(payload.allocationCount).toBe(3);
  });

  it("matchedSystemCount=0 + monitoringOptions=[] when no rows", () => {
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "b",
      builtAt,
      aggregate: {
        convertedReadCount: 0,
        matchedConvertedReads: 0,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      },
      accumulators: makeEmptyAccumulators(),
    });
    expect(payload.matchedSystemCount).toBe(0);
    expect(payload.allocationCount).toBe(0);
    expect(payload.monitoringOptions).toEqual([]);
    expect(payload.portfolioRatioPercent).toBeNull();
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
      accumulators: makeEmptyAccumulators(),
    });
    expect(payload.buildId).toBe("bld-Z");
    expect(payload.aggregatorVersion).toMatch(/performance-ratio/);
    expect(payload.builtAt).toBe("2026-05-07T17:00:00.000Z");
  });

  it("populates the new server-aggregate fields + monitoringOptions from streaming", () => {
    const accumulators = makeEmptyAccumulators();
    accumulatePerformanceRatioPage(accumulators, [
      makeRow({
        key: "k1",
        trackingSystemRefId: "tr-1",
        monitoring: "Enphase",
        baselineReadWh: 1000,
        expectedProductionWh: 5000,
        productionDeltaWh: 4000,
        performanceRatioPercent: 80,
        contractValue: 100,
      }),
      makeRow({
        key: "k2",
        trackingSystemRefId: "tr-2",
        monitoring: "SolarEdge",
        baselineReadWh: null,
        expectedProductionWh: 0,
        productionDeltaWh: 0,
        performanceRatioPercent: null,
        contractValue: 200,
      }),
    ]);
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "b",
      builtAt,
      aggregate: {
        convertedReadCount: 2,
        matchedConvertedReads: 2,
        unmatchedConvertedReads: 0,
        invalidConvertedReads: 0,
      },
      accumulators,
    });
    expect(payload.allocationCount).toBe(2);
    expect(payload.withBaseline).toBe(1);
    // expected > 0 only on the first row.
    expect(payload.withExpected).toBe(1);
    expect(payload.withRatio).toBe(1);
    expect(payload.totalDeltaWh).toBe(4000);
    expect(payload.totalExpectedWh).toBe(5000);
    expect(payload.totalContractValue).toBe(300);
    // 4000 / 5000 × 100 = 80.0
    expect(payload.portfolioRatioPercent).toBe(80);
    expect(payload.monitoringOptions).toEqual(["Enphase", "SolarEdge"]);
  });
});

// ────────────────────────────────────────────────────────────────────
// Runner-step orchestration tests
// ────────────────────────────────────────────────────────────────────
//
// 2026-05-08 OOM hardening (streaming-write fix). The previous
// orchestration mocked `getOrBuildPerformanceRatio` and asserted
// a single upsert at the end. The streaming runner step now:
//   1. resolvePerformanceRatioBatchIds → returns batch IDs
//   2. loadPerformanceRatioStaticInput → returns static input
//   3. forEachPerformanceRatioConvertedReadPage → calls onPage(rows, idx)
//   4. accumulator.processRows + drainPendingRows per page
//   5. upsertPerformanceRatioFacts per page (NOT once at end)
//   6. deleteOrphanedPerformanceRatioFacts at end
//   7. upsertComputedArtifact (summary) at end
// The test fixtures supply a mock streaming source that drives the
// onPage callback with synthetic converted-read rows; the real
// `createPerformanceRatioAccumulator` runs unmocked so the
// matched-row emission paths get exercised.

function makeBatchIds() {
  return {
    convertedReadsBatchId: "cr-batch-1",
    annualProductionBatchId: "ap-batch-1",
    generationEntryBatchId: "ge-batch-1",
    accountSolarGenerationBatchId: "asg-batch-1",
    generatorDetailsBatchId: "gd-batch-1",
    abpReportBatchId: "abp-batch-1",
    solarApplicationsBatchId: "sa-batch-1",
  };
}

function makeStaticInput() {
  // One matchable system whose tokens line up with the synthetic
  // converted-read rows below. Empty maps are sufficient for the
  // streaming path to emit fact rows.
  return {
    systems: [
      {
        key: "sys-A",
        trackingSystemRefId: "tr-A",
        systemId: "SYS-A",
        stateApplicationRefId: "APP-A",
        systemName: "Acme Solar",
        installerName: "Acme Installer",
        monitoringPlatform: "Enphase",
        installedKwAc: 7.5,
        contractValue: 25000,
        monitoringTokens: ["enphase"],
        idTokens: ["sys-a"],
        nameTokens: ["acme solar"],
      },
    ],
    abpAcSizeKwByApplicationId: new Map(),
    abpPart2VerificationDateByApplicationId: new Map(),
    annualProductionByTrackingId: new Map(),
    generationBaselineByTrackingId: new Map(),
    generatorDateOnlineByTrackingId: new Map(),
  };
}

function makeConvertedReadRow(overrides: Partial<{
  monitoring: string;
  monitoring_system_id: string;
  monitoring_system_name: string;
  lifetime_meter_read_wh: string;
  read_date: string;
}> = {}) {
  return {
    monitoring: "Enphase",
    monitoring_system_id: "SYS-A",
    monitoring_system_name: "Acme Solar",
    lifetime_meter_read_wh: "12345678",
    read_date: "2026-04-01",
    ...overrides,
  };
}

describe("parsePerformanceRatioSummaryPayload (codex review fixup — strict field validation)", () => {
  /**
   * Pre-fix the summary read proc inlined a typed JSON.parse
   * cast that happily returned `available: true` even when the
   * payload was a pre-Option-C schema (missing aggregate fields).
   * The shared parser now validates every required field — a
   * payload missing one returns null, which the proc translates
   * to `available: false` so the client renders the empty-state
   * rather than NaN tile values.
   */
  // We re-import the helper here so we don't pollute the
  // mocked-module scope above.
  let parser:
    | ((p: string | null) => unknown)
    | null = null;
  beforeEach(async () => {
    const mod = await import("./buildDashboardPerformanceRatioFacts");
    parser = mod.parsePerformanceRatioSummaryPayload;
  });

  function makeValidPayload() {
    return {
      buildId: "bld-X",
      builtAt: "2026-05-09T12:00:00.000Z",
      aggregatorVersion: "v1",
      convertedReadCount: 1,
      matchedConvertedReads: 1,
      unmatchedConvertedReads: 0,
      invalidConvertedReads: 0,
      matchedSystemCount: 1,
      allocationCount: 1,
      withBaseline: 1,
      withExpected: 1,
      withRatio: 1,
      totalDeltaWh: 100,
      totalExpectedWh: 200,
      portfolioRatioPercent: 50,
      totalContractValue: 1000,
      monitoringOptions: ["Enphase"],
    };
  }

  it("accepts a fully-formed Option-C payload", () => {
    expect(parser!(JSON.stringify(makeValidPayload()))).not.toBeNull();
  });

  it("rejects null / empty / non-JSON inputs", () => {
    expect(parser!(null)).toBeNull();
    expect(parser!("")).toBeNull();
    expect(parser!("not-json")).toBeNull();
  });

  it("rejects a pre-Option-C payload missing allocationCount", () => {
    const stale = makeValidPayload() as Partial<
      ReturnType<typeof makeValidPayload>
    >;
    delete (stale as Record<string, unknown>).allocationCount;
    expect(parser!(JSON.stringify(stale))).toBeNull();
  });

  it("rejects a payload missing monitoringOptions", () => {
    const stale = makeValidPayload() as Partial<
      ReturnType<typeof makeValidPayload>
    >;
    delete (stale as Record<string, unknown>).monitoringOptions;
    expect(parser!(JSON.stringify(stale))).toBeNull();
  });

  it("accepts portfolioRatioPercent === null (legitimate when totalExpectedWh <= 0)", () => {
    const payload = makeValidPayload();
    (payload as Record<string, unknown>).portfolioRatioPercent = null;
    expect(parser!(JSON.stringify(payload))).not.toBeNull();
  });

  it("rejects payloads where buildId is empty string", () => {
    const payload = makeValidPayload();
    payload.buildId = "";
    expect(parser!(JSON.stringify(payload))).toBeNull();
  });
});

describe("performanceRatioBuildStep — orchestration (Option C visibility flip)", () => {
  /**
   * Helper to count `upsertComputedArtifact` calls by artifactType
   * since one build now writes 3 artifacts (summary + auto-compliant
   * + best-per-system).
   */
  function getArtifactCallByType(artifactType: string) {
    return mocks.upsertComputedArtifact.mock.calls.find(
      ([args]) => args.artifactType === artifactType
    );
  }

  it("static input → stream pages → upsert per page → side-cache writes → SUMMARY (visibility flip) → prune, in that order", async () => {
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.pruneSupersededPerformanceRatioFacts.mockResolvedValue(3);
    // Mock streaming source: 2 pages of 1 row each.
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async (_scopeId: string, _batchId: string, onPage: any) => {
        await onPage([makeConvertedReadRow()], 0);
        await onPage([makeConvertedReadRow()], 1);
        return 2;
      }
    );

    await performanceRatioBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    expect(mocks.resolvePerformanceRatioBatchIds).toHaveBeenCalledWith("scope-A");

    // Streaming-write contract: upsert called once PER PAGE.
    expect(mocks.upsertPerformanceRatioFacts).toHaveBeenCalledTimes(2);
    for (const [pageRows] of mocks.upsertPerformanceRatioFacts.mock.calls) {
      expect(pageRows.length).toBeGreaterThan(0);
      expect(pageRows[0].buildId).toBe("bld-1");
      expect(pageRows[0].scopeId).toBe("scope-A");
    }

    // Three artifact writes: summary + auto-compliant + best-per-system.
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(3);
    const summaryCall = getArtifactCallByType(
      PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE
    );
    expect(summaryCall).toBeDefined();
    const summary = JSON.parse(summaryCall![0].payload);
    expect(summary.buildId).toBe("bld-1");
    expect(summary.convertedReadCount).toBe(2);
    expect(summary.allocationCount).toBe(2);

    // Visibility flip ordering: prune is called AFTER summary
    // write. A failure between row writes and summary leaves the
    // OLD summary visible.
    const lastUpsertOrder =
      mocks.upsertPerformanceRatioFacts.mock.invocationCallOrder[1];
    const summaryOrder =
      mocks.upsertComputedArtifact.mock.invocationCallOrder.find(
        (_o, idx) =>
          mocks.upsertComputedArtifact.mock.calls[idx][0].artifactType ===
          PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE
      );
    const pruneOrder =
      mocks.pruneSupersededPerformanceRatioFacts.mock.invocationCallOrder[0];
    expect(summaryOrder).toBeDefined();
    expect(lastUpsertOrder).toBeLessThan(summaryOrder!);
    expect(summaryOrder!).toBeLessThan(pruneOrder);

    // Prune keeps ONLY the current build's rows.
    expect(mocks.pruneSupersededPerformanceRatioFacts).toHaveBeenCalledWith(
      "scope-A",
      ["bld-1"]
    );
  });

  it("memory-bounded: drains accumulator per page so no UPSERT carries the full row set", async () => {
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async (_s: string, _b: string, onPage: any) => {
        for (let i = 0; i < 3; i += 1) {
          await onPage([makeConvertedReadRow()], i);
        }
        return 3;
      }
    );

    await performanceRatioBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    expect(mocks.upsertPerformanceRatioFacts).toHaveBeenCalledTimes(3);
    for (const [pageRows] of mocks.upsertPerformanceRatioFacts.mock.calls) {
      expect(pageRows.length).toBe(1);
    }
  });

  it("skips the streaming phase when no convertedReads batch is active (zero-aggregate summary write)", async () => {
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue({
      ...makeBatchIds(),
      convertedReadsBatchId: null,
    });

    await performanceRatioBuildStep.run({
      scopeId: "scope-B",
      buildId: "bld-cold",
      signal: new AbortController().signal,
    });

    // No fact-row writes when there's no source dataset.
    expect(mocks.upsertPerformanceRatioFacts).not.toHaveBeenCalled();
    // Three artifact writes still: summary + auto-compliant + best-per-system.
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(3);
    const summaryCall = getArtifactCallByType(
      PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE
    );
    expect(summaryCall).toBeDefined();
    const summary = JSON.parse(summaryCall![0].payload);
    expect(summary.convertedReadCount).toBe(0);
    expect(summary.matchedConvertedReads).toBe(0);
    expect(summary.matchedSystemCount).toBe(0);
    expect(summary.allocationCount).toBe(0);
    expect(summary.monitoringOptions).toEqual([]);
  });

  it("propagates upsert failures (runner converts to errorMessage); side caches + summary NOT written", async () => {
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async (_s: string, _b: string, onPage: any) => {
        await onPage([makeConvertedReadRow()], 0);
      }
    );
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
    expect(mocks.pruneSupersededPerformanceRatioFacts).not.toHaveBeenCalled();
    expect(mocks.upsertComputedArtifact).not.toHaveBeenCalled();
  });

  it("BEST-EFFORT prune sweep: failures DO NOT roll back the visibility flip", async () => {
    // 2026-05-09 — Option C — under the new ordering the summary
    // write IS the visibility flip. Prune happens AFTER the flip
    // and is best-effort: a sweep failure leaves stale rows in
    // the table (invisible via the summary's buildId filter) but
    // does NOT throw out of the runner step. The build is still
    // reported `succeeded` — the new build's rows are visible.
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async () => 0
    );
    mocks.pruneSupersededPerformanceRatioFacts.mockRejectedValue(
      new Error("sweep failed")
    );

    // Should NOT throw — sweep failure is logged + swallowed.
    await expect(
      performanceRatioBuildStep.run({
        scopeId: "scope-A",
        buildId: "bld-1",
        signal: new AbortController().signal,
      })
    ).resolves.toBeUndefined();
    // Summary + side caches WERE written before the sweep
    // attempted (visibility flip succeeded).
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(3);
    expect(
      getArtifactCallByType(PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE)
    ).toBeDefined();
    expect(
      getArtifactCallByType(PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE)
    ).toBeDefined();
    expect(
      getArtifactCallByType(PERFORMANCE_RATIO_BEST_PER_SYSTEM_ARTIFACT_TYPE)
    ).toBeDefined();
  });

  it("aborts before batch resolution when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      performanceRatioBuildStep.run({
        scopeId: "s",
        buildId: "b",
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/);
    expect(mocks.resolvePerformanceRatioBatchIds).not.toHaveBeenCalled();
    expect(mocks.loadPerformanceRatioStaticInput).not.toHaveBeenCalled();
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
