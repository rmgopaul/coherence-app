/**
 * Real-time progress channel for dashboard tab aggregators (Phase
 * B2 — 2026-05-12).
 *
 * When a user opens a dashboard tab and the relevant aggregator's
 * `solarRecComputedArtifacts` entry is cold-cache, the tRPC request
 * runs the aggregator inline and the user waits up to ~15 seconds
 * with a spinner. This module gives the client a real
 * percent-complete + stage-label feed so the wait is legible
 * instead of feeling broken.
 *
 * Design:
 *
 *   - In-memory `Map<string, ProgressState>` keyed by
 *     `${scopeId}::${aggregatorKey}` — by design ephemeral, NOT a
 *     job registry. CLAUDE.md hard rule #8 ("Dashboard
 *     background-job registries must be DB-backed") applies to
 *     jobs that need to survive process restart (CSV exports,
 *     dataset uploads, dashboard builds). Aggregator-progress
 *     state is meaningful only WHILE the recompute is in flight:
 *     if the process dies mid-recompute, the tRPC request also
 *     dies and the client retries — there's nothing to recover.
 *
 *   - **SINGLE-INSTANCE PROD ASSUMPTION.** This works because
 *     the resolver running the recompute and the resolver
 *     answering the client's poll are the same Node process. If
 *     this service is ever scaled out behind a load balancer
 *     (multi-instance Render web service, K8s replicas, etc.),
 *     Process A could be running the recompute while Process B
 *     answers the client's poll with `null`. To support
 *     multi-instance scale-out, replace this Map with a DB-backed
 *     table following the `dashboardCsvExportJobs` pattern
 *     (Phase 6 PR-B): `(scopeId, aggregatorKey)` row with
 *     `stage / fractionComplete / updatedAt / state` columns,
 *     atomic upsert on each `report()`, prune on `finish()` /
 *     `fail()`. The reporter interface below stays unchanged;
 *     only the storage backend swaps.
 *
 *   - One entry per `(scopeId, aggregatorKey)`. Concurrent
 *     recomputes for the same key are prevented upstream by
 *     `withArtifactCache`'s single-flight, so the racy
 *     "two `startAggregatorProgress` calls overlap" case can
 *     only happen if two clients hit the proc at the same
 *     instant before either reaches `withArtifactCache`. In that
 *     case the second `start()` call detects a running entry
 *     for the same key and JOINS it (returns a reporter whose
 *     `report()` calls update the same entry, but whose
 *     `finish()` / `fail()` are suppressed — the joined caller
 *     doesn't own the entry's terminal state).
 *
 *   - Auto-clears the entry on `finish()` / `fail()`. A failed
 *     recompute leaves the entry briefly visible with `state:
 *     "failed"` and the error message so the client UI can render
 *     the diagnostic; after `FAILURE_LINGER_MS` the entry is
 *     pruned.
 *
 *   - Optional `inputDeadlineMs` on `start()`: a recompute that
 *     hasn't reported progress in that long is assumed-dead and
 *     swept on the next poll. Defends against a `reportProgress`
 *     omission in a future aggregator leaving the spinner stuck
 *     at 90% forever.
 *
 * The reporter is intentionally NOT typed as a class — it's a
 * plain function returned from `startAggregatorProgress(...)`.
 * Callers thread it through the aggregator's internal call tree
 * the same way `serverSideMigration.ts` threads its
 * `reportProgress` callback.
 */

type ProgressStage = "loading" | "computing" | "writing";

export interface DashboardAggregatorProgressState {
  scopeId: string;
  aggregatorKey: string;
  stage: ProgressStage;
  /** Human-readable label for the current stage, e.g.
   *  "Loading deliveryScheduleBase rows". */
  stageLabel: string;
  /** [0, 1] inclusive. Round-clamp at read time. */
  fractionComplete: number;
  /** For aggregators that process N items, current count. */
  current: number | null;
  /** For aggregators that process N items, total count. */
  total: number | null;
  /** Singular unit for the count, e.g. "rows", "systems". */
  unitLabel: string | null;
  startedAt: number;
  updatedAt: number;
  state: "running" | "done" | "failed";
  errorMessage: string | null;
}

export interface AggregatorProgressReporter {
  /**
   * Report a progress update. `fractionComplete` is clamped to
   * [0, 1]. The state stays `"running"` until `finish()` / `fail()`.
   */
  report(input: {
    stage: ProgressStage;
    stageLabel: string;
    fractionComplete: number;
    current?: number | null;
    total?: number | null;
    unitLabel?: string | null;
  }): void;
  /**
   * Mark the aggregator done and schedule the entry for prune.
   * `finish()` is idempotent; subsequent calls are no-ops.
   */
  finish(): void;
  /**
   * Mark the aggregator failed. The entry lingers briefly with
   * `state: "failed"` so the client UI can display the error.
   */
  fail(error: unknown): void;
}

const FAILURE_LINGER_MS = 30_000;
const SUCCESS_LINGER_MS = 5_000;
const STALE_PROGRESS_MS = 60_000;

const registry = new Map<string, DashboardAggregatorProgressState>();

function makeKey(scopeId: string, aggregatorKey: string): string {
  return `${scopeId}::${aggregatorKey}`;
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Begin tracking progress for an aggregator recompute. Returns a
 * `reporter` whose methods the aggregator calls at stage
 * boundaries. The caller is responsible for invoking either
 * `reporter.finish()` (happy path) or `reporter.fail(error)`
 * (exception path) — typically in a `try / finally` around the
 * recompute body.
 *
 * **Join semantics on collision.** If a running entry already
 * exists for `(scopeId, aggregatorKey)` (two clients raced into
 * the proc before `withArtifactCache`'s single-flight gate
 * de-duped them), the second call does NOT overwrite the entry.
 * Instead it returns a "joined" reporter whose `report()` calls
 * are silently dropped (the first caller owns the progress
 * stream) and whose `finish()` / `fail()` are no-ops (the first
 * caller's terminal state wins). Without this guard, both
 * callers' `setTimeout` prunes would race for the same key.
 */
export function startAggregatorProgress(
  scopeId: string,
  aggregatorKey: string,
  initialStageLabel: string = "Starting"
): AggregatorProgressReporter {
  const key = makeKey(scopeId, aggregatorKey);
  const existing = registry.get(key);
  if (existing && existing.state === "running") {
    // Join the in-flight entry — return a reporter whose methods
    // are no-ops. The first caller's `withArtifactCache`
    // single-flight will resolve both callers' promises.
    return {
      report: () => {},
      finish: () => {},
      fail: () => {},
    };
  }
  const now = Date.now();
  registry.set(key, {
    scopeId,
    aggregatorKey,
    stage: "loading",
    stageLabel: initialStageLabel,
    fractionComplete: 0,
    current: null,
    total: null,
    unitLabel: null,
    startedAt: now,
    updatedAt: now,
    state: "running",
    errorMessage: null,
  });

  let finished = false;

  return {
    report(input) {
      if (finished) return;
      const existing = registry.get(key);
      if (!existing) return;
      registry.set(key, {
        ...existing,
        stage: input.stage,
        stageLabel: input.stageLabel,
        fractionComplete: clampFraction(input.fractionComplete),
        current: input.current ?? null,
        total: input.total ?? null,
        unitLabel: input.unitLabel ?? null,
        updatedAt: Date.now(),
      });
    },
    finish() {
      if (finished) return;
      finished = true;
      const existing = registry.get(key);
      if (!existing) return;
      registry.set(key, {
        ...existing,
        stage: "writing",
        stageLabel: "Done",
        fractionComplete: 1,
        updatedAt: Date.now(),
        state: "done",
      });
      setTimeout(() => {
        const current = registry.get(key);
        if (current?.state === "done") registry.delete(key);
      }, SUCCESS_LINGER_MS).unref?.();
    },
    fail(error) {
      if (finished) return;
      finished = true;
      const existing = registry.get(key);
      const errorMessage =
        error instanceof Error ? error.message : String(error ?? "Unknown error");
      registry.set(key, {
        ...(existing ?? {
          scopeId,
          aggregatorKey,
          stage: "loading",
          stageLabel: initialStageLabel,
          fractionComplete: 0,
          current: null,
          total: null,
          unitLabel: null,
          startedAt: now,
          updatedAt: now,
          state: "running",
          errorMessage: null,
        }),
        updatedAt: Date.now(),
        state: "failed",
        errorMessage,
      });
      setTimeout(() => {
        const current = registry.get(key);
        if (current?.state === "failed") registry.delete(key);
      }, FAILURE_LINGER_MS).unref?.();
    },
  };
}

/**
 * Read the current progress for a `(scopeId, aggregatorKey)` pair.
 * Returns null if no recompute is in flight. Stale entries (no
 * progress update in `STALE_PROGRESS_MS`) are swept opportunistically
 * on read.
 */
export function getAggregatorProgress(
  scopeId: string,
  aggregatorKey: string
): DashboardAggregatorProgressState | null {
  const key = makeKey(scopeId, aggregatorKey);
  const entry = registry.get(key);
  if (!entry) return null;
  if (
    entry.state === "running" &&
    Date.now() - entry.updatedAt > STALE_PROGRESS_MS
  ) {
    registry.delete(key);
    return null;
  }
  return entry;
}

/**
 * Test-only: clear the in-process registry between cases. Reset
 * hook is needed because the Map is module-level state.
 */
export function __resetAggregatorProgressForTests(): void {
  registry.clear();
}

export const __aggregatorProgressInternalsForTests = {
  FAILURE_LINGER_MS,
  SUCCESS_LINGER_MS,
  STALE_PROGRESS_MS,
};
