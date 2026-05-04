/**
 * Lightweight measurement utility for Solar REC dashboard background
 * jobs (CSV exports today; future Phase 2 derived-fact builds and
 * Phase 4 page-endpoint warmups).
 *
 * Goal: every long-running dashboard job emits a single structured
 * log line per terminal state with heap before/after, elapsed time,
 * and an optional row/artifact count. The shape is the same across
 * jobs so log filters can pin one prefix and slurp the JSON.
 *
 * Intentionally cheap:
 *   - `process.memoryUsage()` is ~200 ns per call. Sampling on
 *     start + finish is fine.
 *   - No timers, no setInterval — the caller decides when to call
 *     `finish` / `fail`.
 *   - No TiDB `SHOW STATUS` / RU query — that needs a verified-
 *     cheap probe before it can run on every job. Add it when
 *     Phase 1 wires the RU diagnostics gate; this file stays
 *     process-local only.
 *
 * Usage:
 *   const metric = startDashboardJobMetric({
 *     prefix: "[dashboard:csv-export-jobs]",
 *     jobId,
 *     context: { exportType: input.exportType },
 *   });
 *   try {
 *     // ...do work...
 *     metric.finish({ rowCount, csvBytes: built.csv.length });
 *   } catch (err) {
 *     metric.fail(err);
 *     throw err;
 *   }
 *
 * The caller controls success/failure semantics — `fail()` does not
 * re-throw, and `finish()` does not consume errors. This is so a
 * runner that captures errors into a record (rather than throwing)
 * can still emit a structured failure metric without disturbing its
 * existing control flow.
 */

export interface DashboardJobMetricStartOptions {
  /** Searchable log prefix, e.g. `"[dashboard:csv-export-jobs]"`. */
  prefix: string;
  /** Job identifier — included in every line so a single job can be traced. */
  jobId: string;
  /**
   * Free-form context spread into every log line for this metric.
   * Keep small (a few enum-style fields) so log lines stay one-line
   * scannable. Don't put large objects in here.
   */
  context?: Record<string, unknown>;
}

export interface DashboardJobMetric {
  /** Emit a one-line structured success log. Safe to call exactly once. */
  finish(extra?: Record<string, unknown>): void;
  /** Emit a one-line structured failure log. Safe to call exactly once. */
  fail(error: unknown, extra?: Record<string, unknown>): void;
}

export function startDashboardJobMetric(
  options: DashboardJobMetricStartOptions
): DashboardJobMetric {
  const heapBeforeBytes = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  let settled = false;

  function emit(
    level: "info" | "error",
    outcome: "success" | "failed",
    extra: Record<string, unknown> | undefined,
    error?: unknown
  ): void {
    if (settled) return;
    settled = true;
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const payload: Record<string, unknown> = {
      jobId: options.jobId,
      ...options.context,
      outcome,
      elapsedMs: Date.now() - startedAt,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
      ...extra,
    };
    if (error !== undefined) {
      payload.error = error instanceof Error ? error.message : String(error);
    }
    const line = `${options.prefix} metric ${JSON.stringify(payload)}`;
    if (level === "info") {
      console.log(line);
    } else {
      console.error(line);
    }
  }

  return {
    finish(extra) {
      emit("info", "success", extra);
    },
    fail(error, extra) {
      emit("error", "failed", extra, error);
    },
  };
}
