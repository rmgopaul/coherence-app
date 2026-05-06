/**
 * Pure-function tests for the server-side dashboard CSV export
 * helpers. The helpers receive the heavy aggregators' detail rows
 * directly (the procedure layer is responsible for cache + load),
 * so these tests just assert: filter is correct, CSV shape matches
 * the legacy client-side format, and a non-zero filter never
 * produces an empty CSV.
 */

import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type {
  ChangeOwnershipExportRow,
  ChangeOwnershipStatus,
  OwnershipStatus,
} from "./buildChangeOwnershipAggregates";
import type { OwnershipOverviewExportRow } from "./buildOverviewSummaryAggregates";
import {
  buildChangeOwnershipTileCsv,
  buildChangeOwnershipTileCsvFile,
  buildChangeOwnershipTileCsvFileFromChunks,
  buildOwnershipTileCsv,
  buildOwnershipTileCsvFile,
  buildOwnershipTileCsvFileFromChunks,
} from "./buildDashboardCsvExport";

const FROZEN_TIME = "2026-05-02T12:34:56.000Z";

async function* rowChunks<Row>(
  chunks: readonly (readonly Row[])[]
): AsyncGenerator<readonly Row[]> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function makeOwnershipRow(
  partial: Partial<OwnershipOverviewExportRow> & {
    systemName: string;
    ownershipStatus: OwnershipStatus;
  }
): OwnershipOverviewExportRow {
  return {
    key: partial.systemName,
    part2ProjectName: `Project ${partial.systemName}`,
    part2ApplicationId: null,
    part2SystemId: null,
    part2TrackingId: null,
    source: "Matched System",
    systemName: partial.systemName,
    systemId: null,
    stateApplicationRefId: null,
    trackingSystemRefId: null,
    ownershipStatus: partial.ownershipStatus,
    isReporting: partial.ownershipStatus.endsWith(" and Reporting"),
    isTransferred: partial.ownershipStatus.startsWith("Transferred"),
    isTerminated: partial.ownershipStatus.startsWith("Terminated"),
    contractType: null,
    contractStatusText: "",
    latestReportingDate: null,
    contractedDate: null,
    zillowStatus: null,
    zillowSoldDate: null,
    ...partial,
  };
}

function makeChangeOwnershipRow(
  partial: Partial<ChangeOwnershipExportRow> & {
    systemName: string;
    changeOwnershipStatus: ChangeOwnershipStatus;
  }
): ChangeOwnershipExportRow {
  return {
    key: partial.systemName,
    systemName: partial.systemName,
    systemId: null,
    trackingSystemRefId: null,
    installedKwAc: null,
    contractType: null,
    contractStatusText: "",
    contractedDate: null,
    zillowStatus: null,
    zillowSoldDate: null,
    latestReportingDate: null,
    ownershipStatus: partial.changeOwnershipStatus as OwnershipStatus,
    changeOwnershipStatus: partial.changeOwnershipStatus,
    isReporting: false,
    isTransferred: false,
    isTerminated: false,
    hasChangedOwnership: true,
    totalContractAmount: null,
    contractedValue: null,
    ...partial,
  };
}

describe("buildOwnershipTileCsv", () => {
  const rows: OwnershipOverviewExportRow[] = [
    makeOwnershipRow({
      systemName: "Alpha System",
      ownershipStatus: "Not Transferred and Reporting",
    }),
    makeOwnershipRow({
      systemName: "Beta System",
      ownershipStatus: "Transferred and Reporting",
    }),
    makeOwnershipRow({
      systemName: "Gamma System",
      ownershipStatus: "Not Transferred and Not Reporting",
    }),
    makeOwnershipRow({
      systemName: "Delta System",
      ownershipStatus: "Terminated and Reporting",
    }),
    makeOwnershipRow({
      systemName: "Epsilon System",
      ownershipStatus: "Terminated and Not Reporting",
    }),
  ];

  it("filters reporting tile to only reporting (transferred + non-transferred) rows", () => {
    const result = buildOwnershipTileCsv(rows, "reporting", FROZEN_TIME);
    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain("Alpha System");
    expect(result.csv).toContain("Beta System");
    expect(result.csv).not.toContain("Gamma System");
    expect(result.csv).not.toContain("Delta System");
  });

  it("filters notReporting tile to only the not-reporting rows (excludes terminated)", () => {
    const result = buildOwnershipTileCsv(rows, "notReporting", FROZEN_TIME);
    expect(result.rowCount).toBe(1);
    expect(result.csv).toContain("Gamma System");
    expect(result.csv).not.toContain("Alpha System");
    expect(result.csv).not.toContain("Delta System");
  });

  it("filters terminated tile to all terminated rows regardless of reporting state", () => {
    const result = buildOwnershipTileCsv(rows, "terminated", FROZEN_TIME);
    expect(result.rowCount).toBe(2);
    expect(result.csv).toContain("Delta System");
    expect(result.csv).toContain("Epsilon System");
  });

  it("ALWAYS produces a non-empty CSV when at least one row matches the tile", () => {
    // Regression rail: the legacy client-side flow could produce a
    // 0-row CSV on first click because of the heavy-query loading
    // race. The server-side path receives rows directly so this
    // can't recur — pin it.
    const result = buildOwnershipTileCsv(rows, "reporting", FROZEN_TIME);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.csv.split("\n").length).toBeGreaterThan(1); // header + ≥1 data row
  });

  it("returns rowCount === 0 when no rows match the tile", () => {
    const onlyTerminated = [
      makeOwnershipRow({
        systemName: "Only",
        ownershipStatus: "Terminated and Reporting",
      }),
    ];
    const result = buildOwnershipTileCsv(
      onlyTerminated,
      "reporting",
      FROZEN_TIME
    );
    expect(result.rowCount).toBe(0);
    // Header line still present so the CSV is well-formed.
    expect(result.csv).toMatch(/^system_name,/);
  });

  it("emits a deterministic file name with the tile slug + timestamp", () => {
    const result = buildOwnershipTileCsv(rows, "notReporting", FROZEN_TIME);
    expect(result.fileName).toMatch(
      /^ownership-status-not-reporting-\d{14}\.csv$/
    );
  });

  it("CSV header row matches the legacy 19-column ownership shape", () => {
    const result = buildOwnershipTileCsv(rows, "reporting", FROZEN_TIME);
    const headerLine = result.csv.split("\n")[0];
    expect(headerLine).toBe(
      [
        "system_name",
        "system_id",
        "tracking_id",
        "state_application_id",
        "part2_project_name",
        "part2_application_id",
        "part2_system_id",
        "part2_tracking_id",
        "source",
        "status_category",
        "reporting",
        "transferred",
        "terminated",
        "contract_type",
        "contract_status",
        "last_reporting_date",
        "contract_date",
        "zillow_status",
        "zillow_sold_date",
      ].join(",")
    );
  });

  it("escapes commas and quotes in cell values per RFC 4180", () => {
    const tricky = makeOwnershipRow({
      systemName: 'O\'Connor "Solar", LLC',
      ownershipStatus: "Not Transferred and Reporting",
    });
    const result = buildOwnershipTileCsv([tricky], "reporting", FROZEN_TIME);
    // The opening quote-escape applies because the cell contains
    // both a comma and a quote.
    expect(result.csv).toContain('"O\'Connor ""Solar"", LLC"');
  });

  it("file-backed helper writes the same CSV without returning a full CSV string", async () => {
    const expected = buildOwnershipTileCsv(rows, "reporting", FROZEN_TIME);
    const artifact = await buildOwnershipTileCsvFile(
      rows,
      "reporting",
      FROZEN_TIME
    );
    const filePath = artifact.filePath!;

    expect(artifact.rowCount).toBe(expected.rowCount);
    expect(artifact.fileName).toBe(expected.fileName);
    expect(artifact.csv).toBeUndefined();
    expect(artifact.csvBytes).toBeGreaterThan(0);

    try {
      await expect(readFile(filePath, "utf8")).resolves.toBe(expected.csv);
    } finally {
      await artifact.cleanup?.();
    }

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streaming file-backed helper writes paged rows without returning a full CSV string", async () => {
    const expected = buildOwnershipTileCsv(rows, "reporting", FROZEN_TIME);
    const artifact = await buildOwnershipTileCsvFileFromChunks(
      rowChunks([
        [rows[0]],
        [rows[1], rows[2]],
      ]),
      "reporting",
      FROZEN_TIME
    );
    const filePath = artifact.filePath!;

    expect(artifact.rowCount).toBe(expected.rowCount);
    expect(artifact.fileName).toBe(expected.fileName);
    expect(artifact.csv).toBeUndefined();
    expect(artifact.csvBytes).toBeGreaterThan(0);

    try {
      await expect(readFile(filePath, "utf8")).resolves.toBe(expected.csv);
    } finally {
      await artifact.cleanup?.();
    }

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("buildChangeOwnershipTileCsv", () => {
  const rows: ChangeOwnershipExportRow[] = [
    makeChangeOwnershipRow({
      systemName: "T-1",
      changeOwnershipStatus: "Transferred and Reporting",
    }),
    makeChangeOwnershipRow({
      systemName: "T-2",
      changeOwnershipStatus: "Transferred and Reporting",
    }),
    makeChangeOwnershipRow({
      systemName: "X-1",
      changeOwnershipStatus: "Terminated",
    }),
    makeChangeOwnershipRow({
      systemName: "C-1",
      changeOwnershipStatus:
        "Change of Ownership - Not Transferred and Not Reporting",
    }),
  ];

  it("filters by exact status match (virtual 'Terminated' included)", () => {
    const transferredReporting = buildChangeOwnershipTileCsv(
      rows,
      "Transferred and Reporting",
      FROZEN_TIME
    );
    expect(transferredReporting.rowCount).toBe(2);
    expect(transferredReporting.csv).toContain("T-1");
    expect(transferredReporting.csv).toContain("T-2");

    const terminated = buildChangeOwnershipTileCsv(
      rows,
      "Terminated",
      FROZEN_TIME
    );
    expect(terminated.rowCount).toBe(1);
    expect(terminated.csv).toContain("X-1");

    const cooNotReporting = buildChangeOwnershipTileCsv(
      rows,
      "Change of Ownership - Not Transferred and Not Reporting",
      FROZEN_TIME
    );
    expect(cooNotReporting.rowCount).toBe(1);
    expect(cooNotReporting.csv).toContain("C-1");
  });

  it("ALWAYS produces a non-empty CSV when at least one row matches", () => {
    const result = buildChangeOwnershipTileCsv(
      rows,
      "Transferred and Reporting",
      FROZEN_TIME
    );
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.csv.split("\n").length).toBeGreaterThan(1);
  });

  it("emits a deterministic file name with the slug + timestamp", () => {
    const result = buildChangeOwnershipTileCsv(
      rows,
      "Transferred and Reporting",
      FROZEN_TIME
    );
    expect(result.fileName).toMatch(
      /^change-ownership-transferred-and-reporting-\d{14}\.csv$/
    );
  });

  it("rowCount is 0 (CSV is just the header) when no row matches", () => {
    const result = buildChangeOwnershipTileCsv(
      [],
      "Transferred and Reporting",
      FROZEN_TIME
    );
    expect(result.rowCount).toBe(0);
    expect(result.csv).toMatch(/^system_name,/);
  });

  it("file-backed helper writes the same CSV without returning a full CSV string", async () => {
    const expected = buildChangeOwnershipTileCsv(
      rows,
      "Transferred and Reporting",
      FROZEN_TIME
    );
    const artifact = await buildChangeOwnershipTileCsvFile(
      rows,
      "Transferred and Reporting",
      FROZEN_TIME
    );
    const filePath = artifact.filePath!;

    expect(artifact.rowCount).toBe(expected.rowCount);
    expect(artifact.fileName).toBe(expected.fileName);
    expect(artifact.csv).toBeUndefined();
    expect(artifact.csvBytes).toBeGreaterThan(0);

    try {
      await expect(readFile(filePath, "utf8")).resolves.toBe(expected.csv);
    } finally {
      await artifact.cleanup?.();
    }

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("streaming file-backed helper writes paged rows without returning a full CSV string", async () => {
    const expected = buildChangeOwnershipTileCsv(
      rows,
      "Transferred and Reporting",
      FROZEN_TIME
    );
    const artifact = await buildChangeOwnershipTileCsvFileFromChunks(
      rowChunks([
        [rows[0]],
        [rows[1], rows[2]],
      ]),
      "Transferred and Reporting",
      FROZEN_TIME
    );
    const filePath = artifact.filePath!;

    expect(artifact.rowCount).toBe(expected.rowCount);
    expect(artifact.fileName).toBe(expected.fileName);
    expect(artifact.csv).toBeUndefined();
    expect(artifact.csvBytes).toBeGreaterThan(0);

    try {
      await expect(readFile(filePath, "utf8")).resolves.toBe(expected.csv);
    } finally {
      await artifact.cleanup?.();
    }

    await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
