/**
 * Scheduled monitoring run.
 *
 * Checks once per day at the configured hour (default 8:00 AM), but only
 * runs the expensive full batch on the configured monthly days. Uses
 * scheduleDaily, so a restart inside the target minute still picks up the
 * work (via the startup-catchup path) and two instances can't both fire
 * the batch (the dailyJobClaims unique index serializes them).
 *
 * Configure via env:
 *   SOLAR_REC_MONITOR_HOUR=8            (0-23, default 8 = 8 AM)
 *   SOLAR_REC_MONITOR_DAYS=1,12,15,last (default; use "daily" to restore daily)
 */
import { scheduleDaily } from "../_core/scheduleDaily";
import { resolveSolarRecScopeId } from "../_core/solarRecAuth";
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

function getMonthlyScheduleTokens(): string[] {
  const raw = process.env.SOLAR_REC_MONITOR_DAYS?.trim();
  if (!raw) return ["1", "12", "15", "last"];
  return raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

function dateParts(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  return { year, month, day };
}

export function shouldRunMonthlyMonitoring(dateKey: string): boolean {
  const tokens = getMonthlyScheduleTokens();
  if (tokens.includes("daily")) return true;

  const { year, month, day } = dateParts(dateKey);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return false;
  }

  const lastDay = new Date(year, month, 0).getDate();
  return tokens.some((token) => {
    if (token === "last") return day === lastDay;
    const parsed = Number(token);
    return Number.isInteger(parsed) && parsed === day;
  });
}

async function runMonitoringBatch(dateKey: string): Promise<void> {
  if (!shouldRunMonthlyMonitoring(dateKey)) {
    console.log(
      `[MonitoringScheduler] Skipping ${dateKey}; scheduled days are ${getMonthlyScheduleTokens().join(", ")}.`
    );
    return;
  }

  console.log(`[MonitoringScheduler] Starting scheduled run for ${dateKey}...`);
  // Single-scope today (Rhett's scope). When Task 5.2 onboards a second
  // scope with its own team credentials, this loop will iterate every
  // active scope; for now resolveSolarRecScopeId() is the single-tenant
  // helper.
  const scopeId = await resolveSolarRecScopeId();
  const batchId = await db.createMonitoringBatchRun({
    scopeId,
    dateKey,
    triggeredBy: null, // system-triggered
  });
  await executeMonitoringBatch(batchId, scopeId, dateKey, null);
  console.log(`[MonitoringScheduler] Completed scheduled run for ${dateKey}`);
}

export function startMonitoringScheduler() {
  if (stopScheduler) return;
  const hour = getScheduledHour();
  console.log(
    `[MonitoringScheduler] Scheduled monitoring check at ${hour}:00; run days=${getMonthlyScheduleTokens().join(", ")}`
  );
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
