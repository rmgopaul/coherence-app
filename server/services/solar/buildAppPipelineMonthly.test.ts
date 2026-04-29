import { describe, expect, it } from "vitest";
import { buildAppPipelineMonthly } from "./buildAppPipelineMonthly";
import type { CsvRow, SnapshotSystem } from "./aggregatorHelpers";

// Server-side tests for the monthly pipeline aggregator. The
// fixtures exercise the dedupe logic + Part 1 / Part 2 / Interconnected
// bucketing against a controllable `now` so prior-year math is
// deterministic. There is no client-side test for the original
// useMemo — this server suite is the SOT for the migrated logic.

const NOW = new Date("2025-04-15T12:00:00Z");

function abpRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    Application_ID: "APP-1",
    system_id: "SYS-1",
    Project_Name: "Test Project",
    ...overrides,
  };
}

function genRow(overrides: Partial<CsvRow> = {}): CsvRow {
  return {
    "GATS Unit ID": "GATS-1",
    "Date Online": "2025-01-15",
    ...overrides,
  };
}

function snapshotSystem(
  overrides: Partial<SnapshotSystem & { installedKwAc: number }> = {}
): SnapshotSystem {
  return {
    systemId: "SYS-1",
    stateApplicationRefId: null,
    trackingSystemRefId: null,
    systemName: "",
    recPrice: null,
    isReporting: false,
    ...overrides,
    // installedKwAc is read off the row by extractSnapshotSystems
    // contract — we attach it for the fallback path below.
  } as SnapshotSystem;
}

describe("buildAppPipelineMonthly", () => {
  it("returns empty when all inputs are empty", () => {
    expect(
      buildAppPipelineMonthly({
        abpReportRows: [],
        generatorDetailsRows: [],
        systems: [],
        now: NOW,
      })
    ).toEqual([]);
  });

  it("buckets Part 1 submissions by month and counts kW", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [
        abpRow({
          Application_ID: "APP-1",
          system_id: "SYS-1",
          Part_1_submission_date: "2025-01-15",
          Inverter_Size_kW_AC_Part_1: "10",
        }),
        abpRow({
          Application_ID: "APP-2",
          system_id: "SYS-2",
          Part_1_submission_date: "2025-01-20",
          Inverter_Size_kW_AC_Part_1: "5",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: NOW,
    });
    const jan = data.find((r) => r.month === "2025-01");
    expect(jan).toBeDefined();
    expect(jan!.part1Count).toBe(2);
    expect(jan!.part1KwAc).toBe(15);
  });

  it("dedupes Part 1 / Part 2 by canonical project key", () => {
    // Two rows with the same systemId — should count once each for
    // Part 1 and Part 2.
    const data = buildAppPipelineMonthly({
      abpReportRows: [
        abpRow({
          system_id: "SYS-1",
          Part_1_submission_date: "2025-01-15",
          Inverter_Size_kW_AC_Part_1: "10",
        }),
        abpRow({
          system_id: "SYS-1",
          Part_1_submission_date: "2025-02-15",
          Inverter_Size_kW_AC_Part_1: "5",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: NOW,
    });
    // First row wins; second is filtered as duplicate. Only Jan
    // should have a count.
    const jan = data.find((r) => r.month === "2025-01");
    const feb = data.find((r) => r.month === "2025-02");
    expect(jan?.part1Count).toBe(1);
    expect(jan?.part1KwAc).toBe(10);
    expect(feb).toBeUndefined();
  });

  it("skips Part 1 rows with future submission dates", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [
        abpRow({
          Part_1_submission_date: "2030-01-15", // future
          Inverter_Size_kW_AC_Part_1: "10",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: NOW,
    });
    expect(data).toEqual([]);
  });

  it("buckets Part 2 verifications by month and counts kW", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [
        abpRow({
          system_id: "SYS-1",
          Part_2_App_Verification_Date: "2025-02-15",
          Inverter_Size_kW_AC_Part_2: "12",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: NOW,
    });
    const feb = data.find((r) => r.month === "2025-02");
    expect(feb?.part2Count).toBe(1);
    expect(feb?.part2KwAc).toBe(12);
  });

  it("buckets Interconnected from Generator Details, deduped by GATS Unit ID", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [],
      generatorDetailsRows: [
        genRow({
          "GATS Unit ID": "GATS-1",
          "Date Online": "2025-03-15",
          "AC Size (kW)": "100",
        }),
        genRow({
          "GATS Unit ID": "GATS-1", // duplicate — ignored
          "Date Online": "2025-04-15",
          "AC Size (kW)": "50",
        }),
        genRow({
          "GATS Unit ID": "GATS-2",
          "Date Online": "2025-03-15",
          "AC Size (kW)": "200",
        }),
      ],
      systems: [],
      now: NOW,
    });
    const mar = data.find((r) => r.month === "2025-03");
    expect(mar?.interconnectedCount).toBe(2); // GATS-1 + GATS-2
    expect(mar?.interconnectedKwAc).toBe(300);
  });

  it("falls back to snapshot installedKwAc when generator row has no AC size column", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [],
      generatorDetailsRows: [
        genRow({
          "GATS Unit ID": "GATS-1",
          "Date Online": "2025-03-15",
          // No AC size columns at all.
        }),
      ],
      systems: [
        Object.assign(
          snapshotSystem({ trackingSystemRefId: "GATS-1" }),
          { installedKwAc: 75 }
        ) as SnapshotSystem,
      ],
      now: NOW,
    });
    const mar = data.find((r) => r.month === "2025-03");
    expect(mar?.interconnectedCount).toBe(1);
    expect(mar?.interconnectedKwAc).toBe(75);
  });

  it("emits prior-year comparison fields for each row", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [
        abpRow({
          system_id: "SYS-A",
          Part_1_submission_date: "2024-03-15",
          Inverter_Size_kW_AC_Part_1: "5",
        }),
        abpRow({
          system_id: "SYS-B",
          Part_1_submission_date: "2025-03-15",
          Inverter_Size_kW_AC_Part_1: "10",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: NOW,
    });
    const mar2025 = data.find((r) => r.month === "2025-03");
    expect(mar2025?.part1Count).toBe(1);
    expect(mar2025?.prevPart1Count).toBe(1); // 2024-03 had 1
    expect(mar2025?.prevPart1KwAc).toBe(5);
  });

  it("sorts result rows chronologically", () => {
    const data = buildAppPipelineMonthly({
      abpReportRows: [
        abpRow({
          system_id: "SYS-A",
          Part_1_submission_date: "2025-03-15",
        }),
        abpRow({
          system_id: "SYS-B",
          Part_1_submission_date: "2025-01-15",
        }),
        abpRow({
          system_id: "SYS-C",
          Part_1_submission_date: "2025-02-15",
        }),
      ],
      generatorDetailsRows: [],
      systems: [],
      now: NOW,
    });
    expect(data.map((r) => r.month)).toEqual([
      "2025-01",
      "2025-02",
      "2025-03",
    ]);
  });
});
