/**
 * Bridge: pushes successful monitoring API runs into the Converted Reads
 * dataset so they appear in the Solar REC Dashboard's Performance Ratio tab.
 *
 * Server-side equivalent of client/src/lib/convertedReads.ts — duplicates
 * only the pure CSV/merge logic (no React, no tRPC client).
 */
import {
  getSolarRecDashboardPayload,
  saveSolarRecDashboardPayload,
} from "../db";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONVERTED_READS_HEADERS = [
  "monitoring",
  "monitoring_system_id",
  "monitoring_system_name",
  "lifetime_meter_read_wh",
  "status",
  "alert_severity",
  "read_date",
] as const;

const DB_STORAGE_KEY = "dataset:convertedReads";

/** Map adapter provider keys to the display labels the dashboard expects. */
const PROVIDER_LABELS: Record<string, string> = {
  solaredge: "SolarEdge",
  "enphase-v4": "Enphase V4",
  enphasev2: "Enphase V2",
  "enphase-v2": "Enphase V2",
  fronius: "Fronius",
  generac: "Generac",
  hoymiles: "Hoymiles",
  goodwe: "GoodWe",
  solis: "Solis",
  locus: "Locus Energy",
  apsystems: "APsystems",
  solarlog: "SolarLog",
  growatt: "Growatt",
  egauge: "eGauge",
  "egauge-monitoring": "eGauge",
  "tesla-powerhub": "Tesla Powerhub",
  teslapowerhub: "Tesla Powerhub",
  "tesla-solar": "Tesla Solar",
  teslasolar: "Tesla Solar",
  ennexos: "eNNexOS",
  ekm: "EKM",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConvertedReadRow = Record<string, string>;

type SerializedCsvDataset = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  csvText: string;
  rows: ConvertedReadRow[];
  sources?: Array<{
    fileName: string;
    uploadedAt: string;
    rowCount: number;
  }>;
};

export type MonitoringRunRow = {
  provider: string;
  siteId: string;
  siteName: string | null;
  lifetimeKwh: number | null;
  dateKey: string;
  status: string;
};

// ---------------------------------------------------------------------------
// Pure helpers (mirrored from client/src/lib/convertedReads.ts)
// ---------------------------------------------------------------------------

function formatReadDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return `${month}/${day}/${parts[0]}`;
}

function convertedReadsRowKey(row: ConvertedReadRow): string {
  return [
    row.monitoring ?? "",
    row.monitoring_system_id ?? "",
    row.monitoring_system_name ?? "",
    row.lifetime_meter_read_wh ?? "",
    row.read_date ?? "",
  ].join("|");
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function buildCsvText(headers: readonly string[], rows: ConvertedReadRow[]): string {
  const headerLine = headers.map((h) => csvEscape(h)).join(",");
  const bodyLines = rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","));
  return [headerLine, ...bodyLines].join("\n");
}

function parseCsvRows(csvText: string, headers: string[]): ConvertedReadRow[] {
  if (!csvText.trim()) return [];
  const lines = csvText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const csvHeaders = lines[0].split(",").map((h) => h.replace(/^"|"$/g, "").trim());
  return lines.slice(1).map((line) => {
    const values = line.split(",").map((v) => v.replace(/^"|"$/g, "").trim());
    const row: ConvertedReadRow = {};
    csvHeaders.forEach((h, i) => { row[h] = values[i] ?? ""; });
    return row;
  });
}

function buildConvertedReadRow(
  monitoring: string,
  systemId: string,
  systemName: string,
  lifetimeKwh: number,
  anchorDate: string
): ConvertedReadRow {
  return {
    monitoring,
    monitoring_system_id: systemId,
    monitoring_system_name: systemName,
    lifetime_meter_read_wh: String(Math.round(lifetimeKwh * 1000)),
    read_date: formatReadDate(anchorDate),
    status: "",
    alert_severity: "",
  };
}

// ---------------------------------------------------------------------------
// Core push function
// ---------------------------------------------------------------------------

/**
 * Push successful monitoring runs into the Converted Reads dataset,
 * merging with existing rows and deduplicating.
 */
export async function pushMonitoringRunsToConvertedReads(
  userId: number,
  runs: MonitoringRunRow[]
): Promise<{ pushed: number; skipped: number }> {
  // Filter to successful runs with lifetime kWh data
  const validRuns = runs.filter(
    (r) => r.status === "success" && r.lifetimeKwh != null && r.lifetimeKwh > 0
  );
  if (validRuns.length === 0) {
    return { pushed: 0, skipped: 0 };
  }

  // Build new rows
  const newRows = validRuns.map((r) =>
    buildConvertedReadRow(
      PROVIDER_LABELS[r.provider] ?? r.provider,
      r.siteId,
      r.siteName ?? r.siteId,
      r.lifetimeKwh!,
      r.dateKey
    )
  );

  const now = new Date().toISOString();

  // Fetch existing dataset
  let existingDataset: SerializedCsvDataset | null = null;
  try {
    const payload = await getSolarRecDashboardPayload(userId, DB_STORAGE_KEY);
    if (payload) {
      existingDataset = JSON.parse(payload) as SerializedCsvDataset;
    }
  } catch {
    // No existing dataset — start fresh
  }

  // Parse existing rows
  const existingRows: ConvertedReadRow[] =
    (existingDataset?.csvText
      ? parseCsvRows(existingDataset.csvText, existingDataset.headers ?? [...CONVERTED_READS_HEADERS])
      : null) ??
    existingDataset?.rows ??
    [];
  const existingKeys = new Set(existingRows.map(convertedReadsRowKey));

  // Deduplicate
  const uniqueNewRows = newRows.filter((row) => {
    const key = convertedReadsRowKey(row);
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (uniqueNewRows.length === 0) {
    return { pushed: 0, skipped: newRows.length };
  }

  // Merge headers
  const existingHeaders = existingDataset?.headers ?? [];
  const mergedHeaders = Array.from(
    new Set([...existingHeaders, ...CONVERTED_READS_HEADERS])
  );

  // Build sources array
  const existingSources = existingDataset?.sources ?? (existingDataset ? [{
    fileName: existingDataset.fileName,
    uploadedAt: existingDataset.uploadedAt,
    rowCount: existingRows.length,
  }] : []);

  // Group new rows by provider for the source label
  const providerCounts = new Map<string, number>();
  for (const row of uniqueNewRows) {
    const p = row.monitoring ?? "Unknown";
    providerCounts.set(p, (providerCounts.get(p) ?? 0) + 1);
  }
  const sourceLabel = Array.from(providerCounts.entries())
    .map(([p, c]) => `${p} (${c})`)
    .join(", ");

  const sources = [
    ...existingSources,
    {
      fileName: `Monitoring batch: ${sourceLabel}`,
      uploadedAt: now,
      rowCount: uniqueNewRows.length,
    },
  ];

  // Build merged dataset
  const allRows = [...existingRows, ...uniqueNewRows];
  const merged: SerializedCsvDataset = {
    fileName: `${sources.length} files loaded`,
    uploadedAt: now,
    headers: mergedHeaders,
    csvText: buildCsvText(mergedHeaders, allRows),
    rows: allRows,
    sources,
  };

  // Persist
  await saveSolarRecDashboardPayload(userId, DB_STORAGE_KEY, JSON.stringify(merged));

  return { pushed: uniqueNewRows.length, skipped: newRows.length - uniqueNewRows.length };
}
