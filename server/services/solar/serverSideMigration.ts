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
import { parseChunkPointerPayload } from "../../routers/helpers";

// ---------------------------------------------------------------------------
// Dataset list
// ---------------------------------------------------------------------------

const CORE_DATASETS = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "contractedDate",
  "deliveryScheduleBase",
  "transferHistory",
] as const;

type CoreDatasetKey = (typeof CORE_DATASETS)[number];

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
// Payload loading — handles the chunk-pointer indirection used by the
// existing dashboard storage for large datasets.
// ---------------------------------------------------------------------------

async function loadDatasetPayload(
  userId: number,
  datasetKey: string
): Promise<string | null> {
  const basePayload = await getSolarRecDashboardPayload(
    userId,
    `dataset:${datasetKey}`
  );
  if (!basePayload) return null;

  const chunkKeys = parseChunkPointerPayload(basePayload);
  if (!chunkKeys || chunkKeys.length === 0) {
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
        `Missing chunk '${chunkKey}' for dataset '${datasetKey}'`
      );
    }
    merged += chunk;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Single-dataset migration
// ---------------------------------------------------------------------------

type RemoteDatasetPayload = {
  fileName?: string;
  uploadedAt?: string;
  headers?: string[];
  csvText?: string;
};

async function migrateOneDataset(
  scopeId: string,
  datasetKey: CoreDatasetKey,
  ownerUserId: number
): Promise<DatasetMigrationStatus> {
  const start = Date.now();
  let payload: string | null = null;
  try {
    payload = await loadDatasetPayload(ownerUserId, datasetKey);
  } catch (err) {
    return {
      datasetKey,
      state: "failed",
      error: err instanceof Error ? err.message : "Load payload failed",
    };
  }

  if (!payload) {
    return {
      datasetKey,
      state: "skipped",
      reason: "No payload found in dashboard storage",
    };
  }

  let parsed: RemoteDatasetPayload;
  try {
    parsed = JSON.parse(payload) as RemoteDatasetPayload;
  } catch (err) {
    return {
      datasetKey,
      state: "failed",
      error: `JSON parse failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // Free the original payload string for GC ASAP.
  payload = null;

  const csvText = parsed.csvText;
  const fileName = parsed.fileName ?? `${datasetKey}.csv`;
  if (!csvText || csvText.length === 0) {
    return {
      datasetKey,
      state: "skipped",
      reason: "Payload has empty csvText",
    };
  }

  try {
    const result = await ingestDataset(
      scopeId,
      datasetKey,
      csvText,
      fileName,
      "replace",
      ownerUserId
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
