/**
 * Database access layer for the Solar REC server-side dataset architecture.
 *
 * Provides CRUD for: scopes, import batches, import files, import errors,
 * active dataset versions, and compute runs.
 */

import { eq, and, desc, asc, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  solarRecScopes,
  solarRecImportBatches,
  solarRecImportFiles,
  solarRecImportErrors,
  solarRecActiveDatasetVersions,
  solarRecComputeRuns,
  solarRecComputedArtifacts,
  type InsertSolarRecScope,
  type InsertSolarRecImportBatch,
  type InsertSolarRecImportFile,
  type InsertSolarRecImportError,
  type InsertSolarRecComputeRun,
} from "../../drizzle/schema";
import { getDb, withDbRetry } from "./_core";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

function isDuplicateKeyError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === "ER_DUP_ENTRY" || code === "ER_DUP_KEY") return true;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("duplicate entry") ||
    message.includes("duplicate key") ||
    message.includes("unique constraint")
  );
}

function isMissingTableError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (code === "ER_NO_SUCH_TABLE") return true;

  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("doesn't exist") ||
    message.includes("does not exist") ||
    message.includes("unknown table")
  );
}

function truncateComputeRunError(value: string, maxChars = 16_000): string {
  if (value.length <= maxChars) return value;
  const suffix = "... [truncated]";
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

const ARCHIVED_BATCH_STATUS = "archived";
const SUPERSEDED_BATCH_RETENTION_DAYS = 14;
const STARTUP_BATCH_ARCHIVE_LIMIT = 2;

function isOlderThanRetentionWindow(
  candidateDate: Date | string | null | undefined,
  retentionDays: number,
  nowMs = Date.now()
): boolean {
  if (!candidateDate) return false;
  const timestamp = new Date(candidateDate).getTime();
  if (!Number.isFinite(timestamp)) return false;
  return timestamp < nowMs - retentionDays * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

export async function getOrCreateScope(
  scopeId: string,
  ownerUserId: number
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await withDbRetry("get scope", () =>
    db
      .select()
      .from(solarRecScopes)
      .where(eq(solarRecScopes.id, scopeId))
      .limit(1)
  );

  if (existing.length > 0) return existing[0].id;

  const scope: InsertSolarRecScope = {
    id: scopeId,
    name: `Scope for user ${ownerUserId}`,
    ownerUserId,
  };

  await withDbRetry("create scope", () =>
    db.insert(solarRecScopes).values(scope)
  );

  return scopeId;
}

// ---------------------------------------------------------------------------
// Import Batches
// ---------------------------------------------------------------------------

export async function createImportBatch(
  batch: Omit<InsertSolarRecImportBatch, "id" | "createdAt">
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const id = nanoid();
  await withDbRetry("create import batch", () =>
    db.insert(solarRecImportBatches).values({ ...batch, id })
  );

  return id;
}

export async function getImportBatch(batchId: string) {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry("get import batch", () =>
    db
      .select()
      .from(solarRecImportBatches)
      .where(eq(solarRecImportBatches.id, batchId))
      .limit(1)
  );

  return rows[0] ?? null;
}

export async function updateImportBatchStatus(
  batchId: string,
  status: string,
  updates: { rowCount?: number; error?: string; completedAt?: Date } = {}
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("update import batch status", () =>
    db
      .update(solarRecImportBatches)
      .set({
        status,
        ...(updates.rowCount !== undefined ? { rowCount: updates.rowCount } : {}),
        ...(updates.error !== undefined ? { error: updates.error } : {}),
        ...(updates.completedAt ? { completedAt: updates.completedAt } : {}),
      })
      .where(eq(solarRecImportBatches.id, batchId))
  );
}

export async function getActiveBatchForDataset(
  scopeId: string,
  datasetKey: string
) {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry("get active batch for dataset", () =>
    db
      .select()
      .from(solarRecImportBatches)
      .where(
        and(
          eq(solarRecImportBatches.scopeId, scopeId),
          eq(solarRecImportBatches.datasetKey, datasetKey),
          eq(solarRecImportBatches.status, "active")
        )
      )
      .orderBy(desc(solarRecImportBatches.createdAt))
      .limit(1)
  );

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Import Files
// ---------------------------------------------------------------------------

export async function createImportFile(
  file: Omit<InsertSolarRecImportFile, "id" | "createdAt">
): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const id = nanoid();
  await withDbRetry("create import file", () =>
    db.insert(solarRecImportFiles).values({ ...file, id })
  );

  return id;
}

// ---------------------------------------------------------------------------
// Import Errors
// ---------------------------------------------------------------------------

export async function createImportErrors(
  errors: Omit<InsertSolarRecImportError, "id" | "createdAt">[]
): Promise<void> {
  const db = await getDb();
  if (!db || errors.length === 0) return;

  const rows = errors.map((err) => ({ ...err, id: nanoid() }));
  await withDbRetry("create import errors", () =>
    db.insert(solarRecImportErrors).values(rows)
  );
}

export async function getImportErrors(batchId: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get import errors", () =>
    db
      .select()
      .from(solarRecImportErrors)
      .where(eq(solarRecImportErrors.batchId, batchId))
  );
}

// ---------------------------------------------------------------------------
// Active Dataset Versions
// ---------------------------------------------------------------------------

export async function getActiveDatasetVersions(scopeId: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get active dataset versions", () =>
    db
      .select()
      .from(solarRecActiveDatasetVersions)
      .where(eq(solarRecActiveDatasetVersions.scopeId, scopeId))
  );
}

export async function getActiveVersionsForKeys(
  scopeId: string,
  datasetKeys: string[]
): Promise<Array<{ datasetKey: string; batchId: string }>> {
  const all = await getActiveDatasetVersions(scopeId);
  const keySet = new Set(datasetKeys);
  return all
    .filter((v) => keySet.has(v.datasetKey))
    .map((v) => ({ datasetKey: v.datasetKey, batchId: v.batchId }));
}

export async function activateDatasetVersion(
  scopeId: string,
  datasetKey: string,
  batchId: string,
  options: { rowCount?: number; completedAt?: Date } = {}
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const activatedAt = new Date();
  const completedAt = options.completedAt ?? activatedAt;

  await withDbRetry("activate dataset version", () =>
    db.transaction(async (tx) => {
      // Supersede the prior active batch BEFORE swapping the pointer so we
      // don't accidentally match the new batch in the status update below.
      await tx
        .update(solarRecImportBatches)
        .set({ status: "superseded" })
        .where(
          and(
            eq(solarRecImportBatches.scopeId, scopeId),
            eq(solarRecImportBatches.datasetKey, datasetKey),
            eq(solarRecImportBatches.status, "active")
          )
        );

      await tx
        .insert(solarRecActiveDatasetVersions)
        .values({ scopeId, datasetKey, batchId, activatedAt })
        .onDuplicateKeyUpdate({
          set: {
            batchId,
            activatedAt,
          },
        });

      await tx
        .update(solarRecImportBatches)
        .set({
          status: "active",
          ...(options.rowCount !== undefined
            ? { rowCount: options.rowCount }
            : {}),
          completedAt,
        })
        .where(eq(solarRecImportBatches.id, batchId));
    })
  );
}

/**
 * Mark import batches left mid-ingest by a prior Node process as failed so
 * the UI does not poll "processing" forever after a restart.
 *
 * Safe for the current single-dyno deployment because startup runs before
 * the server begins accepting new ingest requests.
 */
export async function clearOrphanedImportBatchesOnStartup(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const now = new Date();
  const result = await withDbRetry("clear orphaned import batches", () =>
    db
      .update(solarRecImportBatches)
      .set({
        status: "failed",
        error: "orphaned by server restart",
        completedAt: now,
      })
      .where(
        sql`${solarRecImportBatches.status} IN ('uploading', 'processing')`
      )
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any)?.[0]?.affectedRows ?? 0;
}

/**
 * Purge typed dataset rows for old superseded batches, then mark those
 * batches as archived so the cleanup does not repeat on every restart.
 *
 * We intentionally keep the import batch + file metadata for auditability and
 * to retain references to the original uploaded raw files. The expensive part
 * is the typed srDs* row data; that is what this startup cleanup reclaims.
 */
export async function archiveSupersededImportBatchesOnStartup(
  limit = STARTUP_BATCH_ARCHIVE_LIMIT
): Promise<{ archivedBatches: number; purgedRows: number }> {
  const db = await getDb();
  if (!db || limit <= 0) {
    return { archivedBatches: 0, purgedRows: 0 };
  }

  const [activeVersions, candidates] = await Promise.all([
    withDbRetry("load active dataset versions for archive cleanup", () =>
      db
        .select({ batchId: solarRecActiveDatasetVersions.batchId })
        .from(solarRecActiveDatasetVersions)
    ),
    withDbRetry("load superseded import batches for archive cleanup", () =>
      db
        .select({
          id: solarRecImportBatches.id,
          datasetKey: solarRecImportBatches.datasetKey,
          completedAt: solarRecImportBatches.completedAt,
        })
        .from(solarRecImportBatches)
        .where(eq(solarRecImportBatches.status, "superseded"))
        .orderBy(
          asc(solarRecImportBatches.completedAt),
          asc(solarRecImportBatches.createdAt)
        )
        .limit(limit * 10)
    ),
  ]);

  const activeBatchIds = new Set(activeVersions.map((row) => row.batchId));
  const batchesToArchive = candidates
    .filter(
      (batch) =>
        !activeBatchIds.has(batch.id) &&
        isOlderThanRetentionWindow(
          batch.completedAt,
          SUPERSEDED_BATCH_RETENTION_DAYS
        )
    )
    .slice(0, limit);

  if (batchesToArchive.length === 0) {
    return { archivedBatches: 0, purgedRows: 0 };
  }

  const { deleteDatasetBatchRows } = await import(
    "../services/solar/datasetRowPersistence"
  );

  let archivedBatches = 0;
  let purgedRows = 0;

  for (const batch of batchesToArchive) {
    purgedRows += await deleteDatasetBatchRows(batch.datasetKey, batch.id);

    await withDbRetry("mark import batch archived", () =>
      db
        .update(solarRecImportBatches)
        .set({
          status: ARCHIVED_BATCH_STATUS,
        })
        .where(eq(solarRecImportBatches.id, batch.id))
    );
    archivedBatches += 1;
  }

  return { archivedBatches, purgedRows };
}

/**
 * Aggressive one-shot cleanup: purges typed srDs* rows and marks
 * batches as archived for every superseded/failed batch that is
 * not currently referenced by `solarRecActiveDatasetVersions`,
 * regardless of retention window.
 *
 * Distinct from `archiveSupersededImportBatchesOnStartup` which
 * respects the 14-day retention window and a 2-batch-per-startup
 * throttle — appropriate for steady-state operation, but too
 * conservative when the DB has built up chaos from a migration
 * or heavy recovery flow.
 *
 * Intended to be called manually via a tRPC endpoint, not on a
 * schedule. Hard upper bound on batches processed per call so
 * the request doesn't exceed Render's proxy timeout on a very
 * bloated database.
 */
export async function purgeOrphanedDatasetRowsNow(
  maxBatches = 200
): Promise<{
  archivedBatches: number;
  purgedRows: number;
  skippedDueToLimit: boolean;
}> {
  const db = await getDb();
  if (!db) {
    return { archivedBatches: 0, purgedRows: 0, skippedDueToLimit: false };
  }

  // Load active batch ids once; anything referenced is off-limits.
  const activeVersions = await withDbRetry(
    "load active dataset versions for purge",
    () =>
      db
        .select({ batchId: solarRecActiveDatasetVersions.batchId })
        .from(solarRecActiveDatasetVersions)
  );
  const activeBatchIds = new Set(
    activeVersions.map((row) => row.batchId).filter(Boolean) as string[]
  );

  // Candidates: any batch in superseded OR failed state. Archived
  // batches we leave alone — they've already had their rows
  // purged by a previous run.
  const candidates = await withDbRetry(
    "load candidate batches for aggressive purge",
    () =>
      db
        .select({
          id: solarRecImportBatches.id,
          datasetKey: solarRecImportBatches.datasetKey,
        })
        .from(solarRecImportBatches)
        .where(
          sql`${solarRecImportBatches.status} IN ('superseded', 'failed')`
        )
        .orderBy(asc(solarRecImportBatches.createdAt))
        .limit(maxBatches + 1)
  );

  const skippedDueToLimit = candidates.length > maxBatches;
  const batchesToArchive = candidates
    .slice(0, maxBatches)
    .filter((batch) => !activeBatchIds.has(batch.id));

  if (batchesToArchive.length === 0) {
    return { archivedBatches: 0, purgedRows: 0, skippedDueToLimit };
  }

  const { deleteDatasetBatchRows } = await import(
    "../services/solar/datasetRowPersistence"
  );

  let archivedBatches = 0;
  let purgedRows = 0;

  for (const batch of batchesToArchive) {
    purgedRows += await deleteDatasetBatchRows(batch.datasetKey, batch.id);

    await withDbRetry("mark import batch archived (aggressive purge)", () =>
      db
        .update(solarRecImportBatches)
        .set({ status: ARCHIVED_BATCH_STATUS })
        .where(eq(solarRecImportBatches.id, batch.id))
    );
    archivedBatches += 1;
  }

  return { archivedBatches, purgedRows, skippedDueToLimit };
}

// ---------------------------------------------------------------------------
// Compute Runs
// ---------------------------------------------------------------------------

/**
 * Mark every compute_run still in "running" state as failed. Intended
 * to run exactly once at process startup so that a previous process's
 * orphaned runs (killed mid-compute by a Render restart, OOM, or
 * deploy) don't block new requests for up to 10 minutes while the
 * self-heal threshold waits them out.
 *
 * Safe because this process is, by definition, fresh — there can be
 * no compute run genuinely running inside THIS process at startup.
 * Other concurrent processes are a non-concern for the current
 * single-dyno Render setup, but when we eventually scale out this
 * should switch to a heartbeat-based liveness check instead.
 */
export async function clearOrphanedComputeRunsOnStartup(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const now = new Date();
  const result = await withDbRetry("clear orphaned compute runs", () =>
    db
      .update(solarRecComputeRuns)
      .set({
        status: "failed",
        error: "orphaned by server restart",
        completedAt: now,
      })
      .where(eq(solarRecComputeRuns.status, "running"))
  );
  // drizzle mysql result shape is driver-specific; the caller only
  // needs a rough number for logging.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (result as any)?.[0]?.affectedRows ?? 0;
}

/**
 * Claim a compute run. Returns the run ID if claimed, or null if another
 * process already claimed this (scopeId, artifactType, inputVersionHash).
 */
export async function claimComputeRun(
  run: Omit<InsertSolarRecComputeRun, "id" | "startedAt">
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;

  const id = nanoid();
  try {
    await db.insert(solarRecComputeRuns).values({
      ...run,
      id,
      status: "running",
    });
    return id;
  } catch (error) {
    if (!isDuplicateKeyError(error)) {
      throw error;
    }
    return null;
  }
}

/**
 * Reclaim an existing compute_run row for (scope, artifact, hash) by
 * resetting it to running=now. Used when the previous run is stale
 * (status=running but startedAt older than the self-heal threshold)
 * or failed — this swaps the row back into the runnable state without
 * hitting the UNIQUE constraint that blocks fresh claims.
 *
 * Returns the existing row id.
 */
export async function reclaimComputeRun(
  runId: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("reclaim compute run", () =>
    db
      .update(solarRecComputeRuns)
      .set({
        status: "running",
        error: null,
        rowCount: null,
        startedAt: new Date(),
        completedAt: null,
      })
      .where(eq(solarRecComputeRuns.id, runId))
  );
}

export async function getComputeRun(
  scopeId: string,
  artifactType: string,
  inputVersionHash: string
) {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry("get compute run", () =>
    db
      .select()
      .from(solarRecComputeRuns)
      .where(
        and(
          eq(solarRecComputeRuns.scopeId, scopeId),
          eq(solarRecComputeRuns.artifactType, artifactType),
          eq(solarRecComputeRuns.inputVersionHash, inputVersionHash)
        )
      )
      .limit(1)
  );

  return rows[0] ?? null;
}

export async function completeComputeRun(
  runId: string,
  rowCount: number
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("complete compute run", () =>
    db
      .update(solarRecComputeRuns)
      .set({
        status: "completed",
        rowCount,
        completedAt: new Date(),
      })
      .where(eq(solarRecComputeRuns.id, runId))
  );
}

export async function getComputedArtifact(
  scopeId: string,
  artifactType: string,
  inputVersionHash: string
) {
  const db = await getDb();
  if (!db) return null;

  let rows;
  try {
    rows = await withDbRetry("get computed artifact", () =>
      db
        .select()
        .from(solarRecComputedArtifacts)
        .where(
          and(
            eq(solarRecComputedArtifacts.scopeId, scopeId),
            eq(solarRecComputedArtifacts.artifactType, artifactType),
            eq(solarRecComputedArtifacts.inputVersionHash, inputVersionHash)
          )
        )
        .limit(1)
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      return null;
    }
    throw error;
  }

  return rows[0] ?? null;
}

export async function upsertComputedArtifact(data: {
  scopeId: string;
  artifactType: string;
  inputVersionHash: string;
  payload: string;
  rowCount: number;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const now = new Date();

  try {
    await withDbRetry("upsert computed artifact", () =>
      db
        .insert(solarRecComputedArtifacts)
        .values({
          id: nanoid(),
          scopeId: data.scopeId,
          artifactType: data.artifactType,
          inputVersionHash: data.inputVersionHash,
          payload: data.payload,
          rowCount: data.rowCount,
          createdAt: now,
          updatedAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            payload: data.payload,
            rowCount: data.rowCount,
            updatedAt: now,
          },
        })
    );
  } catch (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Scope Contract Scan Version Bridge
// ---------------------------------------------------------------------------

export async function getScopeContractScanVersion(scopeId: string) {
  const db = await getDb();
  if (!db) return null;

  const { solarRecScopeContractScanVersion } = await import("../../drizzle/schema");
  const rows = await withDbRetry("get scope scan version", () =>
    db
      .select()
      .from(solarRecScopeContractScanVersion)
      .where(eq(solarRecScopeContractScanVersion.scopeId, scopeId))
      .limit(1)
  );

  return rows[0] ?? null;
}

export async function bumpScopeContractScanJobVersion(
  scopeId: string,
  completedJobId: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const { solarRecScopeContractScanVersion } = await import("../../drizzle/schema");
  try {
    await db.insert(solarRecScopeContractScanVersion).values({
      scopeId,
      latestCompletedJobId: completedJobId,
    });
  } catch {
    await db
      .update(solarRecScopeContractScanVersion)
      .set({ latestCompletedJobId: completedJobId })
      .where(eq(solarRecScopeContractScanVersion.scopeId, scopeId));
  }
}

export async function bumpScopeContractScanOverrideVersion(
  scopeId: string,
  overrideAt: Date
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  const { solarRecScopeContractScanVersion } = await import("../../drizzle/schema");
  try {
    await db.insert(solarRecScopeContractScanVersion).values({
      scopeId,
      latestOverrideAt: overrideAt,
    });
  } catch {
    await db
      .update(solarRecScopeContractScanVersion)
      .set({ latestOverrideAt: overrideAt })
      .where(eq(solarRecScopeContractScanVersion.scopeId, scopeId));
  }
}

export async function failComputeRun(
  runId: string,
  error: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  const safeError = truncateComputeRunError(error);

  await withDbRetry("fail compute run", () =>
    db
      .update(solarRecComputeRuns)
      .set({
        status: "failed",
        error: safeError,
        completedAt: new Date(),
      })
      .where(eq(solarRecComputeRuns.id, runId))
  );
}
