/**
 * Server-side migration from `solarRecDashboardStorage` to the new
 * normalized `srDs*` dataset tables.
 *
 * This sidesteps the browser-based migration entirely: the client
 * triggers the job, the server reads each dataset payload directly
 * from its existing storage location, feeds the CSV text through
 * the `ingestDataset` pipeline (which writes typed rows to srDs*),
 * and reports progress via an in-memory job state map.
 *
 * Designed for the scenario where the browser tab cannot hold the
 * full dataset in memory for chunked upload (multi-million-row
 * migrations). All work happens in the Node process; the client
 * only polls for status.
 *
 * Job state lives in-memory per-process. Restart loses state —
 * that's acceptable for now because batch ingestion is idempotent
 * (each run creates a new processing batch; only the final
 * activate flips the active pointer).
 */

import { nanoid } from "nanoid";
import { getSolarRecDashboardPayload } from "../../db";
import { ingestDataset } from "./datasetIngestion";
import {
  parseChunkPointerPayload,
  parseScheduleBRemoteSourceManifest,
} from "../../routers/helpers";
import {
  buildSyncProgress,
  type CoreDatasetSyncProgress,
} from "./coreDatasetSyncProgress";

// ---------------------------------------------------------------------------
// Dataset list
// ---------------------------------------------------------------------------

export const CORE_DATASETS = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "contractedDate",
  "deliveryScheduleBase",
  "transferHistory",
  // Task 5.12 PR-1 (2026-04-27): generatorDetails. The backfill tool
  // ingests existing chunked-CSV uploads into the new srDsGeneratorDetails
  // row table so users don't have to re-upload.
  "generatorDetails",
  // Task 5.12 PR-2 (2026-04-27): abpCsgSystemMapping. Same backfill
  // rationale.
  "abpCsgSystemMapping",
  // Task 5.12 PR-3 (2026-04-27): abpProjectApplicationRows. Same
  // backfill rationale; shared with ABP Monthly Invoice Settlement.
  "abpProjectApplicationRows",
  // Task 5.12 PR-4 (2026-04-27): abpPortalInvoiceMapRows. Same
  // rationale.
  "abpPortalInvoiceMapRows",
  // Task 5.12 PR-5 (2026-04-27): abpCsgPortalDatabaseRows. Same
  // rationale.
  "abpCsgPortalDatabaseRows",
  // Task 5.12 PR-6 (2026-04-27): abpQuickBooksRows. Same rationale.
  "abpQuickBooksRows",
  // Task 5.12 PR-7 (2026-04-27): abpUtilityInvoiceRows. Same
  // rationale.
  "abpUtilityInvoiceRows",
  // Task 5.12 PR-8 (2026-04-27): annualProductionEstimates. Same
  // rationale.
  "annualProductionEstimates",
  // Task 5.12 PR-9 (2026-04-27): abpIccReport2Rows + abpIccReport3Rows
  // — two structurally-identical ICC report tables migrated together.
  "abpIccReport2Rows",
  "abpIccReport3Rows",
  // Task 5.12 PR-10 (2026-04-27): convertedReads — the final dataset
  // migration. Multi-file append; backfill flows through
  // `loadDatasetPayload` → unwrap `_rawSourcesV1` manifest → merge
  // sources → ingestDataset(mode="append").
  "convertedReads",
] as const;

export type CoreDatasetKey = (typeof CORE_DATASETS)[number];

export function isCoreDatasetKey(key: string): key is CoreDatasetKey {
  return (CORE_DATASETS as readonly string[]).includes(key);
}

type DatasetSyncProgressReporter = (progress: CoreDatasetSyncProgress) => void;

/**
 * Core datasets that accumulate across uploads rather than being
 * replaced wholesale. Must match CORE_DATASET_DEFINITIONS's
 * multiFileAppend flag in datasetIngestion.ts — any drift will
 * silently fall back to replace and truncate data.
 */
const APPEND_CORE_DATASETS: ReadonlySet<CoreDatasetKey> = new Set<CoreDatasetKey>([
  "accountSolarGeneration",
  "transferHistory",
  "convertedReads",
]);

function modeForDataset(datasetKey: CoreDatasetKey): "replace" | "append" {
  return APPEND_CORE_DATASETS.has(datasetKey) ? "append" : "replace";
}

// ---------------------------------------------------------------------------
// Job state
// ---------------------------------------------------------------------------

export type DatasetMigrationStatus =
  | { datasetKey: string; state: "pending" }
  | { datasetKey: string; state: "running"; startedAt: string }
  | {
      datasetKey: string;
      state: "done";
      batchId: string;
      rowCount: number;
      durationMs: number;
    }
  | {
      datasetKey: string;
      state: "skipped";
      reason: string;
    }
  | {
      datasetKey: string;
      state: "failed";
      error: string;
    };

export type ServerMigrationJobState = {
  jobId: string;
  scopeId: string;
  ownerUserId: number;
  status: "running" | "done" | "failed";
  startedAt: string;
  completedAt: string | null;
  datasets: DatasetMigrationStatus[];
};

const migrationJobs = new Map<string, ServerMigrationJobState>();

// Guard against starting two concurrent migrations for the same scope.
const activeJobByScope = new Map<string, string>();

/**
 * Returns the state of a migration job, or null if unknown.
 */
export function getServerMigrationJob(
  jobId: string
): ServerMigrationJobState | null {
  return migrationJobs.get(jobId) ?? null;
}

/**
 * Returns the currently-active migration job for a scope, if any.
 */
export function getActiveJobForScope(
  scopeId: string
): ServerMigrationJobState | null {
  const jobId = activeJobByScope.get(scopeId);
  if (!jobId) return null;
  return migrationJobs.get(jobId) ?? null;
}

// ---------------------------------------------------------------------------
// Payload loading — unwraps the two-level indirection used by the
// existing dashboard storage for large multi-source datasets.
//
// `dataset:${datasetKey}` stores one of:
//   1. A `_rawSourcesV1` manifest listing one or more sources. Each
//      source has a storageKey that points at either a chunked
//      dataset or a direct payload. After concatenating each source's
//      CSV the migrator merges them into a single CSV (header from
//      the first source is kept; headers from other sources are
//      stripped so rows line up).
//   2. A `_chunkedDataset` pointer — rare for top-level datasets but
//      handled for completeness.
//   3. The raw payload directly (small legacy datasets).
// ---------------------------------------------------------------------------

async function loadRawSource(
  userId: number,
  storageKey: string
): Promise<string | null> {
  const basePayload = await getSolarRecDashboardPayload(
    userId,
    `dataset:${storageKey}`
  );
  if (!basePayload) return null;

  const chunkKeys = parseChunkPointerPayload(basePayload);
  if (!chunkKeys || chunkKeys.length === 0) {
    // Not chunked — the base payload IS the content.
    return basePayload;
  }

  // Assemble chunked payload.
  let merged = "";
  for (const chunkKey of chunkKeys) {
    const chunk = await getSolarRecDashboardPayload(
      userId,
      `dataset:${chunkKey}`
    );
    if (typeof chunk !== "string") {
      throw new Error(
        `Missing chunk '${chunkKey}' for source '${storageKey}'`
      );
    }
    merged += chunk;
  }
  return merged;
}

/**
 * Merge multiple CSV texts into one by keeping the first CSV's
 * header line and stripping the header line from subsequent CSVs.
 * Assumes all sources have the same schema (they're uploads of the
 * same logical dataset).
 */
function mergeCsvTexts(csvs: string[]): string {
  if (csvs.length === 0) return "";
  if (csvs.length === 1) return csvs[0];
  const parts: string[] = [csvs[0]];
  for (let i = 1; i < csvs.length; i++) {
    const csv = csvs[i];
    // Find the end of the header line. Handle \r\n or \n.
    const newlineIdx = csv.indexOf("\n");
    if (newlineIdx === -1) continue;
    const body = csv.slice(newlineIdx + 1);
    if (body.length > 0) parts.push(body);
  }
  return parts.join("\n");
}

/**
 * If `payload` is a v1 `saveDataset` JSON envelope
 * `{ fileName, uploadedAt, headers, csvText }`, return the inner
 * `csvText`. Otherwise return the payload unchanged.
 *
 * The v1 `saveDataset` client path (`SolarRecDashboard.tsx`)
 * always serializes via `serializeDatasetForRemote()` which
 * produces this envelope, then splits it into ≤250 KB chunks
 * (`REMOTE_DATASET_CHUNK_CHAR_LIMIT`). Reassembled chunks AND
 * unchunked direct writes share the same envelope shape, so
 * Case 2 (chunked) and Case 3 (direct) below both need to
 * unwrap.
 *
 * Shape uniqueness: real CSV cannot pass `JSON.parse()` (header
 * rows are not valid JSON tokens), and a payload that does parse
 * but lacks a string `csvText` falls through to the raw return —
 * so envelope-only payloads are the only ones that get unwrapped.
 * Exported for direct unit testing.
 */
export function maybeUnwrapV1Envelope(payload: string): string {
  try {
    const parsed = JSON.parse(payload);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { csvText?: unknown }).csvText === "string"
    ) {
      return (parsed as { csvText: string }).csvText;
    }
  } catch {
    // Not JSON — payload is raw CSV; passthrough.
  }
  return payload;
}

// Exported for unit tests. Production callers go through
// `migrateOneDataset` / `syncOneCoreDatasetFromStorage`.
export async function loadDatasetPayload(
  userId: number,
  datasetKey: string,
  reportProgress?: DatasetSyncProgressReporter
): Promise<string | null> {
  const basePayload = await getSolarRecDashboardPayload(
    userId,
    `dataset:${datasetKey}`
  );
  if (!basePayload) return null;

  // Case 1: multi-source manifest (the common case for real datasets).
  const sourceManifest = parseScheduleBRemoteSourceManifest(basePayload);
  if (sourceManifest && sourceManifest.length > 0) {
    const sourceCsvs: string[] = [];
    reportProgress?.(
      buildSyncProgress({
        phase: "loading_payload",
        startPercent: 0,
        endPercent: 15,
        current: 0,
        total: sourceManifest.length,
        unitLabel: "files",
        message: "Loading uploaded source files",
      })
    );
    for (let index = 0; index < sourceManifest.length; index += 1) {
      const source = sourceManifest[index]!;
      const raw = await loadRawSource(userId, source.storageKey);
      if (!raw) continue;
      const decoded =
        source.encoding === "base64"
          ? Buffer.from(raw, "base64").toString("utf8")
          : raw;
      if (decoded.length > 0) sourceCsvs.push(decoded);
      reportProgress?.(
        buildSyncProgress({
          phase: "loading_payload",
          startPercent: 0,
          endPercent: 15,
          current: index + 1,
          total: sourceManifest.length,
          unitLabel: "files",
          message: "Loading uploaded source files",
        })
      );
    }
    if (sourceCsvs.length === 0) return null;
    return mergeCsvTexts(sourceCsvs);
  }

  // Case 2: top-level chunk pointer (legacy).
  const chunkKeys = parseChunkPointerPayload(basePayload);
  if (chunkKeys && chunkKeys.length > 0) {
    let merged = "";
    reportProgress?.(
      buildSyncProgress({
        phase: "loading_payload",
        startPercent: 0,
        endPercent: 15,
        current: 0,
        total: chunkKeys.length,
        unitLabel: "chunks",
        message: "Loading uploaded source chunks",
      })
    );
    for (let index = 0; index < chunkKeys.length; index += 1) {
      const chunkKey = chunkKeys[index]!;
      const chunk = await getSolarRecDashboardPayload(
        userId,
        `dataset:${chunkKey}`
      );
      if (typeof chunk !== "string") {
        throw new Error(
          `Missing chunk '${chunkKey}' for dataset '${datasetKey}'`
        );
      }
      merged += chunk;
      reportProgress?.(
        buildSyncProgress({
          phase: "loading_payload",
          startPercent: 0,
          endPercent: 15,
          current: index + 1,
          total: chunkKeys.length,
          unitLabel: "chunks",
          message: "Loading uploaded source chunks",
        })
      );
    }
    // 2026-05-12 — `splitTextIntoChunks` (the v1 client-side chunker)
    // slices the SAME `serializeDatasetForRemote()` envelope into
    // ≤250 KB substrings. Reassembling concatenates them back into
    // the original envelope JSON, so the post-reassembly result needs
    // the same unwrap as the unchunked Case 3 path below. PR #559
    // initial revision missed this and only fixed Case 3, leaving
    // the multi-MB stuck datasets (4.76 MB abpQuickBooksRows etc.)
    // still broken because they hit Case 2.
    return maybeUnwrapV1Envelope(merged);
  }

  // Case 3: direct payload — either raw CSV text OR a legacy v1
  // upload envelope.
  //
  // 2026-05-12 — the v1 `saveDataset` proc stored payloads as a JSON
  // envelope `{ fileName, uploadedAt, headers, csvText }` for
  // datasets that fit under the single-row chunk limit (no manifest,
  // no chunk pointer indirection). For those datasets Case 1 and
  // Case 2 both return null, and the migration code below feeds
  // `basePayload` to `parseCsvText` — which then parses the
  // envelope keys (`fileName`, `uploadedAt`, `headers`, `csvText`)
  // as if they were the dataset's CSV header row, producing
  // "missing required columns" errors. abpUtilityInvoiceRows
  // (~308 KB) fits Case 3 after the chunker decided NOT to split a
  // payload barely over the threshold in early uploads (single
  // raw row stored direct). Same envelope, same unwrap.
  return maybeUnwrapV1Envelope(basePayload);
}

// ---------------------------------------------------------------------------
// Single-dataset migration
// ---------------------------------------------------------------------------

async function migrateOneDataset(
  scopeId: string,
  datasetKey: CoreDatasetKey,
  ownerUserId: number,
  reportProgress?: DatasetSyncProgressReporter
): Promise<DatasetMigrationStatus> {
  const start = Date.now();

  // loadDatasetPayload returns the raw, assembled CSV text — the
  // source manifest / chunk pointer indirection is unwrapped
  // internally.
  let csvText: string | null = null;
  try {
    csvText = await loadDatasetPayload(ownerUserId, datasetKey, reportProgress);
  } catch (err) {
    return {
      datasetKey,
      state: "failed",
      error: err instanceof Error ? err.message : "Load payload failed",
    };
  }

  if (!csvText || csvText.length === 0) {
    return {
      datasetKey,
      state: "skipped",
      reason: "No payload found in dashboard storage",
    };
  }

  // Sanity check: first line should contain the header with a comma.
  const firstNewline = csvText.indexOf("\n");
  const firstLine =
    firstNewline === -1 ? csvText : csvText.slice(0, firstNewline);
  if (!firstLine.includes(",")) {
    return {
      datasetKey,
      state: "failed",
      error: `Payload does not look like CSV (first line: "${firstLine.slice(0, 80)}")`,
    };
  }

  const fileName = `${datasetKey}.csv`;

  try {
    // Append-style datasets (accountSolarGeneration, transferHistory)
    // need dedupe-append semantics so re-syncing from
    // solarRecDashboardStorage can't truncate accumulated rows that
    // a previous active batch already has. The server's
    // ingestDataset append path clones the previous batch's rows
    // into the new batch and then filters the upload for rows that
    // are already present (by dataset-specific key fields), so
    // re-ingesting the same data is a no-op and re-ingesting
    // partial data preserves everything.
    const mode = modeForDataset(datasetKey);
    const result = await ingestDataset(
      scopeId,
      datasetKey,
      csvText,
      fileName,
      mode,
      ownerUserId,
      reportProgress
    );

    if (result.status === "failed") {
      return {
        datasetKey,
        state: "failed",
        error: result.errors?.[0]?.message ?? "Ingest returned failed status",
      };
    }

    return {
      datasetKey,
      state: "done",
      batchId: result.batchId,
      rowCount: result.rowCount,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      datasetKey,
      state: "failed",
      error: err instanceof Error ? err.message : "Ingest threw",
    };
  }
}

/**
 * Public entry point to sync ONE core dataset from
 * solarRecDashboardStorage into its typed srDs* table.
 *
 * Single-flight (for the same scope+datasetKey) is enforced one
 * layer up by the core dataset sync job registry in
 * `coreDatasetSyncJobs.ts`. This function is what that registry
 * calls to actually do the work — it assumes the caller has
 * already checked no other job is in flight.
 *
 * Never throws on ingest failure: returns a DatasetMigrationStatus
 * with state="failed" so the job registry can record the error.
 */
export async function syncOneCoreDatasetFromStorage(
  scopeId: string,
  datasetKey: string,
  ownerUserId: number,
  reportProgress?: DatasetSyncProgressReporter
): Promise<DatasetMigrationStatus> {
  if (!isCoreDatasetKey(datasetKey)) {
    return {
      datasetKey,
      state: "skipped",
      reason: "Not a core dataset — no srDs* table for this key",
    };
  }
  return migrateOneDataset(scopeId, datasetKey, ownerUserId, reportProgress);
}

// ---------------------------------------------------------------------------
// Job runner
// ---------------------------------------------------------------------------

async function runMigrationJob(job: ServerMigrationJobState): Promise<void> {
  for (let i = 0; i < CORE_DATASETS.length; i++) {
    const datasetKey = CORE_DATASETS[i];

    // Mark running.
    job.datasets[i] = {
      datasetKey,
      state: "running",
      startedAt: new Date().toISOString(),
    };

    const result = await migrateOneDataset(
      job.scopeId,
      datasetKey,
      job.ownerUserId
    );
    job.datasets[i] = result;

    // Yield to the event loop between datasets so tRPC status polls
    // can be served without waiting for the next dataset to finish.
    await new Promise((resolve) => setImmediate(resolve));
  }

  const anyFailed = job.datasets.some((d) => d.state === "failed");
  job.status = anyFailed ? "failed" : "done";
  job.completedAt = new Date().toISOString();

  // Release the scope lock.
  if (activeJobByScope.get(job.scopeId) === job.jobId) {
    activeJobByScope.delete(job.scopeId);
  }
}

/**
 * Start a server-side migration. Fire-and-forget: returns the job
 * ID immediately, the actual work continues in the background.
 *
 * If a migration is already running for this scope, returns the
 * existing job ID rather than starting a new one.
 */
export function startServerSideMigration(
  scopeId: string,
  ownerUserId: number
): string {
  const existingJobId = activeJobByScope.get(scopeId);
  if (existingJobId && migrationJobs.has(existingJobId)) {
    const existing = migrationJobs.get(existingJobId)!;
    if (existing.status === "running") return existingJobId;
  }

  const jobId = nanoid();
  const job: ServerMigrationJobState = {
    jobId,
    scopeId,
    ownerUserId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    datasets: CORE_DATASETS.map((datasetKey) => ({
      datasetKey,
      state: "pending",
    })),
  };
  migrationJobs.set(jobId, job);
  activeJobByScope.set(scopeId, jobId);

  // Fire and forget. Surface any unhandled errors into the job state.
  void runMigrationJob(job).catch((err) => {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    console.error("[serverSideMigration]", jobId, err);
    if (activeJobByScope.get(scopeId) === jobId) {
      activeJobByScope.delete(scopeId);
    }
  });

  return jobId;
}
