/**
 * Dashboard build job runner — Phase 2 PR-B (OOM-rebuild keystone
 * follow-up).
 *
 * The runner orchestrates a per-scope build of the dashboard fact
 * tables that PR-C+ will introduce (one fact table per oversize-
 * allowlist procedure: monitoringDetails, ownership, changeOwnership,
 * systemFacts). It uses the `solarRecDashboardBuilds` registry
 * (PR-A, [#413](https://github.com/rmgopaul/coherence-app/pull/413))
 * for cross-process safety:
 *
 *   1. Atomic claim (`queued → running` with `claimedBy` set in
 *      the same UPDATE) — concurrent runners racing for the same
 *      buildId both succeed only on exactly one of them.
 *   2. Steps array iteration. PR-B ships an EMPTY array — the
 *      registry + runner shell are wired but no fact-builders
 *      register yet. PR-C+ will export each fact-builder via
 *      `registerDashboardBuildStep(...)`. The runner doesn't care
 *      what the steps do; it just iterates them with heartbeat +
 *      progress writes between each.
 *   3. Heartbeat (`refreshClaim`) every `HEARTBEAT_INTERVAL_MS`
 *      keeps the stale-claim sweeper from reaping legitimately
 *      long builds. If a refresh comes back false (we lost the
 *      claim), the runner stops issuing further DB writes and
 *      bails — the new claimer is responsible for the row now.
 *   4. Atomic completion (`running → succeeded` predicated on
 *      `claimedBy = ours`). A worker that lost its claim cannot
 *      overwrite the new claimer's terminal state.
 *
 * Errors are captured into the row's `errorMessage`; this
 * function does NOT throw under any expected control flow.
 */

import { hostname as osHostname } from "node:os";
import { randomBytes } from "node:crypto";
import {
  claimSolarRecDashboardBuild,
  completeSolarRecDashboardBuildFailure,
  completeSolarRecDashboardBuildSuccess,
  getSolarRecDashboardBuild,
  refreshSolarRecDashboardBuildClaim,
  updateSolarRecDashboardBuildProgress,
} from "../../db/solarRecDashboardBuilds";
import { startDashboardJobMetric } from "./dashboardJobMetrics";
import type { SolarRecDashboardBuild } from "../../../drizzle/schema";

const METRIC_PREFIX = "[dashboard:build-jobs]";

/**
 * Runner version. Bump on any change to the steps array or the
 * runner's contract with the registry. The version is stamped on
 * every claim so a deploy can identify (and re-build) scopes whose
 * derived rows were produced by an older runner shape.
 */
export const DASHBOARD_BUILD_RUNNER_VERSION =
  "dashboard-build-jobs-v1-skeleton";

/**
 * Stale-claim threshold. A `running` row whose `claimedAt` is
 * older than this is considered abandoned (worker process died /
 * restarted between claim and completion). Set generously so a
 * slow but healthy build never appears stale: cold-cache builds
 * across all 4 fact tables can take 60s+; we give 5 min headroom.
 * Healthy long-running builds refresh `claimedAt` via the
 * heartbeat (`HEARTBEAT_INTERVAL_MS`) so they never cross this
 * threshold while alive.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Heartbeat interval. Must be SHORTER than `STALE_CLAIM_MS` —
 * specifically: at least 2× faster, so a single missed heartbeat
 * doesn't immediately tip the row into stale-claim territory.
 * Mirrors the CSV export module's choice.
 */
const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 60 seconds (5× margin)

/**
 * Per-step timeout. Each fact-builder gets at most this long to
 * complete before the runner gives up on it. Defends against a
 * runaway query that holds the claim forever. Bumped on the
 * generous side because cold-cache aggregator runs on a busy
 * scope can take 30s+; the heartbeat keeps the row alive past
 * the stale-claim window during legitimate long runs.
 */
const PER_STEP_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes

// ────────────────────────────────────────────────────────────────────
// Step registry — the seam Phase 2 PR-C+ will plug into
// ────────────────────────────────────────────────────────────────────

export interface DashboardBuildStep {
  /** Stable name for progress messages + step-level metric tags. */
  name: string;
  /**
   * Execute this step against the given scope. The runner sets up
   * heartbeat + progress reporting around the call; the step
   * itself just needs to do its DB work + return.
   *
   * The step MUST honor the `signal` parameter — when the runner
   * loses its claim mid-step (heartbeat refresh returned false)
   * the signal is aborted and the step should bail rather than
   * continue mutating derived rows.
   */
  run(args: {
    scopeId: string;
    buildId: string;
    signal: AbortSignal;
  }): Promise<void>;
}

/**
 * Steps array. EMPTY for PR-B — the registry + runner shell are
 * wired but no fact-builders register yet. PR-C+ will append
 * builders via `registerDashboardBuildStep(...)` (or the steps
 * will be statically imported into this array; the inject pattern
 * is identical to the CSV export's `runCsvExportJob` orchestration
 * but with multiple steps instead of one heavy aggregator load).
 *
 * Test-only: `setDashboardBuildSteps()` swaps the steps for a
 * test fixture. Production code never mutates this array.
 */
let DASHBOARD_BUILD_STEPS: DashboardBuildStep[] = [];

/**
 * Test-only override. Returns the previous steps so tests can
 * restore. Production code MUST NOT call this.
 */
export function setDashboardBuildSteps(
  steps: DashboardBuildStep[]
): DashboardBuildStep[] {
  const previous = DASHBOARD_BUILD_STEPS;
  DASHBOARD_BUILD_STEPS = steps;
  return previous;
}

/** Read-only accessor for tests + introspection. */
export function getDashboardBuildSteps(): readonly DashboardBuildStep[] {
  return DASHBOARD_BUILD_STEPS;
}

// ────────────────────────────────────────────────────────────────────
// Claim id — `pid-${pid}-host-${hostname}-${4-byte hex}`
// ────────────────────────────────────────────────────────────────────

function getClaimId(): string {
  const pid = process.pid;
  const host = osHostname();
  const suffix = randomBytes(4).toString("hex");
  return `pid-${pid}-host-${host}-${suffix}`;
}

// ────────────────────────────────────────────────────────────────────
// Worker entry point
// ────────────────────────────────────────────────────────────────────

/**
 * Atomically claims the build, iterates the registered steps with
 * heartbeat + progress reporting between each, and atomically
 * completes the row.
 *
 * Cross-process safety:
 *   - The claim UPDATE only matches `queued` OR a `running` row
 *     whose claim went stale. Two workers racing for the same
 *     `queued` row both succeed only on exactly one of them.
 *   - Completion UPDATEs predicate on `claimedBy = ours`. If a
 *     stale-claim sweep flipped our row to `failed` while we were
 *     in flight, our completion UPDATE no-ops. Subsequent
 *     readers see the sweeper's terminal state, not ours.
 *
 * Errors are captured into the row's `errorMessage`; this
 * function does NOT throw under any expected control flow.
 */
export async function runDashboardBuildJob(buildId: string): Promise<void> {
  let row: SolarRecDashboardBuild | null = null;
  try {
    row = await getRowAcrossScopes(buildId);
  } catch (err) {
    console.error(
      `${METRIC_PREFIX} failed before claim for buildId=${buildId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }
  if (!row) {
    // Row was pruned between INSERT and the runner firing. Nothing
    // to do; the original caller already received the buildId and
    // their poll will surface a `notFound` once the prune sweeps.
    return;
  }

  const claimId = getClaimId();
  const staleClaimBefore = new Date(Date.now() - STALE_CLAIM_MS);

  let claimed = false;
  try {
    claimed = await claimSolarRecDashboardBuild(
      row.scopeId,
      buildId,
      claimId,
      staleClaimBefore,
      DASHBOARD_BUILD_RUNNER_VERSION
    );
  } catch (err) {
    console.error(
      `${METRIC_PREFIX} failed while claiming buildId=${buildId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return;
  }
  if (!claimed) {
    // Another worker holds a fresh claim, OR the row already
    // reached a terminal state.
    return;
  }

  const metric = startDashboardJobMetric({
    prefix: METRIC_PREFIX,
    jobId: buildId,
    context: { stepCount: DASHBOARD_BUILD_STEPS.length },
  });

  // Heartbeat — refreshes `claimedAt` every HEARTBEAT_INTERVAL_MS
  // while the build is alive. Mirrors the CSV export pattern.
  const abortController = new AbortController();
  let claimLost = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      try {
        const stillOwn = await refreshSolarRecDashboardBuildClaim(
          row.scopeId,
          buildId,
          claimId
        );
        if (!stillOwn) {
          claimLost = true;
          abortController.abort();
          clearInterval(heartbeat);
        }
      } catch (err) {
        // Best-effort: a single failed refresh shouldn't kill the
        // build. The next tick may succeed; the sweeper handles
        // the case where it doesn't.
        console.warn(
          `${METRIC_PREFIX} heartbeat refresh failed for buildId=${buildId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    const totalSteps = DASHBOARD_BUILD_STEPS.length;
    for (let i = 0; i < totalSteps; i += 1) {
      if (claimLost) break;
      const step = DASHBOARD_BUILD_STEPS[i];

      // Progress before the step — lets clients see "starting X"
      // before the step's wall time.
      try {
        await updateSolarRecDashboardBuildProgress(
          row.scopeId,
          buildId,
          claimId,
          {
            currentStep: i,
            totalSteps,
            percent: totalSteps === 0 ? 100 : Math.floor((i / totalSteps) * 100),
            message: `Starting ${step.name}`,
            factTable: step.name,
          }
        );
      } catch (err) {
        // Progress is best-effort — never fail a build because the
        // progress write failed.
        console.warn(
          `${METRIC_PREFIX} progress write failed for buildId=${buildId} step=${step.name}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      try {
        await runStepWithTimeout(
          step,
          {
            scopeId: row.scopeId,
            buildId,
            signal: abortController.signal,
          },
          PER_STEP_TIMEOUT_MS
        );
      } catch (err) {
        if (claimLost) {
          // Heartbeat lost the claim mid-step. The completion
          // UPDATE will no-op anyway; bail without recording the
          // failure to avoid stomping a re-claimer.
          break;
        }
        const message =
          err instanceof Error ? err.message : `unknown: ${String(err)}`;
        await completeSolarRecDashboardBuildFailure(
          row.scopeId,
          buildId,
          claimId,
          `${step.name}: ${message}`
        );
        clearInterval(heartbeat);
        metric.fail(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }

    if (claimLost) {
      clearInterval(heartbeat);
      // No completion write — the new claimer owns the row.
      metric.fail(new Error("claim lost — heartbeat refresh returned false"));
      return;
    }

    // Final progress — useful even when no steps ran (totalSteps=0).
    try {
      await updateSolarRecDashboardBuildProgress(
        row.scopeId,
        buildId,
        claimId,
        {
          currentStep: totalSteps,
          totalSteps,
          percent: 100,
          message: "Build complete",
          factTable: null,
        }
      );
    } catch {
      // Best-effort.
    }

    await completeSolarRecDashboardBuildSuccess(row.scopeId, buildId, claimId);
    clearInterval(heartbeat);
    metric.finish({ stepsRun: totalSteps });
  } catch (err) {
    // Catch-all for an unexpected throw outside step boundaries.
    clearInterval(heartbeat);
    const message =
      err instanceof Error ? err.message : `unknown: ${String(err)}`;
    try {
      await completeSolarRecDashboardBuildFailure(
        row.scopeId,
        buildId,
        claimId,
        `runner: ${message}`
      );
    } catch (innerErr) {
      console.error(
        `${METRIC_PREFIX} failure write failed for buildId=${buildId}: ${
          innerErr instanceof Error ? innerErr.message : String(innerErr)
        }`
      );
    }
    metric.fail(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Run one step with a per-step timeout. Aborts the step's signal
 * if the timeout elapses; the step's `run` is responsible for
 * checking the signal at suspend points.
 */
async function runStepWithTimeout(
  step: DashboardBuildStep,
  args: { scopeId: string; buildId: string; signal: AbortSignal },
  timeoutMs: number
): Promise<void> {
  const timeoutController = new AbortController();
  const composite = anySignal([args.signal, timeoutController.signal]);
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  try {
    await step.run({
      scopeId: args.scopeId,
      buildId: args.buildId,
      signal: composite,
    });
    if (timeoutController.signal.aborted) {
      throw new Error(
        `step ${step.name} timed out after ${timeoutMs}ms`
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cross-runtime AbortSignal.any shim. Node 22+ has `AbortSignal.any`
 * natively but older targets / test environments may not; this
 * polyfill follows the spec semantics: the composite aborts when
 * ANY of the input signals abort.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof (AbortSignal as unknown as { any?: unknown }).any === "function") {
    return (AbortSignal as unknown as {
      any: (s: AbortSignal[]) => AbortSignal;
    }).any(signals);
  }
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      return controller.signal;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/**
 * Read the row by id WITHOUT a scope filter. We need the scopeId
 * to drive every subsequent DB call, so the runner has to fetch
 * the row first. The status-poll proc filters by scope; this
 * runner-only path doesn't need to because the buildId is
 * generated server-side and never exposed to a different scope.
 *
 * Implemented as a scope-aware read with a known-set of scopes
 * would be safer but requires a scope registry; for now we
 * accept that the runner trusts the buildId and fetches by id
 * directly via a special helper that bypasses the scope filter.
 *
 * **PR-B note:** `solarRecDashboardBuilds` doesn't yet export a
 * scope-less getter. We work around this by reading via every
 * known scope is impractical; instead we add a minimal scope-less
 * read here as a private helper. PR-C+ will move this to
 * `server/db/solarRecDashboardBuilds.ts` if other callers need it.
 */
async function getRowAcrossScopes(
  buildId: string
): Promise<SolarRecDashboardBuild | null> {
  const { getDb } = await import("../../db/_core");
  const { solarRecDashboardBuilds } = await import("../../../drizzle/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(solarRecDashboardBuilds)
    .where(eq(solarRecDashboardBuilds.id, buildId))
    .limit(1);
  return rows[0] ?? null;
}

// ────────────────────────────────────────────────────────────────────
// Test-only surface
// ────────────────────────────────────────────────────────────────────

export const __TEST_ONLY__ = {
  HEARTBEAT_INTERVAL_MS,
  STALE_CLAIM_MS,
  PER_STEP_TIMEOUT_MS,
  getClaimId,
};
