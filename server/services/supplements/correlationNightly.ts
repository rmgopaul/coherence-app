/**
 * Nightly pre-compute for the supplement-vs-metric correlation grid.
 *
 * Task 6.1 (2026-04-27) — runs after the per-user `dailyHealthMetrics`
 * upsert in `captureDailySnapshotForAllUsers`. For each
 * active-and-locked supplement on the user's protocol, we run
 * `analyzeCorrelation` over four metrics × two windows = 8 slices,
 * and upsert each result into `supplementCorrelations`. The
 * dashboard's `SupplementsFeedCell` reads from that table via
 * `supplements.getTopSignals` so the homepage no longer recomputes
 * on every render.
 *
 * Why active-and-locked: a "locked" supplement is one the user has
 * declared part of their stable protocol (vs. an experiment). The
 * cost of pre-computing is per-supplement-per-night, so excluding
 * un-locked tinkers keeps the matrix focused.
 *
 * Lag is fixed at 0 for the nightly compute. Lagged variants
 * (sleep aids → next-morning recovery) stay accessible via the
 * existing on-demand `supplements.runCorrelation` tRPC procedure.
 */

import { nanoid } from "nanoid";
import { toDateKey } from "@shared/dateKey";
import {
  getDailyMetricsHistory,
  listSupplementDefinitions,
  listSupplementLogsRange,
  upsertSupplementCorrelation,
} from "../../db";
import { analyzeCorrelation } from "./correlation";

/**
 * Metric fields on `dailyHealthMetrics` we pre-correlate against.
 * The display-friendly key is the Phase 6 spec's name; the column
 * name is the actual table field. Keeping them paired here so the
 * UI can read either.
 */
export const CORRELATED_METRICS = [
  { key: "recoveryScore", column: "whoopRecoveryScore" },
  { key: "sleepHours", column: "whoopSleepHours" },
  { key: "dayStrain", column: "whoopDayStrain" },
  { key: "hrvMs", column: "whoopHrvMs" },
] as const;

export const CORRELATION_WINDOWS = [30, 90] as const;

export type CorrelationMetricKey = (typeof CORRELATED_METRICS)[number]["key"];
export type CorrelationWindow = (typeof CORRELATION_WINDOWS)[number];

function startOfWindow(now: Date, windowDays: number): string {
  const start = new Date(now);
  start.setDate(start.getDate() - (windowDays - 1));
  return toDateKey(start);
}

/**
 * Run the full correlation grid for one user.
 *
 * Pulls the largest window's metric history once and the largest
 * window's supplement-log range once; each per-(supplement, metric,
 * window) slice then re-filters that data in memory. This is much
 * cheaper than 8N round-trips to the DB.
 *
 * Idempotent: row count after a run is `(active+locked supplements) ×
 * 4 metrics × 2 windows`. Re-running the same night overwrites in
 * place via the unique-index upsert.
 *
 * Returns the count of slices written so the snapshot job can log.
 */
export async function runNightlySupplementCorrelationsForUser(
  userId: number,
  now: Date = new Date()
): Promise<{ slicesWritten: number; supplementsConsidered: number }> {
  const definitions = await listSupplementDefinitions(userId);
  const eligible = definitions.filter((d) => d.isActive && d.isLocked);
  if (eligible.length === 0) {
    return { slicesWritten: 0, supplementsConsidered: 0 };
  }

  const maxWindow = Math.max(...CORRELATION_WINDOWS);
  const startKey = startOfWindow(now, maxWindow);
  const endKey = toDateKey(now);

  // Pull the max-window data once. Per-window slices below filter
  // this in memory (cheap — N is bounded at maxWindow rows for
  // metrics, and at the user's logging cadence for logs).
  const [rawMetrics, allLogs] = await Promise.all([
    getDailyMetricsHistory(userId, maxWindow),
    listSupplementLogsRange(userId, startKey, endKey),
  ]);

  let slicesWritten = 0;

  for (const supp of eligible) {
    // Pre-bucket this supplement's log dates once (across the max
    // window); per-window filters trim the set further.
    const allSuppLogDates = new Set<string>();
    for (const log of allLogs) {
      if (log.definitionId === supp.id) allSuppLogDates.add(log.dateKey);
    }

    for (const window of CORRELATION_WINDOWS) {
      const windowStart = startOfWindow(now, window);
      const suppLogDates = new Set<string>();
      allSuppLogDates.forEach((dateKey) => {
        if (dateKey >= windowStart) suppLogDates.add(dateKey);
      });

      for (const { key: metricKey, column: metricColumn } of CORRELATED_METRICS) {
        const metrics = rawMetrics
          .filter((row) => row.dateKey >= windowStart && row.dateKey <= endKey)
          .map((row) => {
            const raw = (row as Record<string, unknown>)[metricColumn];
            const num =
              raw === null || raw === undefined
                ? null
                : typeof raw === "number"
                  ? raw
                  : Number(raw);
            return {
              dateKey: row.dateKey,
              value:
                num === null || !Number.isFinite(num)
                  ? null
                  : (num as number),
            };
          });

        const result = analyzeCorrelation({
          suppLogDates,
          metrics,
          lagDays: 0,
        });

        await upsertSupplementCorrelation({
          id: nanoid(),
          userId,
          supplementId: supp.id,
          metric: metricKey,
          windowDays: window,
          lagDays: 0,
          computedAt: now,
          cohensD: result.cohensD,
          pearsonR: result.pearsonR,
          onN: result.onN,
          offN: result.offN,
          onMean: result.onMean,
          offMean: result.offMean,
          insufficientData: result.insufficientData,
        });
        slicesWritten += 1;
      }
    }
  }

  return { slicesWritten, supplementsConsidered: eligible.length };
}
