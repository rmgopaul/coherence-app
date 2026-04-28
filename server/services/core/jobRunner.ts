/**
 * Generic job-runner inner-loop with atomic per-item counters.
 *
 * Task 8.1 (2026-04-28) — pulls out the shared "iterate pending
 * items with bounded concurrency, increment success/failure
 * counters, poll for cancellation" pattern that
 * `contractScanJobRunner`, `dinScrapeJobRunner`,
 * `scheduleBImportJobRunner`, and `csgScheduleBImportJobRunner`
 * had each copy-pasted. Each runner kept its own
 * provider-specific setup (login, fetch credentials, etc.) and
 * terminal-status update; the inner loop now lives here.
 *
 * What this function owns:
 *   - The `mapWithConcurrency` wrap.
 *   - Per-item cancellation check (before invoking processItem).
 *   - Per-item try/catch; an exception counts as a failure.
 *   - Atomic counter increment after each item.
 *   - Aggregate result (cancelled flag + counts) returned to caller.
 *
 * What the caller still owns:
 *   - Loading the job row + verifying it isn't already terminal.
 *   - Marking the job `running` before calling this.
 *   - Provider-specific setup (CSG portal login, credential fetch,
 *     session refresh strategy, etc.).
 *   - Loading the pending items list (`pendingItems`).
 *   - Determining what counts as success vs. failure inside
 *     `processItem` (return `{outcome}`).
 *   - The terminal-status update at the end (stopped / completed /
 *     failed).
 */

import { mapWithConcurrency } from "./concurrency";

export type JobItemOutcome = "success" | "failure";

export type JobRunnerHelpers = {
  /**
   * Poll for cancellation. Equivalent to the caller's `isCancelled`
   * input, surfaced inside `processItem` so long-running per-item
   * work can short-circuit without waiting for the next outer
   * check.
   */
  isCancelled: () => Promise<boolean>;
};

export type JobRunnerInput<TItem> = {
  jobId: string;
  pendingItems: TItem[];
  concurrency: number;
  /**
   * How the helper polls for "stop requested." Called before each
   * item. Caller decides cadence — wrap in a counter if you want
   * to throttle the DB hits, or hit DB every time if cheap.
   */
  isCancelled: () => Promise<boolean>;
  /**
   * Per-item work. Return `{outcome}` so the helper knows which
   * counter to bump. Throw to indicate an unexpected error — the
   * helper catches, calls `logError`, and counts as a failure.
   */
  processItem: (
    item: TItem,
    helpers: JobRunnerHelpers
  ) => Promise<{ outcome: JobItemOutcome }>;
  /** Atomic counter increment, called once per item after processItem. */
  incrementCounter: (
    field: "successCount" | "failureCount"
  ) => Promise<void>;
  /**
   * Called when `processItem` throws. Defaults to `console.warn`
   * with the jobId + item label (best-effort `String(item)`).
   * Counter-write failures are also routed here, with a
   * `phase: "counter"` discriminator on the error.
   */
  logError?: (input: {
    jobId: string;
    item: TItem;
    error: unknown;
    phase: "process" | "counter";
  }) => void;
};

export type JobRunnerResult = {
  /** True if `isCancelled()` returned true at any point. */
  cancelled: boolean;
  /** Items that ran (i.e. weren't skipped due to cancellation). */
  processed: number;
  successes: number;
  failures: number;
};

const defaultLogError = ({
  jobId,
  item,
  error,
  phase,
}: {
  jobId: string;
  item: unknown;
  error: unknown;
  phase: "process" | "counter";
}): void => {
  const itemLabel =
    typeof item === "string"
      ? item
      : (() => {
          try {
            return JSON.stringify(item);
          } catch {
            return String(item);
          }
        })();
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `[jobRunner] ${phase} error for job ${jobId}, item ${itemLabel}: ${message}`
  );
};

/**
 * Run a list of pending items through `processItem` with bounded
 * concurrency, calling `incrementCounter` after each. Returns when
 * every worker has either finished or short-circuited via
 * `isCancelled()`.
 *
 * Cancellation semantics: once a worker sees `isCancelled()` return
 * true, that worker returns. Other in-flight workers check on
 * their own next iteration. So the helper drains gracefully — no
 * forced-abort mid-item.
 */
export async function runJobWithAtomicCounters<TItem>(
  input: JobRunnerInput<TItem>
): Promise<JobRunnerResult> {
  const {
    jobId,
    pendingItems,
    concurrency,
    isCancelled,
    processItem,
    incrementCounter,
    logError = defaultLogError,
  } = input;

  if (pendingItems.length === 0) {
    return { cancelled: false, processed: 0, successes: 0, failures: 0 };
  }

  let cancelled = false;
  let processed = 0;
  let successes = 0;
  let failures = 0;

  const helpers: JobRunnerHelpers = { isCancelled };

  const checkAndUpdateCancelled = async (): Promise<boolean> => {
    if (cancelled) return true;
    const flag = await isCancelled();
    if (flag) cancelled = true;
    return cancelled;
  };

  await mapWithConcurrency(pendingItems, concurrency, async (item) => {
    if (await checkAndUpdateCancelled()) return;

    let outcome: JobItemOutcome;
    try {
      const result = await processItem(item, helpers);
      outcome = result.outcome;
    } catch (error) {
      outcome = "failure";
      logError({ jobId, item, error, phase: "process" });
    }

    try {
      await incrementCounter(
        outcome === "success" ? "successCount" : "failureCount"
      );
    } catch (error) {
      // Counter-write failure is logged but doesn't change accounting —
      // the worker already determined the outcome locally.
      logError({ jobId, item, error, phase: "counter" });
    }

    processed += 1;
    if (outcome === "success") successes += 1;
    else failures += 1;
  });

  return { cancelled, processed, successes, failures };
}
