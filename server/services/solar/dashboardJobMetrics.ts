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
 *     metric.finish({
 *       rowCount,
 *       // UTF-8 byte count, NOT String.length (which is UTF-16 code
 *       // units and undercounts for non-ASCII content).
 *       csvBytes: Buffer.byteLength(csv, "utf8"),
 *     });
 *   } catch (err) {
 *     // fail() does NOT re-throw. The caller decides whether to
 *     // bubble the error (re-throw after fail) or capture it into
 *     // a record (return after fail) — see runCsvExportJob for the
 *     // capture pattern.
 *     metric.fail(err);
 *   }
 */

/**
 * Reserved envelope keys — the metric utility owns these. Caller-
 * supplied `context` and `extra` keys with these names cannot
 * override them: the runtime either spread-shadows the key (the
 * envelope value lands AFTER the spreads in `emit()`) or explicitly
 * deletes it on the no-error branch (this is what `error` does on
 * `finish()`). The Set is exported so source-rail tests can prove
 * the contract instead of hard-coding the list in two places.
 *
 * **Emitted-when-applicable, not always-present:** reserved keys are
 * owned by the utility but not all are emitted on every line. Today
 * `error` is emitted only on `fail()`; on `finish()` it is
 * unconditionally absent (any caller `extra.error` / `context.error`
 * is deleted). The other six keys (`jobId`, `outcome`, `elapsedMs`,
 * `heap*Bytes`) appear on every emitted line.
 *
 * **Maintainer note:** adding a key here is necessary but NOT
 * sufficient. The runtime in `emit()` must be updated to either
 * (a) write the key after the `...extra` spread (so it shadows), or
 * (b) explicitly delete/handle it on the relevant branches. Without
 * one of those, a new entry here ships a hole — the test mirror
 * passes but caller `extra` survives at runtime.
 */
export const RESERVED_METRIC_KEYS: ReadonlySet<string> = new Set([
  "jobId",
  "outcome",
  "elapsedMs",
  "heapBeforeBytes",
  "heapAfterBytes",
  "heapDeltaBytes",
  "error",
]);

export interface DashboardJobMetricStartOptions {
  /** Searchable log prefix, e.g. `"[dashboard:csv-export-jobs]"`. */
  prefix: string;
  /** Job identifier — included in every line so a single job can be traced. */
  jobId: string;
  /**
   * Free-form context spread into every log line for this metric.
   * Keep small (a few enum-style fields) so log lines stay one-line
   * scannable. Don't put large objects in here.
   *
   * **Reserved-key collision:** keys present in `RESERVED_METRIC_KEYS`
   * (`jobId`, `outcome`, `elapsedMs`, `heap*Bytes`, `error`) are
   * silently shadowed by the envelope. Future Phase 2/4 builders
   * can rely on the envelope's invariants regardless of what
   * callers pass in here.
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
    // Caller fields go FIRST so the reserved envelope fields below
    // ALWAYS win the spread. A future Phase 2 builder that
    // accidentally passes `context: { jobId: "x" }` or
    // `extra: { outcome: "weird" }` cannot corrupt the metric
    // contract that downstream log filters depend on.
    const payload: Record<string, unknown> = {
      ...options.context,
      ...extra,
      jobId: options.jobId,
      outcome,
      elapsedMs: Date.now() - startedAt,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
    };
    if (error !== undefined) {
      payload.error = error instanceof Error ? error.message : String(error);
    } else {
      // `error` is in `RESERVED_METRIC_KEYS` so the contract is
      // "always reserved." On finish(), the runtime has no error to
      // write — but a caller could have passed `extra: { error: ... }`
      // or `context: { error: ... }` and it would survive the spread
      // unless we explicitly delete here. Without this delete, a log
      // filter that uses `error` presence as a failure signal would
      // misclassify success metrics that happen to carry an `error`
      // field from caller context.
      delete payload.error;
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
