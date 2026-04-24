/**
 * Distributed daily-job scheduler.
 *
 * Replaces the old setInterval(60s) + in-process lastRunDateKey pattern
 * that ate runs when the server restarted inside the target minute and
 * double-fired when two instances were running.
 *
 * Mechanics:
 *   1. On startup, if the current time is already past the target hour
 *      today AND no dailyJobClaims row exists for today's (dateKey,
 *      runKey), attempt a run immediately. Handles restart-inside-the-
 *      target-minute without skipping the work.
 *   2. Otherwise, setTimeout until the next target-hour boundary.
 *      setTimeout is recomputed after each run so DST shifts don't
 *      accumulate drift.
 *   3. At the boundary (or on the startup-catchup path), attempt to
 *      INSERT a claim row. The unique (dateKey, runKey) index makes the
 *      claim atomic across instances — only one wins.
 *   4. Winner runs the work; loser skips silently.
 *   5. Update the claim row to completed|failed on settle.
 */
import {
  claimDailyJob,
  completeDailyJob,
  failDailyJob,
  hasDailyJobClaim,
} from "../db";

export type ScheduleDailyOptions = {
  /** Hour of day (0-23) in local server time. */
  hour: number;
  /**
   * Unique key for this job. Two runKey values get two independent
   * claim rows per day — e.g. "nightly-snapshot" and "monitoring-batch"
   * can both fire without fighting.
   */
  runKey: string;
  /** The actual work to perform. */
  run: (dateKey: string) => Promise<void>;
};

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function msUntilNextTarget(hour: number): number {
  const now = new Date();
  const next = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    0,
    0,
    0,
  );
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function attemptRun(opts: ScheduleDailyOptions): Promise<void> {
  const now = new Date();
  const dateKey = toDateKey(now);
  const label = `[ScheduleDaily:${opts.runKey}]`;

  const claim = await claimDailyJob({ dateKey, runKey: opts.runKey });
  if (!claim) {
    console.log(`${label} Already claimed for ${dateKey}, skipping.`);
    return;
  }

  try {
    console.log(`${label} Running for ${dateKey}...`);
    await opts.run(dateKey);
    await completeDailyJob({ dateKey, runKey: opts.runKey });
    console.log(`${label} Completed for ${dateKey}.`);
  } catch (error) {
    console.error(`${label} Failed for ${dateKey}:`, error);
    await failDailyJob({ dateKey, runKey: opts.runKey, error });
  }
}

/**
 * Start a daily-job scheduler. Returns a stop() function that cancels
 * the pending timer; intended for tests and graceful shutdown.
 */
export function scheduleDaily(opts: ScheduleDailyOptions): () => void {
  let cancelled = false;
  let timer: NodeJS.Timeout | undefined;

  function scheduleNext() {
    if (cancelled) return;
    const delay = msUntilNextTarget(opts.hour);
    timer = setTimeout(async () => {
      try {
        await attemptRun(opts);
      } finally {
        scheduleNext();
      }
    }, delay);
  }

  // Startup catchup: if we're already past target-hour today and no
  // claim exists yet, fire immediately. Covers restarts inside the
  // target minute and deploys that happen between target-hour and
  // midnight.
  void (async () => {
    try {
      const now = new Date();
      if (now.getHours() >= opts.hour) {
        const dateKey = toDateKey(now);
        const alreadyClaimed = await hasDailyJobClaim({
          dateKey,
          runKey: opts.runKey,
        });
        if (!alreadyClaimed) {
          await attemptRun(opts);
        }
      }
    } catch (error) {
      console.error(
        `[ScheduleDaily:${opts.runKey}] Startup catchup failed:`,
        error,
      );
    } finally {
      scheduleNext();
    }
  })();

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
