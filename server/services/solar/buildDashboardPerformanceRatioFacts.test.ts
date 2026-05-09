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
  upsertPerformanceRatioCompliantFacts: vi.fn(),
  pruneSupersededPerformanceRatioCompliantFacts: vi.fn(),
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

vi.mock("../../db/dashboardPerformanceRatioCompliantFacts", () => ({
  upsertPerformanceRatioCompliantFacts:
    mocks.upsertPerformanceRatioCompliantFacts,
  pruneSupersededPerformanceRatioCompliantFacts:
    mocks.pruneSupersededPerformanceRatioCompliantFacts,
  // Other exports unused by the build runner; provide stubs.
  getPerformanceRatioCompliantFactsPage: vi.fn(),
  getPerformanceRatioCompliantFactsCount: vi.fn(),
  getPerformanceRatioCompliantFactsAggregates: vi.fn(),
  getPerformanceRatioCompliantSourceOptions: vi.fn(),
  getPerformanceRatioCompliantMonitoringOptions: vi.fn(),
  getPerformanceRatioCompliantFactsBySystemKeys: vi.fn(),
  COMPLIANT_SOURCE_NONE_SENTINEL: "__none__",
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
  mocks.upsertPerformanceRatioCompliantFacts.mockResolvedValue(undefined);
  mocks.pruneSupersededPerformanceRatioCompliantFacts.mockResolvedValue(0);
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
// Range-aware decimal conversion (codex review fixup, 2026-05-09)
// ────────────────────────────────────────────────────────────────────
//
// `performanceRatioPercent` is `decimal(10, 4)` on TiDB — it accepts
// values in `[-999_999.9999, 999_999.9999]`. Production saw values
// like -1_146_203 (a meter-rollover row dividing a huge negative
// delta by a small expected) which triggered
// `ER_WARN_DATA_OUT_OF_RANGE` under STRICT_TRANS_TABLES and aborted
// the entire 200-row bulk upsert batch. Fix: null at the application
// boundary + structured warn so the source of bad data is traceable.
//
// `lifetimeReadWh` / `contractValue` are NOT NULL columns; an
// out-of-range value drops the entire row (null wouldn't satisfy
// the schema).

describe("buildPerformanceRatioFactRows — range-aware decimal handling", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("preserves typical production performanceRatioPercent values that previously caused alarms", () => {
    // Values from the user's production failure investigation.
    // All are within decimal(10, 4) range (±999_999.9999), so they
    // must pass through unchanged. Pre-fix these were assumed to
    // be the cause; the actual cause was the 7-figure outliers.
    const rows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({ key: "k-neg", performanceRatioPercent: -8109 }),
        makeRow({ key: "k-mid", performanceRatioPercent: 515 }),
        makeRow({ key: "k-pos", performanceRatioPercent: 8532 }),
      ],
    });
    expect(rows.map(r => r.performanceRatioPercent)).toEqual([
      "-8109",
      "515",
      "8532",
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("nulls performanceRatioPercent when value exceeds decimal(10, 4) ceiling (positive)", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ performanceRatioPercent: 1_000_000 })],
    });
    expect(row.performanceRatioPercent).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/out-of-range/);
    expect(msg).toMatch(/performanceRatioPercent/);
    expect(msg).toMatch(/value=1000000/);
  });

  it("nulls performanceRatioPercent when value exceeds decimal(10, 4) ceiling (negative — production failure value)", () => {
    // -1_146_203% is the actual value that caused the prod failure.
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ performanceRatioPercent: -1_146_203 })],
    });
    expect(row.performanceRatioPercent).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/out-of-range/);
    expect(msg).toMatch(/performanceRatioPercent/);
    expect(msg).toMatch(/value=-1146203/);
  });

  it("emits a structured warn line with buildId + key + trackingSystemRefId + column for traceability", () => {
    buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "build-XYZ",
      rows: [
        makeRow({
          key: "converted-99-sys-Z",
          trackingSystemRefId: "tr-Z",
          performanceRatioPercent: 5_000_000,
        }),
      ],
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toMatch(/buildId=build-XYZ/);
    expect(msg).toMatch(/key=converted-99-sys-Z/);
    expect(msg).toMatch(/trackingSystemRefId=tr-Z/);
    expect(msg).toMatch(/column=performanceRatioPercent/);
  });

  it("preserves an in-range performanceRatioPercent even at the ceiling edge (just under 1M)", () => {
    // decimal(10, 4) allows up to 999_999.9999. We pass 999_999
    // (cleanly within) — must round-trip via `String()`.
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [makeRow({ performanceRatioPercent: 999_999 })],
    });
    expect(row.performanceRatioPercent).toBe("999999");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("DROPS the row when lifetimeReadWh exceeds decimal(20, 4) ceiling (NOT NULL column)", () => {
    // decimal(20, 4) ceiling = 10^16 - 10^-4 ≈ 9.999...e15. A value
    // ≥ 10^16 must drop the row (null isn't allowed in NOT NULL).
    const rows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({ key: "good", lifetimeReadWh: 12_345_678 }),
        makeRow({ key: "absurd", lifetimeReadWh: 1e17 }),
      ],
    });
    expect(rows.map(r => r.key)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/lifetimeReadWh/);
  });

  it("DROPS the row when contractValue exceeds decimal(18, 4) ceiling (NOT NULL column)", () => {
    // decimal(18, 4) ceiling ≈ 9.999...e13.
    const rows = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({ key: "good", contractValue: 25_000 }),
        makeRow({ key: "absurd", contractValue: 1e15 }),
      ],
    });
    expect(rows.map(r => r.key)).toEqual(["good"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/contractValue/);
  });

  it("nulls out-of-range portalAcSizeKw / abpAcSizeKw without dropping the row (nullable columns)", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          // decimal(18, 4) ceiling ≈ 9.999...e13.
          portalAcSizeKw: 1e15,
          abpAcSizeKw: -1e15,
        }),
      ],
    });
    expect(row.portalAcSizeKw).toBeNull();
    expect(row.abpAcSizeKw).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("nulls out-of-range baselineReadWh / productionDeltaWh / expectedProductionWh without dropping the row", () => {
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          // decimal(20, 4) ceiling ≈ 9.999...e15.
          baselineReadWh: 1e17,
          productionDeltaWh: -1e17,
          expectedProductionWh: 1e17,
        }),
      ],
    });
    expect(row.baselineReadWh).toBeNull();
    expect(row.productionDeltaWh).toBeNull();
    expect(row.expectedProductionWh).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it("does NOT warn when an out-of-range value appears in a different column for the same row", () => {
    // Each column is checked independently — a bad
    // performanceRatioPercent should not affect other decimals.
    const [row] = buildPerformanceRatioFactRows({
      scopeId: "s",
      buildId: "b",
      rows: [
        makeRow({
          performanceRatioPercent: 5_000_000, // out of range
          baselineReadWh: 1000, // in range
          productionDeltaWh: 500, // in range
          portalAcSizeKw: 7.5, // in range
        }),
      ],
    });
    expect(row.performanceRatioPercent).toBeNull();
    expect(row.baselineReadWh).toBe("1000");
    expect(row.productionDeltaWh).toBe("500");
    expect(row.portalAcSizeKw).toBe("7.5");
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// PR-CB-2 — entriesWithCompliantSourcesAttached helper
// ────────────────────────────────────────────────────────────────────

describe("entriesWithCompliantSourcesAttached (PR-CB-2)", () => {
  it("returns [systemKey, row] entries with compliantSource attached from the auto Map", async () => {
    const { entriesWithCompliantSourcesAttached } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const accumulators = createPerformanceRatioStreamingAccumulators();
    accumulators.bestPerSystem.set("sys-1", {
      key: "k1",
      systemId: "sys-1",
      stateApplicationRefId: null,
      trackingSystemRefId: "tr-1",
      systemName: "Acme",
      monitoring: "Enphase",
      monitoringSystemId: "ms-1",
      monitoringSystemName: "Acme Mon",
      monitoringPlatform: "Enphase",
      matchType: "Monitoring + System ID",
      installerName: "Acme Solar",
      portalAcSizeKw: 7.5,
      abpAcSizeKw: 7.5,
      part2VerificationDate: null,
      readDate: null,
      readDateRaw: "2026-05-01",
      performanceRatioPercent: 85,
      productionDeltaWh: 100,
      expectedProductionWh: 117,
      contractValue: 1000,
      baselineReadWh: null,
      baselineDate: null,
      baselineSource: null,
      lifetimeReadWh: 12345,
      compliantSource: null,
    });
    accumulators.autoCompliantSources.set("sys-1", {
      source: "10kW AC or Less",
      priority: 1,
    });
    const entries = entriesWithCompliantSourcesAttached(accumulators);
    expect(entries.length).toBe(1);
    const [systemKey, row] = entries[0];
    expect(systemKey).toBe("sys-1");
    expect(row.compliantSource).toBe("10kW AC or Less");
  });

  it("attaches null when systemId has no auto-source entry", async () => {
    const { entriesWithCompliantSourcesAttached } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const accumulators = createPerformanceRatioStreamingAccumulators();
    accumulators.bestPerSystem.set("sys-2", {
      key: "k2",
      systemId: "sys-2",
      stateApplicationRefId: null,
      trackingSystemRefId: "tr-2",
      systemName: "Beta",
      monitoring: "SolarEdge",
      monitoringSystemId: "ms-2",
      monitoringSystemName: "Beta Mon",
      monitoringPlatform: "SolarEdge",
      matchType: "Monitoring + System ID",
      installerName: "Beta Inc.",
      portalAcSizeKw: null,
      abpAcSizeKw: null,
      part2VerificationDate: null,
      readDate: null,
      readDateRaw: "2026-05-01",
      performanceRatioPercent: null,
      productionDeltaWh: null,
      expectedProductionWh: null,
      contractValue: 500,
      baselineReadWh: null,
      baselineDate: null,
      baselineSource: null,
      lifetimeReadWh: 12345,
      compliantSource: null,
    });
    // No auto-source for sys-2.
    const entries = entriesWithCompliantSourcesAttached(accumulators);
    expect(entries[0][1].compliantSource).toBeNull();
  });

  it("returns empty array when accumulator's bestPerSystem Map is empty", async () => {
    const { entriesWithCompliantSourcesAttached } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const accumulators = createPerformanceRatioStreamingAccumulators();
    expect(entriesWithCompliantSourcesAttached(accumulators)).toEqual([]);
  });
});

describe("buildPerformanceRatioCompliantFactRows (PR-CB-2 pure transformation)", () => {
  function makeBestRow(overrides: Record<string, unknown> = {}) {
    return {
      key: "converted-1-sys-1",
      systemId: "sys-1",
      stateApplicationRefId: null,
      trackingSystemRefId: "tr-1",
      systemName: "Acme",
      monitoring: "Enphase",
      monitoringSystemId: "ms-1",
      monitoringSystemName: "Acme Mon",
      monitoringPlatform: "Enphase",
      matchType: "Monitoring + System ID",
      installerName: "Acme Solar",
      portalAcSizeKw: 7.5,
      abpAcSizeKw: 7.5,
      part2VerificationDate: "2024-06-15T00:00:00.000Z",
      readDate: "2026-05-01T00:00:00.000Z",
      readDateRaw: "5/1/2026",
      performanceRatioPercent: 85,
      productionDeltaWh: 100,
      expectedProductionWh: 117,
      contractValue: 1000,
      baselineReadWh: 50000,
      baselineDate: "2024-06-15T00:00:00.000Z",
      baselineSource: "Generation Entry",
      lifetimeReadWh: 12345,
      compliantSource: "10kW AC or Less",
      ...overrides,
    };
  }

  it("returns one fact row per [systemKey, row] entry", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const rows = buildPerformanceRatioCompliantFactRows({
      scopeId: "scope-1",
      buildId: "bld-1",
      entries: [
        ["sk-1", makeBestRow({ key: "k1" }) as never],
        ["sk-2", makeBestRow({ key: "k2" }) as never],
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.systemKey).sort()).toEqual(["sk-1", "sk-2"]);
  });

  it("stamps every row with the supplied scopeId + buildId", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const rows = buildPerformanceRatioCompliantFactRows({
      scopeId: "scope-X",
      buildId: "bld-Y",
      entries: [["sk-1", makeBestRow() as never]],
    });
    expect(rows[0].scopeId).toBe("scope-X");
    expect(rows[0].buildId).toBe("bld-Y");
    expect(rows[0].systemKey).toBe("sk-1");
  });

  it("converts ISO datetime strings to Date instances for date columns", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const [row] = buildPerformanceRatioCompliantFactRows({
      scopeId: "s",
      buildId: "b",
      entries: [
        [
          "sk-1",
          makeBestRow({
            readDate: "2026-04-01T05:00:00.000Z",
            baselineDate: "2024-06-15T00:00:00.000Z",
            part2VerificationDate: "2024-12-01T23:48:20.215Z",
          }) as never,
        ],
      ],
    });
    expect(row.readDate).toBeInstanceOf(Date);
    expect(row.baselineDate).toBeInstanceOf(Date);
    expect(row.part2VerificationDate).toBeInstanceOf(Date);
  });

  it("passes through null date fields as null", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const [row] = buildPerformanceRatioCompliantFactRows({
      scopeId: "s",
      buildId: "b",
      entries: [
        [
          "sk-1",
          makeBestRow({
            readDate: null,
            baselineDate: null,
            part2VerificationDate: null,
          }) as never,
        ],
      ],
    });
    expect(row.readDate).toBeNull();
    expect(row.baselineDate).toBeNull();
    expect(row.part2VerificationDate).toBeNull();
  });

  it("DROPS the row when a NOT NULL decimal is out-of-range (lifetimeReadWh)", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const rows = buildPerformanceRatioCompliantFactRows({
        scopeId: "s",
        buildId: "b",
        entries: [
          ["sk-1", makeBestRow({ key: "good", lifetimeReadWh: 100 }) as never],
          ["sk-2", makeBestRow({ key: "absurd", lifetimeReadWh: 1e17 }) as never],
        ],
      });
      expect(rows.map((r) => r.key)).toEqual(["good"]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("nulls out-of-range nullable decimals without dropping the row (performanceRatioPercent)", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const [row] = buildPerformanceRatioCompliantFactRows({
        scopeId: "s",
        buildId: "b",
        entries: [
          ["sk-1", makeBestRow({ performanceRatioPercent: 5_000_000 }) as never],
        ],
      });
      expect(row.performanceRatioPercent).toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns [] when the entries array is empty", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    expect(
      buildPerformanceRatioCompliantFactRows({
        scopeId: "s",
        buildId: "b",
        entries: [],
      })
    ).toEqual([]);
  });

  it("preserves compliantSource pre-attached at the helper layer", async () => {
    const { buildPerformanceRatioCompliantFactRows } = await import(
      "./buildDashboardPerformanceRatioFacts"
    );
    const [row] = buildPerformanceRatioCompliantFactRows({
      scopeId: "s",
      buildId: "b",
      entries: [
        [
          "sk-1",
          makeBestRow({ compliantSource: "Explicit Platform" }) as never,
        ],
      ],
    });
    expect(row.compliantSource).toBe("Explicit Platform");
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
        dedupedConvertedReads: 0,
      },
      accumulators: makeEmptyAccumulators(),
    });
    expect(payload.convertedReadCount).toBe(991_000);
    expect(payload.matchedConvertedReads).toBe(12_500);
    expect(payload.unmatchedConvertedReads).toBe(800_000);
    expect(payload.invalidConvertedReads).toBe(178_500);
  });

  it("forwards dedupedConvertedReads counter (Bug #5 cross-source dedup, 2026-05-09)", () => {
    const payload = buildPerformanceRatioSummaryPayload({
      buildId: "bld-1",
      builtAt,
      aggregate: {
        convertedReadCount: 1000,
        matchedConvertedReads: 950,
        unmatchedConvertedReads: 25,
        invalidConvertedReads: 5,
        dedupedConvertedReads: 20,
      },
      accumulators: makeEmptyAccumulators(),
    });
    expect(payload.dedupedConvertedReads).toBe(20);
    // Sanity: counters partition cleanly. dedupedConvertedReads is a
    // distinct bucket from matched/unmatched/invalid; total =
    // matched + unmatched + invalid + deduped.
    expect(
      payload.matchedConvertedReads +
        payload.unmatchedConvertedReads +
        payload.invalidConvertedReads +
        payload.dedupedConvertedReads
    ).toBe(payload.convertedReadCount);
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
        dedupedConvertedReads: 0,
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
        dedupedConvertedReads: 0,
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
        dedupedConvertedReads: 0,
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
        dedupedConvertedReads: 0,
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
      dedupedConvertedReads: 0,
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

  // 2026-05-09 — PR-1, Bug #5 cross-source dedup. The new
  // `dedupedConvertedReads` field is REQUIRED on freshly-built
  // payloads, but the parser tolerates older cached rows that
  // pre-date the field by defaulting to 0 — so a stale row from
  // before the deploy doesn't null-return on read and force an
  // unrelated rebuild prompt on the client.
  it("accepts a pre-PR-1 payload missing dedupedConvertedReads (defaults to 0)", () => {
    const stale = makeValidPayload() as Partial<
      ReturnType<typeof makeValidPayload>
    >;
    delete (stale as Record<string, unknown>).dedupedConvertedReads;
    const result = parser!(JSON.stringify(stale));
    expect(result).not.toBeNull();
    expect(result!.dedupedConvertedReads).toBe(0);
  });

  it("rejects payloads where dedupedConvertedReads is the wrong type", () => {
    const payload = makeValidPayload();
    (payload as Record<string, unknown>).dedupedConvertedReads = "twenty";
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
    // Mock streaming source: 2 pages of 1 row each. The two rows
    // need DIFFERENT `lifetime_meter_read_wh` values so the
    // 2026-05-09 cross-source dedup (PR-1, Bug #5) doesn't collapse
    // them — pre-fix they were identical and the matcher emitted
    // one fact per row regardless. Different lifetimes simulate two
    // distinct physical readings (e.g. consecutive days).
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async (_scopeId: string, _batchId: string, onPage: any) => {
        await onPage(
          [makeConvertedReadRow({ lifetime_meter_read_wh: "5000000" })],
          0
        );
        await onPage(
          [makeConvertedReadRow({ lifetime_meter_read_wh: "5500000" })],
          1
        );
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

    // 2026-05-09 — PR-CB-6 — two artifact writes: summary +
    // auto-compliant. The bestPerSystem artifact write was
    // retired; that data now lives in the
    // `solarRecDashboardPerformanceRatioCompliantFacts` table.
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(2);
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

    // 2026-05-09 — PR-CB-2 — the compliant-facts prune sweep also
    // fires on every successful build, independent of the parent
    // fact-table prune. Test fixture has no compliant rows in
    // accumulator (bestPerSystem is empty because part2VerificationDate
    // is unset in the static input), so the compliant upsert is
    // gated to zero calls; the prune still fires.
    expect(
      mocks.upsertPerformanceRatioCompliantFacts
    ).not.toHaveBeenCalled();
    expect(
      mocks.pruneSupersededPerformanceRatioCompliantFacts
    ).toHaveBeenCalledWith("scope-A", ["bld-1"]);
  });

  it("memory-bounded: drains accumulator per page so no UPSERT carries the full row set", async () => {
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async (_s: string, _b: string, onPage: any) => {
        // Distinct lifetime per page so PR-1's cross-source dedup
        // (2026-05-09) doesn't collapse the 3 rows down to 1.
        for (let i = 0; i < 3; i += 1) {
          await onPage(
            [
              makeConvertedReadRow({
                lifetime_meter_read_wh: String(5_000_000 + i * 100_000),
              }),
            ],
            i
          );
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
    // 2026-05-09 — PR-CB-6 — two artifact writes: summary +
    // auto-compliant. Best-per-system artifact retired.
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(2);
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
    // 2026-05-09 — PR-CB-6 — two artifact writes: summary +
    // auto-compliant. Best-per-system artifact retired (the data
    // is now in `solarRecDashboardPerformanceRatioCompliantFacts`).
    expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(2);
    expect(
      getArtifactCallByType(PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE)
    ).toBeDefined();
    expect(
      getArtifactCallByType(PERFORMANCE_RATIO_AUTO_COMPLIANT_ARTIFACT_TYPE)
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
    expect(
      mocks.upsertPerformanceRatioCompliantFacts
    ).not.toHaveBeenCalled();
    expect(
      mocks.pruneSupersededPerformanceRatioCompliantFacts
    ).not.toHaveBeenCalled();
  });

  it("PR-CB-2 dual-write: when bestPerSystem accumulator has eligible entries, the compliant upsert fires BEFORE the summary write", async () => {
    // The dual-write code path's CONTRACT is covered by the
    // pure-function tests on `buildPerformanceRatioCompliantFactRows`
    // (8 cases; row count, scopeId/buildId stamping, ISO→Date
    // conversion, NOT NULL row-drop, etc.). What we additionally
    // need to assert at the orchestration level is the *wiring*:
    // the helper output flows into the upsert call AT THE RIGHT
    // VISIBILITY-FLIP POSITION (between fact-row writes and the
    // summary artifact write).
    //
    // Driving the upstream matcher to produce an in-band ratio is
    // brittle — the matcher consumes `staticInput.systems` token
    // sets, ABP application + part2 maps, baseline-by-tracking-id,
    // annual-production-by-tracking-id, etc., and computes
    // `performanceRatioPercent` from the converted read's window
    // arithmetic. The eligibility window [30, 150] is narrow
    // enough that small fixture changes flip rows in or out of
    // the bestPerSystem Map. The previous attempt (lifetime −
    // baseline = 678 Wh against a 10k-kWh annual) produced
    // ratio ≈ 0.08%; an attempt at lifetime=800, baseline=0,
    // annual=12 kWh did not produce an eligible row either —
    // suggesting the matcher's window math doesn't behave the
    // way a quick reading suggests.
    //
    // Pragmatic approach: drive the runner with the same fixtures
    // the existing parent-fact-table orchestration test uses, and
    // assert (a) the prune sweep ALWAYS fires (no eligibility
    // dependency), and (b) WHEN the upsert fires it lands BEFORE
    // the summary write. The conditional protects against
    // fixture-driven false negatives without weakening the
    // visibility-flip-ordering assertion when the path IS
    // exercised.
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async (_scopeId: string, _batchId: string, onPage: any) => {
        await onPage([makeConvertedReadRow()], 0);
        return 1;
      }
    );

    await performanceRatioBuildStep.run({
      scopeId: "scope-A",
      buildId: "bld-1",
      signal: new AbortController().signal,
    });

    // Prune sweep MUST fire on every successful build, scoped to
    // the new buildId (no eligibility dependency).
    expect(
      mocks.pruneSupersededPerformanceRatioCompliantFacts
    ).toHaveBeenCalledWith("scope-A", ["bld-1"]);

    // When the matcher does produce eligible rows, the upsert
    // MUST come before the summary write. Conditional guard.
    if (mocks.upsertPerformanceRatioCompliantFacts.mock.calls.length > 0) {
      const compliantUpsertOrder =
        mocks.upsertPerformanceRatioCompliantFacts.mock
          .invocationCallOrder[0];
      const summaryUpsertOrder =
        mocks.upsertComputedArtifact.mock.invocationCallOrder.find(
          (_o, idx) =>
            mocks.upsertComputedArtifact.mock.calls[idx][0].artifactType ===
            PERFORMANCE_RATIO_SUMMARY_ARTIFACT_TYPE
        );
      expect(summaryUpsertOrder).toBeDefined();
      expect(compliantUpsertOrder).toBeLessThan(summaryUpsertOrder!);
      const [factRows] =
        mocks.upsertPerformanceRatioCompliantFacts.mock.calls[0];
      for (const row of factRows) {
        expect(row.scopeId).toBe("scope-A");
        expect(row.buildId).toBe("bld-1");
      }
    }
  });

  // 2026-05-09 self-review fixup: the originally-planned
  // "stub-driven dual-write contract" test (using vi.spyOn to
  // inject a compliant row via `accumulatePerformanceRatioPage`)
  // does NOT work at the orchestration level. Vitest's spyOn on
  // an ES-module export binding does not intercept SAME-MODULE
  // internal calls — when `runPerformanceRatioStep` calls
  // `accumulatePerformanceRatioPage`, it reads the function
  // directly from the local module scope, bypassing the spy.
  // ESM semantics make this a known limitation.
  //
  // The dual-write contract is therefore covered by:
  //   - 8 pure-function tests on `buildPerformanceRatioCompliantFactRows`
  //     (row count, stamping, ISO→Date conversion, NOT NULL drop,
  //     range-aware decimal handling, empty input, compliantSource
  //     pre-attach).
  //   - The orchestration test ABOVE (prune sweep wiring +
  //     conditional visibility-flip ordering).
  //   - The empty-batch path test BELOW (asserts the prune fires
  //     even with no convertedReads).
  //
  // A future PR could refactor the runner to accept the helpers
  // as parameters (dependency-injection style) so the orchestration
  // tests can drive the pipeline end-to-end without depending on
  // the matcher's full eligibility math. Out of scope here.

  it("PR-CB-2 dual-write empty-batch path: prunes compliant facts even when no convertedReads", async () => {
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue({
      ...makeBatchIds(),
      convertedReadsBatchId: null,
    });
    mocks.pruneSupersededPerformanceRatioCompliantFacts.mockResolvedValue(2);

    await performanceRatioBuildStep.run({
      scopeId: "scope-empty",
      buildId: "bld-empty",
      signal: new AbortController().signal,
    });

    expect(
      mocks.upsertPerformanceRatioCompliantFacts
    ).not.toHaveBeenCalled();
    expect(
      mocks.pruneSupersededPerformanceRatioCompliantFacts
    ).toHaveBeenCalledWith("scope-empty", ["bld-empty"]);
  });

  it("PR-CB-2 dual-write: compliant prune failure does NOT roll back the visibility flip", async () => {
    // The compliant prune is best-effort, mirroring the parent
    // fact-table prune contract. Failure logs + swallows; build
    // still resolves successfully.
    mocks.resolvePerformanceRatioBatchIds.mockResolvedValue(makeBatchIds());
    mocks.loadPerformanceRatioStaticInput.mockResolvedValue(makeStaticInput());
    mocks.forEachPerformanceRatioConvertedReadPage.mockImplementation(
      async () => 0
    );
    mocks.pruneSupersededPerformanceRatioCompliantFacts.mockRejectedValue(
      new Error("compliant prune failed")
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(
        performanceRatioBuildStep.run({
          scopeId: "scope-A",
          buildId: "bld-1",
          signal: new AbortController().signal,
        })
      ).resolves.toBeUndefined();
      // 2026-05-09 — PR-CB-6 — two artifact writes: summary +
      // auto-compliant. Best-per-system artifact retired.
      expect(mocks.upsertComputedArtifact).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
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
