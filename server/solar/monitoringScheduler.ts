/**
 * Scheduled daily monitoring run.
 *
 * Triggers a full batch monitoring run at the configured hour (default
 * 8:00 AM). Uses scheduleDaily, so a restart inside the target minute
 * still picks up the work (via the startup-catchup path) and two
 * instances can't both fire the batch (the dailyJobClaims unique index
 * serializes them).
 *
 * Configure via env:
 *   SOLAR_REC_MONITOR_HOUR=8   (0-23, default 8 = 8 AM)
 */
import { scheduleDaily } from "../_core/scheduleDaily";
import { executeMonitoringBatch } from "./monitoring.service";
import * as db from "../db";

let stopScheduler: (() => void) | null = null;

function getScheduledHour(): number {
  const envValue = process.env.SOLAR_REC_MONITOR_HOUR;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 23) return parsed;
  }
  return 8; // default: 8 AM
}

async function runMonitoringBatch(dateKey: string): Promise<void> {
  console.log(`[MonitoringScheduler] Starting daily run for ${dateKey}...`);
  const batchId = await db.createMonitoringBatchRun({
    dateKey,
    triggeredBy: null, // system-triggered
  });
  await executeMonitoringBatch(batchId, dateKey, null);
  console.log(`[MonitoringScheduler] Completed daily run for ${dateKey}`);
}

export function startMonitoringScheduler() {
  if (stopScheduler) return;
  const hour = getScheduledHour();
  console.log(`[MonitoringScheduler] Scheduled daily monitoring at ${hour}:00`);
  stopScheduler = scheduleDaily({
    hour,
    runKey: "monitoring-batch",
    run: runMonitoringBatch,
  });
}

export function stopMonitoringScheduler() {
  if (stopScheduler) {
    stopScheduler();
    stopScheduler = null;
  }
}
