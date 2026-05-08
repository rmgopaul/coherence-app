/**
 * Dashboard build jobs — service layer (Phase 2 PR-B).
 *
 * Orchestrates the public-facing entry points the tRPC procs call:
 *   - `startDashboardBuild(scopeId, createdByUserId)` — INSERTs a
 *     queued row and schedules the runner via `setImmediate`.
 *   - `getDashboardBuildStatus(scopeId, buildId)` — reads the row
 *     and returns a slim status snapshot. Cross-scope reads return
 *     null (caller sees `notFound` without leaking existence).
 *   - `sweepStaleAndPrune` — opportunistic stale-claim + TTL prune
 *     fired on every status read. No background timer; same
 *     pattern as the CSV export module.
 *
 * Mirrors `server/services/solar/dashboardCsvExportJobs.ts`'s
 * shape so the dashboard-job module family stays uniform. The
 * runner itself lives in `dashboardBuildJobRunner.ts` to keep
 * service-layer concerns (start/status/prune) separate from
 * worker-loop concerns (claim/heartbeat/steps/complete).
 */

import { randomBytes } from "node:crypto";
import {
  failStaleSolarRecDashboardBuilds,
  getActiveDashboardBuildForScope,
  getSolarRecDashboardBuild,
  insertSolarRecDashboardBuild,
  markSolarRecDashboardBuildSuperseded,
  pruneTerminalSolarRecDashboardBuilds,
} from "../../db/solarRecDashboardBuilds";
import {
  DASHBOARD_BUILD_RUNNER_VERSION,
  runDashboardBuildJob,
} from "./dashboardBuildJobRunner";
import type { SolarRecDashboardBuild } from "../../../drizzle/schema";

const METRIC_PREFIX = "[dashboard:build-jobs]";

/**
 * TTL for terminal rows. After `completedAt + JOB_TTL_MS` the row
 * is eligible for prune. Mirrors the CSV export module's choice
 * (30 minutes — long enough for a slow client to read its result,
 * short enough to keep the table bounded).
 */
const JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Stale-claim threshold (mirrors the runner). Kept in sync with
 * `dashboardBuildJobRunner.STALE_CLAIM_MS` so the sweeper and the
 * runner agree on what "stale" means.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes

// ────────────────────────────────────────────────────────────────────
// Status snapshot — what the public proc returns
// ────────────────────────────────────────────────────────────────────

export type DashboardBuildStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "notFound";

export interface DashboardBuildProgress {
  currentStep: number;
  totalSteps: number;
  percent: number;
  message: string | null;
  factTable: string | null;
}

export interface DashboardBuildStatusSnapshot {
  buildId: string;
  status: DashboardBuildStatus;
  progress: DashboardBuildProgress | null;
  errorMessage: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runnerVersion: string;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/**
 * Start a new build. Inserts a `queued` row and schedules the
 * runner via `setImmediate` so the mutation returns fast.
 *
 * `runner` and `scheduler` are dependency-injected for tests; in
 * production they default to `runDashboardBuildJob` and
 * `setImmediate`.
 *
 * **2026-05-09 — Option C — same-scope dedup.** If a `queued` or
 * `running` build already exists for this scope, return its
 * `buildId` instead of starting a new build that would race the
 * existing one through orphan sweeps + fact writes. The result
 * shape adds `reused: true` so the caller can surface "already
 * building" UX vs. a fresh start.
 *
 * Stale-claim safety: a `running` build whose `claimedAt` is older
 * than `STALE_CLAIM_MS` is treated as NOT active — the periodic
 * sweeper would have flipped it to `failed` on its next tick, and
 * waiting for it would deadlock the new caller.
 *
 * Race window: two concurrent calls both see "no active build",
 * both insert queued rows. Race-loser detection: after insert,
 * re-query for the active build; if it's a DIFFERENT buildId
 * (because the loser inserted later), mark our row as superseded
 * and return the winner's ID. The runner is NOT scheduled for
 * the superseded row.
 */
export interface StartDashboardBuildResult {
  buildId: string;
  reused: boolean;
}

export async function startDashboardBuild(
  scopeId: string,
  createdByUserId: number | null,
  options?: {
    inputVersions?: Record<string, string | null>;
    runner?: (buildId: string) => Promise<void>;
    scheduler?: (cb: () => void) => void;
  }
): Promise<StartDashboardBuildResult> {
  // Check #1 — pre-insert. Cheapest path: existing build wins, we
  // return early with `reused: true`.
  const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);
  const existing = await getActiveDashboardBuildForScope(
    scopeId,
    staleClaimBefore
  );
  if (existing) {
    return { buildId: existing.id, reused: true };
  }

  // No active build seen — insert ours.
  const buildId = newBuildId();
  await insertSolarRecDashboardBuild({
    id: buildId,
    scopeId,
    createdBy: createdByUserId,
    inputVersionsJson: options?.inputVersions ?? {},
    status: "queued",
    runnerVersion: DASHBOARD_BUILD_RUNNER_VERSION,
  });

  // Check #2 — post-insert race-loser detection. If another build
  // for this scope is now the canonical active row (i.e. it was
  // inserted between check #1 and our insert AND has lower
  // createdAt), mark our row as superseded and return the
  // winner's buildId. `getActiveDashboardBuildForScope` orders by
  // createdAt ASC, so the OLDEST active build wins; our just-
  // inserted row is the youngest by definition.
  const activeNow = await getActiveDashboardBuildForScope(
    scopeId,
    staleClaimBefore
  );
  if (activeNow && activeNow.id !== buildId) {
    const marked = await markSolarRecDashboardBuildSuperseded(
      buildId,
      activeNow.id
    );
    if (!marked) {
      // Defensive: if our row already got claimed (impossible in
      // practice — the runner is scheduled BELOW this check), log
      // and fall through to scheduling. Mark-superseded only
      // succeeds for `status='queued' AND claimedBy IS NULL` so a
      // false return here means the row already changed state,
      // which means the runner is taking over and we shouldn't
      // re-schedule. Just return the winner's ID.
      console.warn(
        `${METRIC_PREFIX} race-loser mark failed for buildId=${buildId} (winner=${activeNow.id}); returning winner anyway`
      );
    }
    return { buildId: activeNow.id, reused: true };
  }

  scheduleBuildRunner(buildId, options?.runner, options?.scheduler);
  return { buildId, reused: false };
}

/**
 * Read the status snapshot for a given (scopeId, buildId). Returns
 * `notFound` for cross-scope reads or pruned rows. Opportunistically
 * fires the prune + stale-claim sweeps; both helpers no-op cheaply
 * when there's nothing to sweep.
 *
 * Codex P1 follow-up parity (mirrors the CSV export module): if
 * the row is `queued`, also schedule the runner here. Pre-fix the
 * runner was scheduled only at insert time via `setImmediate`; if
 * the inserting process restarted before the runner fired, the
 * row would sit queued forever — the sweeper only handles
 * `running` and terminal rows. Now any client poll for a queued
 * row will trigger a runner. The claim semantics inside
 * `runDashboardBuildJob` ensure exactly one of the racing processes
 * actually claims and runs.
 */
export async function getDashboardBuildStatus(
  scopeId: string,
  buildId: string,
  options?: {
    runner?: (buildId: string) => Promise<void>;
    scheduler?: (cb: () => void) => void;
  }
): Promise<DashboardBuildStatusSnapshot> {
  await sweepStaleAndPrune();
  const row = await getSolarRecDashboardBuild(scopeId, buildId);
  if (!row) {
    return {
      buildId,
      status: "notFound",
      progress: null,
      errorMessage: null,
      createdAt: null,
      startedAt: null,
      completedAt: null,
      runnerVersion: DASHBOARD_BUILD_RUNNER_VERSION,
    };
  }
  if (row.status === "queued") {
    scheduleBuildRunner(buildId, options?.runner, options?.scheduler);
  }
  return buildSnapshot(row);
}

/**
 * Periodic sweep: flip stale `running` rows to `failed`, prune
 * terminal rows older than TTL. Returns counts for observability.
 * Public so the test suite + an optional periodic scheduler can
 * trigger it directly.
 */
export async function sweepStaleAndPrune(): Promise<{
  staleFailedCount: number;
  prunedCount: number;
}> {
  const now = Date.now();
  let staleFailedCount = 0;
  let prunedCount = 0;
  try {
    staleFailedCount = await failStaleSolarRecDashboardBuilds(
      new Date(now - STALE_CLAIM_MS)
    );
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} stale-claim sweep failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  try {
    const pruned = await pruneTerminalSolarRecDashboardBuilds(
      new Date(now - JOB_TTL_MS)
    );
    prunedCount = pruned.length;
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} TTL prune failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  return { staleFailedCount, prunedCount };
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

function newBuildId(): string {
  // 16 bytes of randomness → 32 hex chars. Plenty of entropy and
  // matches the CSV export module's id shape.
  return `bld-${randomBytes(16).toString("hex")}`;
}

function scheduleBuildRunner(
  buildId: string,
  runner: ((buildId: string) => Promise<void>) | undefined,
  scheduler: ((cb: () => void) => void) | undefined
): void {
  const run = runner ?? runDashboardBuildJob;
  const schedule = scheduler ?? ((cb) => setImmediate(cb));
  schedule(() => {
    void run(buildId).catch((err) => {
      // Runner already captures errors into the row's
      // `errorMessage`; this catch is just to keep the
      // unhandled-rejection log clean if something escapes.
      console.error(
        `${METRIC_PREFIX} runner threw outside row capture for buildId=${buildId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    });
  });
}

function buildSnapshot(
  row: SolarRecDashboardBuild
): DashboardBuildStatusSnapshot {
  return {
    buildId: row.id,
    status: row.status as DashboardBuildStatus,
    progress: parseProgress(row.progressJson),
    errorMessage: row.errorMessage,
    createdAt: row.createdAt ? row.createdAt.toISOString() : null,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    runnerVersion: row.runnerVersion,
  };
}

function parseProgress(raw: unknown): DashboardBuildProgress | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const currentStep = toFiniteNumber(record.currentStep);
  const totalSteps = toFiniteNumber(record.totalSteps);
  const percent = toFiniteNumber(record.percent);
  if (currentStep === null || totalSteps === null || percent === null) {
    return null;
  }
  const message =
    typeof record.message === "string" ? record.message : null;
  const factTable =
    typeof record.factTable === "string" ? record.factTable : null;
  return { currentStep, totalSteps, percent, message, factTable };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

// ────────────────────────────────────────────────────────────────────
// Boot-time periodic sweeper
// ────────────────────────────────────────────────────────────────────

/**
 * 2026-05-09 — post-merge audit follow-up. Pre-fix, `sweepStaleAndPrune`
 * ran ONLY opportunistically on a `getDashboardBuildStatus` read.
 * That works while the inserting client is still polling the buildId,
 * but if the worker dies after claim AND the client moved on (page
 * reload, tab close, started a new build), the orphaned `running`
 * row sat forever — the docs claimed "periodic sweep" but no timer
 * was wired to a boot path. Production evidence: `bld-312c41a266cf…`
 * stayed `running` for ~24 h on prod after a deploy cutover before
 * this fix.
 *
 * Mirror `startDatasetUploadStaleJobSweeper` shape: 5-minute interval
 * (matches `STALE_CLAIM_MS`), boot-time tick on start, env-tunable
 * via `DASHBOARD_BUILD_SWEEP_INTERVAL_MS`. `unref()` so the timer
 * never holds Node alive in tests or graceful shutdown. Returns an
 * idempotent stopper for tests.
 */
const DEFAULT_BUILD_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

let buildSweepTimer: NodeJS.Timeout | null = null;
let buildSweeping = false;

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

async function runBuildSweepTick(): Promise<void> {
  // Re-entrancy guard: skip overlapping ticks if a slow DB makes
  // the previous sweep still in flight.
  if (buildSweeping) return;
  buildSweeping = true;
  try {
    const { staleFailedCount, prunedCount } = await sweepStaleAndPrune();
    if (staleFailedCount > 0) {
      console.log(
        `${METRIC_PREFIX} periodic sweep flipped ${staleFailedCount} ` +
          `stale-claim build${staleFailedCount === 1 ? "" : "s"} to failed.`
      );
    }
    if (prunedCount > 0) {
      console.log(
        `${METRIC_PREFIX} periodic sweep pruned ${prunedCount} terminal ` +
          `build row${prunedCount === 1 ? "" : "s"}.`
      );
    }
  } catch (err) {
    console.warn(
      `${METRIC_PREFIX} periodic sweep tick threw: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  } finally {
    buildSweeping = false;
  }
}

export function startDashboardBuildStaleJobSweeper(): () => void {
  const intervalMs = readEnvNumber(
    "DASHBOARD_BUILD_SWEEP_INTERVAL_MS",
    DEFAULT_BUILD_SWEEP_INTERVAL_MS
  );

  // Boot-tick: fire-and-forget so server startup isn't blocked by
  // a slow DB. Fresh process inherits stuck rows from the prior
  // instance via this tick.
  void runBuildSweepTick();

  if (buildSweepTimer) {
    clearInterval(buildSweepTimer);
    buildSweepTimer = null;
  }

  if (intervalMs > 0) {
    buildSweepTimer = setInterval(() => {
      void runBuildSweepTick();
    }, intervalMs);
    if (typeof buildSweepTimer.unref === "function") {
      buildSweepTimer.unref();
    }
  }

  return () => {
    if (buildSweepTimer) {
      clearInterval(buildSweepTimer);
      buildSweepTimer = null;
    }
  };
}

// ────────────────────────────────────────────────────────────────────
// Test-only surface
// ────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
  JOB_TTL_MS,
  STALE_CLAIM_MS,
  DEFAULT_BUILD_SWEEP_INTERVAL_MS,
  newBuildId,
  buildSnapshot,
  parseProgress,
};
