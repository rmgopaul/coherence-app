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

async function loadDatasetPayload(
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
    return merged;
  }

  // Case 3: direct payload (very small datasets only).
  return basePayload;
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
