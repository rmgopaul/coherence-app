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
 * warm cache is one parse. The wire payload is the CSV string only
 * — already filtered to the tile/status the user clicked, so it is
 * smaller than the full ownershipRows JSON would have been.
 *
 * Keep these helpers pure. The tRPC procedure invokes them after
 * loading the heavy aggregator output; tests can drive them with
 * synthetic ownership/changeOwnership row arrays without DB access.
 */

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

function ownershipTileMatcher(
  tile: OwnershipTileKey
): (row: OwnershipOverviewExportRow) => boolean {
  if (tile === "reporting") {
    return (row) => REPORTING_TILE_STATUSES.has(row.ownershipStatus);
  }
  if (tile === "notReporting") {
    return (row) => NOT_REPORTING_TILE_STATUSES.has(row.ownershipStatus);
  }
  return (row) => TERMINATED_TILE_STATUSES.has(row.ownershipStatus);
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
  const matcher = ownershipTileMatcher(tile);
  const filtered = ownershipRows
    .filter(matcher)
    .slice()
    .sort((a, b) =>
      a.systemName.localeCompare(b.systemName, undefined, {
        sensitivity: "base",
        numeric: true,
      })
    );
  const rows = filtered.map((row) => ({
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
  }));

  const tileLabel =
    tile === "reporting"
      ? "Reporting"
      : tile === "notReporting"
        ? "Not Reporting"
        : "Terminated";

  return {
    csv: buildCsvString(OWNERSHIP_HEADERS, rows),
    fileName: `ownership-status-${toCsvFileSlug(tileLabel)}-${timestampForCsvFileName(generatedAtIso)}.csv`,
    rowCount: filtered.length,
  };
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
  const filtered = changeOwnershipRows
    .filter((row) => row.changeOwnershipStatus === status)
    .slice()
    .sort((a, b) =>
      a.systemName.localeCompare(b.systemName, undefined, {
        sensitivity: "base",
        numeric: true,
      })
    );
  const rows = filtered.map((row) => ({
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
  }));

  return {
    csv: buildCsvString(CHANGE_OWNERSHIP_HEADERS, rows),
    fileName: `change-ownership-${toCsvFileSlug(status)}-${timestampForCsvFileName(generatedAtIso)}.csv`,
    rowCount: filtered.length,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDateOnly(value: Date | null | undefined): string {
  if (!value) return "";
  if (Number.isNaN(value.getTime())) return "";
  return value.toISOString().slice(0, 10);
}

function buildCsvString(
  headers: readonly string[],
  rows: readonly Record<string, string>[]
): string {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const rowLines = rows.map((row) =>
    headers.map((h) => escapeCsvCell(row[h] ?? "")).join(",")
  );
  return [headerLine, ...rowLines].join("\n");
}

function escapeCsvCell(value: string): string {
  if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
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
  toCsvFileSlug,
  timestampForCsvFileName,
};
