/**
 * Shared utilities for generating and pushing "Converted Reads" rows
 * to the Solar REC Dashboard from any monitoring platform's bulk API run.
 *
 * The Converted Reads dataset feeds the Performance Ratio tab.
 */

/* ------------------------------------------------------------------ */
/*  Constants                                                           */
/* ------------------------------------------------------------------ */

export const CONVERTED_READS_HEADERS = [
  "monitoring",
  "monitoring_system_id",
  "monitoring_system_name",
  "lifetime_meter_read_wh",
  "status",
  "alert_severity",
  "read_date",
] as const;

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type ConvertedReadRow = Record<string, string>;

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

type GetDatasetFn = (input: { key: string }) => Promise<{ key: string; payload: string } | null>;
type SaveDatasetFn = (input: { key: string; payload: string }) => Promise<unknown>;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Convert YYYY-MM-DD to M/D/YYYY (portal upload format). */
export function formatReadDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return `${month}/${day}/${parts[0]}`;
}

/** Build dedup key matching SolarRecDashboard convertedReadsRowKey(). */
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

/** Build a single Converted Read CSV row from monitoring data. */
export function buildConvertedReadRow(
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

/* ------------------------------------------------------------------ */
/*  Core push function                                                  */
/* ------------------------------------------------------------------ */

/**
 * Push Converted Reads rows to the Solar REC Dashboard's remote dataset
 * storage, merging with any existing rows and deduplicating.
 */
export async function pushConvertedReadsToRecDashboard(
  getDataset: GetDatasetFn,
  saveDataset: SaveDatasetFn,
  newRows: ConvertedReadRow[],
  platformLabel: string
): Promise<{ pushed: number; skipped: number }> {
  if (newRows.length === 0) {
    return { pushed: 0, skipped: 0 };
  }

  const now = new Date().toISOString();

  // Fetch existing dataset (may be null if never uploaded).
  let existingDataset: SerializedCsvDataset | null = null;
  try {
    const result = await getDataset({ key: "convertedReads" });
    if (result?.payload) {
      existingDataset = JSON.parse(result.payload) as SerializedCsvDataset;
    }
  } catch {
    // No existing dataset — start fresh.
  }

  // Build dedup set from existing rows.
  // Prefer rows parsed from csvText (the format the dashboard actually reads),
  // fall back to the legacy rows array for backward compatibility.
  const existingRows: ConvertedReadRow[] =
    (existingDataset?.csvText
      ? parseCsvRows(existingDataset.csvText, existingDataset.headers ?? [...CONVERTED_READS_HEADERS])
      : null) ??
    existingDataset?.rows ??
    [];
  const existingKeys = new Set(existingRows.map(convertedReadsRowKey));

  // Filter new rows to only unique ones.
  const uniqueNewRows = newRows.filter((row) => {
    const key = convertedReadsRowKey(row);
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });

  if (uniqueNewRows.length === 0) {
    return { pushed: 0, skipped: newRows.length };
  }

  // Merge headers.
  const existingHeaders = existingDataset?.headers ?? [];
  const mergedHeaders = Array.from(
    new Set([...existingHeaders, ...CONVERTED_READS_HEADERS])
  );

  // Build sources array.
  const existingSources = existingDataset?.sources ?? (existingDataset ? [{
    fileName: existingDataset.fileName,
    uploadedAt: existingDataset.uploadedAt,
    rowCount: existingRows.length,
  }] : []);
  const sources = [
    ...existingSources,
    {
      fileName: `${platformLabel} API (${uniqueNewRows.length} rows)`,
      uploadedAt: now,
      rowCount: uniqueNewRows.length,
    },
  ];

  // Build merged dataset with csvText (the format the dashboard deserializer expects).
  const allRows = [...existingRows, ...uniqueNewRows];
  const merged: SerializedCsvDataset = {
    fileName: `${sources.length} files loaded`,
    uploadedAt: now,
    headers: mergedHeaders,
    csvText: buildCsvText(mergedHeaders, allRows),
    rows: allRows,
    sources,
  };

  // Save to remote storage.
  await saveDataset({ key: "convertedReads", payload: JSON.stringify(merged) });

  return { pushed: uniqueNewRows.length, skipped: newRows.length - uniqueNewRows.length };
}
