/**
 * Dataset upload — pure helpers + types shared by both sides of
 * the IndexedDB-removal refactor (docs/server-side-dashboard-
 * refactor.md).
 *
 * Phase 1 — types, validators, status state machine, progress
 * formatters.
 * Phase 2 — chunk-plan helper + base64 length math for the
 * client-side upload controller.
 *
 * No DB, no DOM. Both the server-side runner
 * (`server/services/core/datasetUploadJobRunner.ts`) and the client
 * progress dialog (Phase 2) consume from here.
 */

/**
 * Max raw bytes per upload chunk. Conservative against the
 * server-side base64 limit of 320,000 chars: base64 expands by
 * ~4/3 (every 3 bytes → 4 chars), so 240,000 raw bytes encodes to
 * 320,000 base64 chars. Keep this in lockstep with
 * `DATASET_UPLOAD_CHUNK_BASE64_LIMIT` in
 * `server/routers/helpers/scheduleB.ts`.
 */
export const DATASET_UPLOAD_RAW_BYTES_PER_CHUNK = 240_000;

export interface UploadChunkPlanItem {
  chunkIndex: number;
  /** Inclusive start offset into the file (bytes). */
  byteStart: number;
  /** Exclusive end offset into the file (bytes). */
  byteEnd: number;
}

export interface UploadChunkPlan {
  totalChunks: number;
  rawBytesPerChunk: number;
  chunks: UploadChunkPlanItem[];
}

/**
 * Pre-compute the chunk plan for a file of `fileSizeBytes`.
 * Returns:
 *   - totalChunks (caller passes this to `startDatasetUpload` so the
 *     server pre-allocates the row's `totalChunks`).
 *   - one entry per chunk with byteStart / byteEnd, suitable for
 *     `file.slice(byteStart, byteEnd)` on the client.
 *
 * `rawBytesPerChunk` defaults to `DATASET_UPLOAD_RAW_BYTES_PER_CHUNK`
 * but is injectable for tests. Empty/zero/negative input produces
 * an empty plan rather than throwing — caller decides how to
 * surface the empty-file case.
 */
export function computeUploadChunkPlan(
  fileSizeBytes: number,
  rawBytesPerChunk = DATASET_UPLOAD_RAW_BYTES_PER_CHUNK
): UploadChunkPlan {
  if (
    !Number.isFinite(fileSizeBytes) ||
    fileSizeBytes <= 0 ||
    !Number.isFinite(rawBytesPerChunk) ||
    rawBytesPerChunk <= 0
  ) {
    return { totalChunks: 0, rawBytesPerChunk, chunks: [] };
  }
  const totalChunks = Math.ceil(fileSizeBytes / rawBytesPerChunk);
  const chunks: UploadChunkPlanItem[] = [];
  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex += 1) {
    chunks.push({
      chunkIndex,
      byteStart: chunkIndex * rawBytesPerChunk,
      byteEnd: Math.min(
        (chunkIndex + 1) * rawBytesPerChunk,
        fileSizeBytes
      ),
    });
  }
  return { totalChunks, rawBytesPerChunk, chunks };
}

/**
 * Every dataset the dashboard hydrates. The 18 keys here are the
 * authoritative wire-vocabulary for the upload flow — any future
 * dataset added to the dashboard MUST be added here too, or the
 * `isDatasetKey` guard rejects uploads of it.
 *
 * Kept in sync with `client/src/solar-rec-dashboard/state/types.ts`
 * (the legacy client-side type union). The client union is
 * preserved for backwards compatibility; future PRs will collapse
 * them onto this single source of truth.
 */
export const DATASET_KEYS = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "contractedDate",
  "convertedReads",
  "annualProductionEstimates",
  "generatorDetails",
  "abpUtilityInvoiceRows",
  "abpCsgSystemMapping",
  "abpQuickBooksRows",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
  "deliveryScheduleBase",
  "transferHistory",
] as const;

export type DatasetKey = (typeof DATASET_KEYS)[number];

/** True when `value` is a recognized dataset key. Pure. */
export function isDatasetKey(value: string): value is DatasetKey {
  return (DATASET_KEYS as readonly string[]).includes(value);
}

/**
 * Phase 6 PR-B — datasets that accumulate across uploads rather
 * than being replaced wholesale. A v2 upload of one of these keys
 * preserves the prior active batch's rows and de-duplicates the
 * new file against them; everything else replaces the active batch
 * with the freshly parsed rows.
 *
 * Keep aligned with:
 *   - `APPEND_CORE_DATASETS` in `server/services/solar/serverSideMigration.ts`
 *   - `MULTI_APPEND_DATASET_KEYS` in `client/src/features/solar-rec/SolarRecDashboard.tsx`
 *   - `multiFileAppend: true` entries in `CORE_DATASET_DEFINITIONS`
 *     (`server/services/solar/datasetIngestion.ts`)
 *
 * Drift here = silent data loss: a multi-append dataset uploaded
 * via v2 with `mergeStrategy: "replace"` truncates everything that
 * isn't in the latest file.
 */
export const MULTI_APPEND_DATASET_KEYS: ReadonlySet<DatasetKey> = new Set<DatasetKey>([
  "accountSolarGeneration",
  "convertedReads",
  "transferHistory",
]);

/**
 * The merge strategy this dataset uses when ingested via the v2
 * upload runner. Multi-append datasets accumulate; everything else
 * replaces the active batch.
 *
 * Pure — derived solely from the dataset key. Caller doesn't choose;
 * the dataset's nature does. (If a future dataset needs caller-
 * driven mode selection, evolve this signature; for now the
 * mapping is 1:1.)
 */
export type DatasetMergeStrategy = "replace" | "append";
export function defaultMergeStrategyForDataset(
  datasetKey: string
): DatasetMergeStrategy {
  return MULTI_APPEND_DATASET_KEYS.has(datasetKey as DatasetKey)
    ? "append"
    : "replace";
}

/**
 * State machine for an upload job. Each status describes the
 * job's current phase; the runner advances through them in order
 * (or jumps to `failed` from any non-terminal state on error).
 *
 *   queued    — row created, no chunks yet
 *   uploading — chunks streaming in (clients call uploadChunk)
 *   parsing   — runner has reassembled the file and is reading rows
 *   writing   — runner is batch-inserting into srDs* (overlap with
 *               parsing for streaming inserts)
 *   done      — completedAt stamped; batchId is now the active
 *               version
 *   failed    — errorMessage set; row preserved for diagnostic
 */
export const UPLOAD_STATUSES = [
  "queued",
  "uploading",
  "parsing",
  "writing",
  "done",
  "failed",
] as const;

export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/** True when `value` is a recognized upload status. Pure. */
export function isUploadStatus(value: string): value is UploadStatus {
  return (UPLOAD_STATUSES as readonly string[]).includes(value);
}

/**
 * Terminal statuses — the job is over. The UI stops polling on
 * these; the row stays in the DB for history + diagnostics.
 */
export function isTerminalUploadStatus(status: string): boolean {
  return status === "done" || status === "failed";
}

/**
 * Allowed non-terminal transitions:
 *
 *   queued    → uploading | failed
 *   uploading → parsing   | failed
 *   parsing   → writing   | failed | done    (small files skip writing-as-distinct-phase)
 *   writing   → done      | failed
 *
 * Terminal statuses (`done` / `failed`) are absorbing — the runner
 * never re-opens a finished job. Returns `true` if the transition is
 * legal. Pure.
 */
export function isValidUploadStatusTransition(
  from: string,
  to: string
): boolean {
  if (!isUploadStatus(to)) return false;
  if (from === to) return false;
  if (isTerminalUploadStatus(from)) return false;
  if (to === "failed") return isUploadStatus(from);
  switch (from) {
    case "queued":
      return to === "uploading";
    case "uploading":
      return to === "parsing";
    case "parsing":
      return to === "writing" || to === "done";
    case "writing":
      return to === "done";
    default:
      return false;
  }
}

/**
 * Subset of an upload-job row needed by the formatter. Defined as
 * a structural type so the helper accepts both the full DB row and
 * a stripped wire payload without coupling.
 */
export interface UploadProgressInput {
  status: string;
  totalRows: number | null;
  rowsParsed: number;
  rowsWritten: number;
  uploadedChunks: number;
  totalChunks: number | null;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  errorMessage: string | null;
}

export interface UploadProgressView {
  /** Stage label suitable for a progress dialog header. */
  stageLabel: string;
  /** Best-fit completion percent (0-1) for the current stage. */
  pct: number;
  /** Best-fit "X / Y rows" or "X / Y chunks" string for the row. */
  detailLabel: string;
  /** Estimated milliseconds until completion. Null when unknown. */
  estimatedRemainingMs: number | null;
  /** True when `isTerminalUploadStatus(status)`. */
  isTerminal: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  uploading: "Uploading",
  parsing: "Parsing",
  writing: "Writing rows",
  done: "Done",
  failed: "Failed",
};

/**
 * Render an upload-job row into a progress-dialog view. Pure.
 *
 *   - During `uploading`, completion comes from `uploadedChunks /
 *     totalChunks`.
 *   - During `parsing` / `writing`, completion comes from
 *     `rowsWritten / totalRows` if `totalRows` is known, else
 *     `rowsParsed / totalRows`, else null.
 *   - Estimated time remaining uses the observed rows/sec (or
 *     chunks/sec during upload) since `startedAt`.
 */
export function formatUploadProgress(
  job: UploadProgressInput,
  now: Date = new Date()
): UploadProgressView {
  const stageLabel = STAGE_LABELS[job.status] ?? job.status;
  const isTerminal = isTerminalUploadStatus(job.status);

  if (job.status === "uploading") {
    const total = job.totalChunks ?? 0;
    const pct = total > 0 ? Math.min(1, job.uploadedChunks / total) : 0;
    return {
      stageLabel,
      pct,
      detailLabel:
        total > 0
          ? `${job.uploadedChunks} of ${total} chunks`
          : `${job.uploadedChunks} chunks`,
      estimatedRemainingMs: estimateRemainingMs(
        { observed: job.uploadedChunks, total, startedAt: job.startedAt },
        now
      ),
      isTerminal,
    };
  }

  if (job.status === "parsing" || job.status === "writing") {
    const observed =
      job.status === "writing" ? job.rowsWritten : job.rowsParsed;
    const total = job.totalRows ?? 0;
    const pct = total > 0 ? Math.min(1, observed / total) : 0;
    return {
      stageLabel,
      pct,
      detailLabel:
        total > 0
          ? `${observed.toLocaleString()} of ${total.toLocaleString()} rows`
          : `${observed.toLocaleString()} rows`,
      estimatedRemainingMs: estimateRemainingMs(
        { observed, total, startedAt: job.startedAt },
        now
      ),
      isTerminal,
    };
  }

  if (job.status === "done") {
    return {
      stageLabel,
      pct: 1,
      detailLabel:
        job.totalRows != null
          ? `${job.totalRows.toLocaleString()} rows written`
          : "Complete",
      estimatedRemainingMs: 0,
      isTerminal: true,
    };
  }

  if (job.status === "failed") {
    return {
      stageLabel,
      pct: 0,
      detailLabel: job.errorMessage ?? "Upload failed",
      estimatedRemainingMs: null,
      isTerminal: true,
    };
  }

  // queued / unknown
  return {
    stageLabel,
    pct: 0,
    detailLabel:
      job.totalChunks != null
        ? `Waiting to start (${job.totalChunks} chunks)`
        : "Waiting to start",
    estimatedRemainingMs: null,
    isTerminal: false,
  };
}

/**
 * Estimate remaining time from observed throughput. Pure.
 *
 * Returns null when:
 *   - `total` is unknown or zero
 *   - `startedAt` is missing or in the future
 *   - `observed` is zero (no throughput sample yet)
 *
 * The estimate is intentionally simple: linear extrapolation from
 * (observed, elapsedMs). Real-world streaming uploads vary in
 * rate, but this is good enough for a "1 minute left" ETA.
 */
export function estimateRemainingMs(
  input: {
    observed: number;
    total: number;
    startedAt: Date | string | null;
  },
  now: Date = new Date()
): number | null {
  if (!input.total || input.total <= 0) return null;
  if (input.observed <= 0) return null;
  if (input.observed >= input.total) return 0;
  const startMs = toMs(input.startedAt);
  if (startMs == null) return null;
  const elapsedMs = now.getTime() - startMs;
  if (elapsedMs <= 0) return null;
  const rate = input.observed / elapsedMs; // items per ms
  if (rate <= 0) return null;
  const remaining = input.total - input.observed;
  return Math.round(remaining / rate);
}

function toMs(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Format an estimated-remaining-ms into a human label. Pure.
 *
 *   null      → ""           (caller renders an em-dash or hides)
 *   < 1s      → "less than a second"
 *   < 60s     → "12 seconds"
 *   < 60min   → "5 minutes"
 *   else      → "1h 23m"
 */
export function formatEstimatedRemaining(ms: number | null): string {
  if (ms == null) return "";
  if (ms < 1_000) return "less than a second";
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1_000));
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  if (ms < 3_600_000) {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms - hours * 3_600_000) / 60_000);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
