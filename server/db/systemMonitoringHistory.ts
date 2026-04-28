/**
 * Task 9.5 PR-6 (2026-04-28) — daily monitoring run history per
 * CSG ID. Final detail-page growth slice.
 *
 * Powers the new "Monitoring history" section on the system
 * detail page. Joins `monitoringApiRuns` rows for one system to
 * surface the daily run history (success / error / no_data /
 * skipped status + readings count + lifetime kWh + error message).
 *
 * Linkage walks the same chain as the Meter Reads section
 * (PR-1) — `csgId → registry.trackingSystemRefId →
 * srDsGenerationEntry.unitId → onlineMonitoring (vendor) +
 * onlineMonitoringSystemId`. From there: `monitoringApiRuns
 * WHERE provider === onlineMonitoring AND siteId ===
 * onlineMonitoringSystemId`. Could reuse the meter-reads helper's
 * resolution, but resolving inline here keeps the composer's
 * Promise.all parallelism intact (no helper-to-helper await chain)
 * and the duplicated ~10 LOC of generation-entry lookup is
 * acceptable for a feature that ships once.
 *
 * Why this is read-only:
 *
 *   - The MonitoringDashboard (`/solar-rec/monitoring`) is the
 *     authoritative place to trigger a re-run. The detail page's
 *     "Re-run" button hands off there.
 *   - We only show the most recent N runs (default 30) — that's
 *     a month of daily runs, enough to spot a regression without
 *     pulling years of history into a single payload.
 */

import { eq, and, desc, sql, getDb, withDbRetry } from "./_core";
import {
  monitoringApiRuns,
  srDsGenerationEntry,
  solarRecActiveDatasetVersions,
} from "../../drizzle/schema";
import { getSystemByCsgId } from "./systemRegistry";

export interface SystemMonitoringRun {
  dateKey: string;
  status: "success" | "error" | "no_data" | "skipped";
  readingsCount: number;
  lifetimeKwh: number | null;
  errorMessage: string | null;
  durationMs: number | null;
  triggeredAt: Date | null;
}

export interface SystemMonitoringHistoryResult {
  /** Resolved via generation-entry — null when the system has no
   *  vendor/siteId attached. */
  monitoringVendor: string | null;
  monitoringSystemId: string | null;
  /** Most-recent first, capped at the helper's limit. */
  runs: SystemMonitoringRun[];
  /** Total runs in the result set (matches `runs.length` because
   *  we don't query past the limit). Surfaced for symmetry with
   *  the other `getX*` helpers. */
  totalRuns: number;
  /** Status mix across the returned runs. */
  successCount: number;
  errorCount: number;
  noDataCount: number;
  skippedCount: number;
  /** Most recent successful-run dateKey. Null when no successes
   *  exist in the result window. */
  latestSuccessfulRunDate: string | null;
  /** Most recent error-run dateKey. */
  latestErrorRunDate: string | null;
  /** Number of consecutive non-success runs (error / no_data /
   *  skipped) ending at the most recent run. Useful as an alarm
   *  signal — a streak > 3 suggests the credential expired or the
   *  vendor's API changed. */
  consecutiveErrorStreak: number;
}

const EMPTY_RESULT: SystemMonitoringHistoryResult = {
  monitoringVendor: null,
  monitoringSystemId: null,
  runs: [],
  totalRuns: 0,
  successCount: 0,
  errorCount: 0,
  noDataCount: 0,
  skippedCount: 0,
  latestSuccessfulRunDate: null,
  latestErrorRunDate: null,
  consecutiveErrorStreak: 0,
};

/** Resolve the generationEntry active batch in one round-trip.
 *  Exposed for testability + reuse if a future composer wants
 *  a slimmer dependency graph. */
export async function resolveGenerationEntryBatchId(
  scopeId: string
): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await withDbRetry("monitoring history — active batch", () =>
    db
      .select({ batchId: solarRecActiveDatasetVersions.batchId })
      .from(solarRecActiveDatasetVersions)
      .where(
        and(
          eq(solarRecActiveDatasetVersions.scopeId, scopeId),
          eq(solarRecActiveDatasetVersions.datasetKey, "generationEntry")
        )
      )
      .limit(1)
  );
  return rows[0]?.batchId ?? null;
}

/** Compute the consecutive-error streak from the most recent end
 *  of a date-desc-sorted runs list. Stops counting when it hits
 *  a `success` row. Exposed for testability. */
export function computeConsecutiveErrorStreak(
  runs: ReadonlyArray<{ status: SystemMonitoringRun["status"] }>
): number {
  let streak = 0;
  for (const run of runs) {
    if (run.status === "success") break;
    streak += 1;
  }
  return streak;
}

export async function getMonitoringHistoryForCsgId(
  scopeId: string,
  csgId: string,
  opts: {
    /** Cap on runs returned. Default 30 (a month of daily runs);
     *  clamped to [1, 365]. Roll-ups span only the returned runs. */
    limit?: number;
    preResolvedRegistry?: Awaited<ReturnType<typeof getSystemByCsgId>>;
  } = {}
): Promise<SystemMonitoringHistoryResult> {
  const trimmed = csgId.trim();
  if (!trimmed) return EMPTY_RESULT;
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 365);

  const db = await getDb();
  if (!db) return EMPTY_RESULT;

  const registry =
    opts.preResolvedRegistry ?? (await getSystemByCsgId(scopeId, csgId));
  if (!registry) return EMPTY_RESULT;
  const trackingId = registry.trackingSystemRefId?.trim() || null;
  if (!trackingId) return EMPTY_RESULT;

  // Step 1 — resolve vendor + monitoring system id via
  // generationEntry. Mirrors the chain in `getLatestMeterReadsForCsgId`.
  const generationEntryBatchId = await resolveGenerationEntryBatchId(scopeId);
  if (!generationEntryBatchId) return EMPTY_RESULT;

  const genRows = await withDbRetry(
    "monitoring history — generation entry lookup",
    () =>
      db
        .select({
          onlineMonitoring: srDsGenerationEntry.onlineMonitoring,
          onlineMonitoringSystemId:
            srDsGenerationEntry.onlineMonitoringSystemId,
        })
        .from(srDsGenerationEntry)
        .where(
          and(
            eq(srDsGenerationEntry.scopeId, scopeId),
            eq(srDsGenerationEntry.batchId, generationEntryBatchId),
            eq(srDsGenerationEntry.unitId, trackingId)
          )
        )
        .limit(1)
  );
  const monitoringVendor = genRows[0]?.onlineMonitoring?.trim() || null;
  const monitoringSystemId =
    genRows[0]?.onlineMonitoringSystemId?.trim() || null;
  if (!monitoringVendor || !monitoringSystemId) {
    return { ...EMPTY_RESULT, monitoringVendor, monitoringSystemId };
  }

  // Step 2 — pull recent monitoring runs.
  const runRows = await withDbRetry(
    "monitoring history — api runs lookup",
    () =>
      db
        .select({
          dateKey: monitoringApiRuns.dateKey,
          status: monitoringApiRuns.status,
          readingsCount: monitoringApiRuns.readingsCount,
          lifetimeKwh: monitoringApiRuns.lifetimeKwh,
          errorMessage: monitoringApiRuns.errorMessage,
          durationMs: monitoringApiRuns.durationMs,
          triggeredAt: monitoringApiRuns.triggeredAt,
        })
        .from(monitoringApiRuns)
        .where(
          and(
            eq(monitoringApiRuns.scopeId, scopeId),
            eq(monitoringApiRuns.provider, monitoringVendor),
            eq(monitoringApiRuns.siteId, monitoringSystemId)
          )
        )
        .orderBy(desc(monitoringApiRuns.dateKey))
        .limit(limit)
  );

  if (runRows.length === 0) {
    return { ...EMPTY_RESULT, monitoringVendor, monitoringSystemId };
  }

  // Roll-ups across the result window.
  let successCount = 0;
  let errorCount = 0;
  let noDataCount = 0;
  let skippedCount = 0;
  let latestSuccessfulRunDate: string | null = null;
  let latestErrorRunDate: string | null = null;
  for (const r of runRows) {
    if (r.status === "success") {
      successCount += 1;
      if (latestSuccessfulRunDate === null) {
        // runRows are date-desc, so the first success we see is the
        // most recent.
        latestSuccessfulRunDate = r.dateKey;
      }
    } else if (r.status === "error") {
      errorCount += 1;
      if (latestErrorRunDate === null) {
        latestErrorRunDate = r.dateKey;
      }
    } else if (r.status === "no_data") {
      noDataCount += 1;
    } else if (r.status === "skipped") {
      skippedCount += 1;
    }
  }

  const runs: SystemMonitoringRun[] = runRows.map((r) => ({
    dateKey: r.dateKey,
    status: r.status,
    readingsCount: r.readingsCount,
    lifetimeKwh: r.lifetimeKwh,
    errorMessage: r.errorMessage,
    durationMs: r.durationMs,
    triggeredAt: r.triggeredAt,
  }));

  return {
    monitoringVendor,
    monitoringSystemId,
    runs,
    totalRuns: runs.length,
    successCount,
    errorCount,
    noDataCount,
    skippedCount,
    latestSuccessfulRunDate,
    latestErrorRunDate,
    consecutiveErrorStreak: computeConsecutiveErrorStreak(runs),
  };
}

// `sql` re-export silences the unused-import lint for the
// occasional `desc(monitoringApiRuns.dateKey)` paired query that
// some linters grouped under `sql` aliasing in older drizzle
// versions. Importing here keeps the file's import shape identical
// to the other systemX domain helpers.
void sql;
