/**
 * Task 9.5 PR-6 (2026-04-28) — monitoring history per CSG ID.
 *
 * Closes Task 9.5. Final section on the system detail page —
 * "Monitoring history" — surfaces the recent `monitoringApiRuns`
 * activity for one system so the user can see at-a-glance whether
 * yesterday's scheduler picked up readings, how the 7-day and 30-day
 * windows are trending, and what error message most recently
 * surfaced.
 *
 * Vendor + site resolution chain (mirrors `systemMeterReads.ts`):
 *
 *   csgId
 *     → registry (Task 9.1)
 *     → `srDsGenerationEntry.onlineMonitoring` (vendor name) +
 *       `onlineMonitoringSystemId`
 *     → `monitoringApiRuns(provider = LOWER(vendor), siteId = onlineMonitoringSystemId)`
 *
 * Provider adapter keys in `monitoring.service` are lowercase
 * (`solis`, `solaredge`, `fronius`, etc) but the
 * `srDsGenerationEntry.onlineMonitoring` column is mixed-case
 * ("Solis" / "SolarEdge"). We lowercase before the join and pass the
 * lowercase value to the client too — that's the form the existing
 * Monitoring Overview page uses.
 *
 * Returns aggregates over the last 30 days plus the last 14 raw
 * runs ordered newest-first so the section can render a recent-
 * activity table without a separate paginated read.
 */

import { eq, and, desc, gte, sql, getDb, withDbRetry } from "./_core";
import { lte } from "drizzle-orm";
import { monitoringApiRuns, srDsGenerationEntry } from "../../drizzle/schema";
import { getSystemByCsgId } from "./systemRegistry";
import { resolveMeterReadsBatchIds } from "./systemMeterReads";

const RECENT_RUN_LIMIT = 14;
const HISTORY_WINDOW_DAYS = 30;

export type MonitoringHistoryStatus =
  | "success"
  | "error"
  | "no_data"
  | "skipped";

export interface SystemMonitoringHistoryRun {
  dateKey: string;
  status: MonitoringHistoryStatus;
  readingsCount: number;
  lifetimeKwh: number | null;
  errorMessage: string | null;
  durationMs: number | null;
}

export interface SystemMonitoringHistoryResult {
  /** Lowercase provider key matching `monitoringApiRuns.provider`
   *  (e.g. "solis", "solaredge"). `null` when no generation-entry row
   *  resolved a vendor — same fallback story as the meter-reads
   *  section. */
  provider: string | null;
  /** The vendor's site ID — joins back to `monitoringApiRuns.siteId`
   *  AND is what the monitoring vendor's portal expects. */
  siteId: string | null;
  /** The vendor's display name for this system, captured at run time
   *  (`monitoringApiRuns.siteName`). `null` if no run has happened
   *  yet for this system in the 30-day window. */
  siteName: string | null;
  /** Most-recent connection used to run this site, if known. Surfaces
   *  the credential pin when multiple credentials exist for one
   *  provider — useful when triaging "connection X is broken,
   *  connection Y is fine" failure modes. */
  connectionId: string | null;
  /** 7-day rollup ending at the anchor (server today in CT). */
  last7Attempts: number;
  last7Successes: number;
  last7Errors: number;
  last7NoData: number;
  /** 30-day rollup ending at the anchor. */
  last30Attempts: number;
  last30Successes: number;
  last30Errors: number;
  last30NoData: number;
  /** dateKey of the latest successful run — null if none in 30 days. */
  lastSuccessAt: string | null;
  /** Most-recent run regardless of status. */
  lastRunAt: string | null;
  lastRunStatus: MonitoringHistoryStatus | null;
  /** Most-recent non-success run's errorMessage + dateKey. Surfaces
   *  the actual failure context, not "the last run was an error"
   *  (which `lastRunStatus` already covers separately). */
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
  /** Up to 14 most-recent runs, newest first. */
  recentRuns: SystemMonitoringHistoryRun[];
}

const EMPTY_RESULT: SystemMonitoringHistoryResult = {
  provider: null,
  siteId: null,
  siteName: null,
  connectionId: null,
  last7Attempts: 0,
  last7Successes: 0,
  last7Errors: 0,
  last7NoData: 0,
  last30Attempts: 0,
  last30Successes: 0,
  last30Errors: 0,
  last30NoData: 0,
  lastSuccessAt: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastErrorAt: null,
  lastErrorMessage: null,
  recentRuns: [],
};

function asStatus(raw: unknown): MonitoringHistoryStatus | null {
  if (raw === "success" || raw === "error" || raw === "no_data" || raw === "skipped") {
    return raw;
  }
  return null;
}

/**
 * Look up monitoring history for one CSG ID. Returns `EMPTY_RESULT`
 * (with `provider`/`siteId` left null) when:
 *   - The registry doesn't resolve (unknown CSG ID), OR
 *   - Generation entry doesn't reveal a vendor + system ID for this
 *     trackingSystemRefId, OR
 *   - The vendor/site has zero runs in the last 30 days.
 *
 * The first two cases are indistinguishable in the result shape —
 * the section's empty-state copy explains why on the client side.
 */
export async function getMonitoringHistoryForCsgId(
  scopeId: string,
  csgId: string,
  opts: {
    preResolvedRegistry?: Awaited<ReturnType<typeof getSystemByCsgId>>;
    /** Anchor for the 7d/30d windows. Defaults to today in
     *  `America/Chicago`. Override is for tests only. */
    anchorDateKey?: string;
  } = {}
): Promise<SystemMonitoringHistoryResult> {
  const trimmed = csgId.trim();
  if (!trimmed) return EMPTY_RESULT;

  const db = await getDb();
  if (!db) return EMPTY_RESULT;

  const registry =
    opts.preResolvedRegistry ?? (await getSystemByCsgId(scopeId, csgId));
  if (!registry) return EMPTY_RESULT;

  // Step 1 — resolve vendor + siteId via generation entry.
  // Reuses the same active-batch resolver the meter-reads helper
  // uses; we only need the `generationEntry` slot.
  const batches = await resolveMeterReadsBatchIds(scopeId);
  let vendor: string | null = null;
  let siteIdRaw: string | null = null;
  // Capture the narrowed values up-front so the closure below
  // doesn't lose narrowing across the await boundary (TS6133-style).
  const generationEntryBatchId: string | null = batches.generationEntry;
  const trackingId: string | null = registry.trackingSystemRefId;
  if (generationEntryBatchId && trackingId) {
    const genRows = await withDbRetry(
      "monitoring history — generation entry lookup",
      () =>
        db
          .select({
            onlineMonitoring: srDsGenerationEntry.onlineMonitoring,
            onlineMonitoringSystemId: srDsGenerationEntry.onlineMonitoringSystemId,
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
    const gen = genRows[0];
    if (gen) {
      vendor = gen.onlineMonitoring?.trim() || null;
      siteIdRaw = gen.onlineMonitoringSystemId?.trim() || null;
    }
  }

  if (!vendor || !siteIdRaw) return EMPTY_RESULT;

  // `monitoringApiRuns.provider` is the lowercase adapter key
  // (`solis`, `solaredge`); `srDsGenerationEntry.onlineMonitoring`
  // is mixed-case display text. Lowercase before the join.
  const provider = vendor.toLowerCase();
  const siteId = siteIdRaw;

  // Step 2 — compute window anchors. America/Chicago "today"
  // matches the existing scheduler's dateKey convention.
  const anchorDateKey =
    opts.anchorDateKey ??
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Chicago",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());

  const anchor = new Date(`${anchorDateKey}T00:00:00`);
  const last7Start = new Date(anchor);
  last7Start.setDate(last7Start.getDate() - 6);
  const last30Start = new Date(anchor);
  last30Start.setDate(last30Start.getDate() - (HISTORY_WINDOW_DAYS - 1));
  const last7StartDateKey = last7Start.toISOString().slice(0, 10);
  const last30StartDateKey = last30Start.toISOString().slice(0, 10);

  // Step 3 — pull all 30-day rows for this (provider, siteId).
  // `(scopeId, provider, siteId, dateKey)` composite index covers
  // the lookup; bounded by a 30-day window so worst-case ~30 rows.
  // We pull every row (no LIMIT) so the recent-runs table + the
  // aggregate columns share one read.
  const rows = await withDbRetry(
    "monitoring history — runs lookup",
    () =>
      db
        .select({
          dateKey: monitoringApiRuns.dateKey,
          status: monitoringApiRuns.status,
          readingsCount: monitoringApiRuns.readingsCount,
          lifetimeKwh: monitoringApiRuns.lifetimeKwh,
          errorMessage: monitoringApiRuns.errorMessage,
          durationMs: monitoringApiRuns.durationMs,
          siteName: monitoringApiRuns.siteName,
          connectionId: monitoringApiRuns.connectionId,
        })
        .from(monitoringApiRuns)
        .where(
          and(
            eq(monitoringApiRuns.scopeId, scopeId),
            sql`LOWER(${monitoringApiRuns.provider}) = ${provider}`,
            eq(monitoringApiRuns.siteId, siteId),
            gte(monitoringApiRuns.dateKey, last30StartDateKey),
            lte(monitoringApiRuns.dateKey, anchorDateKey)
          )
        )
        .orderBy(desc(monitoringApiRuns.dateKey))
  );

  if (rows.length === 0) {
    // Vendor + siteId resolved but no scheduler activity — common
    // when a system is freshly added and the next batch hasn't run
    // yet. Return the resolved metadata but empty aggregates so the
    // section renders "configured but not yet scheduled" rather
    // than "no vendor".
    return {
      ...EMPTY_RESULT,
      provider,
      siteId,
    };
  }

  // Step 4 — fold rows into the aggregate result. Single pass over
  // the 30-day rows.
  let last7Attempts = 0;
  let last7Successes = 0;
  let last7Errors = 0;
  let last7NoData = 0;
  let last30Attempts = 0;
  let last30Successes = 0;
  let last30Errors = 0;
  let last30NoData = 0;
  let lastSuccessAt: string | null = null;
  let lastErrorAt: string | null = null;
  let lastErrorMessage: string | null = null;
  let latestSiteName: string | null = null;
  let latestConnectionId: string | null = null;

  for (const row of rows) {
    const dateKey = row.dateKey;
    const status = asStatus(row.status);
    if (!status) continue;
    const inLast7 = dateKey >= last7StartDateKey;

    last30Attempts += 1;
    if (status === "success") last30Successes += 1;
    if (status === "error") last30Errors += 1;
    if (status === "no_data") last30NoData += 1;
    if (inLast7) {
      last7Attempts += 1;
      if (status === "success") last7Successes += 1;
      if (status === "error") last7Errors += 1;
      if (status === "no_data") last7NoData += 1;
    }

    if (status === "success" && lastSuccessAt === null) {
      // rows are dateKey desc, so the first success is the newest.
      lastSuccessAt = dateKey;
    }
    if (
      status !== "success" &&
      lastErrorAt === null &&
      typeof row.errorMessage === "string" &&
      row.errorMessage.length > 0
    ) {
      lastErrorAt = dateKey;
      lastErrorMessage = row.errorMessage;
    }
    if (latestSiteName === null && typeof row.siteName === "string") {
      latestSiteName = row.siteName;
    }
    if (
      latestConnectionId === null &&
      typeof row.connectionId === "string" &&
      row.connectionId.length > 0
    ) {
      latestConnectionId = row.connectionId;
    }
  }

  const recentRuns: SystemMonitoringHistoryRun[] = rows
    .slice(0, RECENT_RUN_LIMIT)
    .map((row) => {
      const status = asStatus(row.status);
      return {
        dateKey: row.dateKey,
        status: status ?? "skipped",
        readingsCount: Number(row.readingsCount ?? 0),
        lifetimeKwh:
          row.lifetimeKwh === null || row.lifetimeKwh === undefined
            ? null
            : Number(row.lifetimeKwh),
        errorMessage:
          typeof row.errorMessage === "string" && row.errorMessage.length > 0
            ? row.errorMessage
            : null,
        durationMs:
          row.durationMs === null || row.durationMs === undefined
            ? null
            : Number(row.durationMs),
      };
    });

  const lastRunAt = rows[0]?.dateKey ?? null;
  const lastRunStatus = asStatus(rows[0]?.status);

  return {
    provider,
    siteId,
    siteName: latestSiteName,
    connectionId: latestConnectionId,
    last7Attempts,
    last7Successes,
    last7Errors,
    last7NoData,
    last30Attempts,
    last30Successes,
    last30Errors,
    last30NoData,
    lastSuccessAt,
    lastRunAt,
    lastRunStatus,
    lastErrorAt,
    lastErrorMessage,
    recentRuns,
  };
}
