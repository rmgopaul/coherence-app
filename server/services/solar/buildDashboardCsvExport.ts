/**
 * Server-side CSV export helpers for the Solar REC dashboard.
 *
 * The client previously triggered downloads by hydrating the heavy
 * `getDashboardOverviewSummary.ownershipRows` (~5–15 MB) /
 * `getDashboardChangeOwnership.rows` (~19 MB) into the browser, then
 * filtering and joining a CSV string client-side. That:
 *
 *   1. Forced the user to wait through a giant JSON fetch on first
 *      click (and to click again because of the loading-race bug
 *      this PR retires).
 *   2. Held megabytes of detail rows in browser heap forever.
 *
 * These helpers move both filter + CSV-generation server-side. The
 * heavy aggregator artifact is already cached behind
 * `withArtifactCache` + single-flight, so the marginal cost on a
 * warm cache is one parse. Job runners use the file-backed helpers
 * so the MB-scale CSV itself does not live as one giant JS string
 * before upload.
 *
 * Keep the string builders pure. The file-backed helpers perform
 * only local temp-file IO; tests can drive both variants with
 * synthetic ownership/changeOwnership row arrays without DB access.
 */

import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ChangeOwnershipExportRow,
  ChangeOwnershipStatus,
  OwnershipStatus,
} from "./buildChangeOwnershipAggregates";
import type { OwnershipOverviewExportRow } from "./buildOverviewSummaryAggregates";

export type OwnershipTileKey = "reporting" | "notReporting" | "terminated";

export interface OwnershipTileCsvResult {
  csv: string;
  fileName: string;
  rowCount: number;
}

export interface ChangeOwnershipTileCsvResult {
  csv: string;
  fileName: string;
  rowCount: number;
}

export interface FileBackedTileCsvResult {
  csv?: string;
  filePath?: string;
  fileName: string;
  rowCount: number;
  csvBytes: number;
  cleanup?: () => Promise<void>;
}

const OWNERSHIP_HEADERS = [
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
];

const CHANGE_OWNERSHIP_HEADERS = [
  "system_name",
  "system_id",
  "tracking_id",
  "status_category",
  "change_ownership_status",
  "reporting",
  "transferred",
  "terminated",
  "contract_type",
  "contract_status",
  "contract_date",
  "zillow_status",
  "zillow_sold_date",
  "last_reporting_date",
];

const REPORTING_TILE_STATUSES: ReadonlySet<OwnershipStatus> =
  new Set<OwnershipStatus>([
    "Not Transferred and Reporting",
    "Transferred and Reporting",
  ]);

const NOT_REPORTING_TILE_STATUSES: ReadonlySet<OwnershipStatus> =
  new Set<OwnershipStatus>([
    "Not Transferred and Not Reporting",
    "Transferred and Not Reporting",
  ]);

const TERMINATED_TILE_STATUSES: ReadonlySet<OwnershipStatus> =
  new Set<OwnershipStatus>([
    "Terminated and Reporting",
    "Terminated and Not Reporting",
  ]);

const CSV_FILE_WRITE_CHUNK_ROWS = 1000;

function ownershipTileMatcher(
  tile: OwnershipTileKey
): (row: OwnershipOverviewExportRow) => boolean {
  if (tile === "reporting") {
    return row => REPORTING_TILE_STATUSES.has(row.ownershipStatus);
  }
  if (tile === "notReporting") {
    return row => NOT_REPORTING_TILE_STATUSES.has(row.ownershipStatus);
  }
  return row => TERMINATED_TILE_STATUSES.has(row.ownershipStatus);
}

/**
 * Build the CSV for an Ownership-tile filter. Pure: takes the heavy
 * aggregator's `ownershipRows` and returns the CSV string + a file
 * name + the row count.
 *
 * The row count is included so the procedure can fail loudly if the
 * caller asks for an empty tile when summary counts indicate
 * matches exist (smoke-tested at the client by the toast layer).
 */
export function buildOwnershipTileCsv(
  ownershipRows: readonly OwnershipOverviewExportRow[],
  tile: OwnershipTileKey,
  generatedAtIso: string = new Date().toISOString()
): OwnershipTileCsvResult {
  const filtered = filterOwnershipTileRows(ownershipRows, tile);
  const rows = filtered.map(ownershipRowToCsvRecord);

  return {
    csv: buildCsvString(OWNERSHIP_HEADERS, rows),
    fileName: ownershipTileFileName(tile, generatedAtIso),
    rowCount: filtered.length,
  };
}

/**
 * File-backed variant for the background job runner. It preserves
 * the exact CSV shape produced by `buildOwnershipTileCsv` but writes
 * rows in bounded chunks so the worker does not allocate one large
 * CSV string before `storagePutFile`.
 */
export async function buildOwnershipTileCsvFile(
  ownershipRows: readonly OwnershipOverviewExportRow[],
  tile: OwnershipTileKey,
  generatedAtIso: string = new Date().toISOString()
): Promise<FileBackedTileCsvResult> {
  const filtered = filterOwnershipTileRows(ownershipRows, tile);
  return writeCsvFileArtifact(
    OWNERSHIP_HEADERS,
    filtered,
    ownershipTileFileName(tile, generatedAtIso),
    ownershipRowToCsvRecord
  );
}

/**
 * Build the CSV for a Change-Ownership status filter. Same pattern
 * as ownership — filter, sort, map to CSV columns.
 */
export function buildChangeOwnershipTileCsv(
  changeOwnershipRows: readonly ChangeOwnershipExportRow[],
  status: ChangeOwnershipStatus,
  generatedAtIso: string = new Date().toISOString()
): ChangeOwnershipTileCsvResult {
  const filtered = filterChangeOwnershipRows(changeOwnershipRows, status);
  const rows = filtered.map(changeOwnershipRowToCsvRecord);

  return {
    csv: buildCsvString(CHANGE_OWNERSHIP_HEADERS, rows),
    fileName: changeOwnershipTileFileName(status, generatedAtIso),
    rowCount: filtered.length,
  };
}

/**
 * File-backed variant for the background job runner. Keeps the
 * legacy CSV format while avoiding a single full-size CSV string
 * allocation before upload.
 */
export async function buildChangeOwnershipTileCsvFile(
  changeOwnershipRows: readonly ChangeOwnershipExportRow[],
  status: ChangeOwnershipStatus,
  generatedAtIso: string = new Date().toISOString()
): Promise<FileBackedTileCsvResult> {
  const filtered = filterChangeOwnershipRows(changeOwnershipRows, status);
  return writeCsvFileArtifact(
    CHANGE_OWNERSHIP_HEADERS,
    filtered,
    changeOwnershipTileFileName(status, generatedAtIso),
    changeOwnershipRowToCsvRecord
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filterOwnershipTileRows(
  ownershipRows: readonly OwnershipOverviewExportRow[],
  tile: OwnershipTileKey
): OwnershipOverviewExportRow[] {
  const matcher = ownershipTileMatcher(tile);
  return ownershipRows.filter(matcher).slice().sort(compareBySystemName);
}

function filterChangeOwnershipRows(
  changeOwnershipRows: readonly ChangeOwnershipExportRow[],
  status: ChangeOwnershipStatus
): ChangeOwnershipExportRow[] {
  return changeOwnershipRows
    .filter(row => row.changeOwnershipStatus === status)
    .slice()
    .sort(compareBySystemName);
}

function compareBySystemName(
  a: { systemName: string },
  b: { systemName: string }
): number {
  return a.systemName.localeCompare(b.systemName, undefined, {
    sensitivity: "base",
    numeric: true,
  });
}

function ownershipRowToCsvRecord(
  row: OwnershipOverviewExportRow
): Record<string, string> {
  return {
    system_name: row.systemName,
    system_id: row.systemId ?? "",
    tracking_id: row.trackingSystemRefId ?? "",
    state_application_id: row.stateApplicationRefId ?? "",
    part2_project_name: row.part2ProjectName,
    part2_application_id: row.part2ApplicationId ?? "",
    part2_system_id: row.part2SystemId ?? "",
    part2_tracking_id: row.part2TrackingId ?? "",
    source: row.source,
    status_category: row.ownershipStatus,
    reporting: row.isReporting ? "Yes" : "No",
    transferred: row.isTransferred ? "Yes" : "No",
    terminated: row.isTerminated ? "Yes" : "No",
    contract_type: row.contractType ?? "",
    contract_status: row.contractStatusText,
    last_reporting_date: isoDateOnly(row.latestReportingDate),
    contract_date: isoDateOnly(row.contractedDate),
    zillow_status: row.zillowStatus ?? "",
    zillow_sold_date: isoDateOnly(row.zillowSoldDate),
  };
}

function changeOwnershipRowToCsvRecord(
  row: ChangeOwnershipExportRow
): Record<string, string> {
  return {
    system_name: row.systemName,
    system_id: row.systemId ?? "",
    tracking_id: row.trackingSystemRefId ?? "",
    status_category: row.ownershipStatus,
    change_ownership_status: row.changeOwnershipStatus ?? "",
    reporting: row.isReporting ? "Yes" : "No",
    transferred: row.isTransferred ? "Yes" : "No",
    terminated: row.isTerminated ? "Yes" : "No",
    contract_type: row.contractType ?? "",
    contract_status: row.contractStatusText,
    contract_date: isoDateOnly(row.contractedDate),
    zillow_status: row.zillowStatus ?? "",
    zillow_sold_date: isoDateOnly(row.zillowSoldDate),
    last_reporting_date: isoDateOnly(row.latestReportingDate),
  };
}

function ownershipTileFileName(
  tile: OwnershipTileKey,
  generatedAtIso: string
): string {
  const tileLabel =
    tile === "reporting"
      ? "Reporting"
      : tile === "notReporting"
        ? "Not Reporting"
        : "Terminated";
  return `ownership-status-${toCsvFileSlug(tileLabel)}-${timestampForCsvFileName(generatedAtIso)}.csv`;
}

function changeOwnershipTileFileName(
  status: ChangeOwnershipStatus,
  generatedAtIso: string
): string {
  return `change-ownership-${toCsvFileSlug(status)}-${timestampForCsvFileName(generatedAtIso)}.csv`;
}

async function writeCsvFileArtifact<Row>(
  headers: readonly string[],
  rows: readonly Row[],
  fileName: string,
  mapRow: (row: Row) => Record<string, string>
): Promise<FileBackedTileCsvResult> {
  if (rows.length === 0) {
    const csv = buildCsvString(headers, []);
    return {
      csv,
      fileName,
      rowCount: 0,
      csvBytes: Buffer.byteLength(csv, "utf8"),
    };
  }

  let tempDir: string | null = null;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "solar-rec-tile-csv-"));
    const filePath = path.join(tempDir, fileName);
    await writeFile(filePath, buildCsvHeaderLine(headers), "utf8");

    for (let i = 0; i < rows.length; i += CSV_FILE_WRITE_CHUNK_ROWS) {
      const chunk = rows
        .slice(i, i + CSV_FILE_WRITE_CHUNK_ROWS)
        .map(row => buildCsvRowLine(headers, mapRow(row)))
        .join("\n");
      await appendFile(filePath, `\n${chunk}`, "utf8");
    }

    const csvBytes = (await stat(filePath)).size;
    const cleanup = async () => {
      if (!tempDir) return;
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    };

    return {
      filePath,
      fileName,
      rowCount: rows.length,
      csvBytes,
      cleanup,
    };
  } catch (err) {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(
        () => undefined
      );
    }
    throw err;
  }
}

function isoDateOnly(value: Date | null | undefined): string {
  if (!value) return "";
  if (Number.isNaN(value.getTime())) return "";
  return value.toISOString().slice(0, 10);
}

function buildCsvString(
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): string {
  return [
    buildCsvHeaderLine(headers),
    ...rows.map(row => buildCsvRowLine(headers, row)),
  ].join("\n");
}

function buildCsvHeaderLine(headers: readonly string[]): string {
  return headers.map(escapeCsvCell).join(",");
}

function buildCsvRowLine(
  headers: readonly string[],
  row: Record<string, string>
): string {
  return headers.map(h => escapeCsvCell(row[h] ?? "")).join(",");
}

function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvFileSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function timestampForCsvFileName(iso: string): string {
  return iso.replace(/[^0-9]/g, "").slice(0, 14); // YYYYMMDDhhmmss
}

// Test surface — exposed so tests can pin the CSV format without
// importing the heavy aggregator.
export const __TEST_ONLY__ = {
  ownershipTileMatcher,
  isoDateOnly,
  buildCsvString,
  buildCsvHeaderLine,
  buildCsvRowLine,
  toCsvFileSlug,
  timestampForCsvFileName,
  CSV_FILE_WRITE_CHUNK_ROWS,
};
