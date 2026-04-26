import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  desc,
  sql,
  getDb,
  withDbRetry,
  ensureScheduleBImportTables,
  ensureScheduleBImportCsgIdsTable,
  getDbExecuteAffectedRows,
} from "./_core";
import {
  scheduleBImportJobs,
  scheduleBImportFiles,
  scheduleBImportResults,
  scheduleBImportCsgIds,
} from "../../drizzle/schema";

// ── Schedule B Import Jobs ─────────────────────────────────────────

export type ScheduleBImportJobStatus =
  | "queued"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed";

export type ScheduleBImportFileStatus =
  | "uploading"
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export async function createScheduleBImportJob(
  data: {
    userId: number;
    scopeId: string;
  }
) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) throw new Error("Schedule B import table initialization failed");

  const id = nanoid();
  const now = new Date();
  await withDbRetry("create schedule b import job", async () => {
    await db.insert(scheduleBImportJobs).values({
      id,
      userId: data.userId,
      scopeId: data.scopeId,
      status: "queued",
      currentFileName: null,
      error: null,
      startedAt: null,
      stoppedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
  return id;
}

export async function getScheduleBImportJob(jobId: string) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return null;
  return withDbRetry("get schedule b import job", async () => {
    const [row] = await db
      .select()
      .from(scheduleBImportJobs)
      .where(eq(scheduleBImportJobs.id, jobId))
      .limit(1);
    return row ?? null;
  });
}

export async function getLatestScheduleBImportJob(scopeId: string) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return null;
  return withDbRetry("get latest schedule b import job", async () => {
    const [row] = await db
      .select()
      .from(scheduleBImportJobs)
      .where(eq(scheduleBImportJobs.scopeId, scopeId))
      .orderBy(desc(scheduleBImportJobs.createdAt))
      .limit(1);
    return row ?? null;
  });
}

export async function updateScheduleBImportJob(
  jobId: string,
  data: Partial<{
    status: ScheduleBImportJobStatus;
    currentFileName: string | null;
    error: string | null;
    startedAt: Date | null;
    stoppedAt: Date | null;
    completedAt: Date | null;
    totalFiles: number;
    successCount: number;
    failureCount: number;
  }>
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("update schedule b import job", async () => {
    await db
      .update(scheduleBImportJobs)
      .set(data)
      .where(eq(scheduleBImportJobs.id, jobId));
  });
}

/**
 * Atomically increment a counter column on the Schedule B job row. Mirrors
 * `incrementContractScanJobCounter` — the contract scraper's pattern for
 * tracking progress without relying on derived COUNT(*) queries over a
 * file-state table.
 */
export async function incrementScheduleBImportJobCounter(
  jobId: string,
  field: "successCount" | "failureCount" | "totalFiles"
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("increment schedule b import job counter", async () => {
    await db
      .update(scheduleBImportJobs)
      .set({
        [field]: sql`${scheduleBImportJobs[field]} + 1`,
      })
      .where(eq(scheduleBImportJobs.id, jobId));
  });
}

export async function getOrCreateLatestScheduleBImportJob(
  scopeId: string,
  userId: number
) {
  const existing = await getLatestScheduleBImportJob(scopeId);
  if (existing) return existing;
  const id = await createScheduleBImportJob({ userId, scopeId });
  const created = await getScheduleBImportJob(id);
  if (!created) {
    throw new Error("Failed to create Schedule B import job.");
  }
  return created;
}

// ── Schedule B Import Files ───────────────────────────────────────

export async function getScheduleBImportFile(jobId: string, fileName: string) {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return null;
  return withDbRetry("get schedule b import file", async () => {
    const [row] = await db
      .select()
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.fileName, fileName)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

/**
 * Resolve the scopeId for a job by reading the parent
 * `scheduleBImportJobs` row. Used by insert helpers in this module
 * that take a `jobId` but need to set `scopeId` on the new child row
 * to satisfy the post-Task-5.6-PR-B NOT NULL constraint.
 */
async function resolveScopeIdForJob(jobId: string): Promise<string> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database unavailable");
  }
  const [row] = await db
    .select({ scopeId: scheduleBImportJobs.scopeId })
    .from(scheduleBImportJobs)
    .where(eq(scheduleBImportJobs.id, jobId))
    .limit(1);
  if (!row?.scopeId) {
    throw new Error(
      `Schedule B job ${jobId} has no scopeId — backfill migration may not have run`
    );
  }
  return row.scopeId;
}

export async function upsertScheduleBImportFileUploadProgress(
  data: {
    jobId: string;
    fileName: string;
    fileSize: number;
    uploadedChunks: number;
    totalChunks: number;
    status: ScheduleBImportFileStatus;
    storageKey?: string | null;
    error?: string | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  const now = new Date();

  await withDbRetry("upsert schedule b import file upload progress", async () => {
    const existing = await db
      .select({ id: scheduleBImportFiles.id })
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(scheduleBImportFiles)
        .set({
          fileSize: data.fileSize,
          uploadedChunks: data.uploadedChunks,
          totalChunks: data.totalChunks,
          status: data.status,
          storageKey:
            data.storageKey !== undefined
              ? data.storageKey
              : sql`${scheduleBImportFiles.storageKey}`,
          error: data.error ?? null,
          updatedAt: now,
        })
        .where(eq(scheduleBImportFiles.id, existing[0].id));
      return;
    }

    const scopeId = await resolveScopeIdForJob(data.jobId);
    await db.insert(scheduleBImportFiles).values({
      id: nanoid(),
      jobId: data.jobId,
      scopeId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      storageKey: data.storageKey ?? null,
      status: data.status,
      uploadedChunks: data.uploadedChunks,
      totalChunks: data.totalChunks,
      error: data.error ?? null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function markScheduleBImportFileQueued(
  data: {
    jobId: string;
    fileName: string;
    fileSize: number;
    totalChunks: number;
    storageKey: string;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  const now = new Date();

  await withDbRetry("mark schedule b import file queued", async () => {
    const existing = await db
      .select({ id: scheduleBImportFiles.id })
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(scheduleBImportFiles)
        .set({
          fileSize: data.fileSize,
          totalChunks: data.totalChunks,
          uploadedChunks: data.totalChunks,
          storageKey: data.storageKey,
          status: "queued",
          error: null,
          updatedAt: now,
        })
        .where(eq(scheduleBImportFiles.id, existing[0].id));
      return;
    }

    const scopeId = await resolveScopeIdForJob(data.jobId);
    await db.insert(scheduleBImportFiles).values({
      id: nanoid(),
      jobId: data.jobId,
      scopeId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      totalChunks: data.totalChunks,
      uploadedChunks: data.totalChunks,
      storageKey: data.storageKey,
      status: "queued",
      error: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * Bulk-insert scheduleBImportFiles rows for a drive-link-v1 batch.
 *
 * Each row is stored with `storageKey = "drive:<fileId>"` and
 * `status = "queued"` so the existing scheduleBImportJobRunner picks
 * them up immediately — the drive branch inside processSingleFile
 * downloads from Google Drive based on the prefix. No chunk lifecycle
 * (uploadedChunks = totalChunks = 1) because drive files are
 * finalized from the moment the row exists.
 *
 * Deduplicates by fileName against the job's existing rows before
 * inserting — collisions are silently counted as `skipped` so the
 * mutation can report "X new, Y already in queue" to the user.
 *
 * Chunks the actual INSERT into batches of 500 to keep the SQL
 * statement size manageable on TiDB/MySQL and to keep withDbRetry
 * units small.
 *
 * Returns { inserted, skipped }.
 */
export async function bulkInsertScheduleBDriveFiles(
  jobId: string,
  files: Array<{
    fileName: string;
    fileSize: number | null;
    driveFileId: string;
  }>
): Promise<{ inserted: number; skipped: number }> {
  if (files.length === 0) return { inserted: 0, skipped: 0 };
  const db = await getDb();
  if (!db) return { inserted: 0, skipped: 0 };
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return { inserted: 0, skipped: 0 };

  // 1. Load all existing filenames for this job so we can filter
  //    duplicates in-memory (the (jobId, fileName) unique index would
  //    reject them anyway, but pre-filtering keeps the INSERT clean).
  const knownFileNamesRows = await withDbRetry(
    "list schedule b file names for bulk drive insert",
    async () =>
      db
        .select({ fileName: scheduleBImportFiles.fileName })
        .from(scheduleBImportFiles)
        .where(eq(scheduleBImportFiles.jobId, jobId))
  );
  const knownFileNames = new Set(
    knownFileNamesRows.map((row) => row.fileName)
  );

  // 2. Partition into "new" and "skip".
  const fresh: typeof files = [];
  let skipped = 0;
  const seenThisBatch = new Set<string>();
  for (const file of files) {
    if (knownFileNames.has(file.fileName)) {
      skipped += 1;
      continue;
    }
    // Also skip duplicates WITHIN this batch (two Drive files with
    // the same name in the same folder would trip the unique index
    // otherwise).
    if (seenThisBatch.has(file.fileName)) {
      skipped += 1;
      continue;
    }
    seenThisBatch.add(file.fileName);
    fresh.push(file);
  }

  if (fresh.length === 0) {
    return { inserted: 0, skipped };
  }

  // 3. Chunked multi-row insert. 500 rows/chunk is a conservative
  //    balance between throughput and statement size.
  const CHUNK_SIZE = 500;
  let inserted = 0;
  const scopeId = await resolveScopeIdForJob(jobId);
  for (let start = 0; start < fresh.length; start += CHUNK_SIZE) {
    const chunk = fresh.slice(start, start + CHUNK_SIZE);
    const now = new Date();
    const rows = chunk.map((file) => ({
      id: nanoid(),
      jobId,
      scopeId,
      fileName: file.fileName,
      fileSize: file.fileSize ?? 0,
      storageKey: `drive:${file.driveFileId}`,
      status: "queued" as const,
      uploadedChunks: 1,
      totalChunks: 1,
      error: null,
      processedAt: null,
      createdAt: now,
      updatedAt: now,
    }));
    await withDbRetry("bulk insert schedule b drive files chunk", async () => {
      await db.insert(scheduleBImportFiles).values(rows);
    });
    inserted += rows.length;
  }

  return { inserted, skipped };
}

export async function markScheduleBImportFileStatus(
  data: {
    jobId: string;
    fileName: string;
    status: ScheduleBImportFileStatus;
    error?: string | null;
    processedAt?: Date | null;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("mark schedule b import file status", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: data.status,
        error: data.error ?? null,
        processedAt:
          data.processedAt ??
          (data.status === "completed" || data.status === "failed"
            ? new Date()
            : null),
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      );
  });
}

export async function listScheduleBImportFileNames(
  jobId: string,
  opts?: { includeStatuses?: ScheduleBImportFileStatus[] }
) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];
  return withDbRetry("list schedule b import file names", async () => {
    const statuses = opts?.includeStatuses;
    const whereCondition =
      Array.isArray(statuses) && statuses.length > 0
        ? and(
            eq(scheduleBImportFiles.jobId, jobId),
            sql`${scheduleBImportFiles.status} IN (${sql.join(
              statuses.map((status) => sql`${status}`),
              sql`, `
            )})`
          )
        : eq(scheduleBImportFiles.jobId, jobId);

    const rows = await db
      .select({ fileName: scheduleBImportFiles.fileName })
      .from(scheduleBImportFiles)
      .where(whereCondition);
    return rows.map((row) => row.fileName);
  });
}

export async function listPendingScheduleBImportFiles(jobId: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];
  return withDbRetry("list pending schedule b import files", async () =>
    db
      .select()
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.status, "queued")
        )
      )
      .orderBy(asc(scheduleBImportFiles.createdAt))
      .limit(limit)
  );
}

/**
 * List every file in the job that has a permanent storage key (i.e. the
 * chunked upload finished and storagePut succeeded). Files still being
 * uploaded chunk-by-chunk have storageKey = 'tmp:...' and are
 * deliberately excluded — processing them would write an "upload did
 * not finalize" error result row that then permanently masks the file
 * after upload actually completes (because the runner skips any
 * fileName already in the results table on resume).
 *
 * Files with NULL or empty storageKey are also excluded for the same
 * reason. The runner will pick them up on a subsequent invocation once
 * markScheduleBImportFileQueued has assigned a permanent key.
 */
export async function listAllUploadedScheduleBImportFiles(jobId: string) {
  const db = await getDb();
  if (!db) return [] as Array<{ fileName: string; storageKey: string | null }>;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [] as Array<{ fileName: string; storageKey: string | null }>;
  return withDbRetry("list all uploaded schedule b import files", async () => {
    const rows = await db
      .select({
        fileName: scheduleBImportFiles.fileName,
        storageKey: scheduleBImportFiles.storageKey,
      })
      .from(scheduleBImportFiles)
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          // Exclude tmp:, NULL, and empty — i.e. any file whose upload
          // has not yet been finalized into permanent storage.
          sql`${scheduleBImportFiles.storageKey} IS NOT NULL`,
          sql`${scheduleBImportFiles.storageKey} <> ''`,
          sql`${scheduleBImportFiles.storageKey} NOT LIKE 'tmp:%'`
        )
      )
      .orderBy(asc(scheduleBImportFiles.fileName));
    return rows;
  });
}

/**
 * Return the set of fileNames that already have a row in
 * scheduleBImportResults for the given job. Used by the runner to skip
 * already-processed files on resume (mirrors getCompletedCsgIdsForJob
 * in the contract scraper).
 */
export async function getCompletedScheduleBImportFileNames(
  jobId: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return new Set();
  return withDbRetry("get completed schedule b file names", async () => {
    const rows = await db
      .select({ fileName: scheduleBImportResults.fileName })
      .from(scheduleBImportResults)
      .where(eq(scheduleBImportResults.jobId, jobId));
    return new Set(rows.map((r) => r.fileName));
  });
}

/**
 * Return fileNames for rows that were processed successfully (error IS NULL)
 * for the given job. Used by CSG portal runner so previously failed IDs can
 * be retried on subsequent runs.
 */
export async function getSuccessfulScheduleBImportFileNames(
  jobId: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return new Set();
  return withDbRetry("get successful schedule b file names", async () => {
    const rows = await db
      .select({ fileName: scheduleBImportResults.fileName })
      .from(scheduleBImportResults)
      .where(
        and(
          eq(scheduleBImportResults.jobId, jobId),
          sql`${scheduleBImportResults.error} IS NULL`
        )
      );
    return new Set(rows.map((r) => r.fileName));
  });
}

export async function requeueScheduleBImportProcessingFiles(jobId: string) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("requeue schedule b import processing files", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: "queued",
        error: null,
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.status, "processing")
        )
      );
  });
}

/**
 * DEPRECATED — retained as a no-op so any cached caller (e.g. already-
 * deployed clients polling the old getScheduleBImportStatus) continues
 * to function. The new runner handles stale "tmp:" storage keys
 * explicitly per-file (writing an error result row) rather than
 * sweeping with a global UPDATE that could race with in-flight uploads.
 */
export async function failScheduleBImportFilesWithInvalidStorage(_jobId: string) {
  // Intentionally empty. See the rewritten scheduleBImportJobRunner for
  // the new per-file "storageKey missing / tmp:" error handling.
}

export async function requeueScheduleBImportRetryableFiles(jobId: string) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;

  await withDbRetry("requeue schedule b import retryable files", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: "queued",
        error: null,
        processedAt: null,
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, jobId),
          eq(scheduleBImportFiles.status, "failed"),
          sql`${scheduleBImportFiles.storageKey} IS NOT NULL`,
          sql`${scheduleBImportFiles.storageKey} <> ''`,
          sql`${scheduleBImportFiles.storageKey} NOT LIKE 'tmp:%'`
        )
      );

    await db.execute(sql`
      UPDATE scheduleBImportFiles f
      JOIN scheduleBImportResults r
        ON r.jobId = f.jobId
       AND r.fileName = f.fileName
      SET
        f.status = 'queued',
        f.error = NULL,
        f.processedAt = NULL
      WHERE
        f.jobId = ${jobId}
        AND f.status = 'completed'
        AND r.error IS NOT NULL
    `);
  });
}

/**
 * Delete rows that are stuck in 'uploading' status with a NULL / empty /
 * 'tmp:%' storageKey, i.e. upload sessions the client started but never
 * finalized (browser crash, page reload, retry loop exhausted, etc.).
 *
 * These rows are invisible to listAllUploadedScheduleBImportFiles (which
 * excludes tmp: keys) so they never get processed, but they DO count
 * toward the job's totalFiles tally — which means the runner's
 * "remaining = totalFiles - processed" check never reaches 0 and the
 * job stays wedged in 'queued' forever.
 *
 * After calling this, the caller should invoke
 * reconcileScheduleBImportJobState to resync the job-row counters and
 * runScheduleBImportJob to re-evaluate the completion state.
 *
 * Returns the number of rows deleted.
 */
export async function clearScheduleBImportStuckUploads(
  jobId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return 0;

  return withDbRetry("clear schedule b import stuck uploads", async () => {
    const result = await db.execute(sql`
      DELETE FROM scheduleBImportFiles
      WHERE jobId = ${jobId}
        AND status = 'uploading'
        AND (
          storageKey IS NULL
          OR storageKey = ''
          OR storageKey LIKE 'tmp:%'
        )
    `);
    return getDbExecuteAffectedRows(result);
  });
}

export async function getScheduleBImportJobCounts(jobId: string) {
  const db = await getDb();
  if (!db) {
    return {
      totalFiles: 0,
      uploadingFiles: 0,
      queuedFiles: 0,
      processingFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      uploadedFiles: 0,
      processedFiles: 0,
      successCount: 0,
      failureCount: 0,
    };
  }
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) {
    return {
      totalFiles: 0,
      uploadingFiles: 0,
      queuedFiles: 0,
      processingFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      uploadedFiles: 0,
      processedFiles: 0,
      successCount: 0,
      failureCount: 0,
    };
  }

  return withDbRetry("get schedule b import job counts", async () => {
    const [
      totalFilesResult,
      uploadingResult,
      queuedResult,
      processingResult,
      completedResult,
      failedResult,
      successResult,
      extractionFailedResult,
    ] = await Promise.all([
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(eq(scheduleBImportFiles.jobId, jobId)),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "uploading")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "queued")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "processing")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "completed")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportFiles)
        .where(
          and(
            eq(scheduleBImportFiles.jobId, jobId),
            eq(scheduleBImportFiles.status, "failed")
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(
          and(
            eq(scheduleBImportResults.jobId, jobId),
            sql`${scheduleBImportResults.error} IS NULL`
          )
        ),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(
          and(
            eq(scheduleBImportResults.jobId, jobId),
            sql`${scheduleBImportResults.error} IS NOT NULL`
          )
        ),
    ]);

    const totalFiles = totalFilesResult[0]?.count ?? 0;
    const uploadingFiles = uploadingResult[0]?.count ?? 0;
    const queuedFiles = queuedResult[0]?.count ?? 0;
    const processingFiles = processingResult[0]?.count ?? 0;
    const completedFiles = completedResult[0]?.count ?? 0;
    const failedFiles = failedResult[0]?.count ?? 0;
    const successCount = successResult[0]?.count ?? 0;
    const extractionFailedCount = extractionFailedResult[0]?.count ?? 0;

    return {
      totalFiles,
      uploadingFiles,
      queuedFiles,
      processingFiles,
      completedFiles,
      failedFiles,
      uploadedFiles: Math.max(0, totalFiles - uploadingFiles),
      processedFiles: completedFiles + failedFiles,
      successCount,
      failureCount: extractionFailedCount + failedFiles,
    };
  });
}

export async function reconcileScheduleBImportJobState(jobId: string) {
  const db = await getDb();
  const emptyCounts = {
    totalFiles: 0,
    uploadingFiles: 0,
    queuedFiles: 0,
    processingFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    uploadedFiles: 0,
    processedFiles: 0,
    successCount: 0,
    failureCount: 0,
    filesMarkedCompleted: 0,
    filesRequeued: 0,
  };
  if (!db) return emptyCounts;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return emptyCounts;

  let filesMarkedCompleted = 0;
  let filesRequeued = 0;

  await withDbRetry("reconcile schedule b import job state", async () => {
    const now = new Date();
    // IMPORTANT: exclude in-flight uploads (NULL / empty / 'tmp:%'
    // storageKey) from the markCompleted sweep. Without this guard the
    // reconciler flips a row from 'uploading' -> 'completed' whenever a
    // matching result row exists from a prior scan of the same filename
    // (e.g. a re-upload), which causes the next chunk of the in-flight
    // upload to fail with "Upload session missing ...". The requeue
    // step below already has the same guard; this aligns the
    // markCompleted step with the invariant enforced by
    // listAllUploadedScheduleBImportFiles.
    const markCompletedResult = await db.execute(sql`
      UPDATE scheduleBImportFiles f
      JOIN scheduleBImportResults r
        ON r.jobId = f.jobId
       AND r.fileName = f.fileName
      SET
        f.status = 'completed',
        f.error = NULL,
        f.processedAt = COALESCE(f.processedAt, r.scannedAt),
        f.updatedAt = ${now}
      WHERE
        f.jobId = ${jobId}
        AND f.storageKey IS NOT NULL
        AND f.storageKey <> ''
        AND f.storageKey NOT LIKE 'tmp:%'
        AND (
          f.status <> 'completed'
          OR f.error IS NOT NULL
        )
    `);
    filesMarkedCompleted = getDbExecuteAffectedRows(markCompletedResult);

    const requeueResult = await db.execute(sql`
      UPDATE scheduleBImportFiles f
      LEFT JOIN scheduleBImportResults r
        ON r.jobId = f.jobId
       AND r.fileName = f.fileName
      SET
        f.status = 'queued',
        f.error = NULL,
        f.processedAt = NULL,
        f.updatedAt = ${now}
      WHERE
        f.jobId = ${jobId}
        AND f.status = 'processing'
        AND f.storageKey IS NOT NULL
        AND f.storageKey <> ''
        AND f.storageKey NOT LIKE 'tmp:%'
        AND r.id IS NULL
    `);
    filesRequeued = getDbExecuteAffectedRows(requeueResult);
  });

  const counts = await getScheduleBImportJobCounts(jobId);
  await withDbRetry("sync schedule b import job counters from authoritative counts", async () => {
    await db
      .update(scheduleBImportJobs)
      .set({
        totalFiles: counts.totalFiles,
        successCount: counts.successCount,
        failureCount: counts.failureCount,
      })
      .where(eq(scheduleBImportJobs.id, jobId));
  });

  return {
    ...counts,
    filesMarkedCompleted,
    filesRequeued,
  };
}

// ── Schedule B Import Results ─────────────────────────────────────

export async function upsertScheduleBImportResult(
  data: {
    jobId: string;
    fileName: string;
    designatedSystemId: string | null;
    gatsId: string | null;
    acSizeKw: number | null;
    capacityFactor: number | null;
    contractPrice: number | null;
    contractNumber: string | null;
    energizationDate: string | null;
    maxRecQuantity: number | null;
    deliveryYearsJson: string;
    error: string | null;
    scannedAt: Date;
  }
) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;

  const scannedAt = data.scannedAt
    ? new Date(Math.floor(data.scannedAt.getTime() / 1000) * 1000)
    : new Date();
  const now = new Date();

  await withDbRetry("upsert schedule b import result", async () => {
    const existing = await db
      .select({ id: scheduleBImportResults.id })
      .from(scheduleBImportResults)
      .where(
        and(
          eq(scheduleBImportResults.jobId, data.jobId),
          eq(scheduleBImportResults.fileName, data.fileName)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(scheduleBImportResults)
        .set({
          designatedSystemId: data.designatedSystemId,
          gatsId: data.gatsId,
          acSizeKw: data.acSizeKw,
          capacityFactor: data.capacityFactor,
          contractPrice: data.contractPrice,
          contractNumber: data.contractNumber,
          energizationDate: data.energizationDate,
          maxRecQuantity: data.maxRecQuantity,
          deliveryYearsJson: data.deliveryYearsJson,
          error: data.error,
          scannedAt,
        })
        .where(eq(scheduleBImportResults.id, existing[0].id));
      return;
    }

    const scopeId = await resolveScopeIdForJob(data.jobId);
    await db.insert(scheduleBImportResults).values({
      id: nanoid(),
      jobId: data.jobId,
      scopeId,
      fileName: data.fileName,
      designatedSystemId: data.designatedSystemId,
      gatsId: data.gatsId,
      acSizeKw: data.acSizeKw,
      capacityFactor: data.capacityFactor,
      contractPrice: data.contractPrice,
      contractNumber: data.contractNumber,
      energizationDate: data.energizationDate,
      maxRecQuantity: data.maxRecQuantity,
      deliveryYearsJson: data.deliveryYearsJson,
      error: data.error,
      scannedAt,
    });
  });

  await withDbRetry("mark schedule b file completed after result upsert", async () => {
    await db
      .update(scheduleBImportFiles)
      .set({
        status: "completed",
        error: null,
        processedAt: scannedAt,
        updatedAt: now,
      })
      .where(
        and(
          eq(scheduleBImportFiles.jobId, data.jobId),
          eq(scheduleBImportFiles.fileName, data.fileName)
        )
      );
  });
}

export async function listScheduleBImportResults(
  jobId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const db = await getDb();
  if (!db) return { rows: [], total: 0 };
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return { rows: [], total: 0 };

  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;

  return withDbRetry("list schedule b import results", async () => {
    const [rows, countResult] = await Promise.all([
      db
        .select()
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, jobId))
        .orderBy(asc(scheduleBImportResults.fileName))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, jobId)),
    ]);
    return { rows, total: countResult[0]?.count ?? 0 };
  });
}

export async function getAllScheduleBImportResults(jobId: string) {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];
  return withDbRetry("get all schedule b import results", async () =>
    db
      .select()
      .from(scheduleBImportResults)
      .where(eq(scheduleBImportResults.jobId, jobId))
      .orderBy(asc(scheduleBImportResults.fileName))
  );
}

/**
 * Get files from the results table that failed with transient,
 * retryable errors (Drive download failures, timeouts, network
 * errors). Used by the job runner's automatic retry pass.
 */
export async function listRetryableScheduleBImportResults(
  jobId: string
): Promise<Array<{ fileName: string; storageKey: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return [];

  return withDbRetry("list retryable schedule b results", async () => {
    const rows = await db.execute(sql`
      SELECT r.fileName, f.storageKey
      FROM scheduleBImportResults r
      JOIN scheduleBImportFiles f
        ON f.jobId = r.jobId AND f.fileName = r.fileName
      WHERE r.jobId = ${jobId}
        AND r.error IS NOT NULL
        AND (
          r.error LIKE 'Drive download failed%'
          OR r.error LIKE '%timed out%'
          OR r.error LIKE '%network%'
          OR r.error LIKE '%ECONNRESET%'
          OR r.error LIKE '%ETIMEDOUT%'
          OR r.error LIKE '%socket hang up%'
        )
    `);
    return (rows as any)[0] ?? [];
  });
}

/**
 * Mark a set of schedule B import result rows as applied to the
 * deliveryScheduleBase dataset. Called by
 * applyScheduleBToDeliveryObligations after a successful merge +
 * persist. The "Apply as Delivery Schedule (N)" button counter binds
 * to the resulting pendingApplyCount so it decreases automatically.
 *
 * Safe to call with an empty fileNames array (no-op).
 *
 * Returns the number of rows affected.
 */
export async function markScheduleBImportResultsApplied(
  jobId: string,
  fileNames: string[]
): Promise<number> {
  if (fileNames.length === 0) return 0;
  const db = await getDb();
  if (!db) return 0;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return 0;

  return withDbRetry("mark schedule b import results applied", async () => {
    // Chunk the UPDATE so we don't build an unbounded IN list if the
    // caller hands us tens of thousands of filenames. MySQL/TiDB handle
    // large IN lists but the query planner stays fastest at ~1k.
    const CHUNK_SIZE = 500;
    const now = new Date();
    let totalAffected = 0;
    for (let start = 0; start < fileNames.length; start += CHUNK_SIZE) {
      const chunk = fileNames.slice(start, start + CHUNK_SIZE);
      const result = await db.execute(sql`
        UPDATE scheduleBImportResults
        SET appliedAt = ${now}
        WHERE jobId = ${jobId}
          AND fileName IN (${sql.join(
            chunk.map((name) => sql`${name}`),
            sql`, `
          )})
      `);
      totalAffected += getDbExecuteAffectedRows(result);
    }
    return totalAffected;
  });
}

/**
 * COUNT(*) of scheduleBImportResults rows for the job that have no
 * error AND have not been applied yet. This is the authoritative count
 * behind the "Apply as Delivery Schedule (N)" button label.
 *
 * Uses the (jobId, appliedAt) index.
 */
export async function getPendingScheduleBImportApplyCount(
  jobId: string
): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return 0;
  return withDbRetry("get pending schedule b apply count", async () => {
    const rows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(scheduleBImportResults)
      .where(
        and(
          eq(scheduleBImportResults.jobId, jobId),
          sql`${scheduleBImportResults.error} IS NULL`,
          sql`${scheduleBImportResults.appliedAt} IS NULL`
        )
      );
    return rows[0]?.count ?? 0;
  });
}

export async function deleteScheduleBImportJobData(jobId: string) {
  const db = await getDb();
  if (!db) return;
  const ensured = await ensureScheduleBImportTables();
  if (!ensured) return;
  await withDbRetry("delete schedule b import job data", async () => {
    await db
      .delete(scheduleBImportResults)
      .where(eq(scheduleBImportResults.jobId, jobId));
    await db
      .delete(scheduleBImportFiles)
      .where(eq(scheduleBImportFiles.jobId, jobId));
    await db
      .delete(scheduleBImportJobs)
      .where(eq(scheduleBImportJobs.id, jobId));
  });
}

// ── Schedule B CSG Portal Import ──────────────────────────────────

export async function bulkInsertScheduleBImportCsgIds(
  jobId: string,
  items: Array<{ csgId: string; nonId?: string; abpId?: string }>
): Promise<{ inserted: number; skipped: number }> {
  const db = await getDb();
  if (!db) return { inserted: 0, skipped: items.length };
  const ensured = await ensureScheduleBImportCsgIdsTable();
  if (!ensured) return { inserted: 0, skipped: items.length };

  const scopeId = await resolveScopeIdForJob(jobId);
  let inserted = 0;
  let skipped = 0;

  const isDuplicateEntryError = (error: unknown): boolean => {
    const seen = new Set<unknown>();
    const stack: unknown[] = [error];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);

      if (typeof current === "string") {
        if (/duplicate/i.test(current) || current.includes("ER_DUP_ENTRY")) return true;
        continue;
      }

      if (typeof current !== "object") continue;

      const maybeError = current as {
        code?: unknown;
        message?: unknown;
        cause?: unknown;
        sqlMessage?: unknown;
      };

      if (maybeError.code === "ER_DUP_ENTRY") return true;
      if (typeof maybeError.message === "string") {
        if (/duplicate/i.test(maybeError.message) || maybeError.message.includes("ER_DUP_ENTRY")) {
          return true;
        }
      }
      if (typeof maybeError.sqlMessage === "string") {
        if (/duplicate/i.test(maybeError.sqlMessage) || maybeError.sqlMessage.includes("ER_DUP_ENTRY")) {
          return true;
        }
      }

      if (maybeError.cause) stack.push(maybeError.cause);
    }

    return false;
  };

  for (const item of items) {
    try {
      await db.insert(scheduleBImportCsgIds).values({
        id: nanoid(),
        jobId,
        scopeId,
        csgId: item.csgId,
        nonId: item.nonId || null,
        abpId: item.abpId || null,
        createdAt: new Date(),
      });
      inserted += 1;
    } catch (err) {
      // Duplicate key → skip
      if (isDuplicateEntryError(err)) {
        skipped += 1;
      } else {
        throw err;
      }
    }
  }

  return { inserted, skipped };
}

export async function getScheduleBImportCsgIdsForJob(
  jobId: string
): Promise<Array<{ csgId: string; nonId: string | null; abpId: string | null }>> {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureScheduleBImportCsgIdsTable();
  if (!ensured) return [];

  return withDbRetry("get schedule b csg ids for job", async () =>
    db
      .select({
        csgId: scheduleBImportCsgIds.csgId,
        nonId: scheduleBImportCsgIds.nonId,
        abpId: scheduleBImportCsgIds.abpId,
      })
      .from(scheduleBImportCsgIds)
      .where(eq(scheduleBImportCsgIds.jobId, jobId))
  );
}
