/**
 * Scheduled daily monitoring run.
 *
 * Checks every minute and triggers a full batch monitoring run at the
 * configured hour (default 8:00 AM). Follows the same pattern as
 * server/_core/nightlySnapshotScheduler.ts.
 *
 * Configure via env:
 *   SOLAR_REC_MONITOR_HOUR=8   (0-23, default 8 = 8 AM)
 */
import { executeMonitoringBatch } from "./monitoring.service";
import * as db from "../db";

let intervalId: NodeJS.Timeout | null = null;
let lastRunDateKey: string | null = null;

function toDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getScheduledHour(): number {
  const envValue = process.env.SOLAR_REC_MONITOR_HOUR;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 23) return parsed;
  }
  return 8; // default: 8 AM
}

async function maybeRunMonitoringBatch() {
  const now = new Date();
  const targetHour = getScheduledHour();

  if (now.getHours() !== targetHour || now.getMinutes() !== 0) {
    return;
  }

  const dateKey = toDateKey(now);
  if (lastRunDateKey === dateKey) {
    return;
  }
  lastRunDateKey = dateKey;

  try {
    console.log(`[MonitoringScheduler] Starting daily run for ${dateKey}...`);
    const batchId = await db.createMonitoringBatchRun({
      dateKey,
      triggeredBy: null, // system-triggered
    });
    await executeMonitoringBatch(batchId, dateKey, null);
    console.log(`[MonitoringScheduler] Completed daily run for ${dateKey}`);
  } catch (error) {
    console.error("[MonitoringScheduler] Daily run failed:", error);
  }
}

export function startMonitoringScheduler() {
  if (intervalId) return;

  const hour = getScheduledHour();
  console.log(`[MonitoringScheduler] Scheduled daily monitoring at ${hour}:00`);

  // Check every minute
  intervalId = setInterval(() => {
    maybeRunMonitoringBatch().catch((error) => {
      console.error("[MonitoringScheduler] Interval error:", error);
    });
  }, 60_000);

  // Startup check
  maybeRunMonitoringBatch().catch((error) => {
    console.error("[MonitoringScheduler] Startup check error:", error);
  });
}
