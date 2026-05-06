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
  getSolarRecDashboardBuild,
  insertSolarRecDashboardBuild,
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
 * `setImmediate`. Mirrors the CSV export module's start contract.
 *
 * `inputVersionsJson` is a stub for PR-B (empty object). PR-C+
 * will pass the active source-batch IDs (`solarApplications`,
 * `transferHistory`, etc.) so the build knows which inputs it's
 * deriving from, and the cache key Phase 6's `inputVersionHash`
 * already produces gets a durable home on the row.
 */
export async function startDashboardBuild(
  scopeId: string,
  createdByUserId: number | null,
  options?: {
    inputVersions?: Record<string, string | null>;
    runner?: (buildId: string) => Promise<void>;
    scheduler?: (cb: () => void) => void;
  }
): Promise<{ buildId: string }> {
  const buildId = newBuildId();
  await insertSolarRecDashboardBuild({
    id: buildId,
    scopeId,
    createdBy: createdByUserId,
    inputVersionsJson: options?.inputVersions ?? {},
    status: "queued",
    runnerVersion: DASHBOARD_BUILD_RUNNER_VERSION,
  });
  scheduleBuildRunner(buildId, options?.runner, options?.scheduler);
  return { buildId };
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
// Test-only surface
// ────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
  JOB_TTL_MS,
  STALE_CLAIM_MS,
  newBuildId,
  buildSnapshot,
  parseProgress,
};
