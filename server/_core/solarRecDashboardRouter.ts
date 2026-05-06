import path from "node:path";
import { mkdir, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t } from "./solarRecBase";
import { dashboardProcedure } from "./dashboardResponseGuard";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  scheduleBImportFiles,
  scheduleBImportResults,
  srDsAbpCsgPortalDatabaseRows,
  srDsAbpCsgSystemMapping,
  srDsAbpIccReport2Rows,
  srDsAbpIccReport3Rows,
  srDsAbpPortalInvoiceMapRows,
  srDsAbpProjectApplicationRows,
  srDsAbpQuickBooksRows,
  srDsAbpReport,
  srDsAbpUtilityInvoiceRows,
  srDsAccountSolarGeneration,
  srDsAnnualProductionEstimates,
  srDsContractedDate,
  srDsConvertedReads,
  srDsDeliverySchedule,
  srDsGenerationEntry,
  srDsGeneratorDetails,
  srDsSolarApplications,
  srDsTransferHistory,
  solarRecActiveDatasetVersions,
  solarRecImportBatches,
  solarRecImportFiles,
  datasetUploadJobs,
} from "../../drizzle/schema";
import { JOB_TTL_MS } from "../constants";
import {
  bulkInsertScheduleBDriveFiles,
  bulkInsertScheduleBImportCsgIds,
  clearScheduleBImportStuckUploads,
  deleteScheduleBImportJobData,
  getAllScheduleBImportResults,
  getDb,
  getIntegrationByProvider,
  getLatestScheduleBImportJob,
  getOrCreateLatestScheduleBImportJob,
  getPendingScheduleBImportApplyCount,
  getScheduleBImportCsgIdsForJob,
  getScheduleBImportFile,
  getScheduleBImportJob,
  getScheduleBImportJobCounts,
  getSolarRecDashboardPayload,
  listAllUploadedScheduleBImportFiles,
  listScheduleBImportFileNames,
  listScheduleBImportResults,
  markScheduleBImportFileQueued,
  markScheduleBImportFileStatus,
  markScheduleBImportResultsApplied,
  reconcileScheduleBImportJobState,
  requeueScheduleBImportRetryableFiles,
  saveSolarRecDashboardPayload,
  updateScheduleBImportJob,
  upsertSolarRecDatasetSyncState,
  upsertScheduleBImportFileUploadProgress,
} from "../db";
import { storageGet, storagePut } from "../storage";
import { resolveSolarRecOwnerUserId } from "./solarRecAuth";
import { Semaphore } from "../services/core/concurrency";
import {
  DASHBOARD_DATASET_CSV_EXPORT_KEYS,
} from "../services/solar/dashboardDatasetCsvExport";

const APPEND_UPLOAD_SOURCE_DATASET_KEYS = [
  "accountSolarGeneration",
  "convertedReads",
  "transferHistory",
] as const;

/**
 * Dataset keys that are team-wide (shared across all Solar REC users) rather
 * than per-user. For these keys, we always store/load under the Solar REC
 * team owner's userId so that:
 *   (a) the monitoring batch bridge (which runs server-side as the owner)
 *       and the client-side dashboard uploads share the same storage slot
 *   (b) every user on the team sees the same converted reads regardless
 *       of who is currently logged in.
 */
/**
 * Check whether a dataset key is team-wide. Matches:
 *   - "convertedReads" — the main manifest key
 *   - "src_convertedReads_mon_batch_*" — the monitoring bridge's source
 *     chunks (stable IDs like mon_batch_solaredge, mon_batch_hoymiles)
 *   - "src_convertedReads_individual_*" — the per-vendor meter-reads
 *     page source chunks (stable IDs like individual_solaredge), written
 *     by the `pushConvertedReadsSource` mutation below
 *
 * Does NOT match user-uploaded source chunks like
 * "src_convertedReads_mo0rczoydl24xs0j_chunk_0000" — those are stored
 * under ctx.userId by the dashboard's auto-sync and must stay per-user
 * for backward compatibility with chunks written before the team-wide fix.
 */
function isTeamWideDatasetKey(inputKey: string): boolean {
  if (inputKey === "convertedReads") return true;
  if (inputKey.startsWith("src_convertedReads_mon_batch_")) return true;
  if (inputKey.startsWith("src_convertedReads_individual_")) return true;
  return false;
}

const inFlightDashboardPayloadLoads = new Map<
  string,
  Promise<{ key: string; payload: string } | null>
>();

async function resolveDatasetUserId(
  inputKey: string,
  fallbackUserId: number
): Promise<number> {
  if (isTeamWideDatasetKey(inputKey)) {
    try {
      return await resolveSolarRecOwnerUserId();
    } catch {
      // Fall through to per-user storage if owner resolution fails.
    }
  }
  return fallbackUserId;
}

/**
 * Task 1.2b (PR B) — build both the scope-keyed S3 path and the
 * legacy per-user path for a dashboard blob. The scope path is the
 * primary; the legacy path is handed to `loadDashboardPayload`'s
 * shim so pre-PR-B data stays readable until PR C migrates it.
 */
async function buildDashboardStorageKeys(
  userId: number,
  relativePath: string
): Promise<{ key: string; legacyKey: string }> {
  const { resolveSolarRecScopeId } = await import("../_core/solarRecAuth");
  const scopeId = await resolveSolarRecScopeId();
  return {
    key: `solar-rec-dashboard/${scopeId}/${relativePath}`,
    legacyKey: `solar-rec-dashboard/${userId}/${relativePath}`,
  };
}

/**
 * Task 1.2b (PR B) — scope-aware dashboard payload loader with a
 * read-compat shim. Tries the DB (now filtered by `scopeId`
 * internally), then the scope-keyed S3 path the caller supplied,
 * then — for data written before PR B deployed — falls back to the
 * legacy per-user S3 path. PR C will migrate existing objects and
 * remove the fallback.
 */
async function loadDashboardPayload(
  userId: number,
  dbStorageKey: string,
  storagePath: string,
  legacyStoragePath?: string | null
): Promise<{ key: string; payload: string } | null> {
  try {
    const payload = await getSolarRecDashboardPayload(userId, dbStorageKey);
    if (payload) {
      return {
        key: storagePath,
        payload,
      };
    }
  } catch (error) {
    console.error(
      "[solarRec] DB read failed, falling back to storage:",
      error instanceof Error ? error.message : error
    );
  }

  const candidatePaths = legacyStoragePath
    ? [storagePath, legacyStoragePath]
    : [storagePath];
  for (const path of candidatePaths) {
    try {
      const { url } = await storageGet(path);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;
      const payload = await response.text();
      if (!payload) continue;
      return { key: storagePath, payload };
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

/**
 * Maximum number of dataset-load operations that may run concurrently
 * on a single Node process. Chunked datasets cause chunk-storm
 * fan-outs (distinct keys, so single-flight dedupe doesn't collapse
 * them); the semaphore caps the heap blast radius even when the cache
 * is cold.
 *
 * 8 is conservative for a Render 4 GB box — each slot can buffer a
 * ~250 KB chunk (Node UTF-16 overhead included) without approaching
 * the 3.5 GB max-old-space ceiling set in package.json.
 */
const DASHBOARD_LOAD_CONCURRENCY = 8;

/**
 * Soft heap ceiling at which we reject new dataset-load work with
 * 429 (TOO_MANY_REQUESTS) instead of queueing more callers. Queued
 * callers also take memory, so we need a circuit breaker below V8's
 * --max-old-space-size limit of 3584 MB. 3.0 GB leaves ~500 MB for
 * V8 to GC into before fatal OOM.
 */
const HEAP_SOFT_LIMIT_BYTES = 3.0 * 1024 * 1024 * 1024;

const dashboardLoadSemaphore = new Semaphore(DASHBOARD_LOAD_CONCURRENCY);

function isHeapOverSoftLimit(): boolean {
  try {
    return process.memoryUsage().heapUsed > HEAP_SOFT_LIMIT_BYTES;
  } catch {
    return false;
  }
}

async function loadDashboardPayloadSingleFlight(
  flightKey: string,
  loader: () => Promise<{ key: string; payload: string } | null>
): Promise<{ key: string; payload: string } | null> {
  const existing = inFlightDashboardPayloadLoads.get(flightKey);
  if (existing) {
    return existing;
  }

  // Shed load aggressively when heap is near the V8 ceiling; the
  // client (React Query) will retry on 429 once pressure drops.
  if (isHeapOverSoftLimit()) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Server heap pressure — retry in a moment",
    });
  }

  const promise = (async () => {
    try {
      return await dashboardLoadSemaphore.run(loader);
    } finally {
      inFlightDashboardPayloadLoads.delete(flightKey);
    }
  })();
  inFlightDashboardPayloadLoads.set(flightKey, promise);
  return promise;
}
import { getValidGoogleToken } from "../helpers/tokenRefresh";
import {
  parseGoogleDriveFolderId,
  listGoogleDrivePdfsInFolder,
} from "../services/integrations/google";
import {
  runScheduleBImportJob,
  isScheduleBImportRunnerActive,
} from "../services/core/scheduleBImportJobRunner";
import {
  runCsgScheduleBImportJob,
  isCsgScheduleBImportRunnerActive,
} from "../services/core/csgScheduleBImportJobRunner";
import { DATASET_UPLOAD_RUNNER_VERSION } from "../services/core/datasetUploadJobRunner";
import {
  parseJsonMetadata,
  toNonEmptyString,
  normalizeScheduleBDeliveryYears,
  parseCsvText,
  cleanScheduleBCell,
  loadDeliveryScheduleBaseDataset,
  parseContractIdMappingText,
  findFirstTransferEnergyYear,
  makeDeliveryRowKey,
  scheduleRowsEqual,
  mergeDeliveryRows,
  buildAdjustedScheduleFromExtraction,
  buildScheduleBDeliveryRow,
  sanitizeScheduleBFileName,
  SCHEDULE_B_UPLOAD_TMP_ROOT,
  SCHEDULE_B_UPLOAD_ID_PATTERN,
  SCHEDULE_B_UPLOAD_CHUNK_BASE64_LIMIT,
} from "../routers/helpers";
import type { ParsedRemoteCsvDataset } from "../routers/helpers";
import {
  persistDeliveryScheduleBaseCanonical,
  type DeliveryScheduleBaseRow,
} from "../services/solar/deliveryScheduleBasePersistence";
import type { TransferDeliveryLookupPayload } from "../services/solar/buildTransferDeliveryLookup";

function stringifyDeliveryScheduleRows(
  rows: Array<Record<string, string | undefined>>
): DeliveryScheduleBaseRow[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, String(value ?? "")])
    )
  );
}

function inferDeliveryScheduleHeaders(
  rows: readonly DeliveryScheduleBaseRow[]
): string[] {
  const headers: string[] = ["tracking_system_ref_id"];
  const seen = new Set(headers);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!key || seen.has(key)) continue;
      seen.add(key);
      headers.push(key);
    }
  }
  return headers;
}

function reviveTransferDeliveryLookup(
  payload: Pick<TransferDeliveryLookupPayload, "byTrackingId">
): Map<string, Map<number, number>> {
  const lookup = new Map<string, Map<number, number>>();
  for (const [trackingId, years] of Object.entries(payload.byTrackingId)) {
    if (!trackingId || !years || typeof years !== "object") continue;
    const yearMap = new Map<number, number>();
    for (const [yearKey, quantityValue] of Object.entries(years)) {
      const year = Number(yearKey);
      const quantity = Number(quantityValue);
      if (!Number.isFinite(year) || !Number.isFinite(quantity)) continue;
      yearMap.set(year, quantity);
    }
    if (yearMap.size > 0) {
      lookup.set(trackingId.toLowerCase(), yearMap);
    }
  }
  return lookup;
}

async function loadDeliveryScheduleBaseFromStorage(
  userId: number
): Promise<ParsedRemoteCsvDataset> {
  return loadDeliveryScheduleBaseDataset(async (key) => {
    const { key: storagePath, legacyKey: legacyStoragePath } =
      await buildDashboardStorageKeys(userId, `datasets/${key}.json`);
    return (
      await loadDashboardPayload(
        userId,
        `dataset:${key}`,
        storagePath,
        legacyStoragePath
      )
    )?.payload ?? null;
  });
}

async function loadCanonicalDeliveryScheduleBaseDataset(
  scopeId: string,
  userId: number
): Promise<ParsedRemoteCsvDataset> {
  const { getActiveBatchForDataset } = await import("../db");
  const activeBatch = await getActiveBatchForDataset(
    scopeId,
    "deliveryScheduleBase"
  );
  if (activeBatch?.id) {
    const { loadDatasetRows } = await import(
      "../services/solar/buildSystemSnapshot"
    );
    const rows = stringifyDeliveryScheduleRows(
      await loadDatasetRows(scopeId, activeBatch.id, srDsDeliverySchedule)
    );
    const expectedRows =
      activeBatch.rowCount === null || activeBatch.rowCount === undefined
        ? null
        : Number(activeBatch.rowCount);
    if (
      expectedRows !== null &&
      Number.isFinite(expectedRows) &&
      expectedRows !== rows.length
    ) {
      throw new Error(
        `Active deliveryScheduleBase batch ${activeBatch.id} reports ${expectedRows} row(s), but srDsDeliverySchedule returned ${rows.length}. Aborting because the row table is stale and proceeding would persist the partial set forward.`
      );
    }
    return {
      fileName: `deliveryScheduleBase-${activeBatch.id}.csv`,
      uploadedAt:
        activeBatch.completedAt?.toISOString() ??
        activeBatch.createdAt?.toISOString() ??
        new Date().toISOString(),
      headers: inferDeliveryScheduleHeaders(rows),
      rows,
    };
  }

  return loadDeliveryScheduleBaseFromStorage(userId);
}

export const solarRecDashboardRouter = t.router({
  /**
   * Returns the scopeId for the current user's Solar REC context.
   * Used by the client to pass to server-side dataset endpoints.
   */
  getScopeId: dashboardProcedure("solar-rec-dashboard", "read").query(async () => {
    const { resolveSolarRecScopeId } = await import("../_core/solarRecAuth");
    const { resolveSolarRecOwnerUserId } = await import("../_core/solarRecAuth");
    const { getOrCreateScope } = await import("../db");
    const scopeId = await resolveSolarRecScopeId();
    const ownerUserId = await resolveSolarRecOwnerUserId();
    await getOrCreateScope(scopeId, ownerUserId);
    return { scopeId };
  }),

  /**
   * Start a server-side migration of the 7 core datasets from
   * solarRecDashboardStorage into the new srDs* tables. Fire-and-
   * forget: returns a jobId immediately. Client polls
   * `getServerSideMigrationStatus` to track progress.
   *
   * This sidesteps the browser-based migration for users whose
   * datasets are too large for the tab to hold in memory.
   */
  startServerSideMigration: dashboardProcedure("solar-rec-dashboard", "admin").mutation(async () => {
    const { resolveSolarRecScopeId, resolveSolarRecOwnerUserId } = await import(
      "../_core/solarRecAuth"
    );
    const { getOrCreateScope } = await import("../db");
    const { startServerSideMigration } = await import(
      "../services/solar/serverSideMigration"
    );
    const scopeId = await resolveSolarRecScopeId();
    const ownerUserId = await resolveSolarRecOwnerUserId();
    await getOrCreateScope(scopeId, ownerUserId);
    const jobId = startServerSideMigration(scopeId, ownerUserId);
    return { jobId, scopeId };
  }),

  /**
   * Poll the status of a server-side migration job.
   */
  getServerSideMigrationStatus: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { getServerMigrationJob } = await import(
        "../services/solar/serverSideMigration"
      );
      const job = getServerMigrationJob(input.jobId);
      if (!job) return null;
      return job;
    }),

  /**
   * Return the currently-active server-side migration job for
   * this scope, or null. Lets the client resume polling after a
   * tab reload without needing to persist the jobId.
   */
  getActiveServerSideMigration: dashboardProcedure("solar-rec-dashboard", "read").query(async () => {
    const { resolveSolarRecScopeId } = await import("../_core/solarRecAuth");
    const { getActiveJobForScope } = await import(
      "../services/solar/serverSideMigration"
    );
    const scopeId = await resolveSolarRecScopeId();
    return getActiveJobForScope(scopeId);
  }),

  /**
   * Kick off (or attach to an existing) background sync job for
   * one core dataset. Returns immediately with a jobId — the ingest
   * runs on the event loop and the client polls
   * `getCoreDatasetSyncStatus({ jobId })` until it reaches a
   * terminal state.
   *
   * Single-flight: if there's already a pending or running job for
   * (scope, datasetKey) the existing jobId is returned, so
   * duplicate save calls are a no-op instead of launching
   * overlapping ingests that would strand each other's processing
   * batches.
   *
   * Previous contract ran the full ingest inside the request-
   * response cycle. That hit Render's ~100s proxy timeout on
   * multi-million-row datasets, 502'd the client, and stranded
   * processing batches when the ingest was killed server-side.
   * See commits de59fca (in-process single-flight v1) and
   * 06fdda4 (move to background job) for the history.
   */
  syncCoreDatasetFromStorage: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(z.object({ datasetKey: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const { resolveSolarRecScopeId, resolveSolarRecOwnerUserId } =
        await import("../_core/solarRecAuth");
      const { getOrCreateScope } = await import("../db");
      const { syncOneCoreDatasetFromStorage } = await import(
        "../services/solar/serverSideMigration"
      );
      const { startSyncJob } = await import(
        "../services/solar/coreDatasetSyncJobs"
      );
      const scopeId = await resolveSolarRecScopeId();
      const ownerUserId = await resolveSolarRecOwnerUserId();
      await getOrCreateScope(scopeId, ownerUserId);
      const jobId = startSyncJob(scopeId, input.datasetKey, (reportProgress) =>
        syncOneCoreDatasetFromStorage(
          scopeId,
          input.datasetKey,
          ownerUserId,
          reportProgress
        )
      );
      return { jobId, state: "pending" as const };
    }),

  /**
   * Poll the status of a previously-started sync job. State
   * machine: pending → running → (done | failed). Terminal states
   * persist for up to 30 min so a slow poller doesn't miss the
   * transition.
   */
  getCoreDatasetSyncStatus: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { getSyncJob } = await import(
        "../services/solar/coreDatasetSyncJobs"
      );
      const job = getSyncJob(input.jobId);
      if (!job) {
        return {
          state: "unknown" as const,
          error: null,
          progress: null,
        };
      }
      return {
        _runnerVersion: "data-flow-pr3" as const,
        serverTimeMs: Date.now(),
        state: job.state,
        error: job.error,
        progress: job.progress,
      };
    }),

  /**
   * One-shot aggressive purge of orphaned typed srDs* rows left
   * behind by superseded/failed batches. Doesn't touch batches
   * referenced by the current active version pointers, so live
   * reads are unaffected.
   *
   * Distinct from the 14-day retention-window cleanup that runs
   * on server startup. Call this manually (DevTools console or a
   * future admin button) after big migration/recovery events
   * that leave the DB with gigabytes of orphan data. Limits to
   * 200 batches per call so the request doesn't exceed Render's
   * proxy timeout; run twice if `skippedDueToLimit` is true.
   */
  purgeOrphanedDatasetRows: dashboardProcedure("solar-rec-dashboard", "admin").mutation(async () => {
    try {
      const { purgeOrphanedDatasetRowsNow } = await import(
        "../db/solarRecDatasets"
      );
      return await purgeOrphanedDatasetRowsNow();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      // eslint-disable-next-line no-console
      console.error("[purgeOrphanedDatasetRows] failed:", message, stack);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `purgeOrphanedDatasetRows failed: ${message}`,
        cause: err,
      });
    }
  }),

  /**
   * Return every in-flight sync job for the current scope. Called
   * by the client on mount so a tab reload during a running sync
   * resumes polling instead of losing track of the background
   * work.
   */
  getActiveCoreDatasetSyncJobs: dashboardProcedure("solar-rec-dashboard", "read").query(async () => {
    const { resolveSolarRecScopeId } = await import("../_core/solarRecAuth");
    const { listActiveJobsForScope } = await import(
      "../services/solar/coreDatasetSyncJobs"
    );
    const scopeId = await resolveSolarRecScopeId();
    const jobs = listActiveJobsForScope(scopeId);
    return jobs.map((job) => ({
      jobId: job.jobId,
      datasetKey: job.datasetKey,
      state: job.state,
      startedAt: job.startedAt,
      progress: job.progress,
    }));
  }),

  getState: dashboardProcedure("solar-rec-dashboard", "read").query(async ({ ctx }) => {
    const { key, legacyKey } = await buildDashboardStorageKeys(
      ctx.userId,
      "state.json"
    );
    const dbStorageKey = "state";
    return loadDashboardPayloadSingleFlight(
      `state:${key}`,
      () => loadDashboardPayload(ctx.userId, dbStorageKey, key, legacyKey)
    );
  }),
  saveState: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        payload: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { key } = await buildDashboardStorageKeys(
        ctx.userId,
        "state.json"
      );
      const dbStorageKey = "state";
      let persistedToDatabase = false;

      try {
        persistedToDatabase = await saveSolarRecDashboardPayload(ctx.userId, dbStorageKey, input.payload);
      } catch {
        persistedToDatabase = false;
      }

      try {
        await storagePut(key, input.payload, "application/json");
        return { success: true, key, persistedToDatabase, storageSynced: true };
      } catch (storageError) {
        if (persistedToDatabase) {
          return { success: true, key, persistedToDatabase, storageSynced: false };
        }
        throw storageError;
      }
    }),
  getDataset: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const storageUserId = await resolveDatasetUserId(input.key, ctx.userId);
      const { key, legacyKey } = await buildDashboardStorageKeys(
        storageUserId,
        `datasets/${input.key}.json`
      );
      const dbStorageKey = `dataset:${input.key}`;
      return loadDashboardPayloadSingleFlight(
        `dataset:${key}`,
        () =>
          loadDashboardPayload(storageUserId, dbStorageKey, key, legacyKey)
      );
    }),
  // Task 5.14 PR-6 (2026-04-27): `getDatasetAssembled` removed.
  // The procedure was the legacy single-roundtrip batch endpoint that
  // reassembled a dataset's manifest + every source payload into one
  // tRPC response (up to 50–150 MB on populated scopes — root cause of
  // the 2026-04-26 Chrome tab OOM events). Tasks 5.12 + 5.13 closed
  // the gap by row-backing every dataset and migrating every tab to
  // server-side aggregates; Task 5.14 PR-5 then removed the only
  // remaining caller — the dashboard's cold-cache hydration —
  // collapsing it onto the per-key `getDataset` route. With zero
  // callers, the procedure body, its private helpers
  // (`assembleFromFetchedOrFallback`, `getSourceManifestSize`,
  // `MAX_ASSEMBLED_SOURCE_PAYLOAD_BYTES`,
  // `MAX_ASSEMBLED_SOURCE_CHUNK_KEYS`, `SourceManifestEntry`), and
  // every "_checkpoint: getDatasetAssembled-*" branch are deleted in
  // this PR. `dashboardLoadSemaphore`, `isHeapOverSoftLimit`, and
  // `loadDashboardPayloadSingleFlight` stay — `getDataset` and
  // `getOrCreateRemoteDataset` still rely on them. The
  // `solarRecDashboardStorage` table + `_rawSourcesV1` manifest format
  // also stay (still authored by saveDataset, still read by
  // getDataset's per-key path).
  // PR-8 (data-flow series, 2026-04-27): the dead `getDatasetRowsFromSrDs`
  // stub from the failed bulk row-hydration experiment (#107 / #111 /
  // #114) is removed here. Its replacement is the cursor-paginated
  // `getDatasetRowsPage` (PR-4, see below) which is memory-safe by
  // construction — wire-bound by page size, never the full dataset.
  // The client hook and ref were also removed in this PR.

  getDatasetCloudStatuses: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        keys: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).min(1).max(32),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getRawDatasetCloudStatuses } = await import(
        "../services/solar/datasetCloudStatus"
      );
      // Annotate explicitly: CI's tsc was inferring this as a narrower
      // SrDsDatasetKey union from downstream context (works locally on
      // the same TS 5.9.3 + lockfile; differs only in the CI Node
      // version). `getRawDatasetCloudStatuses` accepts `string[]` so
      // the annotation matches the signature precisely.
      const uniqueKeys: string[] = Array.from(new Set(input.keys));
      const statuses = await getRawDatasetCloudStatuses(uniqueKeys, (datasetKey) =>
        resolveDatasetUserId(datasetKey, ctx.userId)
      );
      return {
        // Version marker for CLAUDE.md "is my code actually running" checks.
        // Bump the suffix when the status derivation semantics change.
        _checkpoint: "dataset-sync-status-v2",
        _runnerVersion: "data-flow-pr2" as const,
        statuses,
      };
    }),
  /**
   * Raw-state debug endpoint for diagnosing Cloud-verified / Not-synced
   * discrepancies per CLAUDE.md "long-running server jobs must expose a
   * raw-state debug endpoint" rule.
   *
   * For a given dataset key, returns:
   *   - the sync-state row (or null)
   *   - whether the top-level blob is present in DB and/or storage
   *   - for chunked datasets, the same for up to `sampleChunks` chunks
   *
   * Diagnostic use only — not wired into the UI path. Callers should
   * treat this as slow (O(chunks) HEAD checks) and not poll it.
   */
  debugDatasetSyncStateRaw: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        datasetKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        sampleChunks: z.number().int().min(0).max(100).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const sampleChunks = input.sampleChunks ?? 10;
      const { getSolarRecDatasetSyncStates } = await import("../db");
      const { storageExists } = await import("../storage");
      const { parseChunkPointerPayload } = await import("../routers/helpers/scheduleB");

      const storageUserId = await resolveDatasetUserId(input.datasetKey, ctx.userId);
      const dbStorageKey = `dataset:${input.datasetKey}`;
      const { key: storagePath, legacyKey: legacyStoragePath } =
        await buildDashboardStorageKeys(
          storageUserId,
          `datasets/${input.datasetKey}.json`
        );

      const [syncRow] = await getSolarRecDatasetSyncStates(storageUserId, [dbStorageKey]);
      const dbPayload = await getSolarRecDashboardPayload(storageUserId, dbStorageKey);
      const topLevelStoragePresent =
        (await storageExists(storagePath)) ||
        (await storageExists(legacyStoragePath));

      // Extract chunk references (either _rawSourcesV1 manifest or Schedule-B chunk pointer)
      const chunkKeys: string[] = [];
      if (dbPayload) {
        try {
          const parsed = JSON.parse(dbPayload) as {
            _rawSourcesV1?: unknown;
            sources?: unknown;
          };
          if (parsed._rawSourcesV1 === true && Array.isArray(parsed.sources)) {
            for (const src of parsed.sources) {
              if (src && typeof src === "object") {
                const ck = (src as { chunkKeys?: unknown }).chunkKeys;
                if (Array.isArray(ck)) {
                  for (const k of ck) if (typeof k === "string") chunkKeys.push(k);
                }
              }
            }
          }
        } catch {
          // fall through to pointer-style parse
        }
        if (chunkKeys.length === 0) {
          const ptrChunks = parseChunkPointerPayload(dbPayload);
          if (ptrChunks) chunkKeys.push(...ptrChunks);
        }
      }

      const chunkKeysToProbe = chunkKeys.slice(0, sampleChunks);
      const chunkSyncRows = chunkKeysToProbe.length
        ? await getSolarRecDatasetSyncStates(
            storageUserId,
            chunkKeysToProbe.map((k) => `dataset:${k}`)
          )
        : [];
      const rowByKey = new Map(chunkSyncRows.map((r) => [r.storageKey, r]));

      const chunkDiagnostics = [];
      for (const chunkKey of chunkKeysToProbe) {
        const childDbKey = `dataset:${chunkKey}`;
        const { key: childStoragePath, legacyKey: childLegacyStoragePath } =
          await buildDashboardStorageKeys(
            storageUserId,
            `datasets/${chunkKey}.json`
          );
        const childDb = await getSolarRecDashboardPayload(storageUserId, childDbKey);
        const childStoragePresent =
          (await storageExists(childStoragePath)) ||
          (await storageExists(childLegacyStoragePath));
        chunkDiagnostics.push({
          key: chunkKey,
          syncRow: rowByKey.get(childDbKey) ?? null,
          dbPresent: childDb !== null && childDb.length > 0,
          dbBytes: childDb ? childDb.length : 0,
          storagePresent: childStoragePresent,
        });
      }

      return {
        _checkpoint: "debug-dataset-sync-state-v1",
        datasetKey: input.datasetKey,
        storageUserId,
        dbStorageKey,
        storagePath,
        topLevel: {
          syncRow: syncRow ?? null,
          dbPresent: dbPayload !== null && dbPayload.length > 0,
          dbBytes: dbPayload ? dbPayload.length : 0,
          storagePresent: topLevelStoragePresent,
        },
        totalChunkCount: chunkKeys.length,
        sampledChunkCount: chunkKeysToProbe.length,
        chunkDiagnostics,
      };
    }),
  /**
   * Single-shot persistence audit for one dataset.
   *
   * Returns the raw rows from every layer of the persistence stack so a
   * developer (or admin tool) can answer "is this dataset actually
   * stored, and where?" without running ad-hoc SQL.
   *
   * Layers reported:
   *   1. `solarRecDashboardStorage` — the chunked-CSV blob (legacy
   *      primary representation). Reports row count + total bytes.
   *   2. `solarRecDatasetSyncState` — the sync-state row used by the
   *      cloud-status badge. Reports `dbPersisted` / `storageSynced` /
   *      payloadSha256 / payloadBytes / updatedAt.
   *   3. S3 object existence at both the scope-keyed and legacy paths
   *      (post-Task-1.2b read-compat shim).
   *   4. `solarRecImportBatches` — for the 7 row-backed datasets,
   *      counts of batches by status + the active batch's metadata.
   *   5. `solarRecActiveDatasetVersions` — the active-batch pointer.
   *   6. `srDs*` — actual row count in the row table for the active
   *      batch. (Compares against the batch's recorded `rowCount` so
   *      drift is visible.)
   *
   * Plus a `verdict` string that classifies the state:
   *   - `consistent` — every layer agrees data is present.
   *   - `storage-only` — S3 has the blob, DB sync row is missing or
   *     has `dbPersisted=false`. THIS IS THE "LOCAL-ONLY-NEVER-
   *     PERSISTS" BUG.
   *   - `db-only` — DB rows exist, S3 missing.
   *   - `row-table-stale` — sync state says good but srDs* row count
   *     doesn't match the batch's recorded count.
   *   - `no-active-batch` — for row-backed datasets, ingestion ran
   *     but never activated.
   *   - `missing` — no trace of this dataset anywhere.
   *
   * Wired into the dashboard's per-dataset card as an admin-only
   * "Inspect" link in PR-2. For now, callable via devtools / curl.
   */
  debugDatasetPersistenceRaw: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        datasetKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getSolarRecDatasetSyncStates, getActiveBatchForDataset } =
        await import("../db");
      const { storageExists } = await import("../storage");
      const { resolveSolarRecScopeId } = await import("./solarRecAuth");

      const ROW_TABLES_BY_DATASET_KEY = {
        solarApplications: srDsSolarApplications,
        abpReport: srDsAbpReport,
        generationEntry: srDsGenerationEntry,
        accountSolarGeneration: srDsAccountSolarGeneration,
        annualProductionEstimates: srDsAnnualProductionEstimates,
        abpIccReport2Rows: srDsAbpIccReport2Rows,
        abpIccReport3Rows: srDsAbpIccReport3Rows,
        contractedDate: srDsContractedDate,
        convertedReads: srDsConvertedReads,
        deliveryScheduleBase: srDsDeliverySchedule,
        transferHistory: srDsTransferHistory,
        generatorDetails: srDsGeneratorDetails,
        abpCsgSystemMapping: srDsAbpCsgSystemMapping,
        abpProjectApplicationRows: srDsAbpProjectApplicationRows,
        abpPortalInvoiceMapRows: srDsAbpPortalInvoiceMapRows,
        abpCsgPortalDatabaseRows: srDsAbpCsgPortalDatabaseRows,
        abpQuickBooksRows: srDsAbpQuickBooksRows,
        abpUtilityInvoiceRows: srDsAbpUtilityInvoiceRows,
      } as const;
      type RowTableKey = keyof typeof ROW_TABLES_BY_DATASET_KEY;
      const isRowTableKey = (k: string): k is RowTableKey =>
        Object.prototype.hasOwnProperty.call(ROW_TABLES_BY_DATASET_KEY, k);

      const scopeId = await resolveSolarRecScopeId();
      const storageUserId = await resolveDatasetUserId(input.datasetKey, ctx.userId);
      const dbStorageKey = `dataset:${input.datasetKey}`;
      const { key: scopeStoragePath, legacyKey: legacyStoragePath } =
        await buildDashboardStorageKeys(
          storageUserId,
          `datasets/${input.datasetKey}.json`
        );

      // Layer 1: chunked-CSV blob in DB
      const dbPayload = await getSolarRecDashboardPayload(storageUserId, dbStorageKey);
      const dbBytes = dbPayload?.length ?? 0;
      const dbPresent = dbPayload !== null && dbBytes > 0;

      // Layer 2: sync-state row
      const [syncRow] = await getSolarRecDatasetSyncStates(storageUserId, [
        dbStorageKey,
      ]);

      // Layer 3: S3 object existence (both paths because of the read-compat shim)
      const [scopeStorageExists, legacyStorageExists] = await Promise.all([
        storageExists(scopeStoragePath),
        storageExists(legacyStoragePath),
      ]);

      // Layer 4 + 5: import batches + active version (row-backed datasets only)
      let rowTableLayer: {
        isRowBacked: boolean;
        activeBatchId: string | null;
        activeBatchRowCount: number | null;
        activeBatchActivatedAt: string | null;
        actualRowCount: number | null;
        pendingBatches: number;
        failedBatches: number;
      } = {
        isRowBacked: false,
        activeBatchId: null,
        activeBatchRowCount: null,
        activeBatchActivatedAt: null,
        actualRowCount: null,
        pendingBatches: 0,
        failedBatches: 0,
      };

      if (isRowTableKey(input.datasetKey)) {
        const db = await getDb();
        const activeBatch = await getActiveBatchForDataset(scopeId, input.datasetKey);
        let pendingBatches = 0;
        let failedBatches = 0;
        if (db) {
          const batchStatusCounts = await db
            .select({
              status: solarRecImportBatches.status,
              count: sql<number>`COUNT(*)`,
            })
            .from(solarRecImportBatches)
            .where(
              and(
                eq(solarRecImportBatches.scopeId, scopeId),
                eq(solarRecImportBatches.datasetKey, input.datasetKey)
              )
            )
            .groupBy(solarRecImportBatches.status);
          for (const row of batchStatusCounts) {
            if (row.status === "pending" || row.status === "processing") {
              pendingBatches += Number(row.count ?? 0);
            } else if (row.status === "failed") {
              failedBatches += Number(row.count ?? 0);
            }
          }
        }

        let actualRowCount: number | null = null;
        if (db && activeBatch) {
          const table = ROW_TABLES_BY_DATASET_KEY[input.datasetKey];
          const rows = await db
            .select({ count: sql<number>`COUNT(*)` })
            .from(table)
            .where(
              and(
                eq(table.scopeId, scopeId),
                eq(table.batchId, activeBatch.id)
              )
            );
          actualRowCount = Number(rows[0]?.count ?? 0);
        }

        rowTableLayer = {
          isRowBacked: true,
          activeBatchId: activeBatch?.id ?? null,
          activeBatchRowCount: activeBatch?.rowCount ?? null,
          activeBatchActivatedAt:
            activeBatch?.completedAt?.toISOString() ??
            activeBatch?.createdAt?.toISOString() ??
            null,
          actualRowCount,
          pendingBatches,
          failedBatches,
        };
      }

      // Verdict — single-line classification of the persistence state.
      type Verdict =
        | "consistent"
        | "storage-only"
        | "db-only"
        | "row-table-stale"
        | "no-active-batch"
        | "missing";
      let verdict: Verdict;
      let explanation: string;
      const anyStorage = scopeStorageExists || legacyStorageExists;

      if (rowTableLayer.isRowBacked) {
        if (rowTableLayer.activeBatchId === null) {
          if (rowTableLayer.pendingBatches > 0 || rowTableLayer.failedBatches > 0) {
            verdict = "no-active-batch";
            explanation = `${rowTableLayer.pendingBatches} pending + ${rowTableLayer.failedBatches} failed batch(es) exist but none has been activated.`;
          } else if (anyStorage || dbPresent) {
            verdict = "storage-only";
            explanation = "Chunked-CSV blob exists but the row-table ingest never ran (no batch).";
          } else {
            verdict = "missing";
            explanation = "No trace of this dataset in any layer.";
          }
        } else if (
          rowTableLayer.activeBatchRowCount !== null &&
          rowTableLayer.actualRowCount !== null &&
          rowTableLayer.activeBatchRowCount !== rowTableLayer.actualRowCount
        ) {
          verdict = "row-table-stale";
          explanation = `Active batch claims ${rowTableLayer.activeBatchRowCount} rows but srDs* table has ${rowTableLayer.actualRowCount}.`;
        } else {
          verdict = "consistent";
          explanation = `Active batch ${rowTableLayer.activeBatchId} with ${rowTableLayer.actualRowCount} rows.`;
        }
      } else {
        // Non-row-backed: only the chunked-CSV layer exists.
        if (dbPresent && anyStorage) {
          verdict = "consistent";
          explanation = `Chunked CSV present in DB (${dbBytes} bytes) and storage.`;
        } else if (dbPresent && !anyStorage) {
          verdict = "db-only";
          explanation = "DB has the blob but neither storage path returned a hit.";
        } else if (!dbPresent && anyStorage) {
          verdict = "storage-only";
          explanation = `Storage has the blob (scope=${scopeStorageExists}, legacy=${legacyStorageExists}) but DB has no row. THIS IS THE LOCAL-ONLY-NEVER-PERSISTS BUG.`;
        } else {
          verdict = "missing";
          explanation = "No trace of this dataset in any layer.";
        }
      }

      return {
        _checkpoint: "debug-dataset-persistence-v1",
        _runnerVersion: "data-flow-pr1" as const,
        datasetKey: input.datasetKey,
        scopeId,
        storageUserId,
        dbStorageKey,
        storagePath: { scope: scopeStoragePath, legacy: legacyStoragePath },
        storageBlob: {
          dbPresent,
          dbBytes,
          storagePresentScope: scopeStorageExists,
          storagePresentLegacy: legacyStorageExists,
        },
        syncState: {
          record: syncRow
            ? {
                payloadSha256: syncRow.payloadSha256,
                payloadBytes: syncRow.payloadBytes,
                dbPersisted: syncRow.dbPersisted,
                storageSynced: syncRow.storageSynced,
                updatedAt: syncRow.updatedAt?.toISOString() ?? null,
              }
            : null,
        },
        rowTables: rowTableLayer,
        verdict: { state: verdict, explanation },
      };
    }),
  /**
   * One-time production repair for legacy Schedule B blobs.
   *
   * If `debugDatasetPersistenceRaw({ datasetKey:"deliveryScheduleBase" })`
   * reports `storage-only`, this mutation ingests the current cloud
   * Schedule B CSV into `srDsDeliverySchedule` and activates the new
   * batch. It does not invent data; it only promotes the existing
   * compatibility blob into the canonical row-table layer.
   */
  backfillDeliveryScheduleBaseFromCloud: dashboardProcedure(
    "solar-rec-dashboard",
    "admin"
  )
    .input(z.object({ force: z.boolean().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const { getActiveBatchForDataset } = await import("../db");
      const activeBatch = await getActiveBatchForDataset(
        ctx.scopeId,
        "deliveryScheduleBase"
      );
      if (activeBatch && !input?.force) {
        return {
          success: true,
          skipped: true,
          reason: "active-batch-exists" as const,
          activeBatchId: activeBatch.id,
          rowCount: activeBatch.rowCount ?? null,
          _checkpoint: "delivery-schedule-base-cloud-backfill-v1" as const,
          _runnerVersion: null,
        };
      }

      const storageUserId = await resolveDatasetUserId(
        "deliveryScheduleBase",
        ctx.userId
      );
      const existingDataset =
        await loadDeliveryScheduleBaseFromStorage(storageUserId);
      if (existingDataset.rows.length === 0) {
        return {
          success: false,
          skipped: true,
          reason: "no-cloud-rows" as const,
          activeBatchId: activeBatch?.id ?? null,
          rowCount: 0,
          _checkpoint: "delivery-schedule-base-cloud-backfill-v1" as const,
          _runnerVersion: null,
        };
      }

      const { key: storageKey } = await buildDashboardStorageKeys(
        storageUserId,
        "datasets/deliveryScheduleBase.json"
      );
      const persistence = await persistDeliveryScheduleBaseCanonical({
        scopeId: ctx.scopeId,
        userId: storageUserId,
        storagePath: storageKey,
        fileName: existingDataset.fileName || "deliveryScheduleBase-backfill.csv",
        uploadedAt: new Date().toISOString(),
        headers: existingDataset.headers,
        rows: existingDataset.rows,
      });

      return {
        success: true,
        skipped: false,
        reason: "backfilled" as const,
        _checkpoint: "delivery-schedule-base-cloud-backfill-v1" as const,
        _runnerVersion: persistence._runnerVersion,
        previousActiveBatchId: activeBatch?.id ?? null,
        batchId: persistence.batchId,
        rowCount: persistence.rowCount,
        rowTableStatus: persistence.rowTableStatus,
        rowTableErrors: persistence.rowTableErrors,
        persistedToDatabase: persistence.persistedToDatabase,
        storageSynced: persistence.storageSynced,
        persistError: persistence.persistError,
        storageError: persistence.storageError,
        syncStateUpdated: persistence.syncStateUpdated,
        syncStateError: persistence.syncStateError,
      };
    }),
  saveDataset: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        payload: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const storageUserId = await resolveDatasetUserId(input.key, ctx.userId);
      const { key } = await buildDashboardStorageKeys(
        storageUserId,
        `datasets/${input.key}.json`
      );
      const dbStorageKey = `dataset:${input.key}`;
      let persistedToDatabase = false;
      let persistError: string | null = null;

      try {
        persistedToDatabase = await saveSolarRecDashboardPayload(storageUserId, dbStorageKey, input.payload);
      } catch (dbError) {
        persistedToDatabase = false;
        persistError = dbError instanceof Error ? dbError.message : String(dbError);
        // PR-2: bumped from console.warn to console.error so the
        // failure shows up in Render's error log surface, not buried
        // in info. The silent-warn in prior versions is the reason
        // the LOCAL-ONLY-NEVER-PERSISTS bug went undiagnosed for so
        // long.
        console.error(
          "[saveDataset] DB persist failed:",
          dbStorageKey,
          persistError
        );
      }

      try {
        await storagePut(key, input.payload, "application/json");
        await upsertSolarRecDatasetSyncState({
          userId: storageUserId,
          storageKey: dbStorageKey,
          payload: input.payload,
          dbPersisted: persistedToDatabase,
          storageSynced: true,
        }).catch((err) => {
          console.error(
            "[saveDataset] sync-state upsert failed (storage ok):",
            dbStorageKey,
            err instanceof Error ? err.message : err
          );
          return false;
        });
        return {
          _checkpoint: "saveDataset-scope-v2",
          _runnerVersion: "data-flow-pr3" as const,
          success: persistedToDatabase,
          partial: !persistedToDatabase,
          key,
          persistedToDatabase,
          storageSynced: true,
          // PR-1: surface the DB error and return success: false so the client
          // can show a real message instead of silently treating partial-success as OK.
          dbError: persistError,
        };
      } catch (storageError) {
        if (persistedToDatabase) {
          await upsertSolarRecDatasetSyncState({
            userId: storageUserId,
            storageKey: dbStorageKey,
            payload: input.payload,
            dbPersisted: true,
            storageSynced: false,
          }).catch((err) => {
            console.error(
              "[saveDataset] sync-state upsert failed (storage failed):",
              dbStorageKey,
              err instanceof Error ? err.message : err
            );
            return false;
          });
          return {
            _checkpoint: "saveDataset-scope-v2",
            _runnerVersion: "data-flow-pr3" as const,
            success: false,
            partial: true,
            key,
            persistedToDatabase,
            storageSynced: false,
            dbError: null,
          };
        }
        throw storageError;
      }
    }),
  /**
   * Push Converted Reads rows from an individual meter-reads page run into
   * the dashboard's `_rawSourcesV1` manifest. Shares the monitoring batch
   * bridge's write path so the two ingest sources coexist in one manifest
   * instead of clobbering each other's main-key writes.
   *
   * Resolves to the Solar REC team owner's user ID so every teammate
   * sees the same rows — matching how `isTeamWideDatasetKey` routes the
   * manifest + chunk reads.
   */
  pushConvertedReadsSource: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        providerKey: z
          .string()
          .min(1)
          .max(50)
          .regex(/^[a-z0-9_-]+$/, "providerKey must be lowercase alphanumeric plus _ or -"),
        providerLabel: z.string().min(1).max(100),
        rows: z.array(z.record(z.string(), z.string())).max(10_000),
      })
    )
    .mutation(async ({ input }) => {
      const { pushIndividualRunsToConvertedReads } = await import(
        "../solar/convertedReadsBridge"
      );
      const ownerUserId = await resolveSolarRecOwnerUserId();
      const result = await pushIndividualRunsToConvertedReads(
        ownerUserId,
        input.providerKey,
        input.providerLabel,
        input.rows
      );
      return {
        pushed: result?.pushed ?? 0,
        skipped: result?.skipped ?? input.rows.length,
        sourceId: result?.sourceId ?? null,
      };
    }),
  /**
   * Atomic read-merge-write of the convertedReads `_rawSourcesV1` manifest
   * for client-driven source edits (dashboard CSV uploads, "Remove"
   * button, etc.). The server preserves every server-managed source
   * (mon_batch_*, individual_*) regardless of what the client had in
   * memory, so a dashboard session that hydrated before a monitoring
   * batch wrote new data can no longer clobber that data during
   * auto-sync.
   *
   * The client is still responsible for writing (or clearing) the chunk
   * blobs for its user-uploaded sources. This mutation only rewrites
   * the manifest blob at `dataset:convertedReads`.
   */
  syncConvertedReadsUserSources: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        userSources: z
          .array(
            z.object({
              id: z
                .string()
                .min(1)
                .max(128)
                .regex(/^[a-zA-Z0-9_-]+$/),
              fileName: z.string().max(512),
              uploadedAt: z.string().min(1).max(64),
              rowCount: z.number().int().nonnegative(),
              sizeBytes: z.number().int().nonnegative(),
              storageKey: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
              chunkKeys: z
                .array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/))
                .max(500)
                .optional(),
              encoding: z.enum(["utf8", "base64"]),
              contentType: z.string().min(1).max(256),
            })
          )
          .max(200),
      })
    )
    .mutation(async ({ input }) => {
      const { syncUserSourcesToConvertedReadsManifest } = await import(
        "../solar/convertedReadsBridge"
      );
      const ownerUserId = await resolveSolarRecOwnerUserId();
      const result = await syncUserSourcesToConvertedReadsManifest(
        ownerUserId,
        input.userSources
      );
      return {
        manifest: result.manifest,
        serverManagedSourceCount: result.serverManagedSourceCount,
        userSourceCount: result.userSourceCount,
      };
    }),
  ensureScheduleBImportJob: dashboardProcedure("solar-rec-dashboard", "edit")
    .mutation(async ({ ctx }) => {
      const job = await getOrCreateLatestScheduleBImportJob(ctx.scopeId, ctx.userId);
      const counts = await getScheduleBImportJobCounts(job.id);
      const knownFileNames = await listScheduleBImportFileNames(job.id, {
        includeStatuses: ["uploading", "queued", "processing"],
      });

      if (
        (job.status === "queued" || job.status === "running") &&
        !isScheduleBImportRunnerActive(job.id) &&
        !isCsgScheduleBImportRunnerActive(job.id)
      ) {
        const [uploadedFiles, queuedCsgIds] = await Promise.all([
          listAllUploadedScheduleBImportFiles(job.id),
          getScheduleBImportCsgIdsForJob(job.id),
        ]);

        if (uploadedFiles.length > 0) {
          // Classic Schedule B file import path (local upload / Drive link).
          void runScheduleBImportJob(job.id);
        } else if (queuedCsgIds.length > 0) {
          // CSG portal import path (no scheduleBImportFiles rows expected).
          void runCsgScheduleBImportJob(job.id);
        }
      }

      return {
        job: {
          id: job.id,
          status: job.status,
          currentFileName: job.currentFileName,
          error: job.error,
          startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
          completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
          createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
          updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
        },
        counts,
        knownFileNames,
      };
    }),
  /**
   * drive-link-v1: paste a Google Drive folder URL, server enumerates
   * all PDFs, creates scheduleBImportFiles rows with storageKey
   * "drive:<fileId>", and kicks off the existing runner. The runner's
   * processSingleFile branches on the prefix and downloads from Drive
   * instead of S3. Every downstream flow — progress, results, Apply,
   * Last Apply panel — works unchanged because drive-linked files
   * write to the same DB tables as local-upload files.
   *
   * Response carries _checkpoint: "drive-link-v1" for deploy
   * verification per docs/server-routing.md.
   */
  linkScheduleBDriveFolder: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        folderUrl: z.string().min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const folderId = parseGoogleDriveFolderId(input.folderUrl);
      if (!folderId) {
        throw new Error(
          "Could not parse a Google Drive folder ID from that URL. Expected something like https://drive.google.com/drive/folders/..."
        );
      }

      const accessToken = await getValidGoogleToken(ctx.userId);

      const discovered = await listGoogleDrivePdfsInFolder(
        accessToken,
        folderId,
        { maxFiles: 100_000 }
      );

      if (discovered.length === 0) {
        throw new Error(
          "No PDFs found in that Drive folder (subfolders are scanned up to 10 levels deep). Make sure the folder contains Schedule B PDFs and that your Google account has access."
        );
      }

      const job = await getOrCreateLatestScheduleBImportJob(ctx.scopeId, ctx.userId);

      const { inserted, skipped } = await bulkInsertScheduleBDriveFiles(
        job.id,
        discovered.map((f) => ({
          fileName: f.name,
          fileSize: f.size,
          driveFileId: f.id,
        }))
      );

      // Reset job state to 'queued' so the runner re-evaluates the
      // work list. Clears any prior 'completed'/'stopped' terminal
      // state left over from a previous run of the same job. No-op
      // if inserted === 0 and the job is already running.
      if (inserted > 0) {
        await updateScheduleBImportJob(job.id, {
          status: "queued",
          error: null,
          completedAt: null,
          stoppedAt: null,
        });
      }

      if (inserted > 0 && !isScheduleBImportRunnerActive(job.id)) {
        void runScheduleBImportJob(job.id);
      }

      return {
        _checkpoint: "drive-link-v1" as const,
        jobId: job.id,
        folderId,
        discovered: discovered.length,
        newFiles: inserted,
        skippedExisting: skipped,
      };
    }),
  importScheduleBFromCsgPortal: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Validate CSG portal credentials
      const integration = await getIntegrationByProvider(ctx.userId, "csg-portal");
      if (!integration?.accessToken) {
        throw new Error("CSG portal credentials not configured. Go to Settings to add your portal email and password.");
      }

      // 2. Deduplicate
      const uniqueIds = Array.from(new Set(input.csgIds.map((v) => v.trim()).filter(Boolean)));
      if (uniqueIds.length === 0) throw new Error("No valid CSG IDs provided.");

      // 3. Get/create job
      const job = await getOrCreateLatestScheduleBImportJob(ctx.scopeId, ctx.userId);

      // 4. Insert CSG IDs
      const { inserted, skipped } = await bulkInsertScheduleBImportCsgIds(
        job.id,
        uniqueIds.map((csgId) => ({ csgId }))
      );

      // 5. Ensure the job can run even when all IDs already existed in the table
      // (for example, retrying previously failed CSG IDs in a completed job).
      await updateScheduleBImportJob(job.id, {
        status: "queued",
        error: null,
        completedAt: null,
        stoppedAt: null,
        ...(inserted > 0 ? { totalFiles: (job.totalFiles ?? 0) + inserted } : {}),
      });

      // 6. Start the CSG-specific runner
      if (!isCsgScheduleBImportRunnerActive(job.id)) {
        void runCsgScheduleBImportJob(job.id);
      }

      return {
        _checkpoint: "csg-schedule-b-v1" as const,
        jobId: job.id,
        total: uniqueIds.length,
        newCsgIds: inserted,
        skippedExisting: skipped,
      };
    }),
  getScheduleBImportStatus: dashboardProcedure("solar-rec-dashboard", "read")
    .query(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.scopeId);
      if (!job) {
        return {
          _runnerVersion: "v2_atomic_counters" as const,
          _reconcileGuard: "tmp-exclude-2026-04-11" as const,
          _applyTracking: "apply-track-v1" as const,
          job: null,
          counts: {
            totalFiles: 0,
            uploadingFiles: 0,
            queuedFiles: 0,
            processingFiles: 0,
            completedFiles: 0,
            failedFiles: 0,
            uploadedFiles: 0,
            processedFiles: 0,
            successCount: 0,
            failureCount: 0,
            pendingApplyCount: 0,
          },
        };
      }

      // v2_atomic_counters: read counters directly from the job row.
      // The new runner maintains successCount/failureCount/totalFiles
      // via atomic increments after every processed file, mirroring
      // the contract scraper. This replaces 8 COUNT(*) queries over
      // scheduleBImportFiles that were racing with the runner's
      // own status updates.
      if (
        (job.status === "queued" || job.status === "running") &&
        !isScheduleBImportRunnerActive(job.id) &&
        !isCsgScheduleBImportRunnerActive(job.id)
      ) {
        const [uploadedFiles, queuedCsgIds] = await Promise.all([
          listAllUploadedScheduleBImportFiles(job.id),
          getScheduleBImportCsgIdsForJob(job.id),
        ]);

        if (uploadedFiles.length > 0) {
          // Stale-runner watchdog for the classic PDF/Drive runner.
          const STALE_RUNNER_MS = JOB_TTL_MS;
          if (
            job.status === "running" &&
            job.startedAt &&
            Date.now() - new Date(job.startedAt).getTime() > STALE_RUNNER_MS
          ) {
            console.warn(
              `[scheduleBImport] stale runner detected for job ${job.id.slice(0, 8)} ` +
                `(started ${job.startedAt}, no active runner). Resetting to queued.`
            );
            await updateScheduleBImportJob(job.id, {
              status: "queued",
              completedAt: null,
              error: null,
            });
          }
          void runScheduleBImportJob(job.id);
        } else if (queuedCsgIds.length > 0) {
          // CSG portal import path (no scheduleBImportFiles rows expected).
          void runCsgScheduleBImportJob(job.id);
        }
      }

      const totalFiles = job.totalFiles ?? 0;
      const successCount = job.successCount ?? 0;
      const failureCount = job.failureCount ?? 0;
      const processedFiles = successCount + failureCount;

      // pendingApplyCount drives the "Apply as Delivery Schedule (N)"
      // button counter. Server-authoritative so it survives
      // navigation, reload, and tRPC refetches without a client-side
      // filter-set race. See markScheduleBImportResultsApplied.
      const pendingApplyCount = await getPendingScheduleBImportApplyCount(
        job.id
      );

      return {
        _runnerVersion: "v2_atomic_counters" as const,
        _reconcileGuard: "tmp-exclude-2026-04-11" as const,
        _applyTracking: "apply-track-v1" as const,
        job: {
          id: job.id,
          status: job.status,
          currentFileName: job.currentFileName,
          error: job.error,
          startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
          stoppedAt: job.stoppedAt ? new Date(job.stoppedAt).toISOString() : null,
          completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
          createdAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
          updatedAt: job.updatedAt ? new Date(job.updatedAt).toISOString() : null,
        },
        counts: {
          totalFiles,
          uploadingFiles: Math.max(0, totalFiles - processedFiles),
          queuedFiles: Math.max(0, totalFiles - processedFiles),
          processingFiles: 0,
          completedFiles: successCount,
          failedFiles: failureCount,
          uploadedFiles: totalFiles,
          processedFiles,
          successCount,
          failureCount,
          pendingApplyCount,
        },
      };
    }),
  listScheduleBImportResults: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z
        .object({
          jobId: z.string().min(1).max(64).optional(),
          limit: z.number().int().min(1).max(50000).optional(),
          offset: z.number().int().min(0).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const requestedJobId = input?.jobId?.trim();
      let job = requestedJobId
        ? await getScheduleBImportJob(requestedJobId)
        : await getLatestScheduleBImportJob(ctx.scopeId);

      // Defensive: Number()-coerce both sides before comparing in case the
      // mysql2 driver returns job.userId as a BigInt or string for any
      // reason. The previous strict `!==` check caused "0 rows returned"
      // ghost behavior while the DB actually held 800+ result rows; the
      // apply mutation worked because it uses a different resolution path.
      // If the requested job doesn't belong to this user, transparently
      // fall back to the latest job for the user instead of returning
      // empty — it's safer to show the user their own data than pretend
      // there isn't any.
      if (job && Number(job.userId) !== Number(ctx.userId)) {
        console.warn(
          `[listScheduleBImportResults] requested jobId ${job.id} belongs to user ${job.userId} but caller is ${ctx.userId}; falling back to latest job for caller`
        );
        job = await getLatestScheduleBImportJob(ctx.scopeId);
      }

      if (!job) {
        console.warn(
          `[listScheduleBImportResults] no job found for user ${ctx.userId} (requestedJobId=${requestedJobId ?? "none"})`
        );
        return { jobId: null, rows: [], total: 0, debug: { requestedJobId: requestedJobId ?? null, resolvedJobId: null } };
      }

      const result = await listScheduleBImportResults(job.id, {
        limit: input?.limit ?? 50000,
        offset: input?.offset ?? 0,
      });

      // Ship one-shot instrumentation so we can see in Render logs what
      // this query is actually returning for the production client when
      // the UI disagrees with the debug proc. Safe to leave for a while.

      const rows = result.rows.map((row) => ({
        fileName: row.fileName,
        designatedSystemId: row.designatedSystemId,
        gatsId: row.gatsId,
        acSizeKw: row.acSizeKw,
        capacityFactor: row.capacityFactor,
        contractPrice: row.contractPrice,
        energizationDate: row.energizationDate,
        maxRecQuantity: row.maxRecQuantity,
        deliveryYears: normalizeScheduleBDeliveryYears(row.deliveryYearsJson),
        error: row.error,
        scannedAt: row.scannedAt ? new Date(row.scannedAt).toISOString() : null,
      }));

      return {
        jobId: job.id,
        rows,
        total: result.total,
      };
    }),
  applyScheduleBToDeliveryObligations: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z
        .object({
          jobId: z.string().min(1).max(64).optional(),
        })
        .optional()
    )
    .mutation(async ({ ctx, input }) => {
      const requestedJobId = input?.jobId?.trim();
      let job = requestedJobId
        ? await getScheduleBImportJob(requestedJobId)
        : await getLatestScheduleBImportJob(ctx.scopeId);

      // Same Number()-coercion + latest-job fallback as
      // listScheduleBImportResults above — mysql2 driver occasionally
      // returns job.userId as a string/bigint and strict !== fails.
      if (job && Number(job.userId) !== Number(ctx.userId)) {
        console.warn(
          `[applyScheduleBToDeliveryObligations] requested jobId ${job.id} belongs to user ${job.userId} but caller is ${ctx.userId}; falling back to latest job for caller`
        );
        job = await getLatestScheduleBImportJob(ctx.scopeId);
      }
      if (!job) {
        throw new Error("Schedule B import job not found.");
      }

      // deliveryScheduleBase is row-table canonical. Fall back to the
      // legacy cloud blob only when no active srDs batch exists yet
      // (the production repair/backfill path uses that same fallback).
      const existingDataset = await loadCanonicalDeliveryScheduleBaseDataset(
        ctx.scopeId,
        ctx.userId
      );

      const contractIdByTrackingId = new Map<string, string>();
      for (const row of existingDataset.rows) {
        const trackingId = cleanScheduleBCell(row.tracking_system_ref_id).toUpperCase();
        const contractId = cleanScheduleBCell(row.utility_contract_number);
        if (!trackingId || !contractId) continue;
        if (!contractIdByTrackingId.has(trackingId)) {
          contractIdByTrackingId.set(trackingId, contractId);
        }
      }

      // Augment with saved NON-ID → Contract-ID mapping so new rows
      // get their contract ID even when the delivery tracker was cleared.
      // Existing row assignments take priority (already in the map).
      try {
        const savedMappingText = await getSolarRecDashboardPayload(
          ctx.userId,
          "dashboard:schedule_b_contract_id_mapping"
        );
        if (savedMappingText) {
          const savedMapping = parseContractIdMappingText(savedMappingText);
          for (const [gatsId, cId] of Array.from(savedMapping.entries())) {
            if (!contractIdByTrackingId.has(gatsId)) {
              contractIdByTrackingId.set(gatsId, cId);
            }
          }
        }
      } catch {
        // Mapping unavailable — proceed without it.
      }

      const { buildTransferDeliveryLookupForScope } = await import(
        "../services/solar/buildTransferDeliveryLookup"
      );
      const transferDeliveryLookup = reviveTransferDeliveryLookup(
        await buildTransferDeliveryLookupForScope(ctx.scopeId)
      );

      const rawResults = await getAllScheduleBImportResults(job.id);
      const incomingRows: Array<Record<string, string>> = [];
      // incomingFileNames is a parallel array to incomingRows — index
      // N of incomingFileNames holds the Schedule B result fileName
      // that produced incomingRows[N]. Tracked separately because
      // buildScheduleBDeliveryRow doesn't persist fileName onto the
      // delivery row itself. Used after the merge to
      // (a) mark scheduleBImportResults rows as applied and
      // (b) populate the "already in database" feedback list.
      const incomingFileNames: string[] = [];
      let conversionErrors = 0;

      for (const resultRow of rawResults) {
        if (resultRow.error) {
          conversionErrors += 1;
          continue;
        }

        const gatsId = cleanScheduleBCell(resultRow.gatsId);
        if (!gatsId) {
          conversionErrors += 1;
          continue;
        }

        const deliveryYears = normalizeScheduleBDeliveryYears(resultRow.deliveryYearsJson);
        const firstTransferEnergyYear = findFirstTransferEnergyYear(
          gatsId,
          transferDeliveryLookup
        );
        const adjustedYears = buildAdjustedScheduleFromExtraction(
          {
            deliveryYears,
            acSizeKw: resultRow.acSizeKw ?? null,
            capacityFactor: resultRow.capacityFactor ?? null,
          },
          firstTransferEnergyYear
        );

        if (adjustedYears.length === 0) {
          conversionErrors += 1;
          continue;
        }

        // Contract ID priority: (1) existing mapping, (2) PDF footer
        // extraction ("Contract 153"), (3) empty.
        const existingContractId =
          contractIdByTrackingId.get(gatsId.toUpperCase()) ||
          resultRow.contractNumber ||
          "";

        incomingRows.push(
          buildScheduleBDeliveryRow({
            fileName: resultRow.fileName,
            designatedSystemId: resultRow.designatedSystemId ?? null,
            gatsId,
            contractId: existingContractId,
            adjustedYears,
          })
        );
        incomingFileNames.push(resultRow.fileName);
      }

      const mergedByKey = new Map<string, Record<string, string>>();
      const orderedKeys: string[] = [];
      existingDataset.rows.forEach((row, rowIndex) => {
        const key = makeDeliveryRowKey(row, "existing", rowIndex);
        if (mergedByKey.has(key)) return;
        mergedByKey.set(key, row);
        orderedKeys.push(key);
      });

      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      // appliedFileNames = every incoming row's source filename that
      // reached the merge (regardless of branch). Used to mark rows
      // as applied in scheduleBImportResults so the pending-apply
      // counter decreases.
      // alreadyInDatabaseFileNames = the subset whose tracking key
      // matched a pre-existing row — i.e. the "tracking ID is
      // already in the database" feedback the user asked for. This
      // is keyed off `existing !== undefined`, which is broader than
      // the `unchanged` bucket (an `updated` row also matched an
      // existing key, it just had changed field values).
      const appliedFileNames: string[] = [];
      const alreadyInDatabaseFileNames: string[] = [];

      incomingRows.forEach((row, rowIndex) => {
        const sourceFileName = incomingFileNames[rowIndex] ?? "";
        if (sourceFileName) {
          appliedFileNames.push(sourceFileName);
        }
        const key = makeDeliveryRowKey(row, "scheduleb", rowIndex);
        const existing = mergedByKey.get(key);
        if (!existing) {
          mergedByKey.set(key, row);
          orderedKeys.push(key);
          inserted += 1;
          return;
        }

        if (sourceFileName) {
          alreadyInDatabaseFileNames.push(sourceFileName);
        }

        const merged = mergeDeliveryRows(existing, row);
        if (scheduleRowsEqual(existing, merged)) {
          unchanged += 1;
        } else {
          updated += 1;
        }
        mergedByKey.set(key, merged);
      });

      const mergedRows = orderedKeys
        .map((key) => mergedByKey.get(key))
        .filter((row): row is Record<string, string> => Boolean(row));

      const mergedHeaders: string[] = [];
      const pushHeader = (header: string) => {
        const cleanHeader = cleanScheduleBCell(header);
        if (!cleanHeader || mergedHeaders.includes(cleanHeader)) return;
        mergedHeaders.push(cleanHeader);
      };
      existingDataset.headers.forEach(pushHeader);
      incomingRows.forEach((row) => Object.keys(row).forEach(pushHeader));
      mergedRows.forEach((row) => Object.keys(row).forEach(pushHeader));

      const uploadedAt = new Date().toISOString();
      const { key: storageKey } = await buildDashboardStorageKeys(
        ctx.userId,
        "datasets/deliveryScheduleBase.json"
      );
      const persistence = await persistDeliveryScheduleBaseCanonical({
        scopeId: ctx.scopeId,
        userId: ctx.userId,
        storagePath: storageKey,
        fileName: existingDataset.fileName || "Schedule B Import",
        uploadedAt,
        headers: mergedHeaders,
        rows: mergedRows,
      });

      // Mark the consumed result rows as applied so the Apply
      // counter drops to 0 (or to whatever genuinely-new results
      // have since landed). Only run if at least one persistence
      // path succeeded — row-table activation is the canonical
      // success signal now. Non-fatal: swallow errors so a successful
      // merge still returns success to the client.
      let markedAppliedCount = 0;
      try {
        markedAppliedCount = await markScheduleBImportResultsApplied(
          job.id,
          appliedFileNames
        );
      } catch (markErr) {
        console.error(
          `[applyScheduleBToDeliveryObligations] failed to mark rows applied for job ${job.id}:`,
          markErr
        );
      }

      return {
        success: true,
        _checkpoint: "apply-track-v1" as const,
        _runnerVersion: persistence._runnerVersion,
        jobId: job.id,
        incoming: incomingRows.length,
        inserted,
        updated,
        unchanged,
        errors: conversionErrors,
        totalRows: mergedRows.length,
        batchId: persistence.batchId,
        rowCount: persistence.rowCount,
        rowTableStatus: persistence.rowTableStatus,
        rowTableErrors: persistence.rowTableErrors,
        persistedToDatabase: persistence.persistedToDatabase,
        storageSynced: persistence.storageSynced,
        persistError: persistence.persistError,
        storageError: persistence.storageError,
        syncStateUpdated: persistence.syncStateUpdated,
        syncStateError: persistence.syncStateError,
        appliedFileNames,
        alreadyInDatabaseFileNames,
        markedAppliedCount,
      };
    }),
  /**
   * csv-upload-v1: Manually upload a Delivery Schedule CSV as a fallback
   * for systems the Schedule B PDF scrape is missing or erroring on.
   *
   * Semantics:
   *   - CSV columns MUST include tracking_system_ref_id. The other
   *     expected columns mirror the deliveryScheduleBase dataset:
   *     system_name, state_certification_number, utility_contract_number,
   *     year1..year15_{quantity_required, quantity_delivered,
   *     start_date, end_date}.
   *   - Rows whose tracking_system_ref_id already exists in
   *     deliveryScheduleBase are SKIPPED (Schedule B scrape wins).
   *   - Rows with a blank tracking_system_ref_id are SKIPPED.
   *   - New rows are APPENDED to the existing dataset and persisted
   *     through the canonical srDs row-table writer. The legacy DB +
   *     S3 JSON blob is still written as a compatibility copy.
   *   - Schedule B re-applies will naturally overwrite CSV rows because
   *     mergeDeliveryRows(existing, incoming) uses
   *     { ...existing, ...incoming } — no merge-flow change needed.
   *
   * Returns _checkpoint so the client can confirm live deployment via
   * the browser devtools Network tab (per CLAUDE.md convention).
   */
  uploadDeliveryScheduleCsv: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        csvText: z.string().min(1).max(10 * 1024 * 1024),
        fileName: z.string().min(1).max(255).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const parsed = parseCsvText(input.csvText);
      if (!parsed.headers.includes("tracking_system_ref_id")) {
        throw new Error(
          "CSV must contain a 'tracking_system_ref_id' column."
        );
      }

      const existingDataset = await loadCanonicalDeliveryScheduleBaseDataset(
        ctx.scopeId,
        ctx.userId
      );

      // Build a Set of keys already in the dataset — keys match
      // makeDeliveryRowKey semantics (uppercased tracking_system_ref_id).
      const existingKeys = new Set<string>();
      existingDataset.rows.forEach((row, idx) => {
        existingKeys.add(makeDeliveryRowKey(row, "existing", idx));
      });

      const insertedRows: Array<Record<string, string>> = [];
      let skippedAlreadyPresent = 0;
      let skippedBlankKey = 0;

      for (let i = 0; i < parsed.rows.length; i += 1) {
        const row = parsed.rows[i];
        const trackingId = cleanScheduleBCell(row.tracking_system_ref_id);
        if (!trackingId) {
          skippedBlankKey += 1;
          continue;
        }
        const key = makeDeliveryRowKey(row, "csv", i);
        if (existingKeys.has(key)) {
          skippedAlreadyPresent += 1;
          continue;
        }
        insertedRows.push(row);
        existingKeys.add(key);
      }

      // Compose merged headers preserving original order, then appending
      // any new columns from the CSV. Same dedupe logic as
      // applyScheduleBToDeliveryObligations.
      const mergedHeaders: string[] = [];
      const pushHeader = (header: string) => {
        const cleanHeader = cleanScheduleBCell(header);
        if (!cleanHeader || mergedHeaders.includes(cleanHeader)) return;
        mergedHeaders.push(cleanHeader);
      };
      existingDataset.headers.forEach(pushHeader);
      parsed.headers.forEach(pushHeader);
      insertedRows.forEach((row) => Object.keys(row).forEach(pushHeader));

      const mergedRows = [...existingDataset.rows, ...insertedRows];

      const uploadedAt = new Date().toISOString();
      const { key: storageKey } = await buildDashboardStorageKeys(
        ctx.userId,
        "datasets/deliveryScheduleBase.json"
      );
      const persistence = await persistDeliveryScheduleBaseCanonical({
        scopeId: ctx.scopeId,
        userId: ctx.userId,
        storagePath: storageKey,
        fileName:
          input.fileName?.trim() ||
          existingDataset.fileName ||
          "Delivery Schedule CSV",
        uploadedAt,
        headers: mergedHeaders,
        rows: mergedRows,
      });

      return {
        success: true,
        _checkpoint: "csv-upload-v1" as const,
        _runnerVersion: persistence._runnerVersion,
        receivedRows: parsed.rows.length,
        inserted: insertedRows.length,
        skippedAlreadyPresent,
        skippedBlankKey,
        totalRows: mergedRows.length,
        batchId: persistence.batchId,
        rowCount: persistence.rowCount,
        rowTableStatus: persistence.rowTableStatus,
        rowTableErrors: persistence.rowTableErrors,
        persistedToDatabase: persistence.persistedToDatabase,
        storageSynced: persistence.storageSynced,
        persistError: persistence.persistError,
        storageError: persistence.storageError,
        syncStateUpdated: persistence.syncStateUpdated,
        syncStateError: persistence.syncStateError,
      };
    }),
  /**
   * contract-id-mapping-v1: persist a GATS ID → Contract ID mapping
   * server-side and patch utility_contract_number across the
   * canonical deliveryScheduleBase rows.
   *
   * Previously the client-side handleContractIdMappingChange path
   * patched local state and relied on the deprecated onApply merge
   * handler + flaky signature-ref cloud sync. That meant 24k-entry
   * mappings were lost on refresh and never reached the server.
   *
   * This mutation:
   *   1. Saves the raw mapping TEXT to cloud (so the textarea
   *      hydrates on next mount via getScheduleBContractIdMapping).
   *   2. Parses the text into a Map<gatsId, contractId> (same
   *      grammar as client/src/lib/scheduleBScanner.ts::parseContractIdMapping).
   *   3. Loads the current canonical deliveryScheduleBase rows,
   *      preferring the active srDs batch and falling back to legacy
   *      cloud storage only when no active batch exists yet.
   *   4. Iterates rows and patches utility_contract_number wherever
   *      tracking_system_ref_id (uppercased) has a mapping entry.
   *   5. Writes the patched dataset back to the active row-table
   *      batch, then writes the legacy flat
   *      {fileName,uploadedAt,headers,csvText} shape as a derived
   *      compatibility copy.
   *   6. Returns counts + checkpoint so the client can display a
   *      "Last mapping: X patched, Y unchanged" panel and so
   *      onApplyComplete can reload the dataset from cloud.
   */
  getScheduleBContractIdMapping: dashboardProcedure("solar-rec-dashboard", "read").query(async ({ ctx }) => {
    const mappingText = await getSolarRecDashboardPayload(
      ctx.userId,
      "dashboard:schedule_b_contract_id_mapping"
    );
    return {
      _checkpoint: "contract-id-mapping-v1" as const,
      mappingText: mappingText ?? "",
    };
  }),
  applyScheduleBContractIdMapping: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        // 24k entries × ~30 bytes/line = ~720KB. Cap at 5 MB to
        // leave headroom for much larger lists without blowing up
        // the tRPC request.
        mappingText: z.string().max(5_000_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // ── Step 1: Persist the raw text so the textarea rehydrates
      //    on next mount. Do this FIRST so even if the patch step
      //    fails the user doesn't lose their pasted mapping.
      const mappingTextSaved = await saveSolarRecDashboardPayload(
        ctx.userId,
        "dashboard:schedule_b_contract_id_mapping",
        input.mappingText
      );
      if (!mappingTextSaved) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            "Failed to save the Schedule B contract-ID mapping. No delivery schedule rows were changed.",
        });
      }

      // ── Step 2: Parse using shared helper (same logic used by
      //    applyScheduleBToDeliveryObligations when loading the
      //    saved mapping during merge).
      const mapping = parseContractIdMappingText(input.mappingText);

      if (mapping.size === 0) {
        return {
          _checkpoint: "contract-id-mapping-v1" as const,
          mappingSize: 0,
          patched: 0,
          unchanged: 0,
          totalRows: 0,
          mappingTextSaved: true,
          mappingText: input.mappingText,
        };
      }

      // ── Step 3: Load the current canonical deliveryScheduleBase.
      //    Prefer the active srDs row-table batch; fall back to the
      //    legacy cloud blob only when no active batch exists yet.
      const existingDataset = await loadCanonicalDeliveryScheduleBaseDataset(
        ctx.scopeId,
        ctx.userId
      );
      if (existingDataset.rows.length === 0) {
        // No dataset yet. Text is saved, but there's nothing to
        // patch. Return early so the client doesn't trigger a
        // cloud reload that would show 0 rows.
        return {
          _checkpoint: "contract-id-mapping-v1" as const,
          mappingSize: mapping.size,
          patched: 0,
          unchanged: 0,
          totalRows: 0,
          batchId: null,
          rowCount: 0,
          _runnerVersion: null,
          mappingTextSaved: true,
          mappingText: input.mappingText,
        };
      }

      // ── Step 4: Patch utility_contract_number on matching rows.
      let patched = 0;
      let unchanged = 0;
      const patchedRows = existingDataset.rows.map((row) => {
        const trackingId = cleanScheduleBCell(
          row.tracking_system_ref_id
        ).toUpperCase();
        if (!trackingId) {
          unchanged += 1;
          return row;
        }
        const newContractId = mapping.get(trackingId);
        if (!newContractId) {
          unchanged += 1;
          return row;
        }
        const currentContractId = cleanScheduleBCell(
          row.utility_contract_number
        );
        if (currentContractId === newContractId) {
          // Already set to the mapped value — count as unchanged
          // so the user sees accurate "patched" totals.
          unchanged += 1;
          return row;
        }
        patched += 1;
        return {
          ...row,
          utility_contract_number: newContractId,
        };
      });

      // Make sure the headers include utility_contract_number so
      // the column appears on any rows that didn't have it before.
      const mergedHeaders: string[] = [];
      const pushHeader = (header: string) => {
        const cleanHeader = cleanScheduleBCell(header);
        if (!cleanHeader || mergedHeaders.includes(cleanHeader)) return;
        mergedHeaders.push(cleanHeader);
      };
      existingDataset.headers.forEach(pushHeader);
      pushHeader("utility_contract_number");
      patchedRows.forEach((row) => Object.keys(row).forEach(pushHeader));

      // ── Step 5: Write back to the canonical row table, then write
      //    the legacy cloud JSON as a derived compatibility copy.
      const uploadedAt = new Date().toISOString();
      const { key: storageKey } = await buildDashboardStorageKeys(
        ctx.userId,
        "datasets/deliveryScheduleBase.json"
      );
      const persistence = await persistDeliveryScheduleBaseCanonical({
        scopeId: ctx.scopeId,
        userId: ctx.userId,
        storagePath: storageKey,
        fileName: existingDataset.fileName || "Schedule B Import",
        uploadedAt,
        headers: mergedHeaders,
        rows: patchedRows,
      });

      return {
        _checkpoint: "contract-id-mapping-v1" as const,
        _runnerVersion: persistence._runnerVersion,
        mappingSize: mapping.size,
        patched,
        unchanged,
        totalRows: patchedRows.length,
        batchId: persistence.batchId,
        rowCount: persistence.rowCount,
        rowTableStatus: persistence.rowTableStatus,
        rowTableErrors: persistence.rowTableErrors,
        persistedToDatabase: persistence.persistedToDatabase,
        storageSynced: persistence.storageSynced,
        persistError: persistence.persistError,
        storageError: persistence.storageError,
        syncStateUpdated: persistence.syncStateUpdated,
        syncStateError: persistence.syncStateError,
        mappingTextSaved: true,
        mappingText: input.mappingText,
      };
    }),
  uploadScheduleBFileChunk: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        jobId: z.string().min(1).max(64),
        uploadId: z.string().regex(SCHEDULE_B_UPLOAD_ID_PATTERN),
        fileName: z.string().min(1).max(255),
        fileSize: z.number().int().min(1).max(300 * 1024 * 1024),
        chunkIndex: z.number().int().min(0),
        totalChunks: z.number().int().min(1).max(500000),
        chunkBase64: z.string().min(1).max(SCHEDULE_B_UPLOAD_CHUNK_BASE64_LIMIT),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const safeFileName = sanitizeScheduleBFileName(input.fileName);
      const job = await getScheduleBImportJob(input.jobId.trim());
      if (!job || job.userId !== ctx.userId) {
        throw new Error("Schedule B import job not found.");
      }

      const existing = await getScheduleBImportFile(job.id, safeFileName);
      if (existing && (existing.status === "queued" || existing.status === "processing")) {
        return {
          skipped: true,
          fileName: safeFileName,
          status: existing.status,
          reason: "already_uploaded",
        } as const;
      }

      const tempDir = path.join(
        SCHEDULE_B_UPLOAD_TMP_ROOT,
        String(ctx.userId),
        job.id
      );
      const tempPath = path.join(tempDir, `${input.uploadId}.part`);
      await mkdir(tempDir, { recursive: true });

      if (input.chunkIndex === 0) {
        // Chunk 0 starts/restarts an upload session for this file.
        await writeFile(tempPath, Buffer.from(input.chunkBase64, "base64"));
        await upsertScheduleBImportFileUploadProgress({
          jobId: job.id,
          fileName: safeFileName,
          fileSize: input.fileSize,
          uploadedChunks: 1,
          totalChunks: input.totalChunks,
          // Keep status="uploading" until the permanent storageKey is
          // written by markScheduleBImportFileQueued below. Transitioning
          // to "queued" here creates a race window where the status poll
          // or the runner's work list picks up a file with storageKey
          // still "tmp:..." and marks it failed / writes an error row.
          status: "uploading",
          storageKey: `tmp:${input.uploadId}`,
          error: null,
        });
      } else {
        const currentFile = await getScheduleBImportFile(job.id, safeFileName);
        if (!currentFile || currentFile.status !== "uploading") {
          throw new Error(`Upload session missing for ${safeFileName}. Restart this file upload.`);
        }

        const currentUploadId = (currentFile.storageKey ?? "").startsWith("tmp:")
          ? (currentFile.storageKey ?? "").slice(4)
          : null;
        if (!currentUploadId || currentUploadId !== input.uploadId) {
          throw new Error(`Upload session changed for ${safeFileName}. Restart this file upload.`);
        }

        const expectedChunkIndex = currentFile.uploadedChunks;
        if (input.chunkIndex < expectedChunkIndex) {
          return {
            skipped: true,
            fileName: safeFileName,
            status: "uploading" as const,
            reason: "duplicate_chunk",
          };
        }
        if (input.chunkIndex > expectedChunkIndex) {
          throw new Error(
            `Out-of-order chunk for ${safeFileName}. Expected ${expectedChunkIndex}, got ${input.chunkIndex}.`
          );
        }

        await appendFile(tempPath, Buffer.from(input.chunkBase64, "base64"));
        await upsertScheduleBImportFileUploadProgress({
          jobId: job.id,
          fileName: safeFileName,
          fileSize: input.fileSize,
          uploadedChunks: input.chunkIndex + 1,
          totalChunks: input.totalChunks,
          // Same reasoning as chunk-0: stay in "uploading" until
          // markScheduleBImportFileQueued sets the permanent storageKey.
          status: "uploading",
          storageKey: `tmp:${input.uploadId}`,
          error: null,
        });
      }

      const completedUpload = input.chunkIndex + 1 >= input.totalChunks;
      if (!completedUpload) {
        return {
          skipped: false,
          fileName: safeFileName,
          uploadedChunks: input.chunkIndex + 1,
          totalChunks: input.totalChunks,
          completedUpload: false,
        };
      }

      try {
        const data = await readFile(tempPath);
        const { key: storageKey } = await buildDashboardStorageKeys(
          ctx.userId,
          `schedule-b/${job.id}/${Date.now()}-${nanoid()}-${safeFileName}`
        );
        await storagePut(storageKey, data, "application/pdf");

        await markScheduleBImportFileQueued({
          jobId: job.id,
          fileName: safeFileName,
          fileSize: input.fileSize,
          totalChunks: input.totalChunks,
          storageKey,
        });

        await updateScheduleBImportJob(job.id, {
          status: "queued",
          error: null,
          completedAt: null,
          stoppedAt: null,
        });

        void runScheduleBImportJob(job.id);

        return {
          skipped: false,
          fileName: safeFileName,
          uploadedChunks: input.totalChunks,
          totalChunks: input.totalChunks,
          completedUpload: true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to finalize upload.";
        await markScheduleBImportFileStatus({
          jobId: job.id,
          fileName: safeFileName,
          status: "failed",
          error: message,
          processedAt: new Date(),
        });
        throw new Error(message);
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    }),
  forceRunScheduleBImport: dashboardProcedure("solar-rec-dashboard", "admin")
    .mutation(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.scopeId);
      if (!job) {
        return { success: false, reason: "no_job" as const };
      }

      await requeueScheduleBImportRetryableFiles(job.id);

      await updateScheduleBImportJob(job.id, {
        status: "queued",
        error: null,
        completedAt: null,
        stoppedAt: null,
      });

      void runScheduleBImportJob(job.id);
      return { success: true, jobId: job.id };
    }),
  clearScheduleBImport: dashboardProcedure("solar-rec-dashboard", "admin")
    .mutation(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.scopeId);
      if (job) {
        await deleteScheduleBImportJobData(job.id);
      }

      const userTmpDir = path.join(SCHEDULE_B_UPLOAD_TMP_ROOT, String(ctx.userId));
      await rm(userTmpDir, { recursive: true, force: true }).catch(() => undefined);
      return { success: true };
    }),
  /**
   * Surgical cleanup endpoint for dangling upload sessions that got
   * stranded with status='uploading' + storageKey='tmp:...'. Wired to
   * the "Clear stuck uploads" admin button so the user can unstick a
   * job without losing the already-processed results (unlike the
   * broader clearScheduleBImport which wipes everything). Also removes
   * any orphaned temp chunk files on disk for the user's workspace.
   *
   * Calls reconcileScheduleBImportJobState and runScheduleBImportJob
   * afterwards so the job row's totalFiles counter catches up and the
   * runner re-evaluates whether to finalize as 'completed'.
   */
  clearScheduleBImportStuckUploads: dashboardProcedure("solar-rec-dashboard", "admin")
    .mutation(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.scopeId);
      if (!job) {
        return {
          _checkpoint: "clear-stuck-uploads-2026-04-11" as const,
          jobId: null,
          deleted: 0,
          reconciled: null,
        };
      }

      const deleted = await clearScheduleBImportStuckUploads(job.id);

      // Best-effort cleanup of any orphaned temp chunk files in the
      // user's workspace. The DELETE above already made the DB rows
      // invisible; leaving the .part files behind wastes disk but is
      // not a correctness issue, so we swallow errors here.
      const userJobTmpDir = path.join(
        SCHEDULE_B_UPLOAD_TMP_ROOT,
        String(ctx.userId),
        job.id
      );
      await rm(userJobTmpDir, { recursive: true, force: true }).catch(
        () => undefined
      );

      const reconciled = await reconcileScheduleBImportJobState(job.id);

      // Kick the runner so it re-evaluates completion. If remaining is
      // now 0 the next runner pass will transition the job to
      // 'completed'.
      if (!isScheduleBImportRunnerActive(job.id)) {
        void runScheduleBImportJob(job.id);
      }

      return {
        _checkpoint: "clear-stuck-uploads-2026-04-11" as const,
        jobId: job.id,
        deleted,
        reconciled: {
          totalFiles: reconciled.totalFiles,
          successCount: reconciled.successCount,
          failureCount: reconciled.failureCount,
          filesMarkedCompleted: reconciled.filesMarkedCompleted,
          filesRequeued: reconciled.filesRequeued,
        },
      };
    }),
  /**
   * Debug-only: returns the raw state of the user's latest Schedule B
   * job. Wired to the "Raw DB state" button in the ScheduleBImport
   * card. Shows the actual DB counts instead of any client-side
   * interpretation so we can diagnose counter-vs-result divergence.
   */
  debugScheduleBImportRaw: dashboardProcedure("solar-rec-dashboard", "read")
    .query(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.scopeId);
      if (!job) {
        return {
          _runnerVersion: "v2_atomic_counters" as const,
          _reconcileGuard: "tmp-exclude-2026-04-11" as const,
          _applyTracking: "apply-track-v1" as const,
          hasJob: false as const,
          job: null,
          fileCountsByStatus: {},
          filesTotal: 0,
          resultRowTotal: 0,
          pendingApplyCount: 0,
          firstResultRows: [],
          sampleFilesWithNoResult: [],
        };
      }

      const db = await getDb();
      if (!db) {
        return {
          _runnerVersion: "v2_atomic_counters" as const,
          _reconcileGuard: "tmp-exclude-2026-04-11" as const,
          _applyTracking: "apply-track-v1" as const,
          hasJob: true as const,
          dbUnavailable: true as const,
          job: {
            id: job.id,
            status: job.status,
            totalFiles: job.totalFiles ?? 0,
            successCount: job.successCount ?? 0,
            failureCount: job.failureCount ?? 0,
            error: job.error,
          },
          fileCountsByStatus: {},
          filesTotal: 0,
          resultRowTotal: 0,
          pendingApplyCount: 0,
          firstResultRows: [],
          sampleFilesWithNoResult: [],
        };
      }

      const fileRows = await db
        .select({
          status: scheduleBImportFiles.status,
          fileName: scheduleBImportFiles.fileName,
          storageKey: scheduleBImportFiles.storageKey,
          error: scheduleBImportFiles.error,
        })
        .from(scheduleBImportFiles)
        .where(eq(scheduleBImportFiles.jobId, job.id));

      const fileCountsByStatus: Record<string, number> = {};
      for (const row of fileRows) {
        fileCountsByStatus[row.status] = (fileCountsByStatus[row.status] ?? 0) + 1;
      }

      const resultCount = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, job.id));
      const resultRowTotal = resultCount[0]?.count ?? 0;

      const firstResultRows = await db
        .select({
          fileName: scheduleBImportResults.fileName,
          gatsId: scheduleBImportResults.gatsId,
          error: scheduleBImportResults.error,
          appliedAt: scheduleBImportResults.appliedAt,
        })
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, job.id))
        .limit(5);

      const allResultNames = await db
        .select({ fileName: scheduleBImportResults.fileName })
        .from(scheduleBImportResults)
        .where(eq(scheduleBImportResults.jobId, job.id));
      const resultNameSet = new Set(allResultNames.map((r) => r.fileName));
      const sampleFilesWithNoResult = fileRows
        .filter((f) => !resultNameSet.has(f.fileName))
        .slice(0, 10)
        .map((f) => ({
          fileName: f.fileName,
          status: f.status,
          storageKey: f.storageKey,
          error: f.error,
        }));

      const pendingApplyCount = await getPendingScheduleBImportApplyCount(job.id);

      return {
        _runnerVersion: "v2_atomic_counters" as const,
        _reconcileGuard: "tmp-exclude-2026-04-11" as const,
        _applyTracking: "apply-track-v1" as const,
        hasJob: true as const,
        job: {
          id: job.id,
          status: job.status,
          totalFiles: job.totalFiles ?? 0,
          successCount: job.successCount ?? 0,
          failureCount: job.failureCount ?? 0,
          error: job.error,
          startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
          completedAt: job.completedAt ? new Date(job.completedAt).toISOString() : null,
        },
        fileCountsByStatus,
        filesTotal: fileRows.length,
        resultRowTotal,
        pendingApplyCount,
        firstResultRows,
        sampleFilesWithNoResult,
      };
    }),
  askTabQuestion: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        tabId: z.string().min(1).max(64),
        question: z.string().min(1).max(4000),
        dataContext: z.string().max(200000),
        conversationHistory: z
          .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
          .max(20),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.userId, "anthropic");
      const apiKey = toNonEmptyString(integration?.accessToken);
      if (!apiKey) {
        throw new Error("Anthropic API key not configured. Go to Settings and connect your Anthropic account.");
      }
      const metadata = parseJsonMetadata(integration?.metadata);
      const model = toNonEmptyString(metadata.model) ?? "claude-sonnet-4-20250514";

      const systemPrompt = [
        `You are a solar REC portfolio analyst assistant for the Coherence platform.`,
        `You have access to data from the "${input.tabId}" tab of the Portfolio Analytics dashboard.`,
        `\nDATA CONTEXT:\n${input.dataContext}`,
        `\nINSTRUCTIONS:`,
        `- Answer using ONLY the provided data. Do not make up numbers.`,
        `- Be specific: cite system names, tracking IDs, contract numbers, and exact figures.`,
        `- Use markdown tables when comparing multiple systems or contracts.`,
        `- Keep answers concise but thorough.`,
        `- If the data doesn't contain enough info to answer, say so.`,
        `- REC = Renewable Energy Credit. 1 REC = 1 MWh = 1,000 kWh.`,
        `- Energy years run June 1 through May 31 (e.g., EY 2025-2026 = June 1 2025 – May 31 2026).`,
      ].join("\n");

      const messages = [
        ...input.conversationHistory.map((msg) => ({ role: msg.role as "user" | "assistant", content: msg.content })),
        { role: "user" as const, content: input.question },
      ];

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model, max_tokens: 4096, system: systemPrompt, messages }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        let message = "Claude API error";
        try { message = (JSON.parse(errorBody) as { error?: { message?: string } })?.error?.message ?? message; } catch { /* */ }
        throw new Error(`Claude API error (${response.status}): ${message}`);
      }

      const payload = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
      const text = payload.content?.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n") ?? "";
      if (!text) throw new Error("Empty response from Claude.");
      return { answer: text };
    }),

  // -- Server-side dataset architecture (Step 2) -------------------------

  getImportStatus: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ batchId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { getImportBatch, getImportErrors } = await import("../db");
      const batch = await getImportBatch(input.batchId);
      if (!batch) return { found: false as const };

      const errors =
        batch.status === "failed" ? await getImportErrors(input.batchId) : [];

      return {
        found: true as const,
        batchId: batch.id,
        datasetKey: batch.datasetKey,
        status: batch.status,
        rowCount: batch.rowCount,
        error: batch.error,
        errors: errors.map((e) => ({
          rowIndex: e.rowIndex,
          message: e.message,
        })),
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      };
    }),

  // -- Server-side tab data endpoints (Step 5) ---------------------------

  /**
   * Fetch the pre-computed system snapshot for a scope.
   *
   * Returns SystemRecord[] equivalent data. If the snapshot is stale
   * (input version hash mismatch), recomputes from normalized DB tables
   * using the same buildSystems() function as the client.
   *
   * Tabs that consume this: Overview, Ownership, Offline, Size, Value,
   * Change Ownership, and any tab that reads the `systems` prop.
   */
  getSystemSnapshot: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { getOrBuildSystemSnapshot } = await import(
        "../services/solar/buildSystemSnapshot"
      );

      const result = await getOrBuildSystemSnapshot(input.scopeId);

      return {
        systems: result.systems,
        fromCache: result.fromCache,
        inputVersionHash: result.inputVersionHash,
        systemCount: result.systems.length,
        building: result.building,
      };
    }),

  /**
   * Phase 2.5 of the dashboard foundation repair (2026-05-01) —
   * fire-and-forget warmup mutation. The dashboard's mount effect
   * calls this once per page load; the request returns within ~50 ms
   * either way (cache hit OR cache miss + background build kicked
   * off). Tabs read the warmed artifact via `getFoundationArtifact`
   * (the slim view) or via `getOrBuildFoundation` server-side (the
   * full artifact, for tab aggregators).
   *
   * Returns a small status payload — never the full artifact —
   * because the wire-payload contract for warm hits is "did the
   * server already have it?", not "give me the data". Status
   * values:
   *
   *   - `"hit"` — `solarRecComputedArtifacts` already had a row
   *     under the current `inputVersionHash`. Tabs can fetch
   *     immediately.
   *   - `"built"` — cache was empty; this caller's warmup ran the
   *     build inline (typical for the first request after a
   *     deploy or dataset upload).
   *   - `"building"` — another caller (same dyno or another) is
   *     mid-build; tabs that read shortly after will join the
   *     in-flight Promise / poll for the cross-process result.
   *
   * Best-effort: any error here is non-fatal. The client's
   * `useEffect` swallows rejections; tabs that try to read before
   * the warmup completes go through the same single-flight path
   * and either join the in-flight build or run their own.
   */
  warmFoundation: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const {
        getOrBuildFoundation,
        FOUNDATION_RUNNER_VERSION: runnerVersion,
      } = await import("../services/solar/foundationRunner");

      try {
        const result = await getOrBuildFoundation(input.scopeId);
        const status: "hit" | "built" | "building" = result.fromCache
          ? "hit"
          : result.fromInflight
            ? "building"
            : "built";
        return {
          status,
          inputVersionHash: result.inputVersionHash,
          _runnerVersion: runnerVersion,
          _checkpoint: result.inputVersionHash,
        };
      } catch (err) {
        // Don't propagate — warmup is best-effort. Tabs reading
        // afterward will trip the same error and surface it
        // through their own integrity-warnings / error UI.
        console.warn(
          "[warmFoundation] best-effort warmup failed:",
          err instanceof Error ? err.message : err
        );
        return {
          status: "building" as const,
          inputVersionHash: "",
          _runnerVersion: runnerVersion,
          _checkpoint: "",
        };
      }
    }),

  /**
   * Phase 2.3 of the dashboard foundation repair (2026-05-01) —
   * cache-or-compute read path for the canonical dashboard
   * foundation artifact. Returns the SLIM summary view —
   * `summaryCounts`, `integrityWarnings`, `populatedDatasets`,
   * `inputVersions`, and metadata — but NOT
   * `canonicalSystemsByCsgId` (the wide per-system row map can hit
   * 25 MB on the wire on a production-size scope, well above
   * CLAUDE.md's 1 MB hard rule). Phase 4's Core System List has its
   * own paginated procedure for the wide rows; Phase 3 tab
   * aggregators read the full artifact server-side via
   * `getOrBuildFoundation` directly and project just what they need
   * into per-tab responses.
   *
   * Single-flight + cache wiring lives in
   * `server/services/solar/foundationRunner.ts` — see the
   * docstring there for the two-layer protection logic.
   *
   * Phase 2.5 added the parallel `warmFoundation` mutation that
   * fires on dashboard mount; this query is what tabs poll once
   * warmed.
   */
  getFoundationArtifact: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const {
        getOrBuildFoundation,
        FOUNDATION_RUNNER_VERSION: runnerVersion,
        projectFoundationSummary,
      } = await import("../services/solar/foundationRunner");

      const result = await getOrBuildFoundation(input.scopeId);
      const summary = projectFoundationSummary(result.payload);

      return {
        ...summary,
        fromCache: result.fromCache,
        fromInflight: result.fromInflight,
        _runnerVersion: runnerVersion,
        _checkpoint: result.inputVersionHash,
      };
    }),

  /**
   * Task 5.13 PR-1 (2026-04-27) — server-side Delivery Tracker
   * aggregate. Replaces the parent's
   * `useMemo(() => buildDeliveryTrackerData({...}))` over raw
   * `datasets.deliveryScheduleBase.rows` + `datasets.transferHistory.rows`.
   *
   * Cache strategy: synchronous fast-path through
   * `solarRecComputedArtifacts` keyed by SHA-256 of the active batch
   * IDs for the two input datasets. Cache miss recomputes inline (the
   * aggregate is small — sub-second on prod data) and writes back, so
   * subsequent tab activations are O(cache read).
   *
   * Wire payload: pure JSON aggregate; transfers/contracts/rows are
   * pre-bucketed. Even on a portfolio with thousands of obligations the
   * response stays under the 1 MB hard rule (rows are 9 fields each).
   */
  getDashboardDeliveryTrackerAggregates: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildDeliveryTrackerData,
      DELIVERY_TRACKER_RUNNER_VERSION,
    } = await import("../services/solar/buildDeliveryTrackerData");

    const result = await getOrBuildDeliveryTrackerData(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: DELIVERY_TRACKER_RUNNER_VERSION,
    };
  }),

  /**
   * Task 5.13 PR-2 (2026-04-27) — server-side delivery-pace aggregate
   * shared by `AlertsTab` and `TrendsTab`. Replaces the parallel
   * `useMemo(() => buildTrendDeliveryPace(deliveryScheduleBase.rows,
   * transferDeliveryLookup))` calls those two tabs used to make.
   *
   * Output is small (one row per active utility contract — typically
   * tens of rows), so cache hits return sub-KB. Cache key includes a
   * UTC day bucket because `now` participates in active-window
   * detection and the time-elapsed expected-pace calculation.
   */
  getDashboardTrendDeliveryPace: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildTrendDeliveryPace,
      TREND_DELIVERY_PACE_RUNNER_VERSION,
    } = await import("../services/solar/buildTrendDeliveryPace");

    const result = await getOrBuildTrendDeliveryPace(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: TREND_DELIVERY_PACE_RUNNER_VERSION,
    };
  }),

  /**
   * Task 5.13 PR-3 (2026-04-27) — server-side per-(contract,
   * deliveryStartDate) aggregate shared by `ContractsTab` and
   * `AnnualReviewTab`. Replaces the parallel
   * `useMemo(() => contractDeliveryRows / annualContractVintageRows)`
   * passes both tabs used to make over `deliveryScheduleBase.rows`,
   * with the same per-tracking-id Part-2 eligibility filter applied.
   *
   * Output is the union of fields both tabs need
   * (`pricedProjectCount` for ContractsTab, `reportingProjectCount` +
   * `reportingProjectPercent` for AnnualReviewTab), so a single
   * endpoint serves both. Per-tab sort + downstream roll-ups
   * (annualVintageRows, contractSummaryRows, etc.) stay client-side
   * since they don't read raw rows.
   *
   * Cache key bundles abpReport + deliveryScheduleBase + transferHistory
   * batch IDs and the system-snapshot hash, so any input invalidation
   * (new ABP report upload, snapshot refresh, etc.) propagates.
   */
  getDashboardContractVintageAggregates: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildContractVintageAggregates,
      CONTRACT_VINTAGE_RUNNER_VERSION,
    } = await import("../services/solar/buildContractVintageAggregates");

    const result = await getOrBuildContractVintageAggregates(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: CONTRACT_VINTAGE_RUNNER_VERSION,
    };
  }),

  /**
   * Task 5.13 PR-4 (2026-04-27) — server-side production-trend
   * aggregate for the Trends tab. Replaces the parent's two raw-row
   * useMemos (`trendProductionMoM` over `convertedReads.rows` +
   * `trendTopSiteIds` derived from that). With this PR shipped,
   * TrendsTab reads zero `datasets[k].rows` arrays.
   *
   * Result is small (top 10 sites × tens of months ≈ a few hundred
   * cells), so plain JSON cache serde is fine. Cache key bundles
   * the `convertedReads` batch ID — recompute fires only when a
   * new convertedReads dataset lands.
   */
  getDashboardTrendsProduction: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildTrendsProduction,
      TRENDS_PRODUCTION_RUNNER_VERSION,
    } = await import("../services/solar/buildTrendsProduction");

    const result = await getOrBuildTrendsProduction(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: TRENDS_PRODUCTION_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 5d PR 1 (2026-04-29) — server-side aggregator for the
   * Performance Ratio tab. Replaces the client `performanceRatioResult`
   * useMemo that walked `datasets.convertedReads.rows` (the heaviest
   * single dataset on populated scopes — root cause of the 2026-04-29
   * Force-Load 502). Cache key bundles 7 active batch IDs:
   * convertedReads + annualProductionEstimates + generationEntry +
   * accountSolarGeneration + generatorDetails + abpReport +
   * solarApplications. Sub-second recompute once invalidated.
   *
   * Wire payload caps at ~200 KB on populated scopes (one row per
   * matched-system-converted-read pair, dedup'd by the system
   * snapshot's part-2-eligibility filter). The client tab paginates
   * its detail table client-side from the returned rows.
   */
  getDashboardPerformanceRatio: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildPerformanceRatio,
      PERFORMANCE_RATIO_RUNNER_VERSION,
    } = await import("../services/solar/buildPerformanceRatioAggregates");

    const result = await getOrBuildPerformanceRatio(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: PERFORMANCE_RATIO_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 5d PR 2 (2026-04-29) — server-side aggregator for the
   * Forecast tab. Replaces the client `forecastProjections` useMemo
   * that walked `performanceSourceRows` × annualProductionByTrackingId
   * × generationBaselineByTrackingId for every system, projecting
   * remaining RECs in the current energy year via
   * `calculateExpectedWhForRange`.
   *
   * Cache key bundles the active batch IDs for deliveryScheduleBase,
   * transferHistory, annualProductionEstimates, generationEntry,
   * accountSolarGeneration, and abpReport, plus the current energy
   * year label, so May 1 boundary crossings and delivered-history
   * uploads both invalidate the cache. Wire payload is tiny (~7.5 KB
   * on a typical portfolio: ~50 contract rows × 10 numeric fields).
   */
  getDashboardForecast: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildForecastAggregates,
      FORECAST_RUNNER_VERSION,
    } = await import("../services/solar/buildForecastAggregates");

    const result = await getOrBuildForecastAggregates(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: FORECAST_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 5d PR 3 (2026-04-29) — server-side aggregator for the
   * Financials tab. Replaces the parent dashboard's
   * `financialProfitData` useMemo that joins ABP Part-II rows,
   * ABP → CSG mapping, ICC Report 3 values, and latest contract-scan
   * rows to produce the profit/collateralization table.
   *
   * Cache key bundles the 3 active dashboard dataset batch IDs
   * (abpCsgSystemMapping, abpIccReport3Rows, abpReport) plus a
   * contract-scan freshness hash so manual override edits invalidate
   * the cached result even though no dashboard dataset changed.
   * Wire payload is one row per system with financial data and should
   * stay well below the 200 KB target on populated scopes.
   */
  getDashboardFinancials: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildFinancialsAggregates,
      FINANCIALS_RUNNER_VERSION,
    } = await import("../services/solar/buildFinancialsAggregates");

    const result = await getOrBuildFinancialsAggregates(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: FINANCIALS_RUNNER_VERSION,
    };
  }),

  /**
   * PR #332 follow-up item 8 (2026-05-02) — slim, cache-only KPI
   * summary for the 4 Overview financial tiles
   * (totalProfit / totalUtilityCollateral /
   * totalAdditionalCollateral / totalCcAuth) plus `systemsWithData`
   * for the subtitle. Wire payload is < 200 bytes.
   *
   * NEVER triggers a row materialization. The heavy
   * `getDashboardFinancials` populates a side cache after it runs;
   * this proc only READS that side cache. When the side cache is
   * cold, returns `{ available: false }` and the client renders the
   * 4 tiles as "N/A" placeholders. Overview mount stops invoking
   * the row-materializing financial aggregate as a result.
   */
  getDashboardFinancialKpiSummary: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getCachedFinancialsKpiSummary,
      FINANCIALS_KPI_SUMMARY_RUNNER_VERSION,
    } = await import("../services/solar/buildFinancialsAggregates");

    const summary = await getCachedFinancialsKpiSummary(ctx.scopeId);

    return {
      ...summary,
      _runnerVersion: FINANCIALS_KPI_SUMMARY_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 5e Followup #4 step 4 PR-C3 (2026-04-30) — server-side
   * aggregator for the Change of Ownership tab + Overview tab's
   * stacked-chart row. Replaces 3 client memos that walked
   * `part2VerifiedAbpRows × systems`:
   * `changeOwnershipRows` (~140 LOC), `changeOwnershipSummary`,
   * `cooNotTransferredNotReportingCurrentCount`, plus
   * `ownershipStackedChartRows` over in OverviewTab.
   *
   * Cache key bundles `abpReport` batch + system snapshot hash.
   * superjson serde because `rows[i].{contractedDate,
   * zillowSoldDate, latestReportingDate}` are `Date | null`.
   */
  getDashboardChangeOwnership: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildChangeOwnership,
      CHANGE_OWNERSHIP_RUNNER_VERSION,
    } = await import(
      "../services/solar/buildChangeOwnershipAggregates"
    );

    const { result, fromCache } = await getOrBuildChangeOwnership(
      ctx.scopeId
    );

    return {
      ...result,
      fromCache,
      _runnerVersion: CHANGE_OWNERSHIP_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 5e Followup #4 step 4 PR-C2 (2026-04-30) — server-side
   * aggregator for the Overview tab `summary` shape. Replaces the
   * 208-line `summary` useMemo in `SolarRecDashboard.tsx` that
   * walked `part2VerifiedAbpRows × systems`. Returns the full
   * shape including `ownershipRows` (used for CSV export).
   *
   * Cache key bundles `abpReport` batch + system snapshot hash.
   * superjson serde because `ownershipRows[i].{latestReportingDate,
   * contractedDate, zillowSoldDate}` are `Date | null`.
   */
  getDashboardOverviewSummary: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildOverviewSummary,
      OVERVIEW_SUMMARY_RUNNER_VERSION,
    } = await import(
      "../services/solar/buildOverviewSummaryAggregates"
    );

    const { result, fromCache } = await getOrBuildOverviewSummary(
      ctx.scopeId
    );

    return {
      ...result,
      fromCache,
      _runnerVersion: OVERVIEW_SUMMARY_RUNNER_VERSION,
    };
  }),

  /**
   * Slim mount summary. Headline counts, ownership tile breakdown,
   * size buckets, totalContractAmount-based value totals, ABP
   * counts. NO per-system arrays or maps; does NOT call the heavy
   * overview/offline-monitoring aggregators. The dashboard parent
   * uses this for first-paint so the heavy procedures stop firing
   * on initial mount.
   */
  getDashboardSummary: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildSlimDashboardSummary,
      SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION,
    } = await import("../services/solar/buildSlimDashboardSummary");

    const { result, fromCache } = await getOrBuildSlimDashboardSummary(
      ctx.scopeId
    );

    return {
      ...result,
      fromCache,
      _runnerVersion: SLIM_DASHBOARD_SUMMARY_RUNNER_VERSION,
    };
  }),

  /**
   * Background CSV export — start. Replaces the synchronous
   * `exportOwnershipTileCsv` / `exportChangeOwnershipTileCsv` queries
   * that returned MB-scale CSV strings inline through tRPC (and were
   * allowlisted on `DASHBOARD_OVERSIZE_ALLOWLIST`).
   *
   * The mutation enqueues a job and returns immediately with
   * `{ jobId }` — the response is bounded (< 200 bytes). The worker
   * loads the heavy aggregator artifact or raw row-table dataset,
   * builds the CSV, writes it to storage via `storagePut`, and
   * surfaces a download URL on the job record. The client polls
   * `getDashboardCsvExportJobStatus({ jobId })` to a terminal status
   * and downloads the artifact directly from the URL.
   *
   * INVARIANT (PR #332 follow-up, 2026-05-02 — preserved): the
   * client CSV-click handler must NOT flip
   * `hasUserInteractedWithDashboard`. The export work is fully
   * server-side; letting the click seed the interaction gate would
   * silently enable the heavy mount-tier queries
   * (`getDashboardOverviewSummary` / `getDashboardOfflineMonitoring`
   * / `getDashboardChangeOwnership`) on the next render, dragging
   * multi-MB JSON payloads into the browser as a side-effect of an
   * export click.
   *
   * TRANSITIONAL — the v1 worker still builds the CSV string in
   * memory before the storage write. True row-streaming directly to
   * storage is the next hardening step. The improvement vs. the
   * prior synchronous procs is scoped: the MB-scale CSV no longer
   * passes through the tRPC response path, which restores the
   * dashboard response budget for these endpoints. See
   * `services/solar/dashboardCsvExportJobs.ts` for the registry
   * + scope-isolation + TTL details.
   */
  startDashboardCsvExport: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(
      z.discriminatedUnion("exportType", [
        z.object({
          exportType: z.literal("ownershipTile"),
          tile: z.enum(["reporting", "notReporting", "terminated"]),
        }),
        z.object({
          exportType: z.literal("changeOwnershipTile"),
          // Accept the wider client-side `ChangeOwnershipStatus`
          // union (7 values incl. legacy split-Terminated) so the
          // client handler doesn't need to narrow at the call site.
          // The heavy aggregator's rows only carry the 5 canonical
          // values; a legacy split-Terminated input resolves to
          // rowCount=0 on the worker and surfaces to the user as
          // "no projects match."
          status: z.enum([
            "Transferred and Reporting",
            "Transferred and Not Reporting",
            "Terminated",
            "Terminated and Reporting",
            "Terminated and Not Reporting",
            "Change of Ownership - Not Transferred and Reporting",
            "Change of Ownership - Not Transferred and Not Reporting",
          ]),
        }),
        z.object({
          exportType: z.literal("datasetCsv"),
          datasetKey: z.enum(DASHBOARD_DATASET_CSV_EXPORT_KEYS),
        }),
        z.object({
          exportType: z.literal("deliveryTrackerDetailCsv"),
        }),
        z.object({
          exportType: z.literal("deliveryTrackerUnmatchedTransfersCsv"),
        }),
      ])
    )
    .mutation(async ({ ctx, input }) => {
      const { startCsvExportJob, DASHBOARD_CSV_EXPORT_RUNNER_VERSION } =
        await import("../services/solar/dashboardCsvExportJobs");
      // Phase 6 PR-B: `startCsvExportJob` is now async (DB-backed
      // INSERT replaces the in-memory `Map.set` — see
      // `dashboardCsvExportJobs.ts` runner-version marker).
      const { jobId } = await startCsvExportJob(ctx.scopeId, input);
      return {
        jobId,
        _runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
      };
    }),

  /**
   * Background CSV export — status poll. Slim response (< 1 KB)
   * regardless of artifact size. Returns the registry snapshot for
   * the supplied jobId, scoped to the caller's scopeId — a
   * cross-scope jobId reads as "not found" (`status: "notFound"`)
   * rather than a permission error so cross-scope job IDs can't be
   * probed.
   *
   * Terminal states the client polls for:
   *   - `succeeded` with `url` + `fileName` + `rowCount > 0` —
   *     navigate the browser to `url` to download.
   *   - `succeeded` with `rowCount === 0` and `url === null` — show
   *     a "no rows match" toast; no download.
   *   - `failed` with `error` — surface the error to the user.
   *   - `notFound` — the job expired (TTL) or never existed for
   *     this scope.
   */
  getDashboardCsvExportJobStatus: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(z.object({ jobId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const { getCsvExportJobStatus, DASHBOARD_CSV_EXPORT_RUNNER_VERSION } =
        await import("../services/solar/dashboardCsvExportJobs");
      // Phase 6 PR-B: `getCsvExportJobStatus` is now async (DB
      // SELECT replaces in-memory `Map.get`). Also: `notFound`
      // genuinely means the row was pruned (TTL elapsed) or never
      // existed for this scope — the in-memory-restart workaround
      // from PR #352 is no longer needed because the DB-backed
      // registry survives process restarts.
      const snapshot = await getCsvExportJobStatus(ctx.scopeId, input.jobId);
      if (!snapshot) {
        return {
          status: "notFound" as const,
          _runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
        };
      }
      return {
        ...snapshot,
        _runnerVersion: DASHBOARD_CSV_EXPORT_RUNNER_VERSION,
      };
    }),

  /**
   * Phase 2 PR-B (OOM-rebuild keystone) — start a per-scope build
   * of the dashboard fact tables. Returns a `buildId` immediately;
   * the runner is scheduled fire-and-forget via `setImmediate` so
   * the mutation returns fast.
   *
   * **PR-B status**: the runner is wired but the steps array is
   * empty. A successful build today claims, runs zero steps, and
   * completes immediately — the contract is exercised end-to-end
   * but no derived rows are produced. PR-C+ will plug in
   * fact-builders one at a time. The `inputVersionsJson` field
   * captures source-batch IDs at build time; PR-B sends an empty
   * object, PR-C+ will populate it with the active dataset
   * batches.
   *
   * Cross-process safety + DB-backed registry — same pattern as
   * `startDashboardCsvExport` (Phase 6 PR-B).
   */
  startDashboardBuild: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).mutation(async ({ ctx }) => {
    const { startDashboardBuild } = await import(
      "../services/solar/dashboardBuildJobs"
    );
    const { DASHBOARD_BUILD_RUNNER_VERSION } = await import(
      "../services/solar/dashboardBuildJobRunner"
    );
    const { buildId } = await startDashboardBuild(
      ctx.scopeId,
      ctx.userId ?? null
    );
    return {
      buildId,
      _runnerVersion: DASHBOARD_BUILD_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 2 PR-B — build status poll. Slim response (< 1 KB).
   * Cross-scope `buildId` reads as `notFound` (no leak).
   *
   * Terminal states the client polls for:
   *   - `succeeded` — derived rows are ready; subsequent reads
   *     hit them via the paginated detail-page procs PR-C+ will
   *     add.
   *   - `failed` with `errorMessage` — surface to the user; the
   *     existing aggregator procs continue to work as a fallback.
   *   - `notFound` — pruned (TTL elapsed) or never existed for
   *     this scope.
   */
  getDashboardBuildStatus: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(z.object({ buildId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const { getDashboardBuildStatus } = await import(
        "../services/solar/dashboardBuildJobs"
      );
      const { DASHBOARD_BUILD_RUNNER_VERSION } = await import(
        "../services/solar/dashboardBuildJobRunner"
      );
      const snapshot = await getDashboardBuildStatus(
        ctx.scopeId,
        input.buildId
      );
      return {
        ...snapshot,
        _runnerVersion: DASHBOARD_BUILD_RUNNER_VERSION,
      };
    }),

  /**
   * Snapshot-log read/recovery surface — READ-ONLY.
   *
   * Background. The Snapshot Log feature historically persisted to
   * both browser localStorage (`solarRecDashboardLogsV1`) and
   * cloud (`solarRecDashboardStorage` rows under
   * `storageKey = "snapshot_logs_v1"`). Phase 5 cleanup removed the
   * cloud-fallback hydration path, so the UI currently reads ONLY
   * localStorage. In production the main cloud row holds a single-
   * entry JSON array, but orphaned chunk rows
   * (`storageKey LIKE "snapshot_logs_v1_chunk_%"`) from a prior
   * chunked write still exist and contain ~21 unique historical
   * snapshot entries.
   *
   * This procedure surfaces what's recoverable from the cloud side
   * so the client can hydrate Snapshot Log from the larger of
   * (localStorage, server) instead of clobbering the server with a
   * single-entry local copy. It performs zero writes / zero
   * deletes — production-data restore/write-back is a separate,
   * explicitly-approved follow-up.
   *
   * Pagination: `limit` defaults to 50 (matches the dashboard's
   * normal-UI page size); `cursorCreatedAt` is the `createdAt` of
   * the last entry in the prior page (newer-first ordering, so
   * "next page" returns entries strictly OLDER than the cursor).
   */
  getSnapshotLogs: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).default(50),
        cursorCreatedAt: z.string().min(1).max(64).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getSolarRecDashboardPayload, listSolarRecDashboardStorageByPrefix } =
        await import("../db/preferences");
      const {
        composeSnapshotLogRecovery,
        paginateSnapshotLogRecovery,
        SNAPSHOT_LOG_RECOVERY_RUNNER_VERSION,
      } = await import("../services/solar/snapshotLogRecovery");
      const SNAPSHOT_LOG_KEY = "snapshot_logs_v1";
      const SNAPSHOT_LOG_CHUNK_PREFIX = "snapshot_logs_v1_chunk_";

      const [mainPayload, orphanRows] = await Promise.all([
        getSolarRecDashboardPayload(ctx.userId, SNAPSHOT_LOG_KEY),
        listSolarRecDashboardStorageByPrefix(
          ctx.userId,
          SNAPSHOT_LOG_CHUNK_PREFIX,
          { maxRows: 256 }
        ),
      ]);

      const recovery = composeSnapshotLogRecovery({
        mainPayload,
        orphanRows,
      });

      const page = paginateSnapshotLogRecovery(recovery, {
        limit: input.limit,
        cursorCreatedAt: input.cursorCreatedAt,
      });

      return {
        source: recovery.source,
        entries: page.entries,
        nextCursorCreatedAt: page.nextCursorCreatedAt,
        // `entries.length` is the canonical "how many unique
        // entries did we recover" — clients should read it
        // directly. `rawEntryCount` and `duplicateCount` are
        // diagnostics for the recovery audit.
        rawEntryCount: recovery.rawEntryCount,
        duplicateCount: recovery.duplicateCount,
        newestCreatedAt: recovery.newestCreatedAt,
        oldestCreatedAt: recovery.oldestCreatedAt,
        mainPayloadEntries: recovery.mainPayloadEntries,
        orphanedChunkEntries: recovery.orphanedChunkEntries,
        warnings: recovery.warnings,
        _runnerVersion: SNAPSHOT_LOG_RECOVERY_RUNNER_VERSION,
      };
    }),

  /**
   * Phase 5e Followup #4 step 4 PR-A (2026-04-30) — server-side
   * aggregator for the Offline Monitoring tab. Replaces four client
   * useMemos in `SolarRecDashboard.tsx` that derived from
   * `datasets.abpReport.rows` + `datasets.solarApplications.rows`:
   * `abpEligibleTrackingIdsStrict`, `abpApplicationIdBySystemKey`,
   * `monitoringDetailsBySystemKey`, and the 3 ID Sets that drive
   * `part2EligibleSystemsForSizeReporting`.
   *
   * `abpEligibleTrackingIdsStrict` and the inner
   * `eligiblePart2TrackingIds` set were byte-identical at the
   * source — this aggregator computes them once.
   *
   * Cache key bundles 2 dataset batch IDs (abpReport,
   * solarApplications). Plain JSON serde — output is all strings
   * and string-keyed records.
   */
  getDashboardOfflineMonitoring: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildOfflineMonitoringAggregates,
      OFFLINE_MONITORING_RUNNER_VERSION,
    } = await import(
      "../services/solar/buildOfflineMonitoringAggregates"
    );

    const { result, fromCache } =
      await getOrBuildOfflineMonitoringAggregates(ctx.scopeId);

    return {
      ...result,
      fromCache,
      _runnerVersion: OFFLINE_MONITORING_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 2 PR-C-3-a (OOM rebuild) — paginated read for the
   * monitoringDetails fact table written by the build runner
   * (PR-C-2's `monitoringDetailsBuildStep`). This is the eventual
   * REPLACEMENT for the per-system `monitoringDetailsBySystemKey`
   * map shape that `getDashboardOfflineMonitoring` ships today
   * (the largest of the four per-system maps that proc returns,
   * keyed by ~21k systems on prod).
   *
   * Returns one page of fact rows ordered by `systemKey` (ASC) so
   * the cursor is stable across requests. Caller paginates by
   * passing the response's `nextCursor` back as the next
   * request's `cursorAfter`. `nextCursor === null` means the last
   * page has been reached.
   *
   * Wire payload: bounded to 1000 rows × ~20 columns × free-form
   * text. Worst case ≈ 250 KB at limit=1000; default limit=200
   * gives ~50-80 KB per page on real data, well under the 1 MB
   * dashboard response budget.
   *
   * **Until the OfflineMonitoringTab migrates onto this** (PR-C-3-b
   * or follow-up), the table will be EMPTY for any scope that
   * hasn't had a build run via `startDashboardBuild`. That's a
   * deliberate transitional state — the read proc returns an
   * empty page rather than synthesizing facts on demand. Building
   * is the explicit "rebuild" action the operator initiates.
   *
   * Cache key: none. The fact table is the cache. Subsequent
   * builds replace rows via the UPSERT-then-orphan-sweep pattern
   * (PR-C-2's orchestration). Reads are sub-second per page given
   * the composite-PK index on `(scopeId, systemKey)`.
   */
  getDashboardMonitoringDetailsPage: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(
      z.object({
        cursorAfter: z.string().min(1).max(128).nullable().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getMonitoringDetailsFactsPage } = await import(
        "../db/dashboardMonitoringDetailsFacts"
      );
      const rows = await getMonitoringDetailsFactsPage(ctx.scopeId, {
        cursorAfter: input.cursorAfter ?? null,
        limit: input.limit,
      });
      const nextCursor =
        rows.length === input.limit
          ? rows[rows.length - 1]?.systemKey ?? null
          : null;
      return {
        _checkpoint: "monitoring-details-page-v1",
        _runnerVersion: "phase-2-pr-c-3-a@1" as const,
        rows,
        nextCursor,
        hasMore: nextCursor !== null,
      };
    }),

  /**
   * Phase 2 PR-D-3 (OOM rebuild) — paginated read for the
   * changeOwnership fact table written by the build runner
   * (PR-D-2's `changeOwnershipBuildStep`). The eventual
   * REPLACEMENT for the per-row `ChangeOwnershipExportRow[]`
   * payload that `getDashboardChangeOwnership` ships today
   * (~19 MB on prod, the largest of the three remaining oversize-
   * allowlist entries).
   *
   * Returns one page of fact rows ordered by `systemKey` (ASC).
   * Caller paginates by passing the response's `nextCursor` back
   * as the next request's `cursorAfter`. `nextCursor === null`
   * signals end-of-stream.
   *
   * **Status filter axis.** The ChangeOwnershipTab's primary
   * control is "show me X status" (Transferred and Reporting,
   * Terminated, etc). The optional `status` input narrows the
   * server-side query via the covering index `(scopeId,
   * changeOwnershipStatus)` PR-D-1 added — making status-filtered
   * reads efficient without paginating the full table client-
   * side. When omitted, all rows for the scope are returned.
   *
   * Wire payload: bounded to 1000 rows × ~22 columns (~150-200
   * KB at limit=1000); default limit=200 gives ~30-40 KB per
   * page on real data, well under the 1 MB dashboard response
   * budget.
   *
   * Empty-table behavior: until the ChangeOwnershipTab migrates
   * onto this proc, the table is EMPTY for any scope that
   * hasn't had a build run via `startDashboardBuild`. The proc
   * returns an empty page rather than synthesizing facts on
   * demand — building is the explicit "rebuild" action the
   * operator initiates.
   */
  getDashboardChangeOwnershipPage: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(
      z.object({
        cursorAfter: z.string().min(1).max(128).nullable().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
        // Match the wider ChangeOwnershipStatus union shipped by
        // the existing `startDashboardCsvExport` proc — same 7
        // values incl. legacy split-Terminated. The DB filter is
        // an exact-match `WHERE changeOwnershipStatus = ?`, so a
        // value the builder doesn't write resolves to an empty
        // page (consistent with "no projects match" UX).
        status: z
          .enum([
            "Transferred and Reporting",
            "Transferred and Not Reporting",
            "Terminated",
            "Terminated and Reporting",
            "Terminated and Not Reporting",
            "Change of Ownership - Not Transferred and Reporting",
            "Change of Ownership - Not Transferred and Not Reporting",
          ])
          .nullable()
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getChangeOwnershipFactsPage } = await import(
        "../db/dashboardChangeOwnershipFacts"
      );
      const rows = await getChangeOwnershipFactsPage(ctx.scopeId, {
        cursorAfter: input.cursorAfter ?? null,
        limit: input.limit,
        status: input.status ?? null,
      });
      const nextCursor =
        rows.length === input.limit
          ? rows[rows.length - 1]?.systemKey ?? null
          : null;
      return {
        _checkpoint: "change-ownership-page-v1",
        _runnerVersion: "phase-2-pr-d-3@1" as const,
        rows,
        nextCursor,
        hasMore: nextCursor !== null,
      };
    }),

  /**
   * Phase 2 PR-E-3 (OOM rebuild) — paginated read for the
   * ownership fact table written by the build runner (PR-E-2's
   * `ownershipBuildStep`). The eventual REPLACEMENT for the
   * per-row `ownershipRows: OwnershipOverviewExportRow[]` payload
   * embedded in `getDashboardOverviewSummary` (~5–15 MB on prod;
   * one of the three remaining heavy entries on
   * `DASHBOARD_OVERSIZE_ALLOWLIST`).
   *
   * Returns one page of fact rows ordered by `systemKey` (ASC).
   * Caller paginates by passing the response's `nextCursor` back
   * as the next request's `cursorAfter`. `nextCursor === null`
   * signals end-of-stream.
   *
   * **Two filter axes — independent and combinable.**
   *   - `status` — the OverviewTab's primary control (Transferred
   *     and Reporting / Not Reporting / Not Transferred and …
   *     Terminated and …). 6-value enum matching
   *     `OwnershipStatus` from
   *     `server/services/solar/buildOverviewSummaryAggregates.ts`.
   *     Backed by the covering index `(scopeId, ownershipStatus)`
   *     PR-E-1 added.
   *   - `source` — the Matched System vs Part II Unmatched toggle.
   *     2-value enum. Backed by the covering index `(scopeId,
   *     source)` PR-E-1 added.
   *
   * Combining both filters falls back to one of the two indexes +
   * a post-index filter on the other column. The DB helper
   * (`getOwnershipFactsPage`) handles the AND composition. A
   * filter value the builder doesn't write resolves to an empty
   * page (consistent with "no projects match" UX).
   *
   * Wire payload: bounded to 1000 rows × ~24 columns (~150-200 KB
   * at limit=1000); default limit=200 gives ~30-40 KB per page on
   * real data, well under the 1 MB dashboard response budget.
   *
   * Empty-table behavior: until the OverviewTab migrates onto
   * this proc, the table is EMPTY for any scope that hasn't had
   * a build run via `startDashboardBuild`. The proc returns an
   * empty page rather than synthesizing facts on demand —
   * building is the explicit "rebuild" action the operator
   * initiates.
   */
  getDashboardOwnershipPage: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(
      z.object({
        cursorAfter: z.string().min(1).max(128).nullable().optional(),
        limit: z.number().int().min(1).max(1000).default(200),
        // Match the 6-value `OwnershipStatus` union exactly. The DB
        // filter is an exact-match `WHERE ownershipStatus = ?`, so
        // a value the builder doesn't write resolves to an empty
        // page.
        status: z
          .enum([
            "Transferred and Reporting",
            "Transferred and Not Reporting",
            "Not Transferred and Reporting",
            "Not Transferred and Not Reporting",
            "Terminated and Reporting",
            "Terminated and Not Reporting",
          ])
          .nullable()
          .optional(),
        // Discriminator: matched-system rows came from the system
        // snapshot ⨝ Part II report; unmatched rows came from the
        // Part II report alone. Two values; storing as varchar in
        // the schema means a future "third source" is a code-only
        // PR — this enum mirrors today's contract.
        source: z
          .enum(["Matched System", "Part II Unmatched"])
          .nullable()
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getOwnershipFactsPage } = await import(
        "../db/dashboardOwnershipFacts"
      );
      const rows = await getOwnershipFactsPage(ctx.scopeId, {
        cursorAfter: input.cursorAfter ?? null,
        limit: input.limit,
        status: input.status ?? null,
        source: input.source ?? null,
      });
      const nextCursor =
        rows.length === input.limit
          ? rows[rows.length - 1]?.systemKey ?? null
          : null;
      return {
        _checkpoint: "ownership-page-v1",
        _runnerVersion: "phase-2-pr-e-3@1" as const,
        rows,
        nextCursor,
        hasMore: nextCursor !== null,
      };
    }),

  /**
   * Phase 5e PR (2026-04-29) — server-side aggregator for the
   * `performanceSourceRows` shape consumed by RecPerformanceEvaluation
   * Tab + Snapshot Log + the parent's `recPerformanceSnapshotContracts
   * 2025` + createLogEntry. Replaces the parent useMemo at
   * `client/src/features/solar-rec/SolarRecDashboard.tsx :: performance
   * SourceRows` that walked `datasets.deliveryScheduleBase.rows` ×
   * eligibleTrackingIds × systemsByTrackingId × transferDeliveryLookup
   * to produce one row per (trackingId, scheduleRowIndex) pair with
   * required + transfer-history-derived delivered values per Schedule
   * year.
   *
   * Cache key bundles 4 inputs: abpReport batch, deliveryScheduleBase
   * batch, transferHistory batch, system snapshot hash. superjson
   * serde because each row's `years[i].{startDate, endDate}` are
   * `Date | null` and need to round-trip cleanly.
   *
   * Tab gating happens client-side: the query is `enabled: is
   * PerformanceEvalTabActive` so the cache only warms when the user
   * is on the perf-eval / snapshot-log tab.
   *
   * Sets up the unblock for Salvage PR C (#273)'s next phase: once
   * `performanceSourceRows` is fully server-driven, ScheduleBImport's
   * auto-apply hybrid can drop its `onApply(rows)` client-state side
   * effect.
   */
  getDashboardPerformanceSourceRows: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildPerformanceSourceRows,
      PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION,
    } = await import("../services/solar/buildPerformanceSourceRows");

    const result = await getOrBuildPerformanceSourceRows(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: PERFORMANCE_SOURCE_ROWS_RUNNER_VERSION,
    };
  }),

  /**
   * Task 5.14 PR-4 (2026-04-27) — server-side reconciliation between
   * `srDsDeliverySchedule.trackingSystemRefId` (or `systemId` fallback)
   * and `srDsConvertedReads.monitoringSystemId`. Replaces the
   * DataQualityTab's `dataQualityUnmatched` useMemo that walked
   * `datasets.deliveryScheduleBase.rows` + `datasets.convertedReads.rows`
   * to compute the same set difference.
   *
   * Cache key bundles both dataset batch IDs; sub-second recompute
   * once invalidated. The match-rate scalar + the two mismatch
   * lists (capped at 10 000 each for wire-payload safety) are
   * everything the tab's reconciliation card needs.
   */
  getDashboardDataQualityReconciliation: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildDataQualityReconciliation,
      DATA_QUALITY_RECONCILIATION_RUNNER_VERSION,
    } = await import("../services/solar/buildDataQualityReconciliation");

    const result = await getOrBuildDataQualityReconciliation(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: DATA_QUALITY_RECONCILIATION_RUNNER_VERSION,
    };
  }),

  /**
   * Phase 5e Followup #4 step 2 (2026-04-29) — server-side
   * implementation of the SystemDetailSheet's "Recent Meter Reads"
   * table. Replaces the client-side filter that walked
   * `datasets.convertedReads.rows` (50–150 MB on populated scopes)
   * just to render up to 20 rows for one selected system.
   *
   * Input shape mirrors the prior client filter (systemId OR
   * systemName match). Caller passes both fields off the
   * SystemRecord; either may be empty.
   *
   * Result is small (~20 rows × 3 fields ≈ 1 KB) so no artifact
   * cache — the underlying SELECT hits the
   * `(scopeId, monitoringSystemId, readDate)` index and returns
   * sub-millisecond on prod scale. `_runnerVersion` is bumped on
   * matcher-shape or sort-order changes.
   */
  getSystemRecentMeterReads: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        systemId: z.string().nullable(),
        systemName: z.string(),
        limit: z.number().int().min(1).max(200).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getSystemRecentMeterReads } = await import(
        "../db/systemMeterReads"
      );
      const result = await getSystemRecentMeterReads(
        ctx.scopeId,
        { systemId: input.systemId, systemName: input.systemName },
        { limit: input.limit }
      );
      return {
        ...result,
        _runnerVersion: "phase-5e-followup-4-systemrecentmeterreads@1",
      };
    }),

  /**
   * Task 5.13 PR-5 (2026-04-27) — server-side Application Pipeline
   * monthly aggregate. Replaces the parent's `pipelineMonthlyRows`
   * useMemo over `abpReport.rows` + `generatorDetails.rows` (with
   * `installedKwAc` fallback from the system snapshot).
   *
   * Returns one row per active month (~36–60 rows on prod data) with
   * Part 1 / Part 2 / Interconnected counts + AC kW + prior-year
   * comparison fields.
   */
  getDashboardAppPipelineMonthly: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  ).query(async ({ ctx }) => {
    const {
      getOrBuildAppPipelineMonthly,
      APP_PIPELINE_MONTHLY_RUNNER_VERSION,
    } = await import("../services/solar/buildAppPipelineMonthly");

    const result = await getOrBuildAppPipelineMonthly(ctx.scopeId);

    return {
      ...result,
      _runnerVersion: APP_PIPELINE_MONTHLY_RUNNER_VERSION,
    };
  }),

  /**
   * Task 5.13 PR-5 (2026-04-27) — server-side Application Pipeline
   * cash-flow aggregate. Replaces the parent's `pipelineCashFlowRows`
   * useMemo over `part2VerifiedAbpRows` + `abpCsgSystemMapping.rows`
   * + `abpIccReport3Rows.rows` + cached contract scan results.
   *
   * Per-csgId vendor-fee % and additional-collateral % overrides
   * come in as `input.overrides` because they're user-editable
   * Financials-tab state that's not persisted server-side. The
   * cache key bundles a stable hash of the override map so cache
   * misses fire only when the user actually changes an override.
   */
  getDashboardAppPipelineCashFlow: dashboardProcedure(
    "solar-rec-dashboard",
    "read"
  )
    .input(
      z.object({
        overrides: z
          .record(
            z.string(),
            z.object({
              vfp: z.number(),
              acp: z.number(),
            })
          )
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const {
        getOrBuildAppPipelineCashFlow,
        APP_PIPELINE_CASH_FLOW_RUNNER_VERSION,
      } = await import("../services/solar/buildAppPipelineCashFlow");

      const result = await getOrBuildAppPipelineCashFlow(
        ctx.scopeId,
        input.overrides ?? {}
      );

      return {
        ...result,
        _runnerVersion: APP_PIPELINE_CASH_FLOW_RUNNER_VERSION,
      };
    }),

  /**
   * Per-dataset summary metadata for ALL 18 datasets in a single
   * roundtrip. Replaces the browser's pattern of holding raw rows in
   * memory just to read `.length` on the Data Quality tab.
   *
   * Response is small (one row per dataset, ~16 fields each -> ~5 KB
   * gzipped) and cheap to compute (one batch sync-state read + one
   * batch active-version read). The active import batch's recorded
   * `rowCount` is the default-mount source of truth; exact row-table
   * verification belongs to `debugDatasetPersistenceRaw`.
   *
   * Per-dataset shape:
   *   - `rowCount`: recorded row count from the active import batch
   *     (row-backed datasets only). For non-row-backed datasets,
   *     `null`.
   *   - `byteCount`: bytes of the chunked-CSV payload, from
   *     `solarRecDatasetSyncState.payloadBytes`.
   *   - `lastUpdated`: from sync state, or the active batch's
   *     `completedAt` / `createdAt`.
   *   - `cloudStatus`: same semantics as `getDatasetCloudStatuses`
   *     (`synced` | `failed` | `missing`) but derived inline from
   *     the same DB read so callers don't have to issue both
   *     queries.
   */
  getDatasetSummariesAll: dashboardProcedure("solar-rec-dashboard", "read")
    .query(async ({ ctx }) => {
      void ctx;
      const { resolveSolarRecScopeId } = await import("./solarRecAuth");
      const { getSolarRecDatasetSyncStates } = await import("../db");

      const ROW_TABLES_BY_DATASET_KEY = {
        solarApplications: srDsSolarApplications,
        abpReport: srDsAbpReport,
        generationEntry: srDsGenerationEntry,
        accountSolarGeneration: srDsAccountSolarGeneration,
        annualProductionEstimates: srDsAnnualProductionEstimates,
        abpIccReport2Rows: srDsAbpIccReport2Rows,
        abpIccReport3Rows: srDsAbpIccReport3Rows,
        contractedDate: srDsContractedDate,
        convertedReads: srDsConvertedReads,
        deliveryScheduleBase: srDsDeliverySchedule,
        transferHistory: srDsTransferHistory,
        generatorDetails: srDsGeneratorDetails,
        abpCsgSystemMapping: srDsAbpCsgSystemMapping,
        abpProjectApplicationRows: srDsAbpProjectApplicationRows,
        abpPortalInvoiceMapRows: srDsAbpPortalInvoiceMapRows,
        abpCsgPortalDatabaseRows: srDsAbpCsgPortalDatabaseRows,
        abpQuickBooksRows: srDsAbpQuickBooksRows,
        abpUtilityInvoiceRows: srDsAbpUtilityInvoiceRows,
      } as const;

      // Source of truth for which dataset keys exist. Kept in sync
      // with client `DATASET_DEFINITIONS` via the migration test
      // (added in PR-8).
      const ALL_DATASET_KEYS = [
        // ALL 18 datasets are now row-backed. Task 5.12 PR-10
        // (2026-04-27) shipped `convertedReads` as the final
        // migration; the chunked-CSV path remains active because
        // the monitoring bridge still writes to it, but all dataset
        // summaries, paginations, and CSV exports flow through
        // `srDs*` row tables.
        "solarApplications",
        "abpReport",
        "generationEntry",
        "accountSolarGeneration",
        "annualProductionEstimates",
        "contractedDate",
        "deliveryScheduleBase",
        "transferHistory",
        "generatorDetails",
        "abpCsgSystemMapping",
        "abpProjectApplicationRows",
        "abpPortalInvoiceMapRows",
        "abpCsgPortalDatabaseRows",
        // PR-6 also fixed an existing typo: this entry was previously
        // `"abpQuickbooksRows"` (lowercase b) which never matched the
        // canonical key `abpQuickBooksRows` used in DATASET_DEFINITIONS,
        // so the dataset was always reported as missing in the
        // summaries response. Verified canonical spelling is the
        // capital-B form across `state/types.ts`, `financialsVersion.ts`,
        // `EarlyPayment.tsx`, and `AbpInvoiceSettlement.tsx`.
        "abpQuickBooksRows",
        "abpUtilityInvoiceRows",
        "abpIccReport2Rows",
        "abpIccReport3Rows",
        "convertedReads",
      ] as const;

      const scopeId = await resolveSolarRecScopeId();
      const ownerUserId = await resolveSolarRecOwnerUserId();
      const db = await getDb();

      // Batch read sync states for every dataset key (one DB query).
      const dbStorageKeys = ALL_DATASET_KEYS.map((k) => `dataset:${k}`);
      const syncStates = await getSolarRecDatasetSyncStates(
        ownerUserId,
        dbStorageKeys
      );
      const syncByKey = new Map(syncStates.map((s) => [s.storageKey, s]));

      // Batch read active versions for the row-backed datasets only.
      // Skipped for non-row-backed since they don't have batches.
      type ActiveVersion = {
        datasetKey: string;
        batchId: string;
        rowCount: number | null;
        completedAt: Date | null;
        createdAt: Date;
        // Latest v2-upload metadata for the active batch. Null when
        // the batch was created via the legacy chunked-CSV path (v1)
        // since that path doesn't write `datasetUploadJobs` rows.
        // Surfaced so the dashboard can show file name + upload time
        // in the slot card after a reload — Phase 5e dropped the IDB
        // local-state hydration that previously held this metadata
        // on the client, but the server has it for v2 uploads.
        uploadFileName: string | null;
        uploadCompletedAt: Date | null;
      };
      type UploadSourceSummary = {
        jobId: string;
        fileName: string;
        uploadedAt: string | null;
        rowCount: number | null;
      };

      const activeVersions = new Map<string, ActiveVersion>();
      const uploadSourcesByDataset = new Map<string, UploadSourceSummary[]>();
      if (db) {
        const rows = await db
          .select({
            datasetKey: solarRecActiveDatasetVersions.datasetKey,
            batchId: solarRecActiveDatasetVersions.batchId,
            rowCount: solarRecImportBatches.rowCount,
            completedAt: solarRecImportBatches.completedAt,
            createdAt: solarRecImportBatches.createdAt,
            // The v2 upload runner sets `datasetUploadJobs.batchId`
            // after assembly; that value matches
            // `solarRecActiveDatasetVersions.batchId` 1:1 for v2
            // uploads. For v1 (legacy chunked-CSV) batches there is
            // no matching job row, so this LEFT JOIN yields null.
            uploadFileName: datasetUploadJobs.fileName,
            uploadCompletedAt: datasetUploadJobs.completedAt,
          })
          .from(solarRecActiveDatasetVersions)
          .leftJoin(
            solarRecImportBatches,
            eq(solarRecActiveDatasetVersions.batchId, solarRecImportBatches.id)
          )
          .leftJoin(
            datasetUploadJobs,
            eq(solarRecActiveDatasetVersions.batchId, datasetUploadJobs.batchId)
          )
          .where(eq(solarRecActiveDatasetVersions.scopeId, scopeId));
        for (const r of rows) {
          activeVersions.set(r.datasetKey, {
            datasetKey: r.datasetKey,
            batchId: r.batchId,
            rowCount: r.rowCount,
            completedAt: r.completedAt,
            createdAt: r.createdAt ?? new Date(),
            uploadFileName: r.uploadFileName ?? null,
            uploadCompletedAt: r.uploadCompletedAt ?? null,
          });
        }

        const appendUploadRows = await db
          .select({
            jobId: datasetUploadJobs.id,
            datasetKey: datasetUploadJobs.datasetKey,
            fileName: datasetUploadJobs.fileName,
            totalRows: datasetUploadJobs.totalRows,
            rowsParsed: datasetUploadJobs.rowsParsed,
            rowsWritten: datasetUploadJobs.rowsWritten,
            completedAt: datasetUploadJobs.completedAt,
            createdAt: datasetUploadJobs.createdAt,
          })
          .from(datasetUploadJobs)
          .where(
            and(
              eq(datasetUploadJobs.scopeId, scopeId),
              eq(datasetUploadJobs.status, "done"),
              inArray(
                datasetUploadJobs.datasetKey,
                APPEND_UPLOAD_SOURCE_DATASET_KEYS
              )
            )
          )
          .orderBy(
            desc(datasetUploadJobs.completedAt),
            desc(datasetUploadJobs.createdAt)
          );
        for (const row of appendUploadRows) {
          const uploadedAt = row.completedAt ?? row.createdAt ?? null;
          const source: UploadSourceSummary = {
            jobId: row.jobId,
            fileName: row.fileName,
            uploadedAt: uploadedAt?.toISOString() ?? null,
            rowCount:
              row.totalRows == null
                ? row.rowsParsed > 0
                  ? row.rowsParsed
                  : row.rowsWritten > 0
                    ? row.rowsWritten
                    : null
                : Number(row.totalRows),
          };
          const list = uploadSourcesByDataset.get(row.datasetKey) ?? [];
          list.push(source);
          uploadSourcesByDataset.set(row.datasetKey, list);
        }

        const convertedReadsManifestPayload =
          await getSolarRecDashboardPayload(ownerUserId, "dataset:convertedReads");
        const { summarizeServerManagedConvertedReadsSources } = await import(
          "../solar/convertedReadsBridge"
        );
        const convertedReadsServerSources =
          summarizeServerManagedConvertedReadsSources(
            convertedReadsManifestPayload
          );
        if (convertedReadsServerSources.length > 0) {
          const existing = uploadSourcesByDataset.get("convertedReads") ?? [];
          const byId = new Map<string, UploadSourceSummary>();
          for (const source of [...existing, ...convertedReadsServerSources]) {
            byId.set(source.jobId, source);
          }
          uploadSourcesByDataset.set(
            "convertedReads",
            Array.from(byId.values()).sort((a, b) => {
              const aTime = a.uploadedAt
                ? new Date(a.uploadedAt).getTime()
                : 0;
              const bTime = b.uploadedAt
                ? new Date(b.uploadedAt).getTime()
                : 0;
              return bTime - aTime;
            })
          );
        }
      }

      type PopulationStatus = "populated" | "empty" | "missing" | "failed";

      type Summary = {
        datasetKey: string;
        rowCount: number | null;
        byteCount: number | null;
        lastUpdated: string | null;
        batchId: string | null;
        payloadSha256: string | null;
        cloudStatus: "synced" | "failed" | "missing";
        isRowBacked: boolean;
        /**
         * Phase 2.6 of the dashboard foundation repair (2026-05-01)
         * — the locked v3 "populated dataset" definition. Mirrors
         * the foundation's `populatedDatasets` derivation:
         *
         *   - "populated" — active batch + recorded rowCount > 0
         *   - "empty"     — active batch + recorded rowCount === 0
         *   - "missing"   — no active batch
         *   - "failed"    — sync state indicates the upload failed
         *                   to persist (chunked-CSV legacy path)
         */
        populationStatus: PopulationStatus;
        /**
         * Latest v2-upload metadata for the active batch — used by
         * the dashboard upload-slot UI so the slot card can show
         * "Saved in cloud — <fileName> (uploaded <when>)" after a
         * reload. Phase 5e (PR #275) dropped the IDB local-state
         * hydration that previously held this on the client; the
         * server has it for v2 uploads via `datasetUploadJobs`.
         * Null on legacy-path (v1) batches because the chunked-CSV
         * path doesn't write `datasetUploadJobs` rows.
         */
        lastUploadFileName: string | null;
        lastUploadCompletedAt: string | null;
        /**
         * For append datasets, the upload jobs that feed the current
         * accumulated dataset, newest first. The active batch has only one
         * `batchId`, so the old scalar `lastUploadFileName` could only show
         * one file after reload.
         */
        lastUploadSources: UploadSourceSummary[];
      };

      const summaries: Summary[] = ALL_DATASET_KEYS.map((datasetKey) => {
        const dbStorageKey = `dataset:${datasetKey}`;
        const syncRow = syncByKey.get(dbStorageKey);
        const isRowBacked = datasetKey in ROW_TABLES_BY_DATASET_KEY;
        const activeBatch = activeVersions.get(datasetKey);
        const recordedRowCount =
          activeBatch?.rowCount == null ? null : Number(activeBatch.rowCount);

        // Cloud status derivation — mirrors PR-2's tightened
        // `isChildKeyRecoverable` semantics: dbPersisted is required
        // for "synced"; storage-only state surfaces as "failed".
        let cloudStatus: "synced" | "failed" | "missing";
        if (!syncRow && !activeBatch) {
          cloudStatus = "missing";
        } else if (syncRow && (syncRow.payloadBytes ?? 0) <= 0) {
          cloudStatus = "missing";
        } else if (syncRow?.dbPersisted === true) {
          cloudStatus = "synced";
        } else if (isRowBacked && activeBatch) {
          // Row-backed without sync row: treat presence of an active
          // batch as proof of persistence (the srDs* path is
          // canonical for these — sync-state row is a leftover from
          // the chunked-CSV era).
          cloudStatus = "synced";
        } else {
          cloudStatus = "failed";
        }

        const rowCount = isRowBacked ? recordedRowCount : null;

        let populationStatus: PopulationStatus;
        if (cloudStatus === "failed") {
          populationStatus = "failed";
        } else if (!activeBatch) {
          populationStatus = "missing";
        } else if ((rowCount ?? 0) > 0) {
          populationStatus = "populated";
        } else {
          populationStatus = "empty";
        }

        return {
          datasetKey,
          rowCount,
          byteCount: syncRow?.payloadBytes ?? null,
          lastUpdated:
            syncRow?.updatedAt?.toISOString() ??
            activeBatch?.completedAt?.toISOString() ??
            activeBatch?.createdAt?.toISOString() ??
            null,
          batchId: activeBatch?.batchId ?? null,
          payloadSha256:
            syncRow?.payloadSha256 && syncRow.payloadSha256.length > 0
              ? syncRow.payloadSha256
              : null,
          cloudStatus,
          isRowBacked,
          populationStatus,
          lastUploadFileName: activeBatch?.uploadFileName ?? null,
          lastUploadCompletedAt:
            activeBatch?.uploadCompletedAt?.toISOString() ?? null,
          lastUploadSources: uploadSourcesByDataset.get(datasetKey) ?? [],
        };
      });

      return {
        _checkpoint: "dataset-summaries-all-v1",
        // 2026-05-05: also surfaces append upload source lists for the
        // multi-file slot UI. 2026-05-04: surfaces lastUploadFileName +
        // lastUploadCompletedAt
        // for the upload-slot UI's saved-in-cloud branch (Phase 5e
        // IDB-removal regression). Bumped from "+phase-2.6".
        _runnerVersion:
          "task-5.12-pr10+phase-2.6+last-upload-meta+append-sources" as const,
        scopeId,
        summaries,
      };
    }),

  /**
   * Cursor-paginated row reader for the 7 row-backed datasets.
   *
   * Returns at most `limit` rows per call, ordered by the row's PK.
   * Pass the response's `nextCursor` back as the `cursor` input to
   * fetch the next page. `nextCursor === null` means no more rows.
   *
   * Why this exists: tabs that show row-level detail (Ownership,
   * Contracts, Annual REC Review, Schedule B detail) used to read
   * the entire CsvRow[] from the in-memory `loadedDatasets` state
   * and filter/paginate client-side. That holds 100k+ rows in JS
   * heap on every cold load. With this endpoint, the browser holds
   * one page (~100-500 rows) at a time. Filter/sort move to the
   * server in a follow-up; this PR is unsorted-natural-order paging
   * only — sufficient for the "load more" UX.
   *
   * Memory bound:
   *   - Server: one indexed `WHERE scopeId = ? AND batchId = ? AND id > ?`
   *     query against the srDs* table, LIMIT N+1. The +1 row is used
   *     to detect end-of-stream without a separate `COUNT(*)`.
   *   - Wire: at default limit=100, ~30-300 KB depending on rawRow
   *     density. transferHistory's rawRow is skipped (typed columns
   *     only) so it's the lighter end of the range.
   *   - Client: caller decides whether to keep all pages (infinite
   *     scroll) or drop on page change. Either way, never the full
   *     dataset.
   */
  getDatasetRowsPage: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        datasetKey: z.enum([
          "solarApplications",
          "abpReport",
          "generationEntry",
          "accountSolarGeneration",
          "annualProductionEstimates",
          "abpIccReport2Rows",
          "abpIccReport3Rows",
          "contractedDate",
          "convertedReads",
          "deliveryScheduleBase",
          "transferHistory",
          "generatorDetails",
          "abpCsgSystemMapping",
          "abpProjectApplicationRows",
          "abpPortalInvoiceMapRows",
          "abpCsgPortalDatabaseRows",
          "abpQuickBooksRows",
          "abpUtilityInvoiceRows",
        ]),
        cursor: z.string().nullable().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      void ctx;
      const { resolveSolarRecScopeId } = await import("./solarRecAuth");
      const { getActiveBatchForDataset } = await import("../db");
      const { loadDatasetRowsPage } = await import(
        "../services/solar/buildSystemSnapshot"
      );

      const TABLES_BY_DATASET_KEY = {
        solarApplications: srDsSolarApplications,
        abpReport: srDsAbpReport,
        generationEntry: srDsGenerationEntry,
        accountSolarGeneration: srDsAccountSolarGeneration,
        annualProductionEstimates: srDsAnnualProductionEstimates,
        abpIccReport2Rows: srDsAbpIccReport2Rows,
        abpIccReport3Rows: srDsAbpIccReport3Rows,
        contractedDate: srDsContractedDate,
        convertedReads: srDsConvertedReads,
        deliveryScheduleBase: srDsDeliverySchedule,
        transferHistory: srDsTransferHistory,
        generatorDetails: srDsGeneratorDetails,
        abpCsgSystemMapping: srDsAbpCsgSystemMapping,
        abpProjectApplicationRows: srDsAbpProjectApplicationRows,
        abpPortalInvoiceMapRows: srDsAbpPortalInvoiceMapRows,
        abpCsgPortalDatabaseRows: srDsAbpCsgPortalDatabaseRows,
        abpQuickBooksRows: srDsAbpQuickBooksRows,
        abpUtilityInvoiceRows: srDsAbpUtilityInvoiceRows,
      } as const;

      const scopeId = await resolveSolarRecScopeId();
      const activeBatch = await getActiveBatchForDataset(
        scopeId,
        input.datasetKey
      );
      if (!activeBatch) {
        return {
          _checkpoint: "dataset-rows-page-v1",
          _runnerVersion: "task-5.12-pr10" as const,
          datasetKey: input.datasetKey,
          batchId: null,
          rows: [],
          rowIds: [],
          nextCursor: null,
          hasMore: false,
        };
      }

      const table = TABLES_BY_DATASET_KEY[input.datasetKey];
      const result = await loadDatasetRowsPage(scopeId, activeBatch.id, table, {
        cursor: input.cursor ?? null,
        limit: input.limit,
      });

      return {
        _checkpoint: "dataset-rows-page-v1",
        _runnerVersion: "task-5.12-pr10" as const,
        datasetKey: input.datasetKey,
        batchId: activeBatch.id,
        rows: result.rows,
        rowIds: result.rowIds,
        nextCursor: result.nextCursor,
        hasMore: result.nextCursor !== null,
      };
    }),

  /**
   * Fetch the (trackingId → energyYear → deliveredQuantity) lookup
   * computed from the active transferHistory batch. Used by tabs
   * that need per-system delivery totals without the client having
   * to load 579k+ transferHistory rows into IDB and recompute on
   * every render.
   *
   * Cheap to compute (~200ms on the server for ~600k rows using the
   * typed-column-only read path) and small to ship (~3MB JSON for
   * 25k tracking IDs × ~3 years), so runs synchronously without
   * the snapshot-style async build machinery.
   */
  getTransferDeliveryLookup: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { buildTransferDeliveryLookupForScope } = await import(
        "../services/solar/buildTransferDeliveryLookup"
      );
      return buildTransferDeliveryLookupForScope(input.scopeId);
    }),

  /**
   * Debug-only: audit the active transferHistory batch for duplicates.
   *
   * Answers: "is the forecast tab's 'Delivered' inflated because the
   * same transfer rows are in the DB multiple times?"
   *
   * Two complementary duplicate checks:
   *   1. Exact-key dupes: rows that share the full dedup key
   *      (transactionId | unitId | completionDate | quantity). If any
   *      exist, the ingest-time dedup missed them (bug or replace-mode
   *      upload with a pre-duped CSV).
   *   2. Near-dupes: rows with the same (unitId, completionDate,
   *      quantity) but *different* transactionIds. These survive the
   *      ingest-time dedup because the key includes transactionId —
   *      catches the case where GATS renumbers Transaction IDs across
   *      re-exports of the same underlying transfer.
   *
   * The near-dupe check is the one most likely to surface a real
   * problem. Exact-key dupes imply a logic bug in ingestion; near-
   * dupes imply the dedup key is too strict for GATS's behavior.
   */
  debugTransferHistoryRaw: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const CHECKPOINT = "transfer-history-audit-v2-2026-04-22";
      try {
      const db = await getDb();
      if (!db) {
        return {
          _runnerVersion: "transfer_history_audit_v2" as const,
          _checkpoint: CHECKPOINT,
          dbUnavailable: true as const,
          activeBatchId: null,
          batch: null,
          totalRowCount: 0,
          exactDupGroups: 0,
          exactDupExtraRows: 0,
          topExactDupes: [],
          nearDupGroups: 0,
          nearDupExtraRows: 0,
          topNearDupes: [],
          files: [],
        };
      }

      const activeRows = await db
        .select({ batchId: solarRecActiveDatasetVersions.batchId })
        .from(solarRecActiveDatasetVersions)
        .where(
          and(
            eq(solarRecActiveDatasetVersions.scopeId, input.scopeId),
            eq(solarRecActiveDatasetVersions.datasetKey, "transferHistory")
          )
        )
        .limit(1);
      const activeBatchId = activeRows[0]?.batchId ?? null;

      if (!activeBatchId) {
        return {
          _runnerVersion: "transfer_history_audit_v2" as const,
          _checkpoint: CHECKPOINT,
          activeBatchId: null,
          batch: null,
          totalRowCount: 0,
          exactDupGroups: 0,
          exactDupExtraRows: 0,
          topExactDupes: [],
          nearDupGroups: 0,
          nearDupExtraRows: 0,
          topNearDupes: [],
          files: [],
        };
      }

      const batchRows = await db
        .select({
          id: solarRecImportBatches.id,
          mergeStrategy: solarRecImportBatches.mergeStrategy,
          status: solarRecImportBatches.status,
          rowCount: solarRecImportBatches.rowCount,
          createdAt: solarRecImportBatches.createdAt,
          completedAt: solarRecImportBatches.completedAt,
          importedBy: solarRecImportBatches.importedBy,
        })
        .from(solarRecImportBatches)
        .where(eq(solarRecImportBatches.id, activeBatchId))
        .limit(1);
      const batch = batchRows[0] ?? null;

      const totalRow = await db
        .select({ count: sql<number>`COUNT(*)` })
        .from(srDsTransferHistory)
        .where(eq(srDsTransferHistory.batchId, activeBatchId));
      const totalRowCount = Number(totalRow[0]?.count ?? 0);

      // Exact-key duplicates (what the ingest dedup is supposed to stop).
      // mysql2 `db.execute` returns [rows, fields]; unwrap with [0].
      const exactDupAggRaw = (await db.execute(sql`
        SELECT COUNT(*) AS dupGroups, COALESCE(SUM(n - 1), 0) AS extraRows
        FROM (
          SELECT COUNT(*) AS n
          FROM srDsTransferHistory
          WHERE batchId = ${activeBatchId}
          GROUP BY transactionId, unitId, transferCompletionDate, quantity
          HAVING COUNT(*) > 1
        ) t
      `)) as unknown as [
        Array<{ dupGroups: number | string; extraRows: number | string }>,
        unknown,
      ];
      const exactDupAgg = exactDupAggRaw[0] ?? [];
      const exactDupGroups = Number(exactDupAgg[0]?.dupGroups ?? 0);
      const exactDupExtraRows = Number(exactDupAgg[0]?.extraRows ?? 0);

      const topExactDupesResult = (await db.execute(sql`
        SELECT transactionId, unitId, transferCompletionDate, quantity, COUNT(*) AS n
        FROM srDsTransferHistory
        WHERE batchId = ${activeBatchId}
        GROUP BY transactionId, unitId, transferCompletionDate, quantity
        HAVING COUNT(*) > 1
        ORDER BY n DESC
        LIMIT 20
      `)) as unknown as [
        Array<{
          transactionId: string | null;
          unitId: string | null;
          transferCompletionDate: string | null;
          quantity: number | null;
          n: number | string;
        }>,
        unknown,
      ];
      const topExactDupesRaw = topExactDupesResult[0] ?? [];
      const topExactDupes = topExactDupesRaw.map((r) => ({
        transactionId: r.transactionId,
        unitId: r.unitId,
        transferCompletionDate: r.transferCompletionDate,
        quantity: r.quantity,
        count: Number(r.n),
      }));

      // Near-duplicates: same (unitId, completionDate, quantity) with
      // different transactionIds. These survive ingest-time dedup
      // because the key includes transactionId — most likely cause of
      // inflated "Delivered" if GATS renumbers txIds across re-exports.
      const nearDupAggRaw = (await db.execute(sql`
        SELECT COUNT(*) AS dupGroups, COALESCE(SUM(n - 1), 0) AS extraRows
        FROM (
          SELECT COUNT(*) AS n
          FROM srDsTransferHistory
          WHERE batchId = ${activeBatchId}
            AND unitId IS NOT NULL
            AND transferCompletionDate IS NOT NULL
            AND quantity IS NOT NULL
          GROUP BY unitId, transferCompletionDate, quantity
          HAVING COUNT(DISTINCT transactionId) > 1
        ) t
      `)) as unknown as [
        Array<{ dupGroups: number | string; extraRows: number | string }>,
        unknown,
      ];
      const nearDupAgg = nearDupAggRaw[0] ?? [];
      const nearDupGroups = Number(nearDupAgg[0]?.dupGroups ?? 0);
      const nearDupExtraRows = Number(nearDupAgg[0]?.extraRows ?? 0);

      const topNearDupesResult = (await db.execute(sql`
        SELECT unitId, transferCompletionDate, quantity,
               COUNT(DISTINCT transactionId) AS distinctTxIds,
               COUNT(DISTINCT transferor) AS distinctTransferors,
               COUNT(DISTINCT transferee) AS distinctTransferees,
               MIN(transferor) AS sampleTransferor,
               MIN(transferee) AS sampleTransferee,
               COUNT(*) AS n
        FROM srDsTransferHistory
        WHERE batchId = ${activeBatchId}
          AND unitId IS NOT NULL
          AND transferCompletionDate IS NOT NULL
          AND quantity IS NOT NULL
        GROUP BY unitId, transferCompletionDate, quantity
        HAVING COUNT(DISTINCT transactionId) > 1
        ORDER BY n DESC, distinctTxIds DESC
        LIMIT 20
      `)) as unknown as [
        Array<{
          unitId: string | null;
          transferCompletionDate: string | null;
          quantity: number | null;
          distinctTxIds: number | string;
          distinctTransferors: number | string;
          distinctTransferees: number | string;
          sampleTransferor: string | null;
          sampleTransferee: string | null;
          n: number | string;
        }>,
        unknown,
      ];
      const topNearDupesRaw = topNearDupesResult[0] ?? [];
      const topNearDupes = topNearDupesRaw.map((r) => ({
        unitId: r.unitId,
        transferCompletionDate: r.transferCompletionDate,
        quantity: r.quantity,
        distinctTransactionIds: Number(r.distinctTxIds),
        distinctTransferors: Number(r.distinctTransferors),
        distinctTransferees: Number(r.distinctTransferees),
        sampleTransferor: r.sampleTransferor,
        sampleTransferee: r.sampleTransferee,
        count: Number(r.n),
      }));

      const fileRows = await db
        .select({
          fileName: solarRecImportFiles.fileName,
          sizeBytes: solarRecImportFiles.sizeBytes,
          rowCount: solarRecImportFiles.rowCount,
          createdAt: solarRecImportFiles.createdAt,
        })
        .from(solarRecImportFiles)
        .where(eq(solarRecImportFiles.batchId, activeBatchId))
        .orderBy(solarRecImportFiles.createdAt);
      const files = fileRows.map((f) => ({
        fileName: f.fileName,
        sizeBytes: f.sizeBytes,
        rowCount: f.rowCount,
        createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null,
      }));

      return {
        _runnerVersion: "transfer_history_audit_v2" as const,
        _checkpoint: CHECKPOINT,
        activeBatchId,
        batch: batch
          ? {
              id: batch.id,
              mergeStrategy: batch.mergeStrategy,
              status: batch.status,
              rowCount: batch.rowCount,
              createdAt: batch.createdAt
                ? new Date(batch.createdAt).toISOString()
                : null,
              completedAt: batch.completedAt
                ? new Date(batch.completedAt).toISOString()
                : null,
              importedBy: batch.importedBy,
            }
          : null,
        totalRowCount,
        exactDupGroups,
        exactDupExtraRows,
        topExactDupes,
        nearDupGroups,
        nearDupExtraRows,
        topNearDupes,
        files,
      };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(
          `[debugTransferHistoryRaw] failed for scope ${input.scopeId}: ${msg}`,
          stack
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `transferHistory audit failed: ${msg}`,
        });
      }
    }),

  /**
   * Debug-only: trace DY1/DY2/DY3 for one tracking ID.
   *
   * Given a trackingSystemRefId (= GATS unitId), returns:
   *   - raw transferHistory rows for that unit in the active batch,
   *   - the per-energy-year aggregate (the exact lookup value the
   *     Forecast tab consumes for this unit),
   *   - the Schedule B year1-15 entries for that contract,
   *   - the rolling 3-year DY1/DY2/DY3 window + sources for the
   *     current energy year, mirroring
   *     deriveRecPerformanceThreeYearValues on the client.
   *
   * Lets us answer "where does DY3 (actual) for NON258210 come from?"
   * without wading through IDB or the 600k-row lookup.
   */
  debugSystemDeliveryBreakdown: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z.object({
        scopeId: z.string().min(1),
        trackingId: z.string().min(1).max(64),
      })
    )
    .query(async ({ input }) => {
      const CHECKPOINT = "system-delivery-breakdown-v2-txid-dedup-2026-04-22";
      try {
        const db = await getDb();
        if (!db) {
          throw new Error("Database not available");
        }

        const trackingIdLower = input.trackingId.trim().toLowerCase();
        const trackingIdUpper = input.trackingId.trim().toUpperCase();

        // Active batches for both datasets (independent activation).
        const activeRows = await db
          .select({
            datasetKey: solarRecActiveDatasetVersions.datasetKey,
            batchId: solarRecActiveDatasetVersions.batchId,
          })
          .from(solarRecActiveDatasetVersions)
          .where(eq(solarRecActiveDatasetVersions.scopeId, input.scopeId));
        const activeByKey = new Map(
          activeRows.map((r) => [r.datasetKey, r.batchId])
        );
        const transferBatchId = activeByKey.get("transferHistory") ?? null;
        const scheduleBatchId =
          activeByKey.get("deliveryScheduleBase") ?? null;

        // --- Transfer rows for this unit -------------------------------
        type TransferRow = {
          transactionId: string | null;
          transferCompletionDate: string | null;
          quantity: number | null;
          transferor: string | null;
          transferee: string | null;
          rawRow: string | null;
        };
        let transferRowsRaw: TransferRow[] = [];
        if (transferBatchId) {
          transferRowsRaw = (await db
            .select({
              transactionId: srDsTransferHistory.transactionId,
              transferCompletionDate:
                srDsTransferHistory.transferCompletionDate,
              quantity: srDsTransferHistory.quantity,
              transferor: srDsTransferHistory.transferor,
              transferee: srDsTransferHistory.transferee,
              rawRow: srDsTransferHistory.rawRow,
            })
            .from(srDsTransferHistory)
            .where(
              and(
                eq(srDsTransferHistory.batchId, transferBatchId),
                sql`LOWER(${srDsTransferHistory.unitId}) = ${trackingIdLower}`
              )
            )) as TransferRow[];
        }

        const parseCompletionDate = (value: string | null): Date | null => {
          if (!value) return null;
          const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
          if (iso) {
            const d = new Date(
              Number(iso[1]),
              Number(iso[2]) - 1,
              Number(iso[3])
            );
            return Number.isNaN(d.getTime()) ? null : d;
          }
          const us = value.match(
            /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
          );
          if (us) {
            const month = Number(us[1]) - 1;
            const day = Number(us[2]);
            const year =
              Number(us[3]) < 100 ? 2000 + Number(us[3]) : Number(us[3]);
            let hours = us[4] ? Number(us[4]) : 0;
            const minutes = us[5] ? Number(us[5]) : 0;
            const meridiem = us[6]?.toUpperCase();
            if (meridiem === "PM" && hours < 12) hours += 12;
            if (meridiem === "AM" && hours === 12) hours = 0;
            const d = new Date(year, month, day, hours, minutes);
            return Number.isNaN(d.getTime()) ? null : d;
          }
          const fb = new Date(value);
          return Number.isNaN(fb.getTime()) ? null : fb;
        };

        // Enrich each row with direction, energy year, and monthYear
        // (the latter pulled from rawRow which holds the original CSV
        // object). `isDuplicate` marks rows whose Transaction ID has
        // already been seen earlier in the batch — those are the ones
        // the compute-time dedup drops from the lookup, so we surface
        // the fact visually rather than silently hiding them.
        type EnrichedTransferRow = {
          transactionId: string | null;
          completionDate: string | null;
          monthYear: string | null;
          quantity: number | null;
          transferor: string | null;
          transferee: string | null;
          direction: 1 | -1 | 0;
          energyYear: number | null;
          isDuplicate: boolean;
        };
        const enrichedRows: EnrichedTransferRow[] = transferRowsRaw.map((r) => {
          const transferor = (r.transferor ?? "").toLowerCase();
          const transferee = (r.transferee ?? "").toLowerCase();
          const isFromCS = transferor.includes("carbon solutions");
          const isToCS = transferee.includes("carbon solutions");
          const transfereeIsUtility = ["comed", "ameren", "midamerican"].some(
            (u) => transferee.includes(u)
          );
          const transferorIsUtility = ["comed", "ameren", "midamerican"].some(
            (u) => transferor.includes(u)
          );
          let direction: 1 | -1 | 0 = 0;
          if (isFromCS && transfereeIsUtility) direction = 1;
          else if (transferorIsUtility && isToCS) direction = -1;
          const d = parseCompletionDate(r.transferCompletionDate);
          let energyYear: number | null = null;
          if (d) {
            energyYear = d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
          }
          let monthYear: string | null = null;
          if (r.rawRow) {
            try {
              const parsed = JSON.parse(r.rawRow) as Record<string, unknown>;
              const my = parsed["Month/Year"];
              if (typeof my === "string") monthYear = my;
            } catch {
              // ignore
            }
          }
          return {
            transactionId: r.transactionId,
            completionDate: r.transferCompletionDate,
            monthYear,
            quantity: r.quantity,
            transferor: r.transferor,
            transferee: r.transferee,
            direction,
            energyYear,
            isDuplicate: false,
          };
        });

        // Sort by completion date ascending, nulls last, so the
        // "first-write-wins" txId dedup keeps the earliest-dated
        // occurrence (matching how the production lookup behaves
        // when rows stream in by insertion order).
        enrichedRows.sort((a, b) => {
          const ad = parseCompletionDate(a.completionDate)?.getTime() ?? Infinity;
          const bd = parseCompletionDate(b.completionDate)?.getTime() ?? Infinity;
          return ad - bd;
        });

        // Energy-year aggregation — same algorithm as
        // computeTransferDeliveryLookupFromRows, including the
        // Transaction ID first-write-wins dedup. Keeping the panel
        // in sync with the compute path is critical: when a user
        // looks up a system to verify the forecast, the numbers
        // must match what the forecast actually uses.
        const energyYearBuckets = new Map<
          number,
          { netQty: number; rowCount: number }
        >();
        const seenTxIds = new Set<string>();
        let duplicateRowCount = 0;
        let duplicateQtyExcluded = 0;
        for (const r of enrichedRows) {
          if (r.direction === 0 || r.energyYear === null || r.quantity === null)
            continue;
          const txId = (r.transactionId ?? "").trim();
          if (txId) {
            if (seenTxIds.has(txId)) {
              r.isDuplicate = true;
              duplicateRowCount += 1;
              duplicateQtyExcluded += r.quantity * r.direction;
              continue;
            }
            seenTxIds.add(txId);
          }
          const bucket = energyYearBuckets.get(r.energyYear) ?? {
            netQty: 0,
            rowCount: 0,
          };
          bucket.netQty += r.quantity * r.direction;
          bucket.rowCount += 1;
          energyYearBuckets.set(r.energyYear, bucket);
        }
        const energyYearAgg = Array.from(energyYearBuckets.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([ey, v]) => ({
            energyYearStart: ey,
            label: `${ey}-${ey + 1}`,
            rowCount: v.rowCount,
            netQty: v.netQty,
          }));

        let firstTransferEnergyYear: number | null = null;
        for (const b of energyYearAgg) {
          if (b.netQty > 0) {
            if (
              firstTransferEnergyYear === null ||
              b.energyYearStart < firstTransferEnergyYear
            ) {
              firstTransferEnergyYear = b.energyYearStart;
            }
          }
        }

        // --- Delivery schedule row(s) for this tracking ID -------------
        type ScheduleRow = {
          utilityContractNumber: string | null;
          systemName: string | null;
          rawRow: string | null;
        };
        let scheduleRows: ScheduleRow[] = [];
        if (scheduleBatchId) {
          scheduleRows = (await db
            .select({
              utilityContractNumber: srDsDeliverySchedule.utilityContractNumber,
              systemName: srDsDeliverySchedule.systemName,
              rawRow: srDsDeliverySchedule.rawRow,
            })
            .from(srDsDeliverySchedule)
            .where(
              and(
                eq(srDsDeliverySchedule.batchId, scheduleBatchId),
                sql`UPPER(${srDsDeliverySchedule.trackingSystemRefId}) = ${trackingIdUpper}`
              )
            )) as ScheduleRow[];
        }

        type ScheduleYearEntry = {
          yearIndex: number;
          startDate: string | null;
          endDate: string | null;
          required: number;
          scheduleDelivered: number;
          energyYearStart: number | null;
          deliveredFromTransfers: number;
        };
        type ScheduleSummary = {
          utilityContractNumber: string | null;
          systemName: string | null;
          years: ScheduleYearEntry[];
        };
        const schedules: ScheduleSummary[] = scheduleRows.map((sr) => {
          const years: ScheduleYearEntry[] = [];
          if (sr.rawRow) {
            try {
              const parsed = JSON.parse(sr.rawRow) as Record<string, unknown>;
              for (let i = 1; i <= 15; i += 1) {
                const startRaw = parsed[`year${i}_start_date`];
                const endRaw = parsed[`year${i}_end_date`];
                const reqRaw = parsed[`year${i}_quantity_required`];
                const delRaw = parsed[`year${i}_quantity_delivered`];
                const start = typeof startRaw === "string" ? startRaw : null;
                const end = typeof endRaw === "string" ? endRaw : null;
                const required = Number(reqRaw) || 0;
                const scheduleDelivered = Number(delRaw) || 0;
                if (!start && !end && required === 0 && scheduleDelivered === 0) {
                  continue;
                }
                const startDate = parseCompletionDate(start);
                const energyYearStart = startDate
                  ? startDate.getFullYear()
                  : null;
                const deliveredFromTransfers =
                  energyYearStart !== null
                    ? energyYearBuckets.get(energyYearStart)?.netQty ?? 0
                    : 0;
                years.push({
                  yearIndex: i,
                  startDate: start,
                  endDate: end,
                  required,
                  scheduleDelivered,
                  energyYearStart,
                  deliveredFromTransfers,
                });
              }
            } catch {
              // ignore malformed rawRow
            }
          }
          years.sort((a, b) => a.yearIndex - b.yearIndex);
          return {
            utilityContractNumber: sr.utilityContractNumber,
            systemName: sr.systemName,
            years,
          };
        });

        // --- Forecast DY window (mirrors ForecastTab + recPerformance) --
        const now = new Date();
        const forecastEyStartYear =
          now.getMonth() >= 5 ? now.getFullYear() : now.getFullYear() - 1;
        const forecastEyLabel = `${forecastEyStartYear}-${forecastEyStartYear + 1}`;

        const dyWindows = schedules.map((s) => {
          const targetIndex = s.years.findIndex(
            (y) => y.energyYearStart === forecastEyStartYear
          );
          if (targetIndex < 2) {
            return {
              utilityContractNumber: s.utilityContractNumber,
              forecastEyLabel,
              eligible: false as const,
              reason:
                targetIndex === -1
                  ? `No schedule year matches current EY ${forecastEyLabel}`
                  : `Target year index ${targetIndex} < 2 (need 3rd+ delivery year)`,
            };
          }
          const dy1 = s.years[targetIndex - 2]!;
          const dy2 = s.years[targetIndex - 1]!;
          const dy3 = s.years[targetIndex]!;
          if (firstTransferEnergyYear === null) {
            return {
              utilityContractNumber: s.utilityContractNumber,
              forecastEyLabel,
              eligible: false as const,
              reason:
                "No positive-net transfers for this unit — firstTransferEnergyYear is null",
            };
          }
          const firstDeliveryYear = firstTransferEnergyYear + 1;
          const targetEy = dy3.energyYearStart ?? 0;
          const actualDeliveryYearNumber =
            targetEy - firstDeliveryYear + 1;
          if (actualDeliveryYearNumber < 3) {
            return {
              utilityContractNumber: s.utilityContractNumber,
              forecastEyLabel,
              eligible: false as const,
              reason: `actualDeliveryYearNumber=${actualDeliveryYearNumber} < 3 (firstTransferEY=${firstTransferEnergyYear}, targetEY=${targetEy})`,
            };
          }
          const isThirdDeliveryYear = actualDeliveryYearNumber === 3;
          const valDy1 = isThirdDeliveryYear
            ? dy1.deliveredFromTransfers
            : dy1.required;
          const valDy2 = isThirdDeliveryYear
            ? dy2.deliveredFromTransfers
            : dy2.required;
          const valDy3 = dy3.deliveredFromTransfers;
          return {
            utilityContractNumber: s.utilityContractNumber,
            forecastEyLabel,
            eligible: true as const,
            firstTransferEnergyYear,
            firstDeliveryYear,
            targetYearIndex: targetIndex,
            actualDeliveryYearNumber,
            dy1: {
              yearIndex: dy1.yearIndex,
              energyYearStart: dy1.energyYearStart,
              value: valDy1,
              source: isThirdDeliveryYear
                ? ("Actual" as const)
                : ("Expected" as const),
              required: dy1.required,
              deliveredFromTransfers: dy1.deliveredFromTransfers,
            },
            dy2: {
              yearIndex: dy2.yearIndex,
              energyYearStart: dy2.energyYearStart,
              value: valDy2,
              source: isThirdDeliveryYear
                ? ("Actual" as const)
                : ("Expected" as const),
              required: dy2.required,
              deliveredFromTransfers: dy2.deliveredFromTransfers,
            },
            dy3: {
              yearIndex: dy3.yearIndex,
              energyYearStart: dy3.energyYearStart,
              value: valDy3,
              source: "Actual" as const,
              required: dy3.required,
              deliveredFromTransfers: dy3.deliveredFromTransfers,
            },
            rollingAverage: Math.floor((valDy1 + valDy2 + valDy3) / 3),
            expectedRecs: dy3.required,
          };
        });

        return {
          _runnerVersion: "system_delivery_breakdown_v2_txid_dedup" as const,
          _checkpoint: CHECKPOINT,
          trackingId: input.trackingId,
          transferBatchId,
          scheduleBatchId,
          transferRowCount: enrichedRows.length,
          transferRows: enrichedRows.slice(0, 200), // bound at 200 for UI
          truncated: enrichedRows.length > 200,
          duplicateTxIdRowCount: duplicateRowCount,
          duplicateTxIdQtyExcluded: duplicateQtyExcluded,
          energyYearAgg,
          firstTransferEnergyYear,
          schedules,
          dyWindows,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        console.error(
          `[debugSystemDeliveryBreakdown] failed for scope ${input.scopeId} tracking ${input.trackingId}: ${msg}`,
          stack
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `system delivery breakdown failed: ${msg}`,
        });
      }
    }),

  /**
   * Get the current input version hash for the system snapshot.
   * Clients use this to check freshness without fetching the full payload.
   */
  getSystemSnapshotHash: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { computeSystemSnapshotHash } = await import(
        "../services/solar/buildSystemSnapshot"
      );
      const hash = await computeSystemSnapshotHash(input.scopeId);
      return { inputVersionHash: hash };
    }),

  /**
   * Get the active dataset versions for a scope.
   * Used by the client to show which datasets are loaded and their batch IDs.
   */
  getActiveDatasetVersions: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { getActiveDatasetVersions } = await import("../db");
      const versions = await getActiveDatasetVersions(input.scopeId);
      return {
        versions: versions.map((v) => ({
          datasetKey: v.datasetKey,
          batchId: v.batchId,
          activatedAt: v.activatedAt,
        })),
      };
    }),

  // -- Delivery Tracker (Step 6) -----------------------------------------

  /**
   * Fetch the pre-computed delivery tracker data for a scope.
   *
   * Returns DeliveryTrackerData equivalent. Depends on 2 datasets:
   * deliveryScheduleBase + transferHistory. Independent version hash
   * from the system snapshot.
   */
  getDeliverySnapshot: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { getOrBuildDeliverySnapshot } = await import(
        "../services/solar/buildDeliverySnapshot"
      );
      const result = await getOrBuildDeliverySnapshot(input.scopeId);
      return {
        data: result.data,
        fromCache: result.fromCache,
        inputVersionHash: result.inputVersionHash,
        building: result.building,
      };
    }),

  // -- Financials (Step 7) -----------------------------------------------

  /**
   * Get the current financials version hash.
   * Includes CSV dataset versions + completed scan job + latest override.
   * Clients use this to check if their cached financials data is stale.
   */
  getFinancialsHash: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { computeFinancialsHash } = await import(
        "../services/solar/financialsVersion"
      );
      const hash = await computeFinancialsHash(input.scopeId);
      return { inputVersionHash: hash };
    }),

  // ── Phase 1: server-side dataset upload (IndexedDB-removal refactor) ──
  //
  // The five procs below replace the legacy chunked-base64
  // `saveDataset` write path one dataset at a time (Phase 4). The
  // upload flow is:
  //   1. Client calls `startDatasetUpload` → server creates a job
  //      row with status=queued, returns jobId + uploadId.
  //   2. Client base64-chunks the CSV and POSTs each chunk via
  //      `uploadDatasetChunk`. The chunks reassemble on disk
  //      under `DATASET_UPLOAD_TMP_ROOT`.
  //   3. After the last chunk, client calls `finalizeDatasetUpload`
  //      → server transitions the job to "uploading" → spawns the
  //      runner (fire-and-forget) → returns immediately.
  //   4. Client polls `getDatasetUploadStatus` until the status is
  //      terminal. The runner stream-parses, writes rows, updates
  //      counters, and activates the new batch.
  //   5. UI invalidates the relevant dashboard queries on success.
  //
  // Phase 1 ships parsers for ONE dataset (`contractedDate`).
  // Other datasets fail fast with a clear "Phase 4 work" error
  // message, so the legacy path remains the supported route for
  // them until Phase 4 lands.

  startDatasetUpload: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        datasetKey: z.string().min(1).max(64),
        fileName: z.string().min(1).max(500),
        fileSize: z.number().int().min(1).max(500 * 1024 * 1024),
        totalChunks: z.number().int().min(1).max(2000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { isDatasetKey } = await import(
        "../../shared/datasetUpload.helpers"
      );
      if (!isDatasetKey(input.datasetKey)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unknown dataset key: ${input.datasetKey}`,
        });
      }
      const { insertDatasetUploadJob } = await import(
        "../db/datasetUploadJobs"
      );
      const jobId = nanoid();
      const uploadId = nanoid();
      await insertDatasetUploadJob({
        id: jobId,
        scopeId: ctx.scopeId,
        initiatedByUserId: ctx.userId,
        datasetKey: input.datasetKey,
        fileName: input.fileName,
        fileSizeBytes: input.fileSize,
        uploadId,
        uploadedChunks: 0,
        totalChunks: input.totalChunks,
        storageKey: `tmp:${uploadId}`,
        status: "queued",
        rowsParsed: 0,
        rowsWritten: 0,
      });
      return {
        jobId,
        uploadId,
        _runnerVersion: DATASET_UPLOAD_RUNNER_VERSION,
      };
    }),

  uploadDatasetChunk: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(
      z.object({
        jobId: z.string().min(1).max(64),
        uploadId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
        chunkIndex: z.number().int().min(0),
        totalChunks: z.number().int().min(1).max(2000),
        chunkBase64: z.string().min(1).max(320_000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getDatasetUploadJob, updateDatasetUploadJob } = await import(
        "../db/datasetUploadJobs"
      );
      const { DATASET_UPLOAD_TMP_ROOT } = await import(
        "../routers/helpers/scheduleB"
      );
      const job = await getDatasetUploadJob(ctx.scopeId, input.jobId);
      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Dataset upload job not found.",
        });
      }
      if (job.uploadId !== input.uploadId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Upload session id mismatch.",
        });
      }
      if (job.status !== "queued" && job.status !== "uploading") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot upload chunk: job is ${job.status}.`,
        });
      }

      const tempDir = path.join(
        DATASET_UPLOAD_TMP_ROOT,
        ctx.scopeId,
        job.id
      );
      await mkdir(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, `${input.uploadId}.csv`);

      const expectedChunkIndex = job.uploadedChunks ?? 0;
      if (input.chunkIndex < expectedChunkIndex) {
        // Idempotent retry — client lost the response and is re-
        // sending. Acknowledge without re-writing.
        return {
          uploadedChunks: expectedChunkIndex,
          totalChunks: input.totalChunks,
          status: job.status,
          skipped: true as const,
        };
      }
      if (input.chunkIndex > expectedChunkIndex) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Out-of-order chunk for job ${job.id}. Expected ${expectedChunkIndex}, got ${input.chunkIndex}.`,
        });
      }

      const buf = Buffer.from(input.chunkBase64, "base64");
      if (input.chunkIndex === 0) {
        await writeFile(tempPath, buf);
      } else {
        await appendFile(tempPath, buf);
      }

      const newUploadedChunks = input.chunkIndex + 1;
      await updateDatasetUploadJob(ctx.scopeId, job.id, {
        status: "uploading",
        uploadedChunks: newUploadedChunks,
        totalChunks: input.totalChunks,
        storageKey: tempPath,
      });

      return {
        uploadedChunks: newUploadedChunks,
        totalChunks: input.totalChunks,
        status: "uploading" as const,
        skipped: false as const,
      };
    }),

  finalizeDatasetUpload: dashboardProcedure("solar-rec-dashboard", "edit")
    .input(z.object({ jobId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const { getDatasetUploadJob } = await import(
        "../db/datasetUploadJobs"
      );
      const { runDatasetUploadJob } = await import(
        "../services/core/datasetUploadJobRunner"
      );
      const job = await getDatasetUploadJob(ctx.scopeId, input.jobId);
      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Dataset upload job not found.",
        });
      }
      if (job.status !== "uploading") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot finalize: job is ${job.status}, not uploading.`,
        });
      }
      if (
        job.totalChunks != null &&
        job.uploadedChunks < job.totalChunks
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot finalize: ${job.uploadedChunks} of ${job.totalChunks} chunks uploaded.`,
        });
      }
      // Spawn fire-and-forget. Errors are persisted to the job row
      // by the runner itself; the catch here is just to prevent
      // unhandled rejections from bubbling to the process logger.
      void runDatasetUploadJob({ scopeId: ctx.scopeId, jobId: job.id }).catch(
        (err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[datasetUploadRunner] job ${job.id} threw outside the catch path:`,
            err
          );
        }
      );
      return { jobId: job.id, status: "running" as const };
    }),

  getDatasetUploadStatus: dashboardProcedure("solar-rec-dashboard", "read")
    .input(z.object({ jobId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const {
        getDatasetUploadJob,
        listDatasetUploadJobErrors,
      } = await import("../db/datasetUploadJobs");
      const job = await getDatasetUploadJob(ctx.scopeId, input.jobId);
      if (!job) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Dataset upload job not found.",
        });
      }
      // Only fetch the error list when relevant — saves a query for
      // every poll while a happy job is uploading/parsing.
      const errors =
        job.status === "failed" ||
        ((job.rowsParsed ?? 0) > (job.rowsWritten ?? 0))
          ? await listDatasetUploadJobErrors(job.id, { limit: 50 })
          : [];
      return {
        _runnerVersion: DATASET_UPLOAD_RUNNER_VERSION,
        job: {
          id: job.id,
          datasetKey: job.datasetKey,
          fileName: job.fileName,
          fileSizeBytes: job.fileSizeBytes,
          status: job.status,
          totalChunks: job.totalChunks,
          uploadedChunks: job.uploadedChunks,
          totalRows: job.totalRows,
          rowsParsed: job.rowsParsed,
          rowsWritten: job.rowsWritten,
          errorMessage: job.errorMessage,
          batchId: job.batchId,
          startedAt: job.startedAt
            ? job.startedAt.toISOString()
            : null,
          completedAt: job.completedAt
            ? job.completedAt.toISOString()
            : null,
          createdAt: job.createdAt
            ? job.createdAt.toISOString()
            : null,
          updatedAt: job.updatedAt
            ? job.updatedAt.toISOString()
            : null,
        },
        errors: errors.map((e) => ({
          id: e.id,
          rowIndex: e.rowIndex,
          errorMessage: e.errorMessage,
          createdAt: e.createdAt
            ? e.createdAt.toISOString()
            : null,
        })),
      };
    }),

  listDatasetUploadJobs: dashboardProcedure("solar-rec-dashboard", "read")
    .input(
      z
        .object({
          datasetKey: z.string().min(1).max(64).optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { listDatasetUploadJobs } = await import(
        "../db/datasetUploadJobs"
      );
      const jobs = await listDatasetUploadJobs(ctx.scopeId, {
        datasetKey: input?.datasetKey,
        limit: input?.limit,
      });
      return {
        _runnerVersion: DATASET_UPLOAD_RUNNER_VERSION,
        jobs: jobs.map((j) => ({
          id: j.id,
          datasetKey: j.datasetKey,
          fileName: j.fileName,
          status: j.status,
          totalRows: j.totalRows,
          rowsWritten: j.rowsWritten,
          startedAt: j.startedAt ? j.startedAt.toISOString() : null,
          completedAt: j.completedAt
            ? j.completedAt.toISOString()
            : null,
          createdAt: j.createdAt ? j.createdAt.toISOString() : null,
        })),
      };
    }),
});
