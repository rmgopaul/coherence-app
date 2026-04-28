import { toDateKey } from "@shared/dateKey";
import { captureDailySnapshotForAllUsers } from "../services/notifications/dailySnapshot";
import {
  generateWeeklyReviewForAllUsers,
  previousWeekKey,
} from "../services/notifications/weeklyReview";
import { scheduleDaily } from "./scheduleDaily";

let stopScheduler: (() => void) | null = null;
let stopWeeklyReviewScheduler: (() => void) | null = null;

async function runNightlySnapshot(dateKey: string): Promise<void> {
  console.log(`[Nightly Snapshot] Starting 10:00 PM capture for ${dateKey}...`);
  const results = await captureDailySnapshotForAllUsers(dateKey);
  console.log(
    `[Nightly Snapshot] Completed for ${dateKey}. Users processed: ${results.length}`,
  );

  const now = new Date();

  // Prune engagement data older than 90 days
  try {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffKey = toDateKey(cutoff);
    const { pruneSectionEngagement } = await import("../db");
    await pruneSectionEngagement(cutoffKey);
    console.log(`[Nightly Snapshot] Pruned engagement data older than ${cutoffKey}`);
  } catch (error) {
    console.error("[Nightly Snapshot] Failed to prune engagement data:", error);
  }

  // Prune monitoringApiRuns older than 365 days so the table stays
  // bounded. One row per (provider, site, date) builds up fast across
  // 17 vendors, and nothing on the dashboard reads beyond the last year.
  try {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 365);
    const cutoffKey = toDateKey(cutoff);
    const { pruneMonitoringApiRuns } = await import("../db");
    await pruneMonitoringApiRuns(cutoffKey);
    console.log(`[Nightly Snapshot] Pruned monitoring api runs older than ${cutoffKey}`);
  } catch (error) {
    console.error("[Nightly Snapshot] Failed to prune monitoring api runs:", error);
  }

  // Prune dailyJobClaims older than 365 days — tiny table, but still
  // unbounded without this.
  try {
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 365);
    const cutoffKey = toDateKey(cutoff);
    const { pruneDailyJobClaims } = await import("../db");
    await pruneDailyJobClaims(cutoffKey);
    console.log(`[Nightly Snapshot] Pruned daily job claims older than ${cutoffKey}`);
  } catch (error) {
    console.error("[Nightly Snapshot] Failed to prune daily job claims:", error);
  }

  // Sweep expired Gmail waiting-on cache rows. 15-minute TTL means
  // stale rows accumulate quickly for any query that stops being
  // asked; the cache helper doesn't lazy-delete, so this is the only
  // place they get cleaned up.
  try {
    const { pruneExpiredGmailWaitingOn } = await import("../db");
    await pruneExpiredGmailWaitingOn();
    console.log(`[Nightly Snapshot] Pruned expired gmail waiting-on cache rows`);
  } catch (error) {
    console.error("[Nightly Snapshot] Failed to prune gmail waiting-on cache:", error);
  }
}

/**
 * Phase E (2026-04-28) — AI Weekly Review cron.
 *
 * Runs every day at 7am, but the work only fires on Monday — the
 * `scheduleDaily` helper doesn't know about days-of-week, so we
 * gate the actual generator inside the run callback. Cron claim
 * still happens daily via `dailyJobClaims`, which is fine —
 * Tue-Sun runs no-op cheaply.
 *
 * The weekKey passed to the generator is *last* week (the one
 * that just finished), via `previousWeekKey()`. Running on
 * Monday at 7am gives the final daily snapshot from Sunday a
 * full ~9 hours to capture (the nightly snapshot fires at 10pm).
 */
async function runWeeklyReview(dateKey: string): Promise<void> {
  const todayUtc = new Date(`${dateKey}T00:00:00Z`);
  // ISO weekday: Mon=1 ... Sun=7. We use UTC since dateKey is UTC.
  const isoDay = todayUtc.getUTCDay() || 7;
  if (isoDay !== 1) {
    console.log(
      `[Weekly Review] ${dateKey} is not a Monday (ISO day ${isoDay}); skipping.`
    );
    return;
  }
  const weekKey = previousWeekKey(todayUtc);
  console.log(`[Weekly Review] Generating for ${weekKey}…`);
  const result = await generateWeeklyReviewForAllUsers(weekKey);
  console.log(
    `[Weekly Review] Completed ${weekKey}: ok=${result.ok} failed=${result.failed}`
  );
}

export function startNightlySnapshotScheduler() {
  if (stopScheduler) return;
  stopScheduler = scheduleDaily({
    hour: 22,
    runKey: "nightly-snapshot",
    run: runNightlySnapshot,
  });
  // Phase E — weekly review cron (Monday 7am). Daily claim with a
  // day-of-week guard inside the run callback.
  if (!stopWeeklyReviewScheduler) {
    stopWeeklyReviewScheduler = scheduleDaily({
      hour: 7,
      runKey: "weekly-review",
      run: runWeeklyReview,
    });
  }
}

export function stopNightlySnapshotScheduler() {
  if (stopScheduler) {
    stopScheduler();
    stopScheduler = null;
  }
  if (stopWeeklyReviewScheduler) {
    stopWeeklyReviewScheduler();
    stopWeeklyReviewScheduler = null;
  }
}
