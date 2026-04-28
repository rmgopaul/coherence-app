import { describe, expect, it } from "vitest";
import {
  buildPerformanceRatioAggregates,
  type PerformanceRatioConvertedReadRow,
  type PerformanceRatioInputSystem,
} from "./buildPerformanceRatioAggregates";
import {
  normalizeMonitoringMatch,
  normalizeSystemIdMatch,
  normalizeSystemNameMatch,
} from "../../../shared/solarRecPerformanceRatio";

// Tokens are constructed by the SAME normalizers the aggregator uses
// (via shared/) so the tests verify behavior parity by construction
// rather than restating the normalizer rules locally.
function buildBaseSystem(
  overrides: Partial<PerformanceRatioInputSystem> = {}
): PerformanceRatioInputSystem {
  return {
    key: "system-A",
    trackingSystemRefId: "TRK-A",
    systemId: "SYS-A",
    stateApplicationRefId: "APP-A",
    systemName: "Acme Solar 1",
    installerName: "Acme Installer",
    monitoringPlatform: "SolarEdge",
    installedKwAc: 100,
    contractValue: 250,
    monitoringTokens: [normalizeMonitoringMatch("SolarEdge")],
    idTokens: [normalizeSystemIdMatch("SYS-A")],
    nameTokens: [normalizeSystemNameMatch("Acme Solar 1")],
    ...overrides,
  };
}

function buildRead(
  overrides: Partial<PerformanceRatioConvertedReadRow> = {}
): PerformanceRatioConvertedReadRow {
  return {
    monitoring: "SolarEdge",
    monitoring_system_id: "SYS-A",
    monitoring_system_name: "Acme Solar 1",
    lifetime_meter_read_wh: "5000000",
    read_date: "2026-04-15",
    ...overrides,
  };
}

const EMPTY_LOOKUPS = {
  abpAcSizeKwByApplicationId: new Map<string, number>(),
  abpPart2VerificationDateByApplicationId: new Map<string, Date>(),
  annualProductionByTrackingId: new Map<
    string,
    { monthlyKwh: number[] }
  >(),
  generationBaselineByTrackingId: new Map<
    string,
    { date: Date; valueWh: number; source: string }
  >(),
  generatorDateOnlineByTrackingId: new Map<string, Date>(),
};

describe("buildPerformanceRatioAggregates", () => {
  it("returns empty aggregates when convertedReadsRows is empty", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
    });
    expect(result).toStrictEqual({
      rows: [],
      convertedReadCount: 0,
      matchedConvertedReads: 0,
      unmatchedConvertedReads: 0,
      invalidConvertedReads: 0,
    });
  });

  it("returns empty aggregates when systems is empty (counter still tracks input)", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [],
      ...EMPTY_LOOKUPS,
    });
    expect(result.rows).toEqual([]);
    expect(result.convertedReadCount).toBe(1);
    expect(result.matchedConvertedReads).toBe(0);
  });

  it("counts invalid reads (missing monitoring / lifetime / id+name)", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({ monitoring: "" }),
        buildRead({ lifetime_meter_read_wh: "" }),
        buildRead({ monitoring_system_id: "", monitoring_system_name: "" }),
      ],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
    });
    expect(result.invalidConvertedReads).toBe(3);
    expect(result.matchedConvertedReads).toBe(0);
    expect(result.unmatchedConvertedReads).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("counts unmatched reads when no system matches", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({ monitoring_system_id: "SOMETHING-ELSE" }),
      ],
      systems: [
        buildBaseSystem({
          idTokens: [normalizeSystemIdMatch("SYS-Z")],
          nameTokens: [normalizeSystemNameMatch("Other System")],
        }),
      ],
      ...EMPTY_LOOKUPS,
    });
    expect(result.unmatchedConvertedReads).toBe(1);
    expect(result.matchedConvertedReads).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("emits one row per matched candidate × read; matchedConvertedReads counts reads not rows", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
    });
    expect(result.matchedConvertedReads).toBe(1);
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.matchType).toBe("Monitoring + System ID + System Name");
    expect(row.systemName).toBe("Acme Solar 1");
    expect(row.lifetimeReadWh).toBe(5_000_000);
  });

  it("derives matchType priority: both ID+Name > ID-only > Name-only", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [
        buildBaseSystem({
          key: "k-both",
          trackingSystemRefId: "TRK-BOTH",
        }),
        buildBaseSystem({
          key: "k-id",
          trackingSystemRefId: "TRK-ID",
          nameTokens: [normalizeSystemNameMatch("Other System")],
        }),
        buildBaseSystem({
          key: "k-name",
          trackingSystemRefId: "TRK-NAME",
          idTokens: [normalizeSystemIdMatch("OTHER-ID")],
        }),
      ],
      ...EMPTY_LOOKUPS,
    });
    expect(result.matchedConvertedReads).toBe(1);
    expect(result.rows).toHaveLength(3);
    const matchTypeByTracking = new Map(
      result.rows.map((r) => [r.trackingSystemRefId, r.matchType])
    );
    expect(matchTypeByTracking.get("TRK-BOTH")).toBe(
      "Monitoring + System ID + System Name"
    );
    expect(matchTypeByTracking.get("TRK-ID")).toBe("Monitoring + System ID");
    expect(matchTypeByTracking.get("TRK-NAME")).toBe(
      "Monitoring + System Name"
    );
  });

  it("uses GATS baseline and computes ratio from delta / expected", () => {
    // 10 kWh per month flat × 12 months. Window = Jan 1 → Apr 1.
    // Q1 has 31+28+31 = 90 days. Each month contributes the full
    // monthlyKwh × 1000 = 10,000 Wh. expected = 30,000 Wh.
    const baselineDate = new Date(2026, 0, 1); // Local Jan 1 — match parseDate
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({
          lifetime_meter_read_wh: "10000000",
          read_date: "2026-04-01",
        }),
      ],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
      annualProductionByTrackingId: new Map([
        ["TRK-A", { monthlyKwh: Array.from({ length: 12 }, () => 10) }],
      ]),
      generationBaselineByTrackingId: new Map([
        [
          "TRK-A",
          {
            date: baselineDate,
            valueWh: 1_000_000,
            source: "GATS account_solar_generation",
          },
        ],
      ]),
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.baselineSource).toBe("GATS account_solar_generation");
    expect(row.baselineReadWh).toBe(1_000_000);
    expect(row.productionDeltaWh).toBe(9_000_000);
    expect(row.expectedProductionWh).toBeCloseTo(30_000, 0);
    // ratio = (9_000_000 / 30_000) × 100 = 30,000%
    expect(row.performanceRatioPercent).toBeCloseTo(30_000, 0);
  });

  it("falls back to generator Date Online (baseline=0) when GATS missing", () => {
    const dateOnline = new Date(2026, 1, 15);
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({
          lifetime_meter_read_wh: "5000000",
          read_date: "2026-04-15",
        }),
      ],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
      annualProductionByTrackingId: new Map([
        ["TRK-A", { monthlyKwh: Array.from({ length: 12 }, () => 100) }],
      ]),
      generatorDateOnlineByTrackingId: new Map([["TRK-A", dateOnline]]),
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.baselineReadWh).toBe(0);
    expect(row.baselineDate).toEqual(dateOnline);
    expect(row.baselineSource).toBe(
      "Generator Details (Date Online @ day 15, baseline 0)"
    );
    expect(row.productionDeltaWh).toBe(5_000_000);
  });

  it("performanceRatioPercent is null when expected is 0", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead({ read_date: "2026-04-15" })],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
      annualProductionByTrackingId: new Map([
        ["TRK-A", { monthlyKwh: Array.from({ length: 12 }, () => 0) }],
      ]),
      generationBaselineByTrackingId: new Map([
        [
          "TRK-A",
          {
            date: new Date(2026, 0, 1),
            valueWh: 0,
            source: "GATS",
          },
        ],
      ]),
    });
    const row = result.rows[0]!;
    expect(row.expectedProductionWh).toBe(0);
    expect(row.performanceRatioPercent).toBeNull();
  });

  it("excludes systems with no trackingSystemRefId from the match index", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [buildBaseSystem({ trackingSystemRefId: null })],
      ...EMPTY_LOOKUPS,
    });
    expect(result.rows).toHaveLength(0);
    expect(result.unmatchedConvertedReads).toBe(1);
  });

  it("populates ABP AC size + Part-2 verification when applicationId matches", () => {
    const part2Date = new Date(2026, 2, 10);
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [buildBaseSystem()],
      ...EMPTY_LOOKUPS,
      abpAcSizeKwByApplicationId: new Map([["APP-A", 99.5]]),
      abpPart2VerificationDateByApplicationId: new Map([["APP-A", part2Date]]),
    });
    const row = result.rows[0]!;
    expect(row.abpAcSizeKw).toBe(99.5);
    expect(row.part2VerificationDate).toEqual(part2Date);
  });

  it("sorts rows by readDate desc → ratio desc → systemName asc", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({
          monitoring_system_id: "SYS-2",
          monitoring_system_name: "Alpha Site",
          read_date: "2026-04-15",
        }),
        buildRead({
          monitoring_system_id: "SYS-1",
          monitoring_system_name: "Beta Site",
          read_date: "2026-04-15",
        }),
        buildRead({
          monitoring_system_id: "SYS-1",
          monitoring_system_name: "Beta Site",
          read_date: "2026-04-01",
        }),
      ],
      systems: [
        buildBaseSystem({
          key: "k-1",
          trackingSystemRefId: "TRK-1",
          systemName: "Beta Site",
          idTokens: [normalizeSystemIdMatch("SYS-1")],
          nameTokens: [normalizeSystemNameMatch("Beta Site")],
        }),
        buildBaseSystem({
          key: "k-2",
          trackingSystemRefId: "TRK-2",
          systemName: "Alpha Site",
          idTokens: [normalizeSystemIdMatch("SYS-2")],
          nameTokens: [normalizeSystemNameMatch("Alpha Site")],
        }),
      ],
      ...EMPTY_LOOKUPS,
    });
    expect(result.rows.map((r) => r.systemName)).toEqual([
      "Alpha Site",
      "Beta Site",
      "Beta Site",
    ]);
    expect(result.rows[0]!.readDate?.getDate()).toBe(15);
    expect(result.rows[2]!.readDate?.getDate()).toBe(1);
  });

  it("normalizeMonitoringMatch collapses separators to space (parity guard)", () => {
    // Pre-fix the server collapsed non-alphanumerics to empty
    // string; the client collapsed them to a space. Diverging
    // outputs meant a system normalized client-side with its
    // hyphenated platform name would never match a server-side
    // index built from the same string. With the shared
    // normalizer both sides produce "solar edge" for "Solar-Edge"
    // and "solaredge" for "SolarEdge".
    expect(normalizeMonitoringMatch("Solar-Edge")).toBe("solar edge");
    expect(normalizeMonitoringMatch("SolarEdge")).toBe("solaredge");
    expect(normalizeMonitoringMatch("Fronius Solar.web")).toBe(
      "fronius solar web"
    );
  });

  it("normalizeSystemIdMatch uppercases non-numeric IDs (parity guard)", () => {
    // Pre-fix the server lowercased and stripped dashes; the
    // client uppercases. "ABC-123" → server "abc123" vs client
    // "ABC-123" — they would never match. The shared normalizer
    // makes both sides produce the same string.
    expect(normalizeSystemIdMatch("ABC-123")).toBe("ABC-123");
    expect(normalizeSystemIdMatch("abc-123")).toBe("ABC-123");
    expect(normalizeSystemIdMatch("12345.0")).toBe("12345");
    expect(normalizeSystemIdMatch("12,345")).toBe("12345");
  });

  it("normalizeSystemNameMatch keeps space separators (parity guard)", () => {
    // Same divergence shape as the monitoring normalizer:
    // pre-fix server emitted "acmesolar1", client emitted
    // "acme solar 1". Shared version produces the latter.
    expect(normalizeSystemNameMatch("Acme Solar 1")).toBe("acme solar 1");
    expect(normalizeSystemNameMatch("Acme-Solar 1")).toBe("acme solar 1");
    expect(normalizeSystemNameMatch("ACME   SOLAR  1")).toBe("acme solar 1");
  });

  it("emits stable composite keys (readKey + candidateKey)", () => {
    // Key shape regression: the original `${readKey}-${candidateKey}-${rows.length+1}`
    // suffix made keys depend on insertion-order arithmetic. The
    // pair (readKey, candidateKey) is already unique because the
    // inner forEach iterates a Set keyed on candidateKey.
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [
        buildBaseSystem({ key: "k-A", trackingSystemRefId: "TRK-A" }),
        buildBaseSystem({
          key: "k-B",
          trackingSystemRefId: "TRK-B",
          nameTokens: [normalizeSystemNameMatch("Some Other Site")],
        }),
      ],
      ...EMPTY_LOOKUPS,
    });
    const keys = result.rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain("converted-0-k-A");
    expect(keys).toContain("converted-0-k-B");
  });
});
