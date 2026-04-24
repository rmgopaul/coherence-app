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
 * Two stable source-ID families coexist in the manifest:
 *   - `mon_batch_<providerSlug>` — written by the monitoring batch runner.
 *     Replace semantics: each batch run overwrites the prior batch's rows
 *     for that provider.
 *   - `individual_<providerSlug>` — written by the per-vendor meter-reads
 *     pages via the `pushConvertedReadsSource` tRPC mutation. Merge/dedup
 *     semantics: each run reads the prior source's rows and merges in any
 *     new (non-duplicate) rows, preserving multi-day history.
 *
 * Both families live in the same manifest and read from the same storage
 * user (the Solar REC owner). That's what prevents the two ingest paths
 * from clobbering each other.
 */
import {
  getSolarRecDashboardPayload,
  saveSolarRecDashboardPayload,
} from "../db";
import { MONITORING_CANONICAL_NAMES } from "@shared/const";
import { parseCsvText } from "../routers/helpers/scheduleB";

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
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Dedup key for a Converted Reads row. Mirrors the client's
 * `convertedReadsRowKey` (client/src/features/solar-rec/SolarRecDashboard.tsx)
 * so the two implementations don't drift.
 */
function convertedReadsRowKey(row: ConvertedReadRow): string {
  return [
    row.monitoring ?? "",
    row.monitoring_system_id ?? "",
    row.monitoring_system_name ?? "",
    row.lifetime_meter_read_wh ?? "",
    row.read_date ?? "",
  ].join("|");
}

/**
 * Reassemble a source's CSV text by fetching all of its chunks in order.
 * Returns `[]` if the source has no chunks or every chunk read failed.
 */
async function loadSourceRows(
  userId: number,
  source: RemoteDatasetSourceRef
): Promise<ConvertedReadRow[]> {
  const chunkKeys = source.chunkKeys ?? [];
  if (chunkKeys.length === 0) return [];
  const parts: string[] = [];
  for (const chunkKey of chunkKeys) {
    const payload = await getSolarRecDashboardPayload(userId, `dataset:${chunkKey}`);
    if (payload) parts.push(payload);
  }
  if (parts.length === 0) return [];
  const { rows } = parseCsvText(parts.join(""));
  return rows;
}

/**
 * Core write path: materialize `rows` as CSV, chunk it, and update the
 * `_rawSourcesV1` manifest so the dashboard's hydrator finds the new (or
 * replaced) source entry under `sourceId`.
 *
 * - Writes each chunk at `dataset:${storageKey}_chunk_NNNN`.
 * - Writes a chunk-pointer JSON at `dataset:${storageKey}` so the
 *   dashboard's `loadPayloadByKey(source.storageKey)` path can follow
 *   the chunks (the dashboard fetches the top-level blob first; without
 *   this pointer the source is silently skipped).
 * - Clears any orphan chunks left over from a prior write for the same
 *   source ID (best-effort — logged, not thrown).
 * - Rewrites the manifest with the new source appended at the end
 *   (prior entry for the same `sourceId` is removed first).
 *
 * Callers are responsible for REPLACE vs MERGE semantics — pass the full
 * row set that should end up stored for this source.
 */
async function writeSourceToManifest(
  userId: number,
  sourceId: string,
  sourceFileName: string,
  rows: ConvertedReadRow[]
): Promise<{ sourceId: string; storageKey: string; rowCount: number }> {
  const csvText = buildCsvText(CONVERTED_READS_HEADERS, rows);
  const storageKey = buildSourceStorageKey(DATASET_KEY, sourceId);
  const chunks = splitTextIntoChunks(csvText, CHUNK_CHAR_LIMIT);
  const newChunkKeys = chunks.map((_, i) => buildChunkKey(storageKey, i));

  for (let i = 0; i < chunks.length; i += 1) {
    await saveSolarRecDashboardPayload(
      userId,
      `dataset:${newChunkKeys[i]}`,
      chunks[i]
    );
  }

  await saveSolarRecDashboardPayload(
    userId,
    `dataset:${storageKey}`,
    buildChunkPointerPayload(newChunkKeys)
  );

  const existingSources = await readExistingManifest(userId);

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

  const newSource: RemoteDatasetSourceRef = {
    id: sourceId,
    fileName: sourceFileName,
    uploadedAt: new Date().toISOString(),
    rowCount: rows.length,
    sizeBytes: csvText.length,
    storageKey,
    chunkKeys: newChunkKeys,
    encoding: "utf8",
    contentType: "text/csv",
  };

  const nextSources = existingSources
    .filter((s) => s.id !== sourceId)
    .concat(newSource);

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

  return { sourceId, storageKey, rowCount: rows.length };
}

// ---------------------------------------------------------------------------
// Public push functions
// ---------------------------------------------------------------------------

/**
 * Push a provider's successful monitoring runs into the Converted Reads
 * dataset as a source-manifest source entry with REPLACE semantics — each
 * batch run overwrites the prior batch for the same provider.
 *
 * Returns null if no rows qualified (no source created).
 */
export async function pushMonitoringRunsToConvertedReads(
  userId: number,
  providerKey: string,
  providerLabel: string,
  runs: MonitoringRunRow[]
): Promise<{ pushed: number; skipped: number; sourceId: string } | null> {
  const validRuns = runs.filter(
    (r) => r.status === "success" && r.lifetimeKwh != null && r.lifetimeKwh > 0
  );
  if (validRuns.length === 0) {
    return null;
  }

  const csvRows = validRuns.map((r) =>
    buildConvertedReadRow(
      providerLabel,
      r.siteId,
      r.siteName ?? r.siteId,
      r.lifetimeKwh!,
      r.dateKey
    )
  );

  const sourceId = providerSourceId(providerKey);
  const fileName = `Monitoring batch: ${providerLabel} (${csvRows.length})`;
  const result = await writeSourceToManifest(userId, sourceId, fileName, csvRows);

  return {
    pushed: result.rowCount,
    skipped: runs.length - result.rowCount,
    sourceId: result.sourceId,
  };
}

/**
 * Stable source ID for an individual meter-reads page push (SolarEdge,
 * Enphase, eGauge, etc.). One entry per provider — subsequent runs for
 * the same provider MERGE into the existing entry rather than replacing
 * it, so multi-day history accumulates over time.
 */
function individualSourceId(providerKey: string): string {
  return `individual_${providerKey.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`;
}

/**
 * Push Converted Reads rows from an individual meter-reads page run.
 * Uses MERGE/DEDUP semantics: reads the prior `individual_<providerKey>`
 * source (if any), keeps existing unique rows, and appends any new rows
 * that don't already exist (by `convertedReadsRowKey`).
 *
 * This preserves the historical behavior of the client-side
 * `pushConvertedReadsToRecDashboard` — running the same vendor page on
 * multiple days accumulates one row per site per day — while writing in
 * the same `_rawSourcesV1` manifest format the monitoring batch uses,
 * so the two paths coexist without clobbering each other.
 *
 * Returns null if no rows were supplied.
 */
export async function pushIndividualRunsToConvertedReads(
  userId: number,
  providerKey: string,
  providerLabel: string,
  newRows: ConvertedReadRow[]
): Promise<{ pushed: number; skipped: number; sourceId: string } | null> {
  if (newRows.length === 0) return null;

  const sourceId = individualSourceId(providerKey);

  const existingSources = await readExistingManifest(userId);
  const priorSource = existingSources.find((s) => s.id === sourceId);
  const priorRows = priorSource ? await loadSourceRows(userId, priorSource) : [];

  const existingKeys = new Set(priorRows.map(convertedReadsRowKey));
  const uniqueNewRows = newRows.filter(
    (r) => !existingKeys.has(convertedReadsRowKey(r))
  );

  if (uniqueNewRows.length === 0) {
    return { pushed: 0, skipped: newRows.length, sourceId };
  }

  const mergedRows = [...priorRows, ...uniqueNewRows];
  const fileName = `${providerLabel} API (${mergedRows.length} rows)`;
  await writeSourceToManifest(userId, sourceId, fileName, mergedRows);

  return {
    pushed: uniqueNewRows.length,
    skipped: newRows.length - uniqueNewRows.length,
    sourceId,
  };
}

// Re-export shared types so callers (e.g. the tRPC mutations) can
// type-narrow Zod output to them without redefining the shape.
export type { ConvertedReadRow, RemoteDatasetSourceRef, RemoteDatasetSourceManifestPayload };

/**
 * Source IDs owned by the server: monitoring batch pushes and individual
 * meter-reads page pushes. The `_rawSourcesV1` manifest holds these
 * alongside user-uploaded CSV sources (which use random slug IDs). Only
 * the server is allowed to add/update/remove server-managed source
 * entries — the dashboard's sync path uses
 * `syncUserSourcesToConvertedReadsManifest` below to leave them untouched.
 */
export function isServerManagedConvertedReadsSourceId(sourceId: string): boolean {
  return (
    sourceId.startsWith("mon_batch_") || sourceId.startsWith("individual_")
  );
}

/**
 * Atomic read-merge-write for the convertedReads manifest, driven by the
 * client. The client passes in its view of the *user-uploaded* sources.
 * The server reads whatever manifest is currently in the DB, keeps every
 * server-managed source (mon_batch_*, individual_*) regardless of whether
 * the client knew about it, and replaces the rest with the client's
 * `userSources` list.
 *
 * This is what prevents the auto-sync clobber: without it, the dashboard's
 * in-memory state (hydrated once on mount) would overwrite any
 * server-managed sources added by the monitoring bridge after hydration.
 *
 * Callers are responsible for writing the user sources' chunk data — this
 * function only touches the manifest blob at `dataset:convertedReads`.
 */
export async function syncUserSourcesToConvertedReadsManifest(
  userId: number,
  userSources: RemoteDatasetSourceRef[]
): Promise<{
  manifest: RemoteDatasetSourceManifestPayload;
  serverManagedSourceCount: number;
  userSourceCount: number;
}> {
  const existingSources = await readExistingManifest(userId);

  const serverManagedSources = existingSources.filter((s) =>
    isServerManagedConvertedReadsSourceId(s.id)
  );

  // Defensive: drop any client-supplied source whose ID looks server-managed.
  // The client should never send those, but we don't let a buggy client
  // hijack the server-managed namespace.
  const safeUserSources = userSources.filter(
    (s) => !isServerManagedConvertedReadsSourceId(s.id)
  );

  const nextSources: RemoteDatasetSourceRef[] = [
    ...serverManagedSources,
    ...safeUserSources,
  ];

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
    manifest,
    serverManagedSourceCount: serverManagedSources.length,
    userSourceCount: safeUserSources.length,
  };
}
