import path from "node:path";
import { mkdir, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import { eq, sql } from "drizzle-orm";
import { scheduleBImportFiles, scheduleBImportResults } from "../../drizzle/schema";
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
  upsertScheduleBImportFileUploadProgress,
} from "../db";
import { storageGet, storagePut } from "../storage";
import { resolveSolarRecOwnerUserId } from "../_core/solarRecAuth";

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
 *
 * Does NOT match user-uploaded source chunks like
 * "src_convertedReads_mo0rczoydl24xs0j_chunk_0000" — those are stored
 * under ctx.user.id by the dashboard's auto-sync and must stay per-user
 * for backward compatibility with chunks written before the team-wide fix.
 */
function isTeamWideDatasetKey(inputKey: string): boolean {
  if (inputKey === "convertedReads") return true;
  // Bridge source chunk keys start with "src_convertedReads_mon_batch_"
  if (inputKey.startsWith("src_convertedReads_mon_batch_")) return true;
  return false;
}

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
import {
  parseJsonMetadata,
  toNonEmptyString,
  normalizeScheduleBDeliveryYears,
  parseChunkPointerPayload,
  parseScheduleBRemoteSourceManifest,
  parseCsvText,
  buildCsvText,
  parseRemoteCsvDataset,
  cleanScheduleBCell,
  parseContractIdMappingText,
  buildTransferDeliveryLookup,
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
} from "./helpers";
import type { ParsedRemoteCsvDataset } from "./helpers";

export const solarRecDashboardRouter = router({
  /**
   * Returns the scopeId for the current user's Solar REC context.
   * Used by the client to pass to server-side dataset endpoints.
   */
  getScopeId: protectedProcedure.query(async () => {
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
  startServerSideMigration: protectedProcedure.mutation(async () => {
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
  getServerSideMigrationStatus: protectedProcedure
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
  getActiveServerSideMigration: protectedProcedure.query(async () => {
    const { resolveSolarRecScopeId } = await import("../_core/solarRecAuth");
    const { getActiveJobForScope } = await import(
      "../services/solar/serverSideMigration"
    );
    const scopeId = await resolveSolarRecScopeId();
    return getActiveJobForScope(scopeId);
  }),

  getState: protectedProcedure.query(async ({ ctx }) => {
    const key = `solar-rec-dashboard/${ctx.user.id}/state.json`;
    const dbStorageKey = "state";

    try {
      const payload = await getSolarRecDashboardPayload(ctx.user.id, dbStorageKey);
      if (payload) return { key, payload };
    } catch (error) {
      console.warn("[solarRec] DB read failed, falling back to storage:", error instanceof Error ? error.message : error);
    }

    try {
      const { url } = await storageGet(key);
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) return null;
      const payload = await response.text();
      if (!payload) return null;
      return { key, payload };
    } catch {
      return null;
    }
  }),
  saveState: protectedProcedure
    .input(
      z.object({
        payload: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const key = `solar-rec-dashboard/${ctx.user.id}/state.json`;
      const dbStorageKey = "state";
      let persistedToDatabase = false;

      try {
        persistedToDatabase = await saveSolarRecDashboardPayload(ctx.user.id, dbStorageKey, input.payload);
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
  getDataset: protectedProcedure
    .input(
      z.object({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const storageUserId = await resolveDatasetUserId(input.key, ctx.user.id);
      const key = `solar-rec-dashboard/${storageUserId}/datasets/${input.key}.json`;
      const dbStorageKey = `dataset:${input.key}`;

      try {
        const payload = await getSolarRecDashboardPayload(storageUserId, dbStorageKey);
        if (payload) return { key, payload };
      } catch {
        // Fall back to storage proxy.
      }

      try {
        const { url } = await storageGet(key);
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) return null;
        const payload = await response.text();
        if (!payload) return null;
        return { key, payload };
      } catch {
        return null;
      }
    }),
  saveDataset: protectedProcedure
    .input(
      z.object({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        payload: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const storageUserId = await resolveDatasetUserId(input.key, ctx.user.id);
      const key = `solar-rec-dashboard/${storageUserId}/datasets/${input.key}.json`;
      const dbStorageKey = `dataset:${input.key}`;
      let persistedToDatabase = false;

      try {
        persistedToDatabase = await saveSolarRecDashboardPayload(storageUserId, dbStorageKey, input.payload);
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
  ensureScheduleBImportJob: protectedProcedure
    .mutation(async ({ ctx }) => {
      const job = await getOrCreateLatestScheduleBImportJob(ctx.user.id);
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
  linkScheduleBDriveFolder: protectedProcedure
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

      const accessToken = await getValidGoogleToken(ctx.user.id);

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

      const job = await getOrCreateLatestScheduleBImportJob(ctx.user.id);

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
  importScheduleBFromCsgPortal: protectedProcedure
    .input(
      z.object({
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Validate CSG portal credentials
      const integration = await getIntegrationByProvider(ctx.user.id, "csg-portal");
      if (!integration?.accessToken) {
        throw new Error("CSG portal credentials not configured. Go to Settings to add your portal email and password.");
      }

      // 2. Deduplicate
      const uniqueIds = Array.from(new Set(input.csgIds.map((v) => v.trim()).filter(Boolean)));
      if (uniqueIds.length === 0) throw new Error("No valid CSG IDs provided.");

      // 3. Get/create job
      const job = await getOrCreateLatestScheduleBImportJob(ctx.user.id);

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
  getScheduleBImportStatus: protectedProcedure
    .query(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.user.id);
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
  listScheduleBImportResults: protectedProcedure
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
        : await getLatestScheduleBImportJob(ctx.user.id);

      // Defensive: Number()-coerce both sides before comparing in case the
      // mysql2 driver returns job.userId as a BigInt or string for any
      // reason. The previous strict `!==` check caused "0 rows returned"
      // ghost behavior while the DB actually held 800+ result rows; the
      // apply mutation worked because it uses a different resolution path.
      // If the requested job doesn't belong to this user, transparently
      // fall back to the latest job for the user instead of returning
      // empty — it's safer to show the user their own data than pretend
      // there isn't any.
      if (job && Number(job.userId) !== Number(ctx.user.id)) {
        console.warn(
          `[listScheduleBImportResults] requested jobId ${job.id} belongs to user ${job.userId} but caller is ${ctx.user.id}; falling back to latest job for caller`
        );
        job = await getLatestScheduleBImportJob(ctx.user.id);
      }

      if (!job) {
        console.warn(
          `[listScheduleBImportResults] no job found for user ${ctx.user.id} (requestedJobId=${requestedJobId ?? "none"})`
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
  applyScheduleBToDeliveryObligations: protectedProcedure
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
        : await getLatestScheduleBImportJob(ctx.user.id);

      // Same Number()-coercion + latest-job fallback as
      // listScheduleBImportResults above — mysql2 driver occasionally
      // returns job.userId as a string/bigint and strict !== fails.
      if (job && Number(job.userId) !== Number(ctx.user.id)) {
        console.warn(
          `[applyScheduleBToDeliveryObligations] requested jobId ${job.id} belongs to user ${job.userId} but caller is ${ctx.user.id}; falling back to latest job for caller`
        );
        job = await getLatestScheduleBImportJob(ctx.user.id);
      }
      if (!job) {
        throw new Error("Schedule B import job not found.");
      }

      const loadDatasetPayloadByKey = async (key: string): Promise<string | null> => {
        const basePayload = await getSolarRecDashboardPayload(
          ctx.user.id,
          `dataset:${key}`
        );
        if (!basePayload) return null;

        const chunkKeys = parseChunkPointerPayload(basePayload);
        if (!chunkKeys || chunkKeys.length === 0) {
          return basePayload;
        }

        let merged = "";
        for (const chunkKey of chunkKeys) {
          const chunk = await getSolarRecDashboardPayload(
            ctx.user.id,
            `dataset:${chunkKey}`
          );
          if (typeof chunk !== "string") {
            return null;
          }
          merged += chunk;
        }
        return merged;
      };

      const existingPayload = await loadDatasetPayloadByKey("deliveryScheduleBase");
      let existingDataset: ParsedRemoteCsvDataset = {
        fileName: "Schedule B Import",
        uploadedAt: new Date().toISOString(),
        headers: [],
        rows: [],
      };

      if (existingPayload) {
        const sourceManifest = parseScheduleBRemoteSourceManifest(existingPayload);
        if (sourceManifest && sourceManifest.length > 0) {
          const latestSource = sourceManifest[sourceManifest.length - 1];
          const sourcePayload = await loadDatasetPayloadByKey(latestSource.storageKey);
          if (sourcePayload) {
            const decoded =
              latestSource.encoding === "base64"
                ? Buffer.from(sourcePayload, "base64").toString("utf8")
                : sourcePayload;
            const parsedCsv = parseCsvText(decoded);
            existingDataset = {
              fileName: "Schedule B Import",
              uploadedAt: new Date().toISOString(),
              headers: parsedCsv.headers,
              rows: parsedCsv.rows,
            };
          }
        } else {
          const parsed = parseRemoteCsvDataset(existingPayload);
          if (parsed) {
            existingDataset = parsed;
          }
        }
      }

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
          ctx.user.id,
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

      let transferHistoryRows: Array<Record<string, string>> = [];
      const transferHistoryPayload = await loadDatasetPayloadByKey("transferHistory");
      if (transferHistoryPayload) {
        const sourceManifest = parseScheduleBRemoteSourceManifest(transferHistoryPayload);
        if (sourceManifest && sourceManifest.length > 0) {
          const latestSource = sourceManifest[sourceManifest.length - 1];
          const sourcePayload = await loadDatasetPayloadByKey(latestSource.storageKey);
          if (sourcePayload) {
            const decoded =
              latestSource.encoding === "base64"
                ? Buffer.from(sourcePayload, "base64").toString("utf8")
                : sourcePayload;
            const parsedCsv = parseCsvText(decoded);
            transferHistoryRows = parsedCsv.rows;
          }
        } else {
          const parsed = parseRemoteCsvDataset(transferHistoryPayload);
          if (parsed) {
            transferHistoryRows = parsed.rows;
          }
        }
      }
      const transferDeliveryLookup = buildTransferDeliveryLookup(transferHistoryRows);

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
      const finalPayload = JSON.stringify({
        fileName: existingDataset.fileName || "Schedule B Import",
        uploadedAt,
        headers: mergedHeaders,
        csvText: buildCsvText(mergedHeaders, mergedRows),
      });

      let persistedToDatabase = false;
      try {
        persistedToDatabase = await saveSolarRecDashboardPayload(
          ctx.user.id,
          "dataset:deliveryScheduleBase",
          finalPayload
        );
      } catch {
        persistedToDatabase = false;
      }

      const storageKey = `solar-rec-dashboard/${ctx.user.id}/datasets/deliveryScheduleBase.json`;
      let storageSynced = false;
      try {
        await storagePut(storageKey, finalPayload, "application/json");
        storageSynced = true;
      } catch (storageError) {
        if (!persistedToDatabase) {
          throw storageError;
        }
      }

      // Mark the consumed result rows as applied so the Apply
      // counter drops to 0 (or to whatever genuinely-new results
      // have since landed). Only run if at least one persistence
      // path succeeded — otherwise we'd "forget" that these rows
      // still need to be applied. Non-fatal: swallow errors so a
      // successful merge still returns success to the client.
      let markedAppliedCount = 0;
      if (persistedToDatabase || storageSynced) {
        try {
          markedAppliedCount = await markScheduleBImportResultsApplied(
            job.id,
            appliedFileNames
          );
        } catch (markErr) {
          console.warn(
            `[applyScheduleBToDeliveryObligations] failed to mark rows applied for job ${job.id}:`,
            markErr
          );
        }
      }

      return {
        success: true,
        _checkpoint: "apply-track-v1" as const,
        jobId: job.id,
        incoming: incomingRows.length,
        inserted,
        updated,
        unchanged,
        errors: conversionErrors,
        totalRows: mergedRows.length,
        persistedToDatabase,
        storageSynced,
        appliedFileNames,
        alreadyInDatabaseFileNames,
        markedAppliedCount,
      };
    }),
  /**
   * contract-id-mapping-v1: persist a GATS ID → Contract ID mapping
   * server-side and patch utility_contract_number across the
   * deliveryScheduleBase rows in cloud storage.
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
   *   3. Loads the current cloud deliveryScheduleBase payload via
   *      the same loadDatasetPayloadByKey helper that
   *      applyScheduleBToDeliveryObligations uses.
   *   4. Iterates rows and patches utility_contract_number wherever
   *      tracking_system_ref_id (uppercased) has a mapping entry.
   *   5. Writes the patched dataset back to cloud (DB + S3) using
   *      the same flat {fileName,uploadedAt,headers,csvText} shape.
   *   6. Returns counts + checkpoint so the client can display a
   *      "Last mapping: X patched, Y unchanged" panel and so
   *      onApplyComplete can reload the dataset from cloud.
   */
  getScheduleBContractIdMapping: protectedProcedure.query(async ({ ctx }) => {
    const mappingText = await getSolarRecDashboardPayload(
      ctx.user.id,
      "dashboard:schedule_b_contract_id_mapping"
    );
    return {
      _checkpoint: "contract-id-mapping-v1" as const,
      mappingText: mappingText ?? "",
    };
  }),
  applyScheduleBContractIdMapping: protectedProcedure
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
      await saveSolarRecDashboardPayload(
        ctx.user.id,
        "dashboard:schedule_b_contract_id_mapping",
        input.mappingText
      );

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
        };
      }

      // ── Step 3: Load the current cloud deliveryScheduleBase.
      //    Reuses the exact same inline helper as
      //    applyScheduleBToDeliveryObligations to handle both flat
      //    and source-manifest payload shapes.
      const loadDatasetPayloadByKey = async (
        key: string
      ): Promise<string | null> => {
        const basePayload = await getSolarRecDashboardPayload(
          ctx.user.id,
          `dataset:${key}`
        );
        if (!basePayload) return null;
        const chunkKeys = parseChunkPointerPayload(basePayload);
        if (!chunkKeys || chunkKeys.length === 0) {
          return basePayload;
        }
        let merged = "";
        for (const chunkKey of chunkKeys) {
          const chunk = await getSolarRecDashboardPayload(
            ctx.user.id,
            `dataset:${chunkKey}`
          );
          if (typeof chunk !== "string") {
            return null;
          }
          merged += chunk;
        }
        return merged;
      };

      const existingPayload = await loadDatasetPayloadByKey(
        "deliveryScheduleBase"
      );
      if (!existingPayload) {
        // No dataset yet. Text is saved, but there's nothing to
        // patch. Return early so the client doesn't trigger a
        // cloud reload that would show 0 rows.
        return {
          _checkpoint: "contract-id-mapping-v1" as const,
          mappingSize: mapping.size,
          patched: 0,
          unchanged: 0,
          totalRows: 0,
          mappingTextSaved: true,
        };
      }

      let existingDataset: ParsedRemoteCsvDataset = {
        fileName: "Schedule B Import",
        uploadedAt: new Date().toISOString(),
        headers: [],
        rows: [],
      };

      const sourceManifest =
        parseScheduleBRemoteSourceManifest(existingPayload);
      if (sourceManifest && sourceManifest.length > 0) {
        const latestSource = sourceManifest[sourceManifest.length - 1];
        const sourcePayload = await loadDatasetPayloadByKey(
          latestSource.storageKey
        );
        if (sourcePayload) {
          const decoded =
            latestSource.encoding === "base64"
              ? Buffer.from(sourcePayload, "base64").toString("utf8")
              : sourcePayload;
          const parsedCsv = parseCsvText(decoded);
          existingDataset = {
            fileName: "Schedule B Import",
            uploadedAt: new Date().toISOString(),
            headers: parsedCsv.headers,
            rows: parsedCsv.rows,
          };
        }
      } else {
        const parsed = parseRemoteCsvDataset(existingPayload);
        if (parsed) {
          existingDataset = parsed;
        }
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

      // ── Step 5: Write back to cloud (DB + S3).
      const uploadedAt = new Date().toISOString();
      const finalPayload = JSON.stringify({
        fileName: existingDataset.fileName || "Schedule B Import",
        uploadedAt,
        headers: mergedHeaders,
        csvText: buildCsvText(mergedHeaders, patchedRows),
      });

      let persistedToDatabase = false;
      try {
        persistedToDatabase = await saveSolarRecDashboardPayload(
          ctx.user.id,
          "dataset:deliveryScheduleBase",
          finalPayload
        );
      } catch {
        persistedToDatabase = false;
      }

      const storageKey = `solar-rec-dashboard/${ctx.user.id}/datasets/deliveryScheduleBase.json`;
      let storageSynced = false;
      try {
        await storagePut(storageKey, finalPayload, "application/json");
        storageSynced = true;
      } catch (storageError) {
        if (!persistedToDatabase) {
          throw storageError;
        }
      }

      return {
        _checkpoint: "contract-id-mapping-v1" as const,
        mappingSize: mapping.size,
        patched,
        unchanged,
        totalRows: patchedRows.length,
        persistedToDatabase,
        storageSynced,
        mappingTextSaved: true,
      };
    }),
  uploadScheduleBFileChunk: protectedProcedure
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
      if (!job || job.userId !== ctx.user.id) {
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
        String(ctx.user.id),
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
        const storageKey = `solar-rec-dashboard/${ctx.user.id}/schedule-b/${job.id}/${Date.now()}-${nanoid()}-${safeFileName}`;
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
  forceRunScheduleBImport: protectedProcedure
    .mutation(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.user.id);
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
  clearScheduleBImport: protectedProcedure
    .mutation(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.user.id);
      if (job) {
        await deleteScheduleBImportJobData(job.id);
      }

      const userTmpDir = path.join(SCHEDULE_B_UPLOAD_TMP_ROOT, String(ctx.user.id));
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
  clearScheduleBImportStuckUploads: protectedProcedure
    .mutation(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.user.id);
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
        String(ctx.user.id),
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
  debugScheduleBImportRaw: protectedProcedure
    .query(async ({ ctx }) => {
      const job = await getLatestScheduleBImportJob(ctx.user.id);
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
  askTabQuestion: protectedProcedure
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
      const integration = await getIntegrationByProvider(ctx.user.id, "anthropic");
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

  getImportStatus: protectedProcedure
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
  getSystemSnapshot: protectedProcedure
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
   * Get the current input version hash for the system snapshot.
   * Clients use this to check freshness without fetching the full payload.
   */
  getSystemSnapshotHash: protectedProcedure
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
  getActiveDatasetVersions: protectedProcedure
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
  getDeliverySnapshot: protectedProcedure
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
      };
    }),

  // -- Financials (Step 7) -----------------------------------------------

  /**
   * Get the current financials version hash.
   * Includes CSV dataset versions + completed scan job + latest override.
   * Clients use this to check if their cached financials data is stale.
   */
  getFinancialsHash: protectedProcedure
    .input(z.object({ scopeId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { computeFinancialsHash } = await import(
        "../services/solar/financialsVersion"
      );
      const hash = await computeFinancialsHash(input.scopeId);
      return { inputVersionHash: hash };
    }),
});
