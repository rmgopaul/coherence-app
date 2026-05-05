/**
 * Tesla Powerhub production-metrics job runner — DB-backed.
 *
 * Replaces the in-memory `Map<jobId, snapshot>` shipped in PR #368
 * (Tesla Powerhub monitoring restoration) per CLAUDE.md Hard
 * Rule #8 (DB-backed registries are required for solar background
 * jobs). Mirrors the `dashboardCsvExportJobs` runner template:
 * atomic queued → running claim, 30s heartbeat refresh, opportunistic
 * stale-claim sweep + TTL prune, and queued-job resume on every
 * status read so a process restart between insert and runner-fire
 * never orphans a row.
 *
 * Wire shape preserved for client compatibility — the three exported
 * functions return the same snapshot shape consumed by the existing
 * `getGroupProductionMetricsJob` query and `getProductionMetricsCsv`
 * debug query in `server/_core/solarRecRouter.ts`. Internally, the
 * snapshot is reconstructed from the DB row each call.
 */
import { hostname as osHostname } from "node:os";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { JOB_TTL_MS } from "../../constants";
import {
  getTeslaPowerhubProductionMetrics,
  type TeslaPowerhubApiContext,
  type TeslaPowerhubMetricsProgress,
  type TeslaPowerhubProductionMetricsResult,
} from "./teslaPowerhub";
import {
  claimTeslaPowerhubProductionJob,
  completeTeslaPowerhubProductionJobFailure,
  completeTeslaPowerhubProductionJobSuccess,
  failStaleTeslaPowerhubProductionJobs,
  getTeslaPowerhubProductionJob,
  getTeslaPowerhubProductionJobById,
  insertTeslaPowerhubProductionJob,
  listRecentTeslaPowerhubProductionJobs,
  pruneTerminalTeslaPowerhubProductionJobs,
  refreshTeslaPowerhubProductionJobClaim,
  updateTeslaPowerhubProductionJobProgress,
} from "../../db/teslaPowerhubProductionJobs";
import type { TeslaPowerhubProductionJobRow } from "../../../drizzle/schema";

const METRIC_PREFIX = "[solar-rec:tesla-powerhub-production-jobs]";

export const TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION =
  "solar-rec-tesla-powerhub-production-job-v3-db-backed";

/**
 * Hard ceiling on a single production fetch. Existing v2
 * implementation used 30 min; preserve. The heartbeat refreshes
 * `claimedAt` every 30 s so the stale-claim sweeper (5-min
 * threshold) never fires while the worker is alive.
 */
const TESLA_POWERHUB_PRODUCTION_JOB_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Stale-claim threshold. A `running` row whose `claimedAt` is
 * older than this is considered abandoned (worker died / process
 * restarted). Heartbeat keeps healthy long jobs alive.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/** Heartbeat interval (10× tighter than STALE_CLAIM_MS). */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/**
 * Progress-write debounce. The Tesla Powerhub fetch invokes its
 * `onProgress` callback dozens of times per minute (per-window,
 * per-site). Writing every tick would burn DB write capacity for
 * a UX signal; ~5 s is fine for a polling client.
 */
const PROGRESS_WRITE_INTERVAL_MS = 5 * 1000;

// ────────────────────────────────────────────────────────────────────
// Wire shape (preserved from the in-memory v2 implementation).
// ────────────────────────────────────────────────────────────────────

type TeslaPowerhubProductionJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

type TeslaPowerhubProductionResult = TeslaPowerhubProductionMetricsResult;

interface ProgressShape {
  currentStep: number;
  totalSteps: number;
  percent: number;
  message: string;
  windowKey: string | null;
}

interface ConfigShape {
  groupId: string | null;
  endpointUrl: string | null;
  signal: string | null;
}

export type TeslaPowerhubProductionJobSnapshot = {
  id: string;
  scopeId: string;
  createdBy: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: TeslaPowerhubProductionJobStatus;
  progress: ProgressShape;
  error: string | null;
  result: TeslaPowerhubProductionResult | null;
  config: ConfigShape;
  _runnerVersion: typeof TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION;
};

// ────────────────────────────────────────────────────────────────────
// Process identity (mirrors dashboardCsvExportJobs).
// ────────────────────────────────────────────────────────────────────

let cachedClaimId: string | null = null;
function getClaimId(): string {
  if (cachedClaimId) return cachedClaimId;
  const pid = typeof process.pid === "number" ? process.pid : 0;
  const host = (() => {
    try {
      return osHostname();
    } catch {
      return "unknown";
    }
  })();
  const suffix = randomBytes(4).toString("hex");
  cachedClaimId = `pid-${pid}-host-${host}-${suffix}`;
  return cachedClaimId;
}

// ────────────────────────────────────────────────────────────────────
// Snapshot reconstruction
// ────────────────────────────────────────────────────────────────────

function defaultProgress(): ProgressShape {
  return {
    currentStep: 0,
    totalSteps: 8,
    percent: 0,
    message: "Queued",
    windowKey: null,
  };
}

function defaultConfig(): ConfigShape {
  return { groupId: null, endpointUrl: null, signal: null };
}

function parseProgress(value: unknown): ProgressShape {
  if (!value || typeof value !== "object") return defaultProgress();
  const v = value as Record<string, unknown>;
  return {
    currentStep:
      typeof v.currentStep === "number" ? v.currentStep : 0,
    totalSteps: typeof v.totalSteps === "number" ? v.totalSteps : 8,
    percent: typeof v.percent === "number" ? v.percent : 0,
    message: typeof v.message === "string" ? v.message : "",
    windowKey: typeof v.windowKey === "string" ? v.windowKey : null,
  };
}

function parseConfig(value: unknown): ConfigShape {
  if (!value || typeof value !== "object") return defaultConfig();
  const v = value as Record<string, unknown>;
  return {
    groupId: typeof v.groupId === "string" ? v.groupId : null,
    endpointUrl: typeof v.endpointUrl === "string" ? v.endpointUrl : null,
    signal: typeof v.signal === "string" ? v.signal : null,
  };
}

function parseResult(
  value: string | null
): TeslaPowerhubProductionResult | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as TeslaPowerhubProductionResult;
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} resultJson parse failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

function buildSnapshot(
  row: TeslaPowerhubProductionJobRow
): TeslaPowerhubProductionJobSnapshot {
  return {
    id: row.id,
    scopeId: row.scopeId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    status: row.status as TeslaPowerhubProductionJobStatus,
    progress: parseProgress(row.progressJson),
    error: row.errorMessage,
    result: parseResult(row.resultJson),
    config: parseConfig(row.config),
    _runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
  };
}

function normalizeProgressPercent(currentStep: number, totalSteps: number) {
  if (totalSteps <= 0) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round((currentStep / totalSteps) * 100))
  );
}

function progressFromCallback(
  progress: TeslaPowerhubMetricsProgress
): ProgressShape {
  const currentStep = Math.max(0, progress.currentStep);
  const totalSteps = Math.max(1, progress.totalSteps);
  return {
    currentStep,
    totalSteps,
    percent: normalizeProgressPercent(currentStep, totalSteps),
    message: progress.message,
    windowKey: progress.windowKey ?? null,
  };
}

// ────────────────────────────────────────────────────────────────────
// Sweep (stale-claim recovery + TTL prune), opportunistic
// ────────────────────────────────────────────────────────────────────

async function sweepStaleAndPruned(): Promise<void> {
  try {
    const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);
    const ttlBefore = new Date(Date.now() - JOB_TTL_MS);
    const [staleCount] = await Promise.all([
      failStaleTeslaPowerhubProductionJobs(staleClaimBefore),
      pruneTerminalTeslaPowerhubProductionJobs(ttlBefore),
    ]);
    if (staleCount > 0) {
      console.warn(
        `${METRIC_PREFIX} marked ${staleCount} stale-claim row(s) failed`
      );
    }
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface StartTeslaPowerhubProductionJobInput {
  scopeId: string;
  createdBy: number | null;
  apiContext: TeslaPowerhubApiContext;
  groupId?: string | null;
  endpointUrl?: string | null;
  signal?: string | null;
}

export interface StartTeslaPowerhubProductionJobResult {
  jobId: string;
  status: TeslaPowerhubProductionJobStatus;
  _runnerVersion: typeof TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION;
}

/**
 * Enqueue a production-metrics fetch. Persists the row, then
 * fire-and-forget schedules the runner via `setImmediate` so the
 * mutation returns fast. The worker is dependency-injected for
 * tests; in production it's `runTeslaPowerhubProductionJob`.
 *
 * **Throws** on DB unavailability (matches the `insertDashboardCsvExportJob`
 * fail-fast contract — silent return would hand the client a
 * jobId that doesn't exist).
 */
export async function startTeslaPowerhubProductionJob(
  input: StartTeslaPowerhubProductionJobInput,
  runner: (
    jobId: string,
    apiContext: TeslaPowerhubApiContext
  ) => Promise<void> = runTeslaPowerhubProductionJob,
  scheduler: (cb: () => void) => void = (cb) => setImmediate(cb)
): Promise<StartTeslaPowerhubProductionJobResult> {
  await sweepStaleAndPruned();

  const jobId = nanoid();
  const config: ConfigShape = {
    groupId: input.groupId ?? null,
    endpointUrl: input.endpointUrl ?? null,
    signal: input.signal ?? null,
  };
  await insertTeslaPowerhubProductionJob({
    id: jobId,
    scopeId: input.scopeId,
    createdBy: input.createdBy,
    config: config as never,
    status: "queued",
    progressJson: defaultProgress() as never,
    runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
  });

  scheduler(() => {
    runner(jobId, input.apiContext).catch((err) => {
      console.error(
        `${METRIC_PREFIX} runner threw for jobId=${jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  });

  return {
    jobId,
    status: "queued",
    _runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
  };
}

/**
 * Read a job's snapshot for a scope. Returns `null` for unknown /
 * cross-scope ids (caller surfaces `notFound`).
 *
 * Mirrors `getCsvExportJobStatus`: opportunistically resumes
 * queued jobs by scheduling a runner. The `apiContext` is missing
 * here (the in-memory v2 closed over it; the DB doesn't persist
 * credentials), so resume cannot fire without a fresh apiContext
 * from the caller. Stale-process recovery for queued rows therefore
 * relies on the next user-initiated start (typical UX) OR the
 * stale-claim sweep moving the row to `failed` after the timeout
 * window. A queued row never auto-runs from a status poll — see
 * the inline comment in the queued branch.
 */
export async function getTeslaPowerhubProductionJobSnapshot(
  scopeId: string,
  jobId: string
): Promise<TeslaPowerhubProductionJobSnapshot | null> {
  await sweepStaleAndPruned();
  const row = await getTeslaPowerhubProductionJob(scopeId, jobId);
  if (!row) return null;
  // Note: queued-resume on status read (the dashboardCsvExportJobs
  // pattern) does NOT apply here because the worker needs an
  // `apiContext` (Tesla bearer token + endpoint) that's only
  // available at the start mutation site — no auth credentials
  // are persisted to the DB row. If the inserting process dies
  // before its `setImmediate` fires, the row sits queued until the
  // user re-initiates from the UI; the stale-claim sweep does NOT
  // cover queued rows. Acceptable tradeoff: the alternative
  // (persisting a bearer token in the DB) would be a regression
  // on the team-credentials boundary documented in
  // `solarRecTeamCredentials`. Documented in CLAUDE.md too.
  return buildSnapshot(row);
}

interface TeslaPowerhubProductionJobDebugView
  extends Omit<TeslaPowerhubProductionJobSnapshot, "result"> {
  resultSiteCount: number | null;
  hasDebug: boolean;
}

export async function debugTeslaPowerhubProductionJobs(
  scopeId: string
): Promise<{
  _runnerVersion: typeof TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION;
  jobs: TeslaPowerhubProductionJobDebugView[];
}> {
  await sweepStaleAndPruned();
  const rows = await listRecentTeslaPowerhubProductionJobs(scopeId);
  return {
    _runnerVersion: TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION,
    jobs: rows.map((row) => {
      const snap = buildSnapshot(row);
      const { result, ...rest } = snap;
      return {
        ...rest,
        resultSiteCount: result?.sites.length ?? null,
        hasDebug: Boolean(result?.debug),
      };
    }),
  };
}

// ────────────────────────────────────────────────────────────────────
// Worker
// ────────────────────────────────────────────────────────────────────

/**
 * Worker entry point. Atomically claims the row, runs
 * `getTeslaPowerhubProductionMetrics` against the caller's
 * `apiContext`, writes progress (debounced), and atomically
 * completes the row. Heartbeat keeps `claimedAt` fresh.
 */
export async function runTeslaPowerhubProductionJob(
  jobId: string,
  apiContext: TeslaPowerhubApiContext
): Promise<void> {
  const row = await getTeslaPowerhubProductionJobById(jobId);
  if (!row) return;

  const claimId = getClaimId();
  const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const claimed = await claimTeslaPowerhubProductionJob(
    row.scopeId,
    jobId,
    claimId,
    staleClaimBefore,
    TESLA_POWERHUB_PRODUCTION_JOB_RUNNER_VERSION
  );
  if (!claimed) return;

  const config = parseConfig(row.config);

  // Heartbeat keeps `claimedAt` < STALE_CLAIM_MS while the worker
  // is alive. Mirrors dashboardCsvExportJobs PR #364 fix.
  let claimLost = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const stillOwn = await refreshTeslaPowerhubProductionJobClaim(
          row.scopeId,
          jobId,
          claimId
        );
        if (!stillOwn) {
          claimLost = true;
          clearInterval(heartbeat);
        }
      } catch (err) {
        console.warn(
          `${METRIC_PREFIX} heartbeat failed for jobId=${jobId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  // Progress writes debounced to ~5s — Tesla's onProgress fires
  // far too fast for one DB write per tick.
  let lastProgressWriteAt = 0;
  let pendingProgress = null as ProgressShape | null;
  const writeProgress = async (progress: ProgressShape): Promise<void> => {
    if (claimLost) return;
    pendingProgress = progress;
    const now = Date.now();
    if (now - lastProgressWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
    lastProgressWriteAt = now;
    try {
      await updateTeslaPowerhubProductionJobProgress(
        row.scopeId,
        jobId,
        claimId,
        progress
      );
    } catch (err) {
      console.warn(
        `${METRIC_PREFIX} progress write failed for jobId=${jobId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  };

  // Bridge Tesla's onProgress callback into the debounced writer.
  const onProgress = (progress: TeslaPowerhubMetricsProgress): void => {
    void writeProgress(progressFromCallback(progress));
  };

  try {
    const result = await getTeslaPowerhubProductionMetrics(apiContext, {
      groupId: config.groupId,
      endpointUrl: config.endpointUrl,
      signal: config.signal,
      globalTimeoutMs: TESLA_POWERHUB_PRODUCTION_JOB_TIMEOUT_MS,
      onProgress,
    });

    const finalProgress: ProgressShape = {
      currentStep:
        pendingProgress?.totalSteps ?? defaultProgress().totalSteps,
      totalSteps:
        pendingProgress?.totalSteps ?? defaultProgress().totalSteps,
      percent: 100,
      message: "Completed",
      windowKey: null,
    };

    if (claimLost) return;
    const ok = await completeTeslaPowerhubProductionJobSuccess(
      row.scopeId,
      jobId,
      claimId,
      {
        resultJson: JSON.stringify(result),
        finalProgress,
      }
    );
    if (!ok) {
      console.warn(
        `${METRIC_PREFIX} lost claim before success completion for jobId=${jobId}`
      );
    }
  } catch (err) {
    if (claimLost) return;
    const message = formatTeslaPowerhubJobError(err);
    const failedProgress: ProgressShape = {
      ...(pendingProgress ?? defaultProgress()),
      message: "Failed",
      windowKey: null,
    };
    const ok = await completeTeslaPowerhubProductionJobFailure(
      row.scopeId,
      jobId,
      claimId,
      {
        errorMessage: message,
        finalProgress: failedProgress,
      }
    );
    if (!ok) {
      console.warn(
        `${METRIC_PREFIX} lost claim before failure completion for jobId=${jobId}`
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
}

function formatTeslaPowerhubJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown job error.";
  const name = error instanceof Error ? error.name : "";
  if (
    name === "TimeoutError" ||
    /aborted due to timeout/i.test(message) ||
    /global timeout/i.test(message)
  ) {
    return `Tesla Powerhub production job exceeded ${Math.round(
      TESLA_POWERHUB_PRODUCTION_JOB_TIMEOUT_MS / 60_000
    )} minutes. Try again with a group ID or endpoint override so the job can avoid broad discovery.`;
  }
  return message;
}

// ────────────────────────────────────────────────────────────────────
// Test surface
// ────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
  buildSnapshot,
  getClaimId,
  parseProgress,
  parseConfig,
  parseResult,
  sweepStaleAndPruned,
  STALE_CLAIM_MS,
  HEARTBEAT_INTERVAL_MS,
  PROGRESS_WRITE_INTERVAL_MS,
};
