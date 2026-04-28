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
import { toDateKey } from "@shared/dateKey";

let stopScheduler: (() => void) | null = null;

export function getScheduledHour(): number {
  const envValue = process.env.SOLAR_REC_MONITOR_HOUR;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 23) return parsed;
  }
  return 8; // default: 8 AM
}

export function getMonthlyScheduleTokens(): string[] {
  const raw = process.env.SOLAR_REC_MONITOR_DAYS?.trim();
  if (!raw) return ["1", "12", "15", "last"];
  return raw
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
}

/**
 * Walk forward day-by-day from `fromDateKey` until the next day matching
 * the configured monthly tokens. Returns null if `daily` is configured.
 * Capped at 366 days so a misconfiguration can't infinite-loop.
 */
export function nextScheduledDateKey(fromDateKey: string): string | null {
  const tokens = getMonthlyScheduleTokens();
  if (tokens.includes("daily")) return null;
  const start = new Date(`${fromDateKey}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;
  for (let i = 1; i <= 366; i += 1) {
    const candidate = new Date(start);
    candidate.setDate(candidate.getDate() + i);
    const candidateKey = toDateKey(candidate);
    if (shouldRunMonthlyMonitoring(candidateKey)) return candidateKey;
  }
  return null;
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
  await runScheduledMonitoringBatch(dateKey, /* triggeredBy */ null);
}

async function runScheduledMonitoringBatch(
  dateKey: string,
  triggeredBy: number | null
): Promise<{ batchId: string; scopeId: string }> {
  console.log(
    `[MonitoringScheduler] Starting ${triggeredBy ? "manual-test" : "scheduled"} run for ${dateKey}...`
  );
  // Single-scope today (Rhett's scope). When Task 5.2 onboards a second
  // scope with its own team credentials, this loop will iterate every
  // active scope; for now resolveSolarRecScopeId() is the single-tenant
  // helper.
  const scopeId = await resolveSolarRecScopeId();
  const batchId = await db.createMonitoringBatchRun({
    scopeId,
    dateKey,
    triggeredBy,
  });
  await executeMonitoringBatch(batchId, scopeId, dateKey, triggeredBy);
  console.log(`[MonitoringScheduler] Completed run for ${dateKey} (batchId=${batchId})`);
  return { batchId, scopeId };
}

/**
 * Manually fire the same code path the scheduler executes on a configured
 * day, regardless of whether today is in `SOLAR_REC_MONITOR_DAYS`. Returns
 * batchId synchronously after creating the row; the actual API sweep runs
 * in the background. Used by `monitoring.testScheduledRun` so an admin can
 * verify the scheduler's path without waiting for the next scheduled day.
 */
export async function startScheduledMonitoringBatchManually(
  triggeredBy: number | null
): Promise<{ batchId: string; scopeId: string; dateKey: string; wouldRunNormally: boolean }> {
  const dateKey = toDateKey(new Date(), "America/Chicago");
  const wouldRunNormally = shouldRunMonthlyMonitoring(dateKey);
  const scopeId = await resolveSolarRecScopeId();
  const batchId = await db.createMonitoringBatchRun({
    scopeId,
    dateKey,
    triggeredBy,
  });
  console.log(
    `[MonitoringScheduler] Manual test fire for ${dateKey} (would-run-normally=${wouldRunNormally}, batchId=${batchId})`
  );
  // Background — matches the existing monitoring.runAll fire-and-forget pattern.
  void executeMonitoringBatch(batchId, scopeId, dateKey, triggeredBy).catch((err) =>
    console.error("[MonitoringScheduler] Manual test fire failed:", err)
  );
  return { batchId, scopeId, dateKey, wouldRunNormally };
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
