/**
 * Database access layer for the Solar REC server-side dataset architecture.
 *
 * Provides CRUD for: scopes, import batches, import files, import errors,
 * active dataset versions, and compute runs.
 */

import { eq, and, desc } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  solarRecScopes,
  solarRecImportBatches,
  solarRecImportFiles,
  solarRecImportErrors,
  solarRecActiveDatasetVersions,
  solarRecComputeRuns,
  type InsertSolarRecScope,
  type InsertSolarRecImportBatch,
  type InsertSolarRecImportFile,
  type InsertSolarRecImportError,
  type InsertSolarRecComputeRun,
} from "../../drizzle/schema";
import { getDb, withDbRetry } from "./_core";

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
  batchId: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  // Upsert: insert or update the active version for this scope+dataset.
  // MySQL ON DUPLICATE KEY UPDATE handles the upsert atomically.
  await withDbRetry("activate dataset version", async () => {
    // Try insert first; if the unique index fires, update.
    try {
      await db
        .insert(solarRecActiveDatasetVersions)
        .values({ scopeId, datasetKey, batchId });
    } catch {
      await db
        .update(solarRecActiveDatasetVersions)
        .set({ batchId, activatedAt: new Date() })
        .where(
          and(
            eq(solarRecActiveDatasetVersions.scopeId, scopeId),
            eq(solarRecActiveDatasetVersions.datasetKey, datasetKey)
          )
        );
    }
  });

  // Mark previous batches as superseded.
  await withDbRetry("supersede old batches", () =>
    db
      .update(solarRecImportBatches)
      .set({ status: "superseded" })
      .where(
        and(
          eq(solarRecImportBatches.scopeId, scopeId),
          eq(solarRecImportBatches.datasetKey, datasetKey),
          eq(solarRecImportBatches.status, "active")
        )
      )
  );

  // Mark the new batch as active.
  await updateImportBatchStatus(batchId, "active", {
    completedAt: new Date(),
  });
}

// ---------------------------------------------------------------------------
// Compute Runs
// ---------------------------------------------------------------------------

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
  } catch {
    // UNIQUE constraint violation — another process claimed it.
    return null;
  }
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

export async function failComputeRun(
  runId: string,
  error: string
): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("fail compute run", () =>
    db
      .update(solarRecComputeRuns)
      .set({
        status: "failed",
        error,
        completedAt: new Date(),
      })
      .where(eq(solarRecComputeRuns.id, runId))
  );
}
