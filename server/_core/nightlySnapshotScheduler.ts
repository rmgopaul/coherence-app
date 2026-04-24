import { captureDailySnapshotForAllUsers } from "../services/notifications/dailySnapshot";
import { scheduleDaily } from "./scheduleDaily";

let stopScheduler: (() => void) | null = null;

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

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
}

export function startNightlySnapshotScheduler() {
  if (stopScheduler) return;
  stopScheduler = scheduleDaily({
    hour: 22,
    runKey: "nightly-snapshot",
    run: runNightlySnapshot,
  });
}

export function stopNightlySnapshotScheduler() {
  if (stopScheduler) {
    stopScheduler();
    stopScheduler = null;
  }
}
