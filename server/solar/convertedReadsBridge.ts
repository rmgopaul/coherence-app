/**
 * Bridge: pushes successful monitoring API runs into the Converted Reads
 * dataset so they appear in the Solar REC Dashboard's Performance Ratio tab.
 *
 * Uses the dashboard's `_rawSourcesV1` source-manifest format:
 *   - The main `dataset:convertedReads` key holds a manifest JSON listing
 *     individual source files.
 *   - Each source's actual data (CSV text) is stored in chunks under keys
 *     like `dataset:src_convertedReads_<sourceId>_chunk_NNNN`.
 *   - The dashboard's load path fetches every source's chunks, parses each
 *     as CSV, and merges them into a single deduplicated dataset.
 *
 * Each provider gets ONE stable source entry `mon_batch_<providerSlug>`
 * that gets replaced on every bridge run — so the manifest stays bounded
 * at N user CSV uploads + M active providers. User uploads coexist as
 * separate source entries because we only touch our own source.
 */
import {
  getSolarRecDashboardPayload,
  saveSolarRecDashboardPayload,
} from "../db";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";

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

const DATASET_KEY = "convertedReads";
const DB_STORAGE_KEY = `dataset:${DATASET_KEY}`;

/**
 * Max characters per chunk. Mirrors REMOTE_DATASET_CHUNK_CHAR_LIMIT from
 * client/src/solar-rec-dashboard/lib/constants.ts — the dashboard uses
 * this same limit when splitting its own uploads, and the tRPC saveDataset
 * input schema is sized to accept payloads up to this size.
 */
const CHUNK_CHAR_LIMIT = 250_000;

/**
 * Map adapter provider keys to the canonical display labels from
 * MONITORING_CANONICAL_NAMES. This is the same source of truth the client
 * meter reads pages use, so rows from the monitoring batch bridge dedup
 * correctly against rows pushed from individual meter reads pages.
 */
const PROVIDER_LABELS: Record<string, string> = {
  solaredge: MONITORING_CANONICAL_NAMES.solarEdge,
  "enphase-v4": MONITORING_CANONICAL_NAMES.enphase,
  enphasev2: MONITORING_CANONICAL_NAMES.enphase,
  "enphase-v2": MONITORING_CANONICAL_NAMES.enphase,
  fronius: MONITORING_CANONICAL_NAMES.fronius,
  generac: MONITORING_CANONICAL_NAMES.generac,
  hoymiles: MONITORING_CANONICAL_NAMES.hoymiles,
  goodwe: MONITORING_CANONICAL_NAMES.goodwe,
  solis: MONITORING_CANONICAL_NAMES.solis,
  locus: MONITORING_CANONICAL_NAMES.locus,
  apsystems: MONITORING_CANONICAL_NAMES.apsystems,
  solarlog: MONITORING_CANONICAL_NAMES.solarLog,
  growatt: MONITORING_CANONICAL_NAMES.growatt,
  egauge: MONITORING_CANONICAL_NAMES.egauge,
  "egauge-monitoring": MONITORING_CANONICAL_NAMES.egauge,
  "tesla-powerhub": MONITORING_CANONICAL_NAMES.teslaPowerhub,
  teslapowerhub: MONITORING_CANONICAL_NAMES.teslaPowerhub,
  "tesla-solar": MONITORING_CANONICAL_NAMES.teslaSolar,
  teslasolar: MONITORING_CANONICAL_NAMES.teslaSolar,
  ennexos: MONITORING_CANONICAL_NAMES.ennexos,
  ekm: MONITORING_CANONICAL_NAMES.ekm,
};

export function providerCanonicalLabel(providerKey: string): string {
  return PROVIDER_LABELS[providerKey] ?? providerKey;
}

// ---------------------------------------------------------------------------
// Types (mirrored from SolarRecDashboard.tsx RemoteDatasetSourceRef)
// ---------------------------------------------------------------------------

type ConvertedReadRow = Record<string, string>;

type RemoteDatasetSourceRef = {
  id: string;
  fileName: string;
  uploadedAt: string;
  rowCount: number;
  sizeBytes: number;
  storageKey: string;
  chunkKeys?: string[];
  encoding: "utf8" | "base64";
  contentType: string;
};

type RemoteDatasetSourceManifestPayload = {
  _rawSourcesV1: true;
  version: 1;
  sources: RemoteDatasetSourceRef[];
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
// Helpers
// ---------------------------------------------------------------------------

function formatReadDate(isoDate: string): string {
  const parts = isoDate.split("-");
  if (parts.length !== 3) return isoDate;
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return `${month}/${day}/${parts[0]}`;
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

/**
 * Build a stable source ID for a provider. Using a stable ID means each
 * bridge run replaces the previous source for that provider — the manifest
 * never grows unboundedly. Normalize the key the same way the dashboard
 * does in buildRemoteSourceStorageKey().
 */
function providerSourceId(providerKey: string): string {
  return `mon_batch_${providerKey.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
}

/**
 * Build the source's base storage key. Matches the dashboard's
 * buildRemoteSourceStorageKey() which truncates to 52 chars to leave
 * room for the "_chunk_0000" suffix within the 64-char key limit.
 */
function buildSourceStorageKey(datasetKey: string, sourceId: string): string {
  const normalizedDataset = datasetKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  const normalizedSource = sourceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `src_${normalizedDataset}_${normalizedSource}`.slice(0, 52);
}

function buildChunkKey(storageKey: string, chunkIndex: number): string {
  return `${storageKey}_chunk_${String(chunkIndex).padStart(4, "0")}`;
}

/**
 * Chunk-pointer JSON payload that the SolarRecDashboard's
 * `parseChunkPointerPayload` (client/src/features/solar-rec/SolarRecDashboard.tsx)
 * recognizes. The dashboard's source hydrator calls
 * `loadPayloadByKey(source.storageKey)`, which fetches the blob stored at
 * `storageKey` and — if it's one of these pointers — follows the listed
 * chunk keys to reassemble the data. Without this pointer at `storageKey`,
 * the reader returns null and silently skips the source.
 */
function buildChunkPointerPayload(chunkKeys: string[]): string {
  return JSON.stringify({
    _chunkedDataset: true,
    chunkKeys,
  });
}

/** Slice text into chunks of at most `limit` characters. */
function splitTextIntoChunks(text: string, limit: number): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

/**
 * Read the current manifest from `dataset:convertedReads`. Returns the
 * parsed sources array. Handles three cases:
 *   - Source-manifest format (`_rawSourcesV1`) → parse and return sources
 *   - Plain format (old bridge writes, no sources tracked) → treat as empty
 *     (the plain data in the main key is orphaned by design; the dashboard's
 *     local state holds it in memory until next full reload)
 *   - Missing/null → empty sources array
 */
async function readExistingManifest(userId: number): Promise<RemoteDatasetSourceRef[]> {
  const payload = await getSolarRecDashboardPayload(userId, DB_STORAGE_KEY);
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    if (parsed && parsed._rawSourcesV1 === true && Array.isArray(parsed.sources)) {
      return parsed.sources as RemoteDatasetSourceRef[];
    }
  } catch {
    // Invalid JSON — treat as empty
  }
  return [];
}

// ---------------------------------------------------------------------------
// Core push function
// ---------------------------------------------------------------------------

/**
 * Push a provider's successful monitoring runs into the Converted Reads
 * dataset as a source-manifest source entry.
 *
 * Behavior:
 *   - Builds a CSV from the runs
 *   - Splits into chunks, writes each chunk to its own storage key
 *   - Reads the existing manifest, removes any prior source for this
 *     provider (`mon_batch_<providerKey>`), appends the new source, writes back
 *   - Orphaned chunks from the prior source (if the new run needs fewer
 *     chunks than before) get cleared to empty strings
 *
 * Returns null if no rows qualified (no source created).
 */
export async function pushMonitoringRunsToConvertedReads(
  userId: number,
  providerKey: string,
  providerLabel: string,
  runs: MonitoringRunRow[]
): Promise<{ pushed: number; skipped: number; sourceId: string } | null> {
  // 1. Filter to successful runs with lifetime kWh data
  const validRuns = runs.filter(
    (r) => r.status === "success" && r.lifetimeKwh != null && r.lifetimeKwh > 0
  );
  if (validRuns.length === 0) {
    return null;
  }

  // 2. Build CSV rows + text
  const csvRows = validRuns.map((r) =>
    buildConvertedReadRow(
      providerLabel,
      r.siteId,
      r.siteName ?? r.siteId,
      r.lifetimeKwh!,
      r.dateKey
    )
  );
  const csvText = buildCsvText(CONVERTED_READS_HEADERS, csvRows);

  // 3. Generate stable source ID + storage + chunk keys
  const sourceId = providerSourceId(providerKey);
  const storageKey = buildSourceStorageKey(DATASET_KEY, sourceId);
  const chunks = splitTextIntoChunks(csvText, CHUNK_CHAR_LIMIT);
  const newChunkKeys = chunks.map((_, i) => buildChunkKey(storageKey, i));

  // 4. Write each chunk
  for (let i = 0; i < chunks.length; i += 1) {
    await saveSolarRecDashboardPayload(
      userId,
      `dataset:${newChunkKeys[i]}`,
      chunks[i]
    );
  }

  // 4b. Write a chunk-pointer payload at the source's top-level storageKey.
  //     The dashboard's source hydrator fetches `dataset:${storageKey}`
  //     first (via loadPayloadByKey) and only follows chunks when that
  //     blob is a valid chunk pointer. Without this write, the top-level
  //     key is empty and the source is silently skipped during hydration
  //     — which is why the Converted Reads upload slot appears empty
  //     after a monitoring batch.
  await saveSolarRecDashboardPayload(
    userId,
    `dataset:${storageKey}`,
    buildChunkPointerPayload(newChunkKeys)
  );

  // 5. Read existing manifest
  const existingSources = await readExistingManifest(userId);

  // 6. Locate any prior source with the same ID — capture its chunk keys so
  //    we can empty any orphans that aren't in our new chunk list.
  const priorSource = existingSources.find((s) => s.id === sourceId);
  if (priorSource?.chunkKeys && priorSource.chunkKeys.length > 0) {
    const newChunkKeySet = new Set(newChunkKeys);
    const orphanKeys = priorSource.chunkKeys.filter((k) => !newChunkKeySet.has(k));
    for (const orphan of orphanKeys) {
      try {
        await saveSolarRecDashboardPayload(userId, `dataset:${orphan}`, "");
      } catch (err) {
        console.warn(
          `[ConvertedReadsBridge] Failed to clear orphaned chunk ${orphan}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  // 7. Build the new source entry
  const now = new Date().toISOString();
  const newSource: RemoteDatasetSourceRef = {
    id: sourceId,
    fileName: `Monitoring batch: ${providerLabel} (${csvRows.length})`,
    uploadedAt: now,
    rowCount: csvRows.length,
    sizeBytes: csvText.length,
    storageKey,
    chunkKeys: newChunkKeys,
    encoding: "utf8",
    contentType: "text/csv",
  };

  // 8. Replace or append: keep everything except the prior entry for this ID,
  //    then append the new one at the end.
  const nextSources = existingSources
    .filter((s) => s.id !== sourceId)
    .concat(newSource);

  // 9. Write the updated manifest back to the main key
  const manifest: RemoteDatasetSourceManifestPayload = {
    _rawSourcesV1: true,
    version: 1,
    sources: nextSources,
  };
  await saveSolarRecDashboardPayload(
    userId,
    DB_STORAGE_KEY,
    JSON.stringify(manifest)
  );

  return {
    pushed: csvRows.length,
    skipped: runs.length - csvRows.length,
    sourceId,
  };
}
