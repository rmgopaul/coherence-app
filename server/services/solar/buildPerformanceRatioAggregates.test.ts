import { describe, expect, it } from "vitest";
import {
  buildPerformanceRatioAggregates,
  type PerformanceRatioConvertedReadRow,
  type PerformanceRatioInputSystem,
} from "./buildPerformanceRatioAggregates";

const baseSystem: PerformanceRatioInputSystem = {
  key: "system-A",
  trackingSystemRefId: "TRK-A",
  systemId: "SYS-A",
  stateApplicationRefId: "APP-A",
  systemName: "Acme Solar 1",
  installerName: "Acme Installer",
  monitoringPlatform: "SolarEdge",
  installedKwAc: 100,
  contractValue: 250,
  monitoringTokens: ["solaredge"],
  idTokens: ["sysa"],
  nameTokens: ["acmesolar1"],
};

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

describe("buildPerformanceRatioAggregates", () => {
  it("returns empty aggregates when convertedReadsRows is empty", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows).toEqual([]);
    expect(result.convertedReadCount).toBe(0);
    expect(result.matchedConvertedReads).toBe(0);
  });

  it("returns empty aggregates when systems is empty", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows).toEqual([]);
    expect(result.convertedReadCount).toBe(1);
  });

  it("counts invalid reads (missing monitoring / lifetime / id+name)", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({ monitoring: "" }),
        buildRead({ lifetime_meter_read_wh: "" }),
        buildRead({ monitoring_system_id: "", monitoring_system_name: "" }),
      ],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
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
        {
          ...baseSystem,
          idTokens: ["sysz"],
          nameTokens: ["zzz"],
        },
      ],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.unmatchedConvertedReads).toBe(1);
    expect(result.matchedConvertedReads).toBe(0);
    expect(result.rows).toHaveLength(0);
  });

  it("emits one row per matched candidate × read", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.matchedConvertedReads).toBe(1);
    expect(result.rows).toHaveLength(1);
    const [row] = result.rows;
    expect(row?.matchType).toBe("Monitoring + System ID + System Name");
    expect(row?.systemName).toBe("Acme Solar 1");
    expect(row?.lifetimeReadWh).toBe(5_000_000);
  });

  it("derives matchType priority: both ID+Name > ID-only > Name-only", () => {
    const systems: PerformanceRatioInputSystem[] = [
      // Matches by both ID and Name (highest priority)
      {
        ...baseSystem,
        key: "k-both",
        trackingSystemRefId: "TRK-BOTH",
        idTokens: ["sysa"],
        nameTokens: ["acmesolar1"],
      },
      // Matches by ID only
      {
        ...baseSystem,
        key: "k-id",
        trackingSystemRefId: "TRK-ID",
        idTokens: ["sysa"],
        nameTokens: ["zzz"],
      },
      // Matches by Name only
      {
        ...baseSystem,
        key: "k-name",
        trackingSystemRefId: "TRK-NAME",
        idTokens: ["zzz"],
        nameTokens: ["acmesolar1"],
      },
    ];
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems,
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows).toHaveLength(3);
    const byTracking = new Map(
      result.rows.map((r) => [r.trackingSystemRefId, r.matchType])
    );
    expect(byTracking.get("TRK-BOTH")).toBe(
      "Monitoring + System ID + System Name"
    );
    expect(byTracking.get("TRK-ID")).toBe("Monitoring + System ID");
    expect(byTracking.get("TRK-NAME")).toBe("Monitoring + System Name");
  });

  it("uses GATS baseline when present and computes performance ratio", () => {
    const baselineDate = new Date("2026-01-01");
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({ lifetime_meter_read_wh: "10000000", read_date: "2026-04-01" }),
      ],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map([
        [
          "TRK-A",
          // 10 kWh per month flat → 90 days × (10 kWh × 1000 / 30 days) = 30 kWh = 30,000 Wh
          { monthlyKwh: Array.from({ length: 12 }, () => 10) },
        ],
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
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0]!;
    expect(row.baselineSource).toBe("GATS account_solar_generation");
    expect(row.baselineReadWh).toBe(1_000_000);
    expect(row.productionDeltaWh).toBe(9_000_000);
    expect(row.expectedProductionWh).toBeGreaterThan(0);
    expect(row.performanceRatioPercent).not.toBeNull();
    // delta=9_000_000 Wh / expected≈30_000 Wh → ratio ~30000% — sanity bound only
    expect(row.performanceRatioPercent! > 0).toBe(true);
  });

  it("falls back to generator Date Online (baseline=0) when GATS missing", () => {
    const dateOnline = new Date("2026-02-15");
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({ lifetime_meter_read_wh: "5000000", read_date: "2026-04-15" }),
      ],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map([
        ["TRK-A", { monthlyKwh: Array.from({ length: 12 }, () => 100) }],
      ]),
      generationBaselineByTrackingId: new Map(),
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

  it("leaves performanceRatioPercent null when expected is 0 or null", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({ read_date: "2026-04-15" }),
      ],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map([
        ["TRK-A", { monthlyKwh: Array.from({ length: 12 }, () => 0) }],
      ]),
      generationBaselineByTrackingId: new Map([
        [
          "TRK-A",
          {
            date: new Date("2026-01-01"),
            valueWh: 0,
            source: "GATS",
          },
        ],
      ]),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows[0]?.expectedProductionWh).toBe(0);
    expect(result.rows[0]?.performanceRatioPercent).toBeNull();
  });

  it("emits no row when candidate has no trackingSystemRefId", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [{ ...baseSystem, trackingSystemRefId: null }],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    // The system is excluded from the index entirely, so the read is unmatched.
    expect(result.rows).toHaveLength(0);
    expect(result.unmatchedConvertedReads).toBe(1);
  });

  it("populates ABP AC size + Part-2 verification when applicationId matches", () => {
    const part2Date = new Date("2026-03-10");
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [buildRead()],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map([["APP-A", 99.5]]),
      abpPart2VerificationDateByApplicationId: new Map([["APP-A", part2Date]]),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows[0]?.abpAcSizeKw).toBe(99.5);
    expect(result.rows[0]?.part2VerificationDate).toEqual(part2Date);
  });

  it("sorts rows by readDate desc → ratio desc → systemName asc", () => {
    const systems: PerformanceRatioInputSystem[] = [
      {
        ...baseSystem,
        key: "k-1",
        trackingSystemRefId: "TRK-1",
        systemName: "Beta Site",
        idTokens: ["sys1"],
        nameTokens: ["betasite"],
      },
      {
        ...baseSystem,
        key: "k-2",
        trackingSystemRefId: "TRK-2",
        systemName: "Alpha Site",
        idTokens: ["sys2"],
        nameTokens: ["alphasite"],
      },
    ];
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({
          monitoring_system_id: "sys-2",
          monitoring_system_name: "Alpha Site",
          read_date: "2026-04-15",
        }),
        buildRead({
          monitoring_system_id: "sys-1",
          monitoring_system_name: "Beta Site",
          read_date: "2026-04-15",
        }),
        buildRead({
          monitoring_system_id: "sys-1",
          monitoring_system_name: "Beta Site",
          read_date: "2026-04-01",
        }),
      ],
      systems,
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.rows.map((r) => r.systemName)).toEqual([
      "Alpha Site",
      "Beta Site",
      "Beta Site",
    ]);
    expect(result.rows[0]?.readDate?.toISOString().slice(0, 10)).toBe(
      "2026-04-15"
    );
    expect(result.rows[2]?.readDate?.toISOString().slice(0, 10)).toBe(
      "2026-04-01"
    );
  });

  it("normalizes monitoring matching across separators and case", () => {
    const result = buildPerformanceRatioAggregates({
      convertedReadsRows: [
        buildRead({
          monitoring: "Solar-Edge",
          monitoring_system_id: "Sys A",
          monitoring_system_name: "Acme-Solar 1",
        }),
      ],
      systems: [baseSystem],
      abpAcSizeKwByApplicationId: new Map(),
      abpPart2VerificationDateByApplicationId: new Map(),
      annualProductionByTrackingId: new Map(),
      generationBaselineByTrackingId: new Map(),
      generatorDateOnlineByTrackingId: new Map(),
    });
    expect(result.matchedConvertedReads).toBe(1);
    expect(result.rows).toHaveLength(1);
  });
});
