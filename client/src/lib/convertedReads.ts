/**
 * Shared utilities for generating and pushing "Converted Reads" rows
 * to the Solar REC Dashboard from any monitoring platform's bulk API run.
 *
 * The Converted Reads dataset feeds the Performance Ratio tab.
 *
 * Historically this file implemented the push itself — read the legacy
 * dataset blob, dedup, and save it back as a `SerializedCsvDataset`.
 * That approach clobbered the monitoring batch bridge's `_rawSourcesV1`
 * manifest writes (and vice versa). Now the actual write happens
 * server-side via the `solarRecDashboard.pushConvertedReadsSource` tRPC
 * mutation, which shares the bridge's source-manifest write path. Each
 * provider's individual meter-reads page gets a stable `individual_<slug>`
 * source entry in the same manifest the monitoring batch populates, and
 * the two ingest paths coexist cleanly.
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

/**
 * Call signature of `trpc.solarRecDashboard.pushConvertedReadsSource.mutateAsync`.
 * Callers inject this so this module stays framework-free and testable.
 */
export type PushConvertedReadsSourceFn = (input: {
  providerKey: string;
  providerLabel: string;
  rows: ConvertedReadRow[];
}) => Promise<{ pushed: number; skipped: number; sourceId: string | null }>;

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

/**
 * Derive the stable provider slug (`individual_<slug>` source-ID suffix)
 * that the server-side bridge expects. Lowercase, alphanumeric plus
 * `_` / `-`. Matches the Zod regex on the tRPC input.
 */
function deriveProviderKey(platformLabel: string): string {
  return (
    platformLabel
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

/* ------------------------------------------------------------------ */
/*  Core push function                                                  */
/* ------------------------------------------------------------------ */

/**
 * Push Converted Reads rows to the Solar REC Dashboard.
 *
 * Delegates the actual manifest/chunk write to the
 * `solarRecDashboard.pushConvertedReadsSource` tRPC mutation. The server
 * merges `newRows` against any prior rows in this provider's
 * `individual_<slug>` source (deduplicated by monitoring + system id +
 * system name + lifetime reading + read date) and appends only the new,
 * unique rows.
 */
export async function pushConvertedReadsToRecDashboard(
  pushSource: PushConvertedReadsSourceFn,
  newRows: ConvertedReadRow[],
  platformLabel: string
): Promise<{ pushed: number; skipped: number }> {
  if (newRows.length === 0) {
    return { pushed: 0, skipped: 0 };
  }

  const providerKey = deriveProviderKey(platformLabel);
  const result = await pushSource({
    providerKey,
    providerLabel: platformLabel,
    rows: newRows,
  });

  return { pushed: result.pushed, skipped: result.skipped };
}
