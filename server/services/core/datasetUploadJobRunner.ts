/**
 * Dataset upload job runner — Phase 1.
 *
 * Reads an assembled CSV from a temp file, parses each row through
 * the per-dataset parser, batch-inserts into the corresponding
 * `srDs*` table, and updates job counters/status atomically along
 * the way. On success, the new batchId becomes the active version
 * for that scope+dataset; on failure, the row preserves the error
 * for diagnostic.
 *
 * Phase 1 ships parsers for ONE dataset (`contractedDate`); Phase 4
 * fills in the other 17. Until then, jobs against unimplemented
 * datasets short-circuit to `failed` with a clear message.
 *
 * Single-process, fire-and-forget execution model (matches the
 * existing Schedule B + DIN scrape runners). The tRPC
 * `finalizeDatasetUpload` proc spawns this without awaiting; the
 * client polls `getDatasetUploadStatus` to observe progress.
 */
import { promises as fs } from "node:fs";
import { nanoid } from "nanoid";

import { getDb, withDbRetry } from "../../db/_core";
import {
  getDatasetUploadJob,
  incrementDatasetUploadJobCounter,
  recordDatasetUploadJobError,
  updateDatasetUploadJob,
} from "../../db/datasetUploadJobs";
import {
  activateDatasetVersion,
  createImportBatch,
  getActiveBatchForDataset,
} from "../../db/solarRecDatasets";
import {
  getDatasetParser,
  type DatasetParseContext,
  type DatasetUploadParser,
} from "./datasetUploadParsers";
import { parseCsvText } from "../../routers/helpers/scheduleB";
import {
  cloneDatasetBatchRows,
  loadExistingRowKeys,
  partitionAppendRowsByKeySet,
} from "../solar/datasetRowPersistence";
import {
  defaultMergeStrategyForDataset,
  isValidUploadStatusTransition,
  type DatasetMergeStrategy,
  type UploadStatus,
} from "../../../shared/datasetUpload.helpers";

/**
 * Local alias for the CSV row shape `loadExistingRowKeys` /
 * `partitionAppendRowsByKeySet` use. Not exported from
 * `datasetRowPersistence.ts`; keep the alias local so the server
 * runner doesn't reach into client code for the type.
 */
type CsvRow = Record<string, string>;

/** Rows-per-INSERT batch when streaming into srDs* tables. */
const INSERT_BATCH_SIZE = 500;

/** Counter-flush cadence — bump rowsParsed every N rows. */
const PARSE_PROGRESS_FLUSH = 250;

/**
 * Marker for the runner version. Bump on any change to the
 * persistence shape (job columns, status state machine, parser
 * registry signature) so deploys with mixed-version Node processes
 * can be diagnosed via the job row.
 */
export const DATASET_UPLOAD_RUNNER_VERSION = "phase-6b-append-v1";

export interface RunDatasetUploadJobInput {
  scopeId: string;
  jobId: string;
}

export interface RunDatasetUploadJobResult {
  status: UploadStatus;
  totalRows: number;
  rowsWritten: number;
  errorCount: number;
  batchId: string | null;
}

/**
 * Run a single upload job to completion (or failure). Idempotent
 * on a job that's already terminal — returns the existing status
 * without doing any work.
 *
 * Errors thrown from the parser are caught per-row and persisted
 * to `datasetUploadJobErrors`. A whole-job failure (file missing,
 * unknown dataset, DB error) transitions the job to `failed` with
 * a descriptive `errorMessage` and rethrows so the caller can log.
 */
export async function runDatasetUploadJob(
  input: RunDatasetUploadJobInput
): Promise<RunDatasetUploadJobResult> {
  const { scopeId, jobId } = input;
  const job = await getDatasetUploadJob(scopeId, jobId);
  if (!job) {
    throw new Error(`Dataset upload job not found: ${jobId}`);
  }

  // Idempotent on terminal jobs — if a stray retry arrives after
  // the runner finished, return the prior result.
  if (job.status === "done" || job.status === "failed") {
    return {
      status: job.status as UploadStatus,
      totalRows: job.totalRows ?? 0,
      rowsWritten: job.rowsWritten ?? 0,
      errorCount: 0,
      batchId: job.batchId ?? null,
    };
  }

  // Validate parser availability before promoting to `parsing` —
  // we never want a job in `parsing` we can't actually parse.
  const parser = getDatasetParser(job.datasetKey);
  if (!parser) {
    await failJob(
      scopeId,
      jobId,
      job.status,
      `Dataset "${job.datasetKey}" has no parser wired yet (Phase 4). ` +
        `See server/services/core/datasetUploadParsers.ts.`
    );
    return {
      status: "failed",
      totalRows: 0,
      rowsWritten: 0,
      errorCount: 0,
      batchId: null,
    };
  }

  if (!job.storageKey) {
    await failJob(
      scopeId,
      jobId,
      job.status,
      "Job has no storageKey — chunk upload was never finalized."
    );
    return {
      status: "failed",
      totalRows: 0,
      rowsWritten: 0,
      errorCount: 0,
      batchId: null,
    };
  }

  // Move to parsing.
  if (job.status !== "parsing") {
    await transitionJobStatus(scopeId, jobId, job.status, "parsing", {
      startedAt: new Date(),
    });
  }

  // Read the assembled file. For Phase 1 we load it whole (fits in
  // memory for any CSV the dashboard cares about; the largest
  // dataset is Solar Apps at ~30MB). True streaming lands later.
  let csvText: string;
  try {
    csvText = await fs.readFile(job.storageKey, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(
      scopeId,
      jobId,
      "parsing",
      `Could not read assembled CSV at ${job.storageKey}: ${message}`
    );
    throw err;
  }

  const { rows: parsedAllRows } = parseCsvText(csvText);
  await updateDatasetUploadJob(scopeId, jobId, {
    totalRows: parsedAllRows.length,
  });

  // Phase 6 PR-B — `mergeStrategy` is derived from the dataset key
  // rather than passed by the client. Multi-append datasets
  // (`accountSolarGeneration`, `convertedReads`, `transferHistory`)
  // accumulate across uploads; everything else replaces the active
  // batch. Until this PR the runner hardcoded "replace" for every
  // upload, which silently truncated multi-append datasets — the
  // user-facing bug Phase 6 PR-B fixes.
  const mergeStrategy: DatasetMergeStrategy = defaultMergeStrategyForDataset(
    job.datasetKey
  );

  // Append mode prep — clone the prior active batch's rows into the
  // new batch FIRST so the dedup key-set we load below already
  // includes them. Replace mode skips this; the new batch starts
  // empty and supersedes the prior active batch wholesale on
  // `activateDatasetVersion`.
  let priorActiveBatchId: string | null = null;
  let clonedRowCount = 0;
  let appendDedupKeys: Set<string> | null = null;
  let rowsToWrite: CsvRow[] = parsedAllRows;
  let dedupedCount = 0;

  if (mergeStrategy === "append") {
    const activeBatch = await getActiveBatchForDataset(scopeId, job.datasetKey);
    priorActiveBatchId = activeBatch?.id ?? null;
  }

  // Create the import batch row that owns the srDs* writes. The
  // batch starts in "processing"; `activateDatasetVersion` below
  // flips it to "active" + supersedes the prior active batch.
  // `ingestSource` records the upload pipeline so a future query
  // can distinguish v2-uploaded batches from legacy chunked-CSV
  // ones.
  const batchId = await createImportBatch({
    scopeId,
    datasetKey: job.datasetKey,
    ingestSource: "upload-v2",
    mergeStrategy,
    status: "processing",
    importedBy: job.initiatedByUserId,
  });
  await updateDatasetUploadJob(scopeId, jobId, { batchId });

  if (mergeStrategy === "append" && priorActiveBatchId) {
    // Mirrors the v1 ingestDataset append path — clone prior active
    // batch's rows into the new batch, then load the resulting
    // key-set in one query so the per-row dedup check is in-memory.
    // See `cloneDatasetBatchRows` / `loadExistingRowKeys` /
    // `partitionAppendRowsByKeySet` in
    // `server/services/solar/datasetRowPersistence.ts`.
    clonedRowCount = await cloneDatasetBatchRows(
      scopeId,
      priorActiveBatchId,
      batchId,
      job.datasetKey
    );
    appendDedupKeys = await loadExistingRowKeys(
      scopeId,
      batchId,
      job.datasetKey
    );
  } else if (mergeStrategy === "append") {
    // Append mode with no prior active batch — first upload of this
    // dataset for this scope. Nothing to clone; dedup runs against
    // an empty set so we're effectively de-duplicating WITHIN the
    // current upload only.
    appendDedupKeys = new Set<string>();
  }

  // Filter incoming rows for append mode. CsvRow shape (raw header
  // → string) feeds the partitioner; the parser then turns the
  // surviving rows into typed `InsertSrDs*` shapes a few lines
  // below.
  if (mergeStrategy === "append" && appendDedupKeys) {
    const partition = partitionAppendRowsByKeySet(
      job.datasetKey,
      parsedAllRows,
      appendDedupKeys
    );
    rowsToWrite = partition.toInsert;
    dedupedCount = partition.dedupedCount;
  }

  // Parse + batch-insert.
  await transitionJobStatus(scopeId, jobId, "parsing", "writing");

  let parsedSinceFlush = 0;
  let totalRowsWritten = 0;
  let totalErrorCount = 0;
  const writeBuffer: unknown[] = [];

  const flushBuffer = async () => {
    if (writeBuffer.length === 0) return;
    const batchToWrite = writeBuffer.splice(0, writeBuffer.length);
    await insertParsedRows(parser, batchToWrite);
    totalRowsWritten += batchToWrite.length;
    await incrementDatasetUploadJobCounter(
      scopeId,
      jobId,
      "rowsWritten",
      batchToWrite.length
    );
  };

  try {
    for (let rowIndex = 0; rowIndex < rowsToWrite.length; rowIndex += 1) {
      const rawRow = rowsToWrite[rowIndex];
      const ctx: DatasetParseContext = { scopeId, batchId, rowIndex };
      let parsed: unknown = null;
      try {
        parsed = parser.parseRow(rawRow, ctx);
      } catch (err) {
        totalErrorCount += 1;
        const message = err instanceof Error ? err.message : String(err);
        await recordDatasetUploadJobError({
          id: nanoid(),
          jobId,
          rowIndex,
          errorMessage: message,
        });
      }

      parsedSinceFlush += 1;
      if (parsedSinceFlush >= PARSE_PROGRESS_FLUSH) {
        await incrementDatasetUploadJobCounter(
          scopeId,
          jobId,
          "rowsParsed",
          parsedSinceFlush
        );
        parsedSinceFlush = 0;
      }

      if (parsed != null) {
        writeBuffer.push(parsed);
        if (writeBuffer.length >= INSERT_BATCH_SIZE) {
          await flushBuffer();
        }
      }
    }

    // Flush trailing parser-progress + write-buffer.
    if (parsedSinceFlush > 0) {
      await incrementDatasetUploadJobCounter(
        scopeId,
        jobId,
        "rowsParsed",
        parsedSinceFlush
      );
    }
    await flushBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(scopeId, jobId, "writing", message);
    throw err;
  }

  // Activate the new batch as the dataset's source of truth. For
  // append mode the rowCount is `clonedRowCount + totalRowsWritten`
  // because the new batch contains every prior row PLUS the
  // newly-inserted ones; for replace mode `clonedRowCount` is 0.
  const finalRowCount = clonedRowCount + totalRowsWritten;
  await activateDatasetVersion(scopeId, job.datasetKey, batchId, {
    rowCount: finalRowCount,
    completedAt: new Date(),
  });

  // Diagnostic-only logging — the job row already carries
  // `rowsWritten` and `totalRows`, but the dedup count is otherwise
  // invisible. Surface it on stdout in case a confused user reports
  // "I uploaded 1000 rows but only 200 landed."
  if (mergeStrategy === "append" && (clonedRowCount > 0 || dedupedCount > 0)) {
    // eslint-disable-next-line no-console
    console.info(
      `[runDatasetUploadJob] ${job.datasetKey} append: cloned ${clonedRowCount} prior, ` +
        `inserted ${totalRowsWritten} new, deduped ${dedupedCount} duplicates ` +
        `→ batch ${batchId} now has ${finalRowCount} rows total.`
    );
  }

  // Done.
  await transitionJobStatus(scopeId, jobId, "writing", "done", {
    completedAt: new Date(),
  });

  // Best-effort temp file cleanup.
  void fs.unlink(job.storageKey).catch(() => undefined);

  return {
    status: "done",
    totalRows: parsedAllRows.length,
    rowsWritten: totalRowsWritten,
    errorCount: totalErrorCount,
    batchId,
  };
}

// ── Helpers ────────────────────────────────────────────────────────

async function transitionJobStatus(
  scopeId: string,
  jobId: string,
  fromStatus: string,
  toStatus: UploadStatus,
  extra: Parameters<typeof updateDatasetUploadJob>[2] = {}
): Promise<void> {
  if (!isValidUploadStatusTransition(fromStatus, toStatus)) {
    throw new Error(
      `Invalid upload status transition for job ${jobId}: ${fromStatus} → ${toStatus}`
    );
  }
  await updateDatasetUploadJob(scopeId, jobId, {
    ...extra,
    status: toStatus,
  });
}

async function failJob(
  scopeId: string,
  jobId: string,
  fromStatus: string,
  message: string
): Promise<void> {
  if (!isValidUploadStatusTransition(fromStatus, "failed")) return;
  await updateDatasetUploadJob(scopeId, jobId, {
    status: "failed",
    errorMessage: message,
    completedAt: new Date(),
  });
}

/**
 * Generic batch insert. The parser narrows the row shape; here we
 * just hand drizzle a table reference + values. The `as never` is
 * needed because TypeScript can't reconcile the heterogeneous
 * parser-output types at the registry level — each parser is sound
 * on its own.
 */
async function insertParsedRows(
  parser: DatasetUploadParser<unknown>,
  rows: unknown[]
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  if (!db) return;
  await withDbRetry("insert dataset upload rows", async () => {
    await db
      .insert(parser.table as never)
      .values(rows as never);
  });
}
