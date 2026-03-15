import { captureDailySnapshotForAllUsers } from "../services/dailySnapshot";

let intervalId: NodeJS.Timeout | null = null;
let lastRunDateKey: string | null = null;

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function maybeRunNightlySnapshot() {
  const now = new Date();
  if (now.getHours() !== 22 || now.getMinutes() !== 0) {
    return;
  }

  const dateKey = toDateKey(now);
  if (lastRunDateKey === dateKey) {
    return;
  }
  lastRunDateKey = dateKey;

  try {
    console.log(`[Nightly Snapshot] Starting 10:00 PM capture for ${dateKey}...`);
    const results = await captureDailySnapshotForAllUsers(dateKey);
    console.log(`[Nightly Snapshot] Completed for ${dateKey}. Users processed: ${results.length}`);
  } catch (error) {
    console.error("[Nightly Snapshot] Failed to capture nightly snapshots:", error);
  }

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
}

export function startNightlySnapshotScheduler() {
  if (intervalId) return;

  // Check every minute and trigger once at 10:00 PM local server time.
  intervalId = setInterval(() => {
    maybeRunNightlySnapshot().catch((error) => {
      console.error("[Nightly Snapshot] Interval error:", error);
    });
  }, 60_000);

  // Run a startup check (useful if server starts right around 10:00 PM).
  maybeRunNightlySnapshot().catch((error) => {
    console.error("[Nightly Snapshot] Startup check error:", error);
  });
}

