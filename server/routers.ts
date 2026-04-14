import path from "node:path";
import { verifySolarReadingsSignedRequest } from "./_core/solarReadingsIngest";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import { callLlmForAddressCleaning, sanitizeMailingFields, toNonEmptyString } from "./services/core/addressCleaning";
import { mapWithConcurrency } from "./services/core/concurrency";
import { JOB_TTL_MS } from "./constants";
import { nanoid } from "nanoid";
import { createSolarConnectionRouter, maskApiKey } from "./routers/solarConnectionFactory";
// Extracted sub-routers
import {
  authRouter,
  twoFactorRouter,
  integrationsRouter,
  oauthCredsRouter,
  preferencesRouter,
  marketDashboardRouter,
  sportsRouter,
  feedbackRouter,
} from "./routers/auth";
// Shared helpers (re-imported from extracted file)
import {
  IntegrationNotConnectedError,
  DEFAULT_OPENAI_MODEL,
  parseJsonMetadata,
  resolveOpenAIModel,
  toNullableScore,
  getTodayDateKey,
  toFiniteNumber,
  normalizeSearchQuery,
  truncateText,
  scoreMatch,
  safeIso,
  computePearsonCorrelation,
  clampPercent,
  normalizeProgressPercent,
  SCHEDULE_B_UPLOAD_TMP_ROOT,
  SCHEDULE_B_UPLOAD_ID_PATTERN,
  SCHEDULE_B_UPLOAD_CHUNK_BASE64_LIMIT,
  SCHEDULE_B_INVALID_FILENAME_CHARS,
  SCHEDULE_B_CHUNK_KEY_PATTERN,
  sanitizeScheduleBFileName,
  normalizeScheduleBDeliveryYears,
  parseChunkPointerPayload,
  parseScheduleBRemoteSourceManifest,
  parseCsvText,
  escapeCsvCell,
  buildCsvText,
  parseRemoteCsvDataset,
  cleanScheduleBCell,
  parseContractIdMappingText,
  SCHEDULE_B_TRANSFER_UTILITY_TOKENS,
  parseScheduleBNumber,
  parseScheduleBDate,
  buildTransferDeliveryLookup,
  findFirstTransferEnergyYear,
  makeDeliveryRowKey,
  scheduleRowsEqual,
  mergeDeliveryRows,
  buildAdjustedScheduleFromExtraction,
  buildScheduleBDeliveryRow,
  performSupplementBottleScanForUser,
  isValidIpv4,
  extractIpv4FromText,
  fetchTeslaPowerhubServerEgressIpv4,
  teslaPowerhubProductionJobs,
  teslaPowerhubResumingJobIds,
  abpSettlementJobs,
  abpSettlementActiveScanRunners,
  ABP_SETTLEMENT_RUNS_INDEX_DB_KEY,
  ABP_SETTLEMENT_SCAN_SESSION_REFRESH_INTERVAL,
  ABP_SETTLEMENT_SCAN_CONCURRENCY,
  ABP_SETTLEMENT_SCAN_SNAPSHOT_BATCH_SIZE,
  pruneTeslaPowerhubProductionJobs,
  pruneAbpSettlementJobs,
  getAbpSettlementRunsIndexObjectKey,
  getAbpSettlementRunObjectKey,
  getAbpSettlementRunDbKey,
  getAbpSettlementScanJobObjectKey,
  getAbpSettlementScanJobDbKey,
  getTeslaPowerhubProductionJobObjectKey,
  getTeslaPowerhubProductionJobDbKey,
  readPayloadWithFallback,
  writePayloadWithFallback,
  parseAbpSettlementRunsIndex,
  serializeAbpSettlementRunsIndex,
  getAbpSettlementRunsIndex,
  saveAbpSettlementRunsIndex,
  getAbpSettlementRun,
  saveAbpSettlementRun,
  parseTeslaPowerhubProductionJobSnapshot,
  saveTeslaPowerhubProductionJobSnapshot,
  loadTeslaPowerhubProductionJobSnapshot,
  launchTeslaPowerhubProductionJobWorker,
  parseAbpSettlementScanJobSnapshot,
  saveAbpSettlementScanJobSnapshot,
  loadAbpSettlementScanJobSnapshot,
  runAbpSettlementContractScanJob,
  ENPHASE_V2_PROVIDER,
  ENPHASE_V4_PROVIDER,
  SOLAR_EDGE_PROVIDER,
  ENNEX_OS_PROVIDER,
  ZENDESK_PROVIDER,
  TESLA_SOLAR_PROVIDER,
  TESLA_POWERHUB_PROVIDER,
  CLOCKIFY_PROVIDER,
  CSG_PORTAL_PROVIDER,
  FRONIUS_PROVIDER,
  EGAUGE_PROVIDER,
  SOLIS_PROVIDER,
  GOODWE_PROVIDER,
  GENERAC_PROVIDER,
  LOCUS_PROVIDER,
  GROWATT_PROVIDER,
  APSYSTEMS_PROVIDER,
  EKM_PROVIDER,
  HOYMILES_PROVIDER,
  SOLAR_LOG_PROVIDER,
  parseEnphaseV2Metadata,
  parseEnphaseV4Metadata,
  parseZendeskMetadata,
  parseTeslaSolarMetadata,
  parseEgaugeMetadata,
  serializeEgaugeMetadata,
  parseTeslaPowerhubMetadata,
  parseClockifyMetadata,
  parseCsgPortalMetadata,
  serializeCsgPortalMetadata,
  serializeZendeskMetadata,
  parseSolarEdgeMetadata,
  serializeSolarEdgeMetadata,
  parseEnnexOsMetadata,
  serializeEnnexOsMetadata,
  parseFroniusMetadata,
  serializeFroniusMetadata,
  parseSolisMetadata,
  serializeSolisMetadata,
  parseGoodWeMetadata,
  serializeGoodWeMetadata,
  parseGeneracMetadata,
  serializeGeneracMetadata,
  parseLocusMetadata,
  serializeLocusMetadata,
  parseGrowattMetadata,
  serializeGrowattMetadata,
  parseAPsystemsMetadata,
  serializeAPsystemsMetadata,
  parseEkmMetadata,
  serializeEkmMetadata,
  parseHoymilesMetadata,
  serializeHoymilesMetadata,
  parseSolarLogMetadata,
  serializeSolarLogMetadata,
  getFroniusContext,
  getEnnexOsContext,
  getEnphaseV2Credentials,
  getEnphaseV4Context,
  getSolarEdgeContext,
  getZendeskContext,
  getTeslaSolarContext,
  getEgaugeContext,
  getTeslaPowerhubContext,
  getClockifyContext,
  getCsgPortalContext,
  getSolisContext,
  getGoodWeContext,
  getGeneracContext,
  getLocusContext,
  getGrowattContext,
  getAPsystemsContext,
  getEkmContext,
  getHoymilesContext,
  getSolarLogContext,
  calculateScheduleBRecForYear,
  deriveEgaugeMeterId,
  normalizeEgaugeAccessType,
} from "./routers/helpers";
import type {
  ParsedRemoteCsvDataset,
  ScheduleBAdjustedYear,
  SupplementBottleScanInput,
  TeslaPowerhubProductionJob,
  TeslaPowerhubProductionJobStatus,
  AbpSettlementContractScanJob,
  AbpSettlementContractScanJobStatus,
  AbpSettlementContractScanJobResultRow,
  AbpSettlementSavedRunSummary,
  AbpSettlementSavedRun,
  EgaugeAccessType,
  EgaugeConnectionConfig,
  SolarEdgeConnectionConfig,
  EnnexOsConnectionConfig,
  FroniusConnectionConfig,
  SolisConnectionConfig,
  GoodWeConnectionConfig,
  GeneracConnectionConfig,
  LocusConnectionConfig,
  GrowattConnectionConfig,
  APsystemsConnectionConfig,
  EkmConnectionConfig,
  HoymilesConnectionConfig,
  SolarLogConnectionConfig,
} from "./routers/helpers";
import {
  addMessage,
  addNoteLink,
  addSupplementLog,
  addSupplementPriceLog,
  bulkInsertContractScanJobCsgIds,
  bulkInsertScheduleBDriveFiles,
  bulkInsertScheduleBImportCsgIds,
  clearSectionEngagement,
  clearScheduleBImportStuckUploads,
  createContractScanJob,
  createConversation,
  createHabitDefinition,
  createNote,
  createSupplementDefinition,
  deleteContractScanJobData,
  deleteConversation,
  deleteHabitDefinition,
  deleteIntegration,
  deleteNote,
  deleteNoteLink,
  deleteScheduleBImportJobData,
  deleteSupplementDefinition,
  deleteSupplementLog,
  getAllContractScanResultsForJob,
  getAllScheduleBImportResults,
  getCompletedCsgIdsForJob,
  getContractScanJob,
  getConversationMessages,
  getConversationSummaries,
  getConversations,
  getDailyMetricsHistory,
  getDb,
  getHabitCompletionsByDate,
  getHabitCompletionsRange,
  getIntegrationByProvider,
  getLatestContractScanJob,
  getLatestSamsungSyncPayload,
  getLatestScanResultsByCsgIds,
  getLatestScheduleBImportJob,
  getNoteById,
  getOrCreateLatestScheduleBImportJob,
  getPendingScheduleBImportApplyCount,
  getProductionReadingSummary,
  getScheduleBImportCsgIdsForJob,
  getScheduleBImportFile,
  getScheduleBImportJob,
  getScheduleBImportJobCounts,
  getSectionEngagementSummary,
  getSectionRatings,
  getSolarRecDashboardPayload,
  getSupplementDefinitionById,
  getSupplementLogByDefinitionAndDate,
  getUserByEmail,
  insertContractScanResult,
  insertProductionReading,
  insertSectionEngagementBatch,
  listAllUploadedScheduleBImportFiles,
  listContractScanJobs,
  listContractScanResults,
  listDailySnapshots,
  listHabitCompletions,
  listHabitDefinitions,
  listNoteLinks,
  listNotes,
  listProductionReadings,
  listScheduleBImportFileNames,
  listScheduleBImportResults,
  listSupplementDefinitions,
  listSupplementLogs,
  listSupplementPriceLogs,
  markScheduleBImportFileQueued,
  markScheduleBImportFileStatus,
  markScheduleBImportResultsApplied,
  reconcileScheduleBImportJobState,
  requeueScheduleBImportRetryableFiles,
  saveSolarRecDashboardPayload,
  setSupplementDefinitionLock,
  updateContractScanJob,
  updateContractScanResultOverrides,
  updateNote,
  updateScheduleBImportJob,
  updateSupplementDefinition,
  upsertHabitCompletion,
  upsertIntegration,
  upsertScheduleBImportFileUploadProgress,
  upsertUserPreferences,
} from "./db";
import { storageGet, storagePut } from "./storage";
import { getValidGoogleToken, getValidWhoopToken } from "./helpers/tokenRefresh";
import { eq, sql } from "drizzle-orm";
import { scheduleBImportFiles, scheduleBImportResults } from "../drizzle/schema";
import { mkdir, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import {
  listSites as listSitesSolarEdge,
  getSiteOverview,
  getSiteDetails,
  getSiteEnergy,
  getSiteEnergyDetails,
  getSiteMeters,
  getSiteInverterProduction,
  getSiteProductionSnapshot as getSiteProductionSnapshotSolarEdge,
  getSiteMeterSnapshot,
  getSiteInverterSnapshot,
} from "./services/solar/solarEdge";
import {
  getTodoistTasks,
  getTodoistProjects,
  getTodoistCompletedTaskCount,
  getTodoistCompletedTasks,
  getTodoistCompletedTasksInRange,
  createTodoistTask,
  completeTodoistTask,
} from "./services/integrations/todoist";
import {
  parseGoogleDriveFolderId,
  listGoogleDrivePdfsInFolder,
  getGoogleCalendarEvents,
  getGmailMessages,
  getGmailWaitingOn,
  markGmailMessageAsRead,
  getGoogleDriveFiles,
  createGoogleSpreadsheet,
  searchGoogleDrive,
} from "./services/integrations/google";
import {
  listPlants as listPlantsEnnexos,
  getPlantDetails,
  getPlantDevices,
  getPlantMeasurements,
  getPlantProductionSnapshot as getPlantProductionSnapshotEnnexos,
  getPlantDeviceSnapshot,
} from "./services/solar/ennexos";
import {
  listPvSystems,
  getPvSystemDetails,
  getPvSystemDevices,
  getAggrData,
  getFlowData,
  getPvSystemProductionSnapshot,
  extractPvSystems,
  getPvSystemDeviceSnapshot,
} from "./services/solar/fronius";
import {
  listSystems as listSystemsEnphaseV4,
  getSystemSummary as getSystemSummaryEnphaseV4,
  getSystemEnergyLifetime as getSystemEnergyLifetimeEnphaseV4,
  getSystemRgmStats as getSystemRgmStatsEnphaseV4,
  getSystemProductionMeterTelemetry,
  getSystemProductionSnapshot as getSystemProductionSnapshotEnphaseV4,
  exchangeEnphaseV4AuthorizationCode,
  refreshEnphaseV4AccessToken,
} from "./services/solar/enphaseV4";
import {
  getEgaugeLocalData,
  getEgaugePortfolioSystems,
  getEgaugeRegisterHistory,
  getEgaugeRegisterLatest,
  getEgaugeSystemInfo,
  getMeterProductionSnapshot as getMeterProductionSnapshotEgauge,
  normalizeEgaugeBaseUrl,
  normalizeEgaugePortfolioBaseUrl,
} from "./services/solar/egauge";
import {
  listTeslaProducts,
  getTeslaEnergySiteLiveStatus,
  getTeslaEnergySiteInfo,
  getTeslaEnergySiteHistory,
} from "./services/solar/teslaSolar";
import {
  listSystems as listSystemsEnphaseV2,
  getSystemSummary as getSystemSummaryEnphaseV2,
  getSystemEnergyLifetime as getSystemEnergyLifetimeEnphaseV2,
  getSystemRgmStats as getSystemRgmStatsEnphaseV2,
  getSystemProductionMeterReadings,
} from "./services/solar/enphaseV2";
import {
  getTeslaPowerhubGroupProductionMetrics,
  getTeslaPowerhubGroupUsers,
  normalizeTeslaPowerhubUrl,
} from "./services/solar/teslaPowerhub";
import {
  listStations as listStationsHoymiles,
  getStationProductionSnapshot as getStationProductionSnapshotHoymiles,
} from "./services/solar/hoymiles";
import {
  getClockifyCurrentUser,
  getClockifyInProgressTimeEntry,
  getClockifyRecentTimeEntries,
  listClockifyWorkspaces,
  startClockifyTimeEntry,
  stopClockifyInProgressTimeEntry,
} from "./services/integrations/clockify";
import {
  listSystems as listSystemsApsystems,
  getSystemProductionSnapshot as getSystemProductionSnapshotApsystems,
} from "./services/solar/apsystems";
import {
  checkSupplementPrice,
  extractSupplementFromBottleImage,
  findExistingSupplementMatch,
  sourceDomainFromUrl,
} from "./services/integrations/supplements";
import {
  CsgPortalClient,
  testCsgPortalCredentials,
} from "./services/integrations/csgPortal";
import {
  runScheduleBImportJob,
  isScheduleBImportRunnerActive,
} from "./services/core/scheduleBImportJobRunner";
import {
  runCsgScheduleBImportJob,
  isCsgScheduleBImportRunnerActive,
} from "./services/core/csgScheduleBImportJobRunner";
import {
  runContractScanJob,
  isContractScanRunnerActive,
} from "./services/core/contractScanJobRunner";
import { extractContractDataFromPdfBuffer } from "./services/core/contractScannerServer";
import { normalizeZendeskSubdomainInput, getZendeskTicketMetricsByAssignee } from "./services/integrations/zendesk";
import { getWhoopSummary } from "./services/integrations/whoop";
import { captureDailySnapshotForUser } from "./services/notifications/dailySnapshot";
import { verifySupplementIngestSignedRequest } from "./_core/supplementIngest";
import { cleanAddressBatch } from "./services/core/addressCleaner";
import { verifyAddressBatch } from "./services/integrations/uspsAddressValidation";
import { listStations as listStationsSolis, getStationProductionSnapshot as getStationProductionSnapshotSolis } from "./services/solar/solis";
import { listDevices as listDevicesSolarLog, getDeviceProductionSnapshot } from "./services/solar/solarLog";
import { listSites as listSitesLocus, getSiteProductionSnapshot as getSiteProductionSnapshotLocus } from "./services/solar/locus";
import { listPlants as listPlantsGrowatt, getPlantProductionSnapshot as getPlantProductionSnapshotGrowatt } from "./services/solar/growatt";
import { listStations as listStationsGoodWe, getStationProductionSnapshot as getStationProductionSnapshotGoodWe } from "./services/solar/goodwe";
import { listSystems as listSystemsGenerac, getSystemProductionSnapshot as getSystemProductionSnapshotGenerac } from "./services/solar/generac";
import { getMeterProductionSnapshot as getMeterProductionSnapshotEkm } from "./services/solar/ekm";


export const appRouter = router({
  system: systemRouter,

  auth: authRouter,
  twoFactor: twoFactorRouter,
  integrations: integrationsRouter,
  oauthCreds: oauthCredsRouter,
  preferences: preferencesRouter,
  marketDashboard: marketDashboardRouter,
  sports: sportsRouter,
  feedback: feedbackRouter,


  solarRecDashboard: router({
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
        const key = `solar-rec-dashboard/${ctx.user.id}/datasets/${input.key}.json`;
        const dbStorageKey = `dataset:${input.key}`;

        try {
          const payload = await getSolarRecDashboardPayload(ctx.user.id, dbStorageKey);
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
        const key = `solar-rec-dashboard/${ctx.user.id}/datasets/${input.key}.json`;
        const dbStorageKey = `dataset:${input.key}`;
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
        console.log(`[importScheduleBFromCsgPortal] called with ${input.csgIds.length} CSG IDs for user ${ctx.user.id}`);
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
        if (result.total === 0) {
          console.log(
            `[listScheduleBImportResults] jobId=${job.id} userId=${job.userId} ctxUserId=${ctx.user.id} returned 0 rows`
          );
        }

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
  }),

  // Service-specific routers
  enphaseV2: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V2_PROVIDER);
      const metadata = parseEnphaseV2Metadata(integration?.metadata);

      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.userId),
        userId: metadata.userId,
        baseUrl: metadata.baseUrl,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          userId: z.string().min(1),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const metadata = JSON.stringify({
          userId: input.userId.trim(),
          baseUrl: toNonEmptyString(input.baseUrl),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENPHASE_V2_PROVIDER,
          accessToken: input.apiKey.trim(),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V2_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listSystems: protectedProcedure.query(async ({ ctx }) => {
      const credentials = await getEnphaseV2Credentials(ctx.user.id);
      return listSystemsEnphaseV2(credentials);
    }),
    getSummary: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        return getSystemSummaryEnphaseV2(credentials, input.systemId.trim());
      }),
    getEnergyLifetime: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        return getSystemEnergyLifetimeEnphaseV2(
          credentials,
          input.systemId.trim(),
          input.startDate,
          input.endDate
        );
      }),
    getRgmStats: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        return getSystemRgmStatsEnphaseV2(credentials, input.systemId.trim(), input.startDate, input.endDate);
      }),
    getProductionMeterReadings: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        return getSystemProductionMeterReadings(
          credentials,
          input.systemId.trim(),
          input.startDate,
          input.endDate
        );
      }),
  }),

  enphaseV4: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V4_PROVIDER);
      const metadata = parseEnphaseV4Metadata(integration?.metadata);
      return {
        connected: Boolean(integration?.accessToken && metadata.apiKey && metadata.clientId),
        hasRefreshToken: Boolean(integration?.refreshToken),
        expiresAt: integration?.expiresAt ? new Date(integration.expiresAt).toISOString() : null,
        clientId: metadata.clientId,
        baseUrl: metadata.baseUrl,
        redirectUri: metadata.redirectUri,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          clientId: z.string().min(1),
          clientSecret: z.string().min(1),
          authorizationCode: z.string().min(1),
          redirectUri: z.string().optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const tokenData = await exchangeEnphaseV4AuthorizationCode({
          clientId: input.clientId.trim(),
          clientSecret: input.clientSecret.trim(),
          authorizationCode: input.authorizationCode.trim(),
          redirectUri: input.redirectUri,
        });

        const metadata = JSON.stringify({
          apiKey: input.apiKey.trim(),
          clientId: input.clientId.trim(),
          clientSecret: input.clientSecret.trim(),
          redirectUri: toNonEmptyString(input.redirectUri),
          baseUrl: toNonEmptyString(input.baseUrl),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENPHASE_V4_PROVIDER,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token ?? null,
          expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
          scope: tokenData.scope ?? null,
          metadata,
        });

        return {
          success: true,
          hasRefreshToken: Boolean(tokenData.refresh_token),
          expiresInSeconds: tokenData.expires_in,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V4_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listSystems: protectedProcedure.query(async ({ ctx }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      return listSystemsEnphaseV4(context);
    }),
    getSummary: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        return getSystemSummaryEnphaseV4(context, input.systemId.trim());
      }),
    getEnergyLifetime: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        return getSystemEnergyLifetimeEnphaseV4(context, input.systemId.trim(), input.startDate, input.endDate);
      }),
    getRgmStats: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        return getSystemRgmStatsEnphaseV4(context, input.systemId.trim(), input.startDate, input.endDate);
      }),
    getProductionMeterReadings: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        return getSystemProductionMeterTelemetry(
          context,
          input.systemId.trim(),
          input.startDate,
          input.endDate
        );
      }),
    getProductionSnapshots: protectedProcedure
      .input(
        z.object({
          systemIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        const uniqueSystemIds = Array.from(
          new Set(input.systemIds.map((id) => id.trim()).filter((id) => id.length > 0))
        );

        const anchorDate =
          input.anchorDate ??
          (() => {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          })();

        // Fetch system names once upfront.
        const nameMap = new Map<string, string>();
        try {
          const { systems } = await listSystemsEnphaseV4(context);
          for (const sys of systems) {
            nameMap.set(sys.systemId, sys.systemName);
          }
        } catch {
          // Non-critical — proceed without names.
        }

        const rows = await mapWithConcurrency(uniqueSystemIds, 4, async (systemId: string) => {
          const snapshot = await getSystemProductionSnapshotEnphaseV4(
            context,
            systemId,
            anchorDate,
            nameMap.get(systemId) ?? null
          );
          return snapshot;
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          rows,
        };
      }),
  }),

  solarEdge: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
      const activeConnection =
        metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];

      return {
        connected: metadata.connections.length > 0,
        baseUrl: activeConnection?.baseUrl ?? metadata.baseUrl,
        activeConnectionId: activeConnection?.id ?? null,
        connections: metadata.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          baseUrl: connection.baseUrl,
          apiKeyMasked: maskApiKey(connection.apiKey),
          updatedAt: connection.updatedAt,
          isActive: connection.id === activeConnection?.id,
        })),
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          connectionName: z.string().optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        const existingMetadata = parseSolarEdgeMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
        const nowIso = new Date().toISOString();
        const newConnection: SolarEdgeConnectionConfig = {
          id: nanoid(),
          name:
            toNonEmptyString(input.connectionName) ??
            `SolarEdge API ${existingMetadata.connections.length + 1}`,
          apiKey: input.apiKey.trim(),
          baseUrl: toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const connections = [newConnection, ...existingMetadata.connections];
        const activeConnectionId = newConnection.id;
        const metadata = serializeSolarEdgeMetadata(
          connections,
          activeConnectionId,
          newConnection.baseUrl ?? existingMetadata.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: SOLAR_EDGE_PROVIDER,
          accessToken: newConnection.apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId,
          totalConnections: connections.length,
        };
      }),
    setActiveConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("SolarEdge");
        }
        const metadataState = parseSolarEdgeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
        if (!activeConnection) {
          throw new Error("Selected SolarEdge API profile was not found.");
        }

        const metadata = serializeSolarEdgeMetadata(
          metadataState.connections,
          activeConnection.id,
          activeConnection.baseUrl ?? metadataState.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: SOLAR_EDGE_PROVIDER,
          accessToken: activeConnection.apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId: activeConnection.id,
        };
      }),
    removeConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("SolarEdge");
        }
        const metadataState = parseSolarEdgeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);

        if (nextConnections.length === 0) {
          if (integration.id) {
            await deleteIntegration(integration.id);
          }
          return {
            success: true,
            connected: false,
            activeConnectionId: null,
            totalConnections: 0,
          };
        }

        const nextActiveConnection =
          nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ?? nextConnections[0];
        const metadata = serializeSolarEdgeMetadata(
          nextConnections,
          nextActiveConnection.id,
          nextActiveConnection.baseUrl ?? metadataState.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: SOLAR_EDGE_PROVIDER,
          accessToken: nextActiveConnection.apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          connected: true,
          activeConnectionId: nextActiveConnection.id,
          totalConnections: nextConnections.length,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listSites: protectedProcedure.query(async ({ ctx }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      return listSitesSolarEdge(context);
    }),
    getOverview: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteOverview(context, input.siteId.trim());
      }),
    getDetails: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteDetails(context, input.siteId.trim());
      }),
    getEnergy: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timeUnit: z.enum(["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteEnergy(context, input.siteId.trim(), input.startDate, input.endDate, input.timeUnit);
      }),
    getProductionMeterReadings: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timeUnit: z.enum(["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteEnergyDetails(
          context,
          input.siteId.trim(),
          input.startDate,
          input.endDate,
          input.timeUnit,
          "PRODUCTION"
        );
      }),
    getMeters: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteMeters(context, input.siteId.trim(), input.startDate, input.endDate);
      }),
    getInverterProduction: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteInverterProduction(context, input.siteId.trim(), input.startDate, input.endDate);
      }),
    getProductionSnapshot: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        return getSiteProductionSnapshotSolarEdge(context, input.siteId.trim(), input.anchorDate);
      }),
    getProductionSnapshots: protectedProcedure
      .input(
        z.object({
          siteIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniqueSiteIds = Array.from(
          new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("SolarEdge");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        const rows = await mapWithConcurrency(uniqueSiteIds, 4, async (siteId) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getSiteProductionSnapshotSolarEdge>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          let fallbackSnapshot: Awaited<ReturnType<typeof getSiteProductionSnapshotSolarEdge>> | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getSiteProductionSnapshotSolarEdge(
              {
                apiKey: connection.apiKey,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              siteId,
              input.anchorDate
            );

            if (!fallbackSnapshot) {
              fallbackSnapshot = snapshot;
            }

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          const anchorDate = selectedSnapshot?.anchorDate ?? fallbackSnapshot?.anchorDate ?? input.anchorDate ?? "";
          const monthlyStartDate =
            selectedSnapshot?.monthlyStartDate ?? fallbackSnapshot?.monthlyStartDate ?? input.anchorDate ?? "";
          const weeklyStartDate =
            selectedSnapshot?.weeklyStartDate ?? fallbackSnapshot?.weeklyStartDate ?? input.anchorDate ?? "";
          const mtdStartDate = selectedSnapshot?.mtdStartDate ?? fallbackSnapshot?.mtdStartDate ?? input.anchorDate ?? "";
          const previousCalendarMonthStartDate =
            selectedSnapshot?.previousCalendarMonthStartDate ??
            fallbackSnapshot?.previousCalendarMonthStartDate ??
            input.anchorDate ??
            "";
          const previousCalendarMonthEndDate =
            selectedSnapshot?.previousCalendarMonthEndDate ??
            fallbackSnapshot?.previousCalendarMonthEndDate ??
            input.anchorDate ??
            "";
          const last12MonthsStartDate =
            selectedSnapshot?.last12MonthsStartDate ?? fallbackSnapshot?.last12MonthsStartDate ?? input.anchorDate ?? "";

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            siteId,
            status: notFoundStatus,
            found: false,
            siteName: null,
            lifetimeKwh: null,
            hourlyProductionKwh: null,
            monthlyProductionKwh: null,
            mtdProductionKwh: null,
            previousCalendarMonthProductionKwh: null,
            last12MonthsProductionKwh: null,
            weeklyProductionKwh: null,
            dailyProductionKwh: null,
            anchorDate,
            monthlyStartDate,
            weeklyStartDate,
            mtdStartDate,
            previousCalendarMonthStartDate,
            previousCalendarMonthEndDate,
            last12MonthsStartDate,
            inverterLifetimes: null,
            meterLifetimeKwh: null,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
    getMeterSnapshots: protectedProcedure
      .input(
        z.object({
          siteIds: z.array(z.string().min(1)).min(1).max(200),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniqueSiteIds = Array.from(
          new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("SolarEdge");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        const rows = await mapWithConcurrency(uniqueSiteIds, 4, async (siteId) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getSiteMeterSnapshot>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getSiteMeterSnapshot(
              {
                apiKey: connection.apiKey,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              siteId
            );

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            siteId,
            status: notFoundStatus,
            found: false,
            meterCount: null,
            productionMeterCount: null,
            consumptionMeterCount: null,
            meterTypes: [],
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
    getInverterSnapshots: protectedProcedure
      .input(
        z.object({
          siteIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniqueSiteIds = Array.from(
          new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("SolarEdge");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        let processedCount = 0;
        let errorCount = 0;
        let circuitBroken = false;

        const rows = await mapWithConcurrency(uniqueSiteIds, 20, async (siteId) => {
          if (circuitBroken) {
            return {
              siteId,
              status: "Error" as const,
              found: false,
              inverterCount: null,
              invertersWithTelemetry: null,
              inverterFailures: null,
              totalLatestPowerW: null,
              totalLatestEnergyWh: null,
              firstTelemetryAt: null,
              lastTelemetryAt: null,
              error: "Aborted: API failure rate too high in this batch.",
              matchedConnectionId: null,
              matchedConnectionName: null,
              checkedConnections: targetConnections.length,
              foundInConnections: 0,
              profileStatusSummary: "",
            };
          }

          let selectedSnapshot: Awaited<ReturnType<typeof getSiteInverterSnapshot>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getSiteInverterSnapshot(
              {
                apiKey: connection.apiKey,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              siteId,
              input.anchorDate
            );

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          if (selectedSnapshot && selectedConnection) {
            processedCount += 1;
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          processedCount += 1;
          if (notFoundStatus === "Error") errorCount += 1;
          if (processedCount >= 15 && errorCount / processedCount > 0.8) {
            circuitBroken = true;
          }

          return {
            siteId,
            status: notFoundStatus,
            found: false,
            inverterCount: null,
            invertersWithTelemetry: null,
            inverterFailures: null,
            totalLatestPowerW: null,
            totalLatestEnergyWh: null,
            firstTelemetryAt: null,
            lastTelemetryAt: null,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
  }),

  fronius: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
      const activeConnection =
        metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];

      return {
        connected: metadata.connections.length > 0,
        activeConnectionId: activeConnection?.id ?? null,
        connections: metadata.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          accessKeyIdMasked: maskApiKey(connection.accessKeyId),
          accessKeyValueMasked: maskApiKey(connection.accessKeyValue),
          updatedAt: connection.updatedAt,
          isActive: connection.id === activeConnection?.id,
        })),
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          accessKeyId: z.string().min(1),
          accessKeyValue: z.string().min(1),
          connectionName: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
        const existingMetadata = parseFroniusMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
        const nowIso = new Date().toISOString();
        const newConnection: FroniusConnectionConfig = {
          id: nanoid(),
          name:
            toNonEmptyString(input.connectionName) ??
            `Fronius API ${existingMetadata.connections.length + 1}`,
          accessKeyId: input.accessKeyId.trim(),
          accessKeyValue: input.accessKeyValue.trim(),
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const connections = [newConnection, ...existingMetadata.connections];
        const activeConnectionId = newConnection.id;
        const metadata = serializeFroniusMetadata(connections, activeConnectionId);

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: FRONIUS_PROVIDER,
          accessToken: newConnection.accessKeyId,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId,
          totalConnections: connections.length,
        };
      }),
    setActiveConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("Fronius");
        }
        const metadataState = parseFroniusMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
        if (!activeConnection) {
          throw new Error("Selected Fronius API profile was not found.");
        }

        const metadata = serializeFroniusMetadata(metadataState.connections, activeConnection.id);

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: FRONIUS_PROVIDER,
          accessToken: activeConnection.accessKeyId,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId: activeConnection.id,
        };
      }),
    removeConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("Fronius");
        }
        const metadataState = parseFroniusMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);

        if (nextConnections.length === 0) {
          if (integration.id) {
            await deleteIntegration(integration.id);
          }
          return {
            success: true,
            connected: false,
            activeConnectionId: null,
            totalConnections: 0,
          };
        }

        const nextActiveConnection =
          nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ?? nextConnections[0];
        const metadata = serializeFroniusMetadata(nextConnections, nextActiveConnection.id);

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: FRONIUS_PROVIDER,
          accessToken: nextActiveConnection.accessKeyId,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          connected: true,
          activeConnectionId: nextActiveConnection.id,
          totalConnections: nextConnections.length,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listPvSystems: protectedProcedure.query(async ({ ctx }) => {
      const context = await getFroniusContext(ctx.user.id);
      return listPvSystems(context);
    }),
    getPvSystemDetails: protectedProcedure
      .input(
        z.object({
          pvSystemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getFroniusContext(ctx.user.id);
        return getPvSystemDetails(context, input.pvSystemId.trim());
      }),
    getDevices: protectedProcedure
      .input(
        z.object({
          pvSystemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getFroniusContext(ctx.user.id);
        return getPvSystemDevices(context, input.pvSystemId.trim());
      }),
    getAggData: protectedProcedure
      .input(
        z.object({
          pvSystemId: z.string().min(1),
          from: z.string().optional(),
          to: z.string().optional(),
          period: z.enum(["Total", "Years", "Months", "Days"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getFroniusContext(ctx.user.id);
        return getAggrData(context, input.pvSystemId.trim(), input.from, input.to);
      }),
    getFlowData: protectedProcedure
      .input(
        z.object({
          pvSystemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getFroniusContext(ctx.user.id);
        return getFlowData(context, input.pvSystemId.trim());
      }),
    getProductionSnapshot: protectedProcedure
      .input(
        z.object({
          pvSystemId: z.string().min(1),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getFroniusContext(ctx.user.id);
        let systemName: string | null = null;
        try {
          const details = await getPvSystemDetails(context, input.pvSystemId.trim());
          const systems = extractPvSystems(Array.isArray(details) ? details : [details]);
          systemName = systems[0]?.name ?? null;
        } catch {
          // Non-critical — proceed without name
        }
        return getPvSystemProductionSnapshot(context, input.pvSystemId.trim(), input.anchorDate, systemName);
      }),
    getProductionSnapshots: protectedProcedure
      .input(
        z.object({
          pvSystemIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniquePvSystemIds = Array.from(
          new Set(input.pvSystemIds.map((id) => id.trim()).filter((id) => id.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
        const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("Fronius");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        // Fetch system names once upfront to include in snapshot results
        const nameMap = new Map<string, string>();
        try {
          const { pvSystems } = await listPvSystems({
            accessKeyId: activeConnection.accessKeyId,
            accessKeyValue: activeConnection.accessKeyValue,
          });
          for (const sys of pvSystems) {
            nameMap.set(sys.pvSystemId, sys.name);
          }
        } catch {
          // Non-critical — proceed without names if the list call fails
        }

        const rows = await mapWithConcurrency(uniquePvSystemIds, 4, async (pvSystemId: string) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getPvSystemProductionSnapshot>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          let fallbackSnapshot: Awaited<ReturnType<typeof getPvSystemProductionSnapshot>> | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getPvSystemProductionSnapshot(
              {
                accessKeyId: connection.accessKeyId,
                accessKeyValue: connection.accessKeyValue,
              },
              pvSystemId,
              input.anchorDate,
              nameMap.get(pvSystemId) ?? null
            );

            if (!fallbackSnapshot) {
              fallbackSnapshot = snapshot;
            }

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          const anchorDate = selectedSnapshot?.anchorDate ?? fallbackSnapshot?.anchorDate ?? input.anchorDate ?? "";
          const monthlyStartDate =
            selectedSnapshot?.monthlyStartDate ?? fallbackSnapshot?.monthlyStartDate ?? input.anchorDate ?? "";
          const weeklyStartDate =
            selectedSnapshot?.weeklyStartDate ?? fallbackSnapshot?.weeklyStartDate ?? input.anchorDate ?? "";
          const mtdStartDate = selectedSnapshot?.mtdStartDate ?? fallbackSnapshot?.mtdStartDate ?? input.anchorDate ?? "";
          const previousCalendarMonthStartDate =
            selectedSnapshot?.previousCalendarMonthStartDate ??
            fallbackSnapshot?.previousCalendarMonthStartDate ??
            input.anchorDate ??
            "";
          const previousCalendarMonthEndDate =
            selectedSnapshot?.previousCalendarMonthEndDate ??
            fallbackSnapshot?.previousCalendarMonthEndDate ??
            input.anchorDate ??
            "";
          const last12MonthsStartDate =
            selectedSnapshot?.last12MonthsStartDate ?? fallbackSnapshot?.last12MonthsStartDate ?? input.anchorDate ?? "";

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            pvSystemId,
            name: nameMap.get(pvSystemId) ?? null,
            status: notFoundStatus,
            found: false,
            lifetimeKwh: null,
            hourlyProductionKwh: null,
            monthlyProductionKwh: null,
            mtdProductionKwh: null,
            previousCalendarMonthProductionKwh: null,
            last12MonthsProductionKwh: null,
            weeklyProductionKwh: null,
            dailyProductionKwh: null,
            anchorDate,
            monthlyStartDate,
            weeklyStartDate,
            mtdStartDate,
            previousCalendarMonthStartDate,
            previousCalendarMonthEndDate,
            last12MonthsStartDate,
            lifetimeChannelName: null,
            lifetimeChannelUnit: null,
            lifetimeChannelSelection: null,
            dailyChannelName: null,
            dailyChannelUnit: null,
            dailyChannelSelection: null,
            monthlyChannelName: null,
            monthlyChannelUnit: null,
            monthlyChannelSelection: null,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
    getDeviceSnapshots: protectedProcedure
      .input(
        z.object({
          pvSystemIds: z.array(z.string().min(1)).min(1).max(200),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniquePvSystemIds = Array.from(
          new Set(input.pvSystemIds.map((id) => id.trim()).filter((id) => id.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, FRONIUS_PROVIDER);
        const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("Fronius");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        // Fetch system names once upfront to include in snapshot results
        const nameMap = new Map<string, string>();
        try {
          const { pvSystems } = await listPvSystems({
            accessKeyId: activeConnection.accessKeyId,
            accessKeyValue: activeConnection.accessKeyValue,
          });
          for (const sys of pvSystems) {
            nameMap.set(sys.pvSystemId, sys.name);
          }
        } catch {
          // Non-critical — proceed without names if the list call fails
        }

        const rows = await mapWithConcurrency(uniquePvSystemIds, 4, async (pvSystemId: string) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getPvSystemDeviceSnapshot>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getPvSystemDeviceSnapshot(
              {
                accessKeyId: connection.accessKeyId,
                accessKeyValue: connection.accessKeyValue,
              },
              pvSystemId,
              nameMap.get(pvSystemId) ?? null
            );

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            pvSystemId,
            name: nameMap.get(pvSystemId) ?? null,
            status: notFoundStatus,
            found: false,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
  }),

  ennexOs: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
      const metadata = parseEnnexOsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
      const activeConnection =
        metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ??
        metadata.connections[0];

      return {
        connected: metadata.connections.length > 0,
        baseUrl: activeConnection?.baseUrl ?? metadata.baseUrl,
        activeConnectionId: activeConnection?.id ?? null,
        connections: metadata.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          baseUrl: connection.baseUrl,
          accessTokenMasked: maskApiKey(connection.accessToken),
          accessKeyIdMasked: maskApiKey(connection.accessToken),
          accessKeyValueMasked: connection.baseUrl,
          updatedAt: connection.updatedAt,
          isActive: connection.id === activeConnection?.id,
        })),
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          accessToken: z.string().optional(),
          accessKeyId: z.string().optional(),
          baseUrl: z.string().optional(),
          accessKeyValue: z.string().optional(),
          connectionName: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const accessToken =
          toNonEmptyString(input.accessToken) ?? toNonEmptyString(input.accessKeyId);
        if (!accessToken) {
          throw new Error("Access token is required.");
        }

        const existing = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
        const existingMetadata = parseEnnexOsMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
        const nowIso = new Date().toISOString();
        const newConnection: EnnexOsConnectionConfig = {
          id: nanoid(),
          name:
            toNonEmptyString(input.connectionName) ??
            `ennexOS API ${existingMetadata.connections.length + 1}`,
          accessToken,
          baseUrl:
            toNonEmptyString(input.baseUrl) ??
            toNonEmptyString(input.accessKeyValue) ??
            existingMetadata.baseUrl,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const connections = [newConnection, ...existingMetadata.connections];
        const activeConnectionId = newConnection.id;
        const metadata = serializeEnnexOsMetadata(
          connections,
          activeConnectionId,
          newConnection.baseUrl ?? existingMetadata.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENNEX_OS_PROVIDER,
          accessToken: newConnection.accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId,
          totalConnections: connections.length,
        };
      }),
    setActiveConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("ennexOS");
        }
        const metadataState = parseEnnexOsMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
        if (!activeConnection) {
          throw new Error("Selected ennexOS API profile was not found.");
        }

        const metadata = serializeEnnexOsMetadata(
          metadataState.connections,
          activeConnection.id,
          activeConnection.baseUrl ?? metadataState.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENNEX_OS_PROVIDER,
          accessToken: activeConnection.accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId: activeConnection.id,
        };
      }),
    removeConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("ennexOS");
        }
        const metadataState = parseEnnexOsMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);

        if (nextConnections.length === 0) {
          if (integration.id) {
            await deleteIntegration(integration.id);
          }
          return {
            success: true,
            connected: false,
            activeConnectionId: null,
            totalConnections: 0,
          };
        }

        const nextActiveConnection =
          nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ??
          nextConnections[0];
        const metadata = serializeEnnexOsMetadata(
          nextConnections,
          nextActiveConnection.id,
          nextActiveConnection.baseUrl ?? metadataState.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENNEX_OS_PROVIDER,
          accessToken: nextActiveConnection.accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          connected: true,
          activeConnectionId: nextActiveConnection.id,
          totalConnections: nextConnections.length,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listPlants: protectedProcedure.query(async ({ ctx }) => {
      const context = await getEnnexOsContext(ctx.user.id);
      return listPlantsEnnexos(context);
    }),
    getPlantDetails: protectedProcedure
      .input(
        z.object({
          plantId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnnexOsContext(ctx.user.id);
        return getPlantDetails(context, input.plantId.trim());
      }),
    getDevices: protectedProcedure
      .input(
        z.object({
          plantId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnnexOsContext(ctx.user.id);
        return getPlantDevices(context, input.plantId.trim());
      }),
    getAggData: protectedProcedure
      .input(
        z.object({
          plantId: z.string().min(1),
          from: z.string().optional(),
          to: z.string().optional(),
          period: z.enum(["Total", "Years", "Months", "Days"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnnexOsContext(ctx.user.id);
        const normalizedPeriod =
          input.period === "Years"
            ? "Year"
            : input.period === "Months" || input.period === "Total"
              ? "Month"
              : "Day";
        const dateArg = toNonEmptyString(input.to) ?? toNonEmptyString(input.from) ?? null;
        const raw = await getPlantMeasurements(
          context,
          input.plantId.trim(),
          "EnergyBalance",
          normalizedPeriod,
          dateArg
        );
        return {
          plantId: input.plantId.trim(),
          measurementSet: "EnergyBalance",
          period: normalizedPeriod,
          from: input.from ?? null,
          to: input.to ?? null,
          date: dateArg,
          raw,
        };
      }),
    getFlowData: protectedProcedure
      .input(
        z.object({
          plantId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnnexOsContext(ctx.user.id);
        const raw = await getPlantMeasurements(
          context,
          input.plantId.trim(),
          "EnergyBalance",
          "Day",
          getTodayDateKey()
        );
        return {
          plantId: input.plantId.trim(),
          measurementSet: "EnergyBalance",
          period: "Day",
          date: getTodayDateKey(),
          raw,
        };
      }),
    getMeasurements: protectedProcedure
      .input(
        z.object({
          plantId: z.string().min(1),
          measurementSet: z.string().optional(),
          period: z.string().optional(),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnnexOsContext(ctx.user.id);
        return getPlantMeasurements(
          context,
          input.plantId.trim(),
          toNonEmptyString(input.measurementSet) ?? "EnergyBalance",
          toNonEmptyString(input.period) ?? "Day",
          input.date
        );
      }),
    getProductionSnapshot: protectedProcedure
      .input(
        z.object({
          plantId: z.string().min(1),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnnexOsContext(ctx.user.id);
        return getPlantProductionSnapshotEnnexos(context, input.plantId.trim(), input.anchorDate);
      }),
    getProductionSnapshots: protectedProcedure
      .input(
        z.object({
          plantIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniquePlantIds = Array.from(
          new Set(input.plantIds.map((id) => id.trim()).filter((id) => id.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
        const metadata = parseEnnexOsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("ennexOS");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        // Fetch plant names once upfront to include in snapshot results.
        const plantNameMap = new Map<string, string>();
        try {
          const { plants } = await listPlantsEnnexos({
            accessToken: activeConnection.accessToken,
            baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
          });
          for (const plant of plants) {
            plantNameMap.set(plant.plantId, plant.name);
          }
        } catch {
          // Non-critical — proceed without names if the list call fails.
        }

        const rows = await mapWithConcurrency(uniquePlantIds, 4, async (plantId: string) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getPlantProductionSnapshotEnnexos>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          let fallbackSnapshot: Awaited<ReturnType<typeof getPlantProductionSnapshotEnnexos>> | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getPlantProductionSnapshotEnnexos(
              {
                accessToken: connection.accessToken,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              plantId,
              input.anchorDate
            );

            if (!fallbackSnapshot) {
              fallbackSnapshot = snapshot;
            }

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          const anchorDate = selectedSnapshot?.anchorDate ?? fallbackSnapshot?.anchorDate ?? input.anchorDate ?? "";
          const monthlyStartDate =
            selectedSnapshot?.monthlyStartDate ?? fallbackSnapshot?.monthlyStartDate ?? input.anchorDate ?? "";
          const weeklyStartDate =
            selectedSnapshot?.weeklyStartDate ?? fallbackSnapshot?.weeklyStartDate ?? input.anchorDate ?? "";
          const mtdStartDate = selectedSnapshot?.mtdStartDate ?? fallbackSnapshot?.mtdStartDate ?? input.anchorDate ?? "";
          const previousCalendarMonthStartDate =
            selectedSnapshot?.previousCalendarMonthStartDate ??
            fallbackSnapshot?.previousCalendarMonthStartDate ??
            input.anchorDate ??
            "";
          const previousCalendarMonthEndDate =
            selectedSnapshot?.previousCalendarMonthEndDate ??
            fallbackSnapshot?.previousCalendarMonthEndDate ??
            input.anchorDate ??
            "";
          const last12MonthsStartDate =
            selectedSnapshot?.last12MonthsStartDate ?? fallbackSnapshot?.last12MonthsStartDate ?? input.anchorDate ?? "";

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              name: plantNameMap.get(plantId) ?? null,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            plantId,
            name: plantNameMap.get(plantId) ?? null,
            status: notFoundStatus,
            found: false,
            lifetimeKwh: null,
            hourlyProductionKwh: null,
            monthlyProductionKwh: null,
            mtdProductionKwh: null,
            previousCalendarMonthProductionKwh: null,
            last12MonthsProductionKwh: null,
            weeklyProductionKwh: null,
            dailyProductionKwh: null,
            anchorDate,
            monthlyStartDate,
            weeklyStartDate,
            mtdStartDate,
            previousCalendarMonthStartDate,
            previousCalendarMonthEndDate,
            last12MonthsStartDate,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
    getDeviceSnapshots: protectedProcedure
      .input(
        z.object({
          plantIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const uniquePlantIds = Array.from(
          new Set(input.plantIds.map((id) => id.trim()).filter((id) => id.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, ENNEX_OS_PROVIDER);
        const metadata = parseEnnexOsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("ennexOS");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        const rows = await mapWithConcurrency(uniquePlantIds, 4, async (plantId: string) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getPlantDeviceSnapshot>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getPlantDeviceSnapshot(
              {
                accessToken: connection.accessToken,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              plantId,
              input.anchorDate
            );

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            plantId,
            status: notFoundStatus,
            found: false,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
  }),

  zendesk: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
      const metadata = parseZendeskMetadata(integration?.metadata);

      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.subdomain && metadata.email),
        subdomain: metadata.subdomain,
        email: metadata.email,
        trackedUsers: metadata.trackedUsers,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          subdomain: z.string().min(1),
          email: z.string().email(),
          apiToken: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existingIntegration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
        const existingMetadata = parseZendeskMetadata(existingIntegration?.metadata);

        const normalizedSubdomain = normalizeZendeskSubdomainInput(input.subdomain);
        if (!normalizedSubdomain) {
          throw new Error("Zendesk subdomain is invalid.");
        }

        const metadata = serializeZendeskMetadata({
          subdomain: normalizedSubdomain,
          email: input.email.trim().toLowerCase(),
          trackedUsers: existingMetadata.trackedUsers,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ZENDESK_PROVIDER,
          accessToken: input.apiToken.trim(),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    saveTrackedUsers: protectedProcedure
      .input(
        z.object({
          users: z.array(z.string().min(1).max(200)).max(500),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("Zendesk");
        }
        const metadata = parseZendeskMetadata(integration.metadata);
        if (!metadata.subdomain || !metadata.email) {
          throw new Error("Zendesk metadata is incomplete. Reconnect first.");
        }

        const nextMetadata = serializeZendeskMetadata({
          subdomain: metadata.subdomain,
          email: metadata.email,
          trackedUsers: input.users,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ZENDESK_PROVIDER,
          accessToken: integration.accessToken,
          refreshToken: integration.refreshToken,
          expiresAt: integration.expiresAt,
          scope: integration.scope,
          metadata: nextMetadata,
        });

        return {
          success: true,
          trackedUsers: parseZendeskMetadata(nextMetadata).trackedUsers,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    getTicketMetrics: protectedProcedure
      .input(
        z
          .object({
            maxTickets: z.number().int().min(100).max(50000).optional(),
            periodStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            trackedUsersOnly: z.boolean().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
        const metadata = parseZendeskMetadata(integration?.metadata);
        const zendeskContext = await getZendeskContext(ctx.user.id);
        return getZendeskTicketMetricsByAssignee(zendeskContext, {
          maxTickets: input?.maxTickets ?? 10000,
          periodStartDate: input?.periodStartDate,
          periodEndDate: input?.periodEndDate,
          trackedUsers: input?.trackedUsersOnly ? metadata.trackedUsers : undefined,
        });
      }),
  }),

  egauge: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
      const metadata = parseEgaugeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
      const activeConnection =
        metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];
      const requiresCredentials = activeConnection ? activeConnection.accessType !== "public" : false;

      return {
        connected: metadata.connections.length > 0,
        baseUrl: activeConnection?.baseUrl ?? null,
        accessType: activeConnection?.accessType ?? null,
        username: activeConnection?.username ?? null,
        hasPassword: Boolean(activeConnection?.password),
        requiresCredentials,
        activeConnectionId: activeConnection?.id ?? null,
        connections: metadata.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          meterId: connection.meterId,
          baseUrl: connection.baseUrl,
          accessType: connection.accessType,
          username: connection.username,
          hasPassword: Boolean(connection.password),
          updatedAt: connection.updatedAt,
          isActive: connection.id === activeConnection?.id,
        })),
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          connectionName: z.string().optional(),
          meterId: z.string().optional(),
          baseUrl: z.string().min(1),
          accessType: z.enum(["public", "user_login", "portfolio_login"]),
          username: z.string().optional(),
          password: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const accessType: EgaugeAccessType = input.accessType;
        const username = toNonEmptyString(input.username);
        const password = toNonEmptyString(input.password);

        const normalizedBaseUrl =
          accessType === "portfolio_login"
            ? normalizeEgaugePortfolioBaseUrl(input.baseUrl)
            : normalizeEgaugeBaseUrl(input.baseUrl);
        const resolvedUsernameForId = toNonEmptyString(input.username)?.toLowerCase().replace(/[^a-z0-9._-]/g, "_") ?? "unknown";
        const normalizedMeterId =
          toNonEmptyString(input.meterId)?.toLowerCase() ??
          (accessType === "portfolio_login"
            ? `portfolio-${resolvedUsernameForId}`
            : deriveEgaugeMeterId(normalizedBaseUrl).toLowerCase());

        const existing = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
        const metadataState = parseEgaugeMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
        const nowIso = new Date().toISOString();
        const existingConnection = metadataState.connections.find((connection) => connection.meterId === normalizedMeterId);
        const resolvedUsername =
          accessType === "public"
            ? null
            : username ?? existingConnection?.username ?? null;

        const usernameChanged =
          existingConnection &&
          resolvedUsername &&
          existingConnection.username &&
          resolvedUsername.toLowerCase() !== existingConnection.username.toLowerCase();

        const resolvedPassword =
          accessType === "public"
            ? null
            : password ?? (usernameChanged ? null : existingConnection?.password ?? null);

        if (accessType !== "public" && (!resolvedUsername || !resolvedPassword)) {
          throw new Error(
            usernameChanged
              ? "Password is required when changing the username. Please enter the password for the new account."
              : "Username and password are required for credentialed login."
          );
        }

        let nextConnections: EgaugeConnectionConfig[];
        let activeConnectionId: string;
        if (existingConnection) {
          const updatedConnection: EgaugeConnectionConfig = {
            ...existingConnection,
            name: toNonEmptyString(input.connectionName) ?? existingConnection.name,
            meterId: normalizedMeterId,
            baseUrl: normalizedBaseUrl,
            accessType,
            username: resolvedUsername,
            password: resolvedPassword,
            updatedAt: nowIso,
          };
          nextConnections = [updatedConnection, ...metadataState.connections.filter((c) => c.id !== existingConnection.id)];
          activeConnectionId = updatedConnection.id;
        } else {
          const newConnection: EgaugeConnectionConfig = {
            id: nanoid(),
            name:
              toNonEmptyString(input.connectionName) ??
              (accessType === "portfolio_login"
                ? `eGauge Portfolio (${toNonEmptyString(input.username) ?? "unknown"})`
                : `eGauge ${normalizedMeterId}`),
            meterId: normalizedMeterId,
            baseUrl: normalizedBaseUrl,
            accessType,
            username: resolvedUsername,
            password: resolvedPassword,
            createdAt: nowIso,
            updatedAt: nowIso,
          };
          nextConnections = [newConnection, ...metadataState.connections];
          activeConnectionId = newConnection.id;
        }

        const activeConnection = nextConnections.find((connection) => connection.id === activeConnectionId) ?? nextConnections[0];
        const metadata = serializeEgaugeMetadata(nextConnections, activeConnection.id);

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: EGAUGE_PROVIDER,
          accessToken: activeConnection.password,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId: activeConnection.id,
          totalConnections: nextConnections.length,
          meterId: activeConnection.meterId,
        };
      }),
    setActiveConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("eGauge");
        }
        const metadataState = parseEgaugeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
        if (!activeConnection) {
          throw new Error("Selected eGauge profile was not found.");
        }

        const metadata = serializeEgaugeMetadata(metadataState.connections, activeConnection.id);

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: EGAUGE_PROVIDER,
          accessToken: activeConnection.password,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId: activeConnection.id,
        };
      }),
    removeConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
        if (!integration) {
          throw new IntegrationNotConnectedError("eGauge");
        }

        const metadataState = parseEgaugeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);
        if (nextConnections.length === 0) {
          if (integration.id) {
            await deleteIntegration(integration.id);
          }
          return {
            success: true,
            connected: false,
            activeConnectionId: null,
            totalConnections: 0,
          };
        }

        const nextActiveConnection =
          nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ?? nextConnections[0];
        const metadata = serializeEgaugeMetadata(nextConnections, nextActiveConnection.id);

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: EGAUGE_PROVIDER,
          accessToken: nextActiveConnection.password,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          connected: true,
          activeConnectionId: nextActiveConnection.id,
          totalConnections: nextConnections.length,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    getSystemInfo: protectedProcedure.mutation(async ({ ctx }) => {
      const context = await getEgaugeContext(ctx.user.id);
      if (context.accessType === "portfolio_login") {
        throw new Error("System Info is meter-level. Use Fetch Portfolio Systems for portfolio access.");
      }
      return getEgaugeSystemInfo(context);
    }),
    getLocalData: protectedProcedure.mutation(async ({ ctx }) => {
      const context = await getEgaugeContext(ctx.user.id);
      if (context.accessType === "portfolio_login") {
        throw new Error("Local Data is meter-level. Use Fetch Portfolio Systems for portfolio access.");
      }
      return getEgaugeLocalData(context);
    }),
    getRegisterLatest: protectedProcedure
      .input(
        z
          .object({
            register: z.string().optional(),
            includeRate: z.boolean().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEgaugeContext(ctx.user.id);
        if (context.accessType === "portfolio_login") {
          throw new Error("Register Latest is meter-level. Use Fetch Portfolio Systems for portfolio access.");
        }
        return getEgaugeRegisterLatest(context, {
          register: input?.register,
          includeRate: input?.includeRate,
        });
      }),
    getRegisterHistory: protectedProcedure
      .input(
        z.object({
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          intervalMinutes: z.number().int().min(1).max(1440).optional(),
          register: z.string().optional(),
          includeRate: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEgaugeContext(ctx.user.id);
        if (context.accessType === "portfolio_login") {
          throw new Error("Register History is meter-level. Use Fetch Portfolio Systems for portfolio access.");
        }
        return getEgaugeRegisterHistory(context, {
          startDate: input.startDate,
          endDate: input.endDate,
          intervalMinutes: input.intervalMinutes ?? 15,
          register: input.register,
          includeRate: input.includeRate,
        });
      }),
    getPortfolioSystems: protectedProcedure
      .input(
        z
          .object({
            filter: z.string().optional(),
            groupId: z.string().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEgaugeContext(ctx.user.id);
        if (context.accessType !== "portfolio_login") {
          throw new Error("Switch access type to Portfolio Login, then run Fetch Portfolio Systems.");
        }
        return getEgaugePortfolioSystems(context, {
          filter: input?.filter,
          groupId: input?.groupId,
        });
      }),
    getProductionSnapshots: protectedProcedure
      .input(
        z
          .object({
            meterIds: z.array(z.string().min(1)).max(5000).optional(),
            anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            autoFetchPortfolioIds: z.boolean().optional(),
            filter: z.string().optional(),
            groupId: z.string().optional(),
          })
          .refine(
            (value) => Boolean(value.autoFetchPortfolioIds) || (value.meterIds?.length ?? 0) > 0,
            {
              message: "Provide at least one meter ID or enable portfolio auto-fetch.",
              path: ["meterIds"],
            }
          )
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
        const metadata = parseEgaugeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new IntegrationNotConnectedError("eGauge");
        }
        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ??
          allConnections[0];

        const anchorDate =
          input.anchorDate ??
          (() => {
            const now = new Date();
            return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
          })();

        const requestedMeterIds = (input.meterIds ?? [])
          .map((id) => id.trim())
          .filter((id) => id.length > 0);
        const uniqueMeterIdsByKey = new Map<string, string>();
        requestedMeterIds.forEach((meterId) => {
          const key = meterId.toLowerCase();
          if (!uniqueMeterIdsByKey.has(key)) {
            uniqueMeterIdsByKey.set(key, meterId);
          }
        });
        const uniqueMeterIds = Array.from(uniqueMeterIdsByKey.values());

        const usePortfolioBulk =
          activeConnection.accessType === "portfolio_login" || Boolean(input.autoFetchPortfolioIds);

        if (usePortfolioBulk) {
          if (activeConnection.accessType !== "portfolio_login") {
            throw new Error(
              "Portfolio auto-fetch requires the active eGauge profile to use Portfolio Login."
            );
          }

          const portfolioResult = await getEgaugePortfolioSystems(
            {
              baseUrl: activeConnection.baseUrl,
              accessType: activeConnection.accessType,
              username: activeConnection.username,
              password: activeConnection.password,
            },
            {
              filter: input.filter,
              groupId: input.groupId,
              anchorDate,
            }
          );

          const portfolioRowsByMeterId = new Map(
            portfolioResult.rows.map((row) => [row.meterId.trim().toLowerCase(), row])
          );

          const rows =
            uniqueMeterIds.length > 0
              ? uniqueMeterIds.map((meterId) => {
                  const matchedRow = portfolioRowsByMeterId.get(meterId.toLowerCase());
                  if (matchedRow) return matchedRow;
                  return {
                    meterId,
                    meterName: null,
                    status: "Not Found" as const,
                    found: false,
                    lifetimeKwh: null,
                    anchorDate,
                    error: `Meter ID "${meterId}" was not returned by the portfolio site list.`,
                  };
                })
              : portfolioResult.rows;

          return {
            total: rows.length,
            found: rows.filter((row) => row.status === "Found").length,
            notFound: rows.filter((row) => row.status === "Not Found").length,
            errored: rows.filter((row) => row.status === "Error").length,
            source: "portfolio" as const,
            meterIdsUsed: rows.map((row) => row.meterId),
            rows,
          };
        }

        // Build map from meterId to non-portfolio meter connections for quick lookup.
        const connectionByMeterId = new Map(
          allConnections
            .filter((conn) => conn.accessType !== "portfolio_login")
            .map((conn) => [conn.meterId.toLowerCase(), conn])
        );

        if (uniqueMeterIds.length === 0) {
          throw new Error("Provide at least one meter ID.");
        }

        const rows = await mapWithConcurrency(uniqueMeterIds, 4, async (meterId: string) => {
          const conn = connectionByMeterId.get(meterId.toLowerCase());
          if (!conn) {
            return {
              meterId,
              meterName: null,
              status: "Not Found" as const,
              found: false,
              lifetimeKwh: null,
              anchorDate,
              error: `No saved connection for meter ID "${meterId}".`,
            };
          }

          return getMeterProductionSnapshotEgauge(
            {
              baseUrl: conn.baseUrl,
              accessType: conn.accessType,
              username: conn.username,
              password: conn.password,
            },
            meterId,
            conn.name,
            anchorDate
          );
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          source: "saved_connections" as const,
          meterIdsUsed: uniqueMeterIds,
          rows,
        };
      }),
    getAllPortfolioSnapshots: protectedProcedure
      .input(
        z
          .object({
            filter: z.string().optional(),
            groupId: z.string().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, EGAUGE_PROVIDER);
        const metadata = parseEgaugeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const portfolioConnections = metadata.connections.filter(
          (c) => c.accessType === "portfolio_login" && c.username && c.password
        );

        if (portfolioConnections.length === 0) {
          throw new Error("No portfolio login connections found. Save at least one Portfolio Login profile first.");
        }

        const portfolioResults: Array<{
          connectionId: string;
          connectionName: string;
          username: string | null;
          total: number;
          found: number;
          error: string | null;
        }> = [];
        const seenMeterIds = new Set<string>();
        const mergedRows: Array<Record<string, unknown>> = [];

        for (const conn of portfolioConnections) {
          try {
            const result = await getEgaugePortfolioSystems(
              {
                baseUrl: conn.baseUrl,
                accessType: conn.accessType,
                username: conn.username,
                password: conn.password,
              },
              {
                filter: input?.filter,
                groupId: input?.groupId,
              }
            );

            portfolioResults.push({
              connectionId: conn.id,
              connectionName: conn.name,
              username: conn.username,
              total: result.total,
              found: result.found,
              error: null,
            });

            for (const row of result.rows) {
              const key = (row.meterId ?? "").trim().toLowerCase();
              if (key && !seenMeterIds.has(key)) {
                seenMeterIds.add(key);
                mergedRows.push({ ...row, portfolioAccount: conn.username });
              }
            }
          } catch (error) {
            portfolioResults.push({
              connectionId: conn.id,
              connectionName: conn.name,
              username: conn.username,
              total: 0,
              found: 0,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return {
          portfolioCount: portfolioConnections.length,
          portfolioResults,
          total: mergedRows.length,
          found: mergedRows.filter((r) => r.status === "Found").length,
          notFound: mergedRows.filter((r) => r.status === "Not Found").length,
          errored: mergedRows.filter((r) => r.status === "Error").length,
          rows: mergedRows,
        };
      }),
  }),

  teslaSolar: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_SOLAR_PROVIDER);
      const metadata = parseTeslaSolarMetadata(integration?.metadata);
      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken)),
        baseUrl: metadata.baseUrl,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          accessToken: z.string().min(1),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const metadata = JSON.stringify({
          baseUrl: toNonEmptyString(input.baseUrl),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: TESLA_SOLAR_PROVIDER,
          accessToken: input.accessToken.trim(),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_SOLAR_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listProducts: protectedProcedure.query(async ({ ctx }) => {
      const context = await getTeslaSolarContext(ctx.user.id);
      return listTeslaProducts(context);
    }),
    listSites: protectedProcedure.query(async ({ ctx }) => {
      const context = await getTeslaSolarContext(ctx.user.id);
      const result = await listTeslaProducts(context);
      return {
        sites: result.energySites,
      };
    }),
    getLiveStatus: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaSolarContext(ctx.user.id);
        return getTeslaEnergySiteLiveStatus(context, input.siteId.trim());
      }),
    getSiteInfo: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaSolarContext(ctx.user.id);
        return getTeslaEnergySiteInfo(context, input.siteId.trim());
      }),
    getHistory: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          kind: z.string().optional(),
          period: z.string().optional(),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaSolarContext(ctx.user.id);
        return getTeslaEnergySiteHistory(context, input.siteId.trim(), {
          kind: input.kind,
          period: input.period,
          startDate: input.startDate,
          endDate: input.endDate,
        });
      }),
  }),

  teslaPowerhub: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_POWERHUB_PROVIDER);
      const metadata = parseTeslaPowerhubMetadata(integration?.metadata);
      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.clientId),
        hasClientSecret: Boolean(toNonEmptyString(integration?.accessToken)),
        clientId: metadata.clientId,
        tokenUrl: metadata.tokenUrl,
        apiBaseUrl: metadata.apiBaseUrl,
        portalBaseUrl: metadata.portalBaseUrl,
      };
    }),
    getServerEgressIpv4: protectedProcedure
      .input(
        z
          .object({
            forceRefresh: z.boolean().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return fetchTeslaPowerhubServerEgressIpv4({
          forceRefresh: Boolean(input?.forceRefresh),
        });
      }),
    refreshServerEgressIpv4: protectedProcedure.mutation(async () => {
      return fetchTeslaPowerhubServerEgressIpv4({
        forceRefresh: true,
      });
    }),
    connect: protectedProcedure
      .input(
        z.object({
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
          tokenUrl: z.string().optional(),
          apiBaseUrl: z.string().optional(),
          portalBaseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, TESLA_POWERHUB_PROVIDER);
        const existingMetadata = parseTeslaPowerhubMetadata(existing?.metadata);

        const incomingClientId = toNonEmptyString(input.clientId);
        const resolvedClientId = incomingClientId ?? existingMetadata.clientId;
        const persistedSecret = toNonEmptyString(existing?.accessToken);
        const incomingSecret = toNonEmptyString(input.clientSecret);
        const resolvedSecret = incomingSecret ?? persistedSecret;

        if (!resolvedClientId) {
          throw new Error("Client ID is required for initial Tesla Powerhub connection.");
        }
        if (!resolvedSecret) {
          throw new Error("Client secret is required for initial Tesla Powerhub connection.");
        }

        const incomingTokenUrl = normalizeTeslaPowerhubUrl(input.tokenUrl);
        const incomingApiBaseUrl = normalizeTeslaPowerhubUrl(input.apiBaseUrl);
        const incomingPortalBaseUrl = normalizeTeslaPowerhubUrl(input.portalBaseUrl);

        const metadata = JSON.stringify({
          clientId: resolvedClientId,
          tokenUrl: incomingTokenUrl ?? existingMetadata.tokenUrl,
          apiBaseUrl: incomingApiBaseUrl ?? existingMetadata.apiBaseUrl,
          portalBaseUrl: incomingPortalBaseUrl ?? existingMetadata.portalBaseUrl,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: TESLA_POWERHUB_PROVIDER,
          accessToken: resolvedSecret,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_POWERHUB_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    startGroupProductionMetricsJob: protectedProcedure
      .input(
        z.object({
          groupId: z.string().min(1),
          endpointUrl: z.string().optional(),
          signal: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaPowerhubContext(ctx.user.id);
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        pruneTeslaPowerhubProductionJobs(nowMs);

        const jobId = nanoid();
        const groupId = input.groupId.trim();
        const endpointUrl = input.endpointUrl;
        const signal = input.signal;

        teslaPowerhubProductionJobs.set(jobId, {
          id: jobId,
          userId: ctx.user.id,
          createdAt: nowIso,
          updatedAt: nowIso,
          startedAt: null,
          finishedAt: null,
          status: "queued",
          progress: {
            currentStep: 0,
            totalSteps: 7,
            percent: 0,
            message: "Queued",
            windowKey: null,
          },
          error: null,
          result: null,
          jobConfig: {
            groupId,
            endpointUrl: endpointUrl ?? null,
            signal: signal ?? null,
          },
        });
        const initialJob = teslaPowerhubProductionJobs.get(jobId);
        if (initialJob) {
          void saveTeslaPowerhubProductionJobSnapshot(initialJob).catch((error) => {
            console.warn(
              "[snapshot] Tesla Powerhub initial job snapshot write failed:",
              error instanceof Error ? error.message : error
            );
          });
        }

        launchTeslaPowerhubProductionJobWorker(jobId, context, { groupId, endpointUrl: endpointUrl ?? null, signal: signal ?? null });

        return {
          jobId,
          status: "queued" as const,
        };
      }),
    getGroupProductionMetricsJob: protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
        })
      )
      .query(async ({ ctx, input }) => {
        pruneTeslaPowerhubProductionJobs(Date.now());
        const normalizedJobId = input.jobId.trim();
        const inMemoryJob = teslaPowerhubProductionJobs.get(normalizedJobId);
        if (inMemoryJob && inMemoryJob.userId === ctx.user.id) {
          return inMemoryJob;
        }

        const snapshotJob = await loadTeslaPowerhubProductionJobSnapshot(ctx.user.id, normalizedJobId);
        if (!snapshotJob) {
          throw new Error("Tesla production job not found.");
        }

        let resolvedJob = snapshotJob;
        // If the process restarted, a queued/running snapshot cannot continue in this instance.
        // Auto-resume if we have the original job config; otherwise fall back to failed status.
        if (snapshotJob.status === "queued" || snapshotJob.status === "running") {
          if (snapshotJob.jobConfig && !teslaPowerhubResumingJobIds.has(normalizedJobId)) {
            // Auto-resume: re-launch the job from scratch using persisted config
            teslaPowerhubResumingJobIds.add(normalizedJobId);
            const nowIso = new Date().toISOString();
            resolvedJob = {
              ...snapshotJob,
              status: "queued",
              updatedAt: nowIso,
              finishedAt: null,
              error: null,
              result: null,
              progress: {
                currentStep: 0,
                totalSteps: snapshotJob.progress.totalSteps,
                percent: 0,
                message: "Resuming after server restart...",
                windowKey: null,
              },
            };
            teslaPowerhubProductionJobs.set(normalizedJobId, resolvedJob);
            void saveTeslaPowerhubProductionJobSnapshot(resolvedJob).catch(() => {});

            // Re-fetch credentials and launch worker
            try {
              const context = await getTeslaPowerhubContext(snapshotJob.userId);
              launchTeslaPowerhubProductionJobWorker(normalizedJobId, context, snapshotJob.jobConfig);
              console.info(`[resume] Tesla Powerhub job ${normalizedJobId} auto-resumed after server restart.`);
            } catch (resumeError) {
              teslaPowerhubResumingJobIds.delete(normalizedJobId);
              const errorNowIso = new Date().toISOString();
              resolvedJob = {
                ...resolvedJob,
                status: "failed",
                updatedAt: errorNowIso,
                finishedAt: errorNowIso,
                error: `Auto-resume failed: ${resumeError instanceof Error ? resumeError.message : "Unknown error"}. Please rerun.`,
                progress: { ...resolvedJob.progress, message: "Resume failed" },
              };
              teslaPowerhubProductionJobs.set(normalizedJobId, resolvedJob);
              void saveTeslaPowerhubProductionJobSnapshot(resolvedJob).catch(() => {});
            }
          } else if (!teslaPowerhubResumingJobIds.has(normalizedJobId)) {
            // Legacy job without config — cannot resume, mark as failed
            const nowIso = new Date().toISOString();
            resolvedJob = {
              ...snapshotJob,
              status: "failed",
              updatedAt: nowIso,
              finishedAt: nowIso,
              error:
                snapshotJob.error ??
                "Tesla production job was interrupted (server restarted or deployment changed). Please rerun.",
              progress: {
                ...snapshotJob.progress,
                message: "Interrupted",
                windowKey: null,
              },
            };
            void saveTeslaPowerhubProductionJobSnapshot(resolvedJob).catch(() => {});
          }
          // else: job is already being resumed by another poll — return current in-memory state
        }

        teslaPowerhubProductionJobs.set(normalizedJobId, resolvedJob);
        return resolvedJob;
      }),
    getGroupUsers: protectedProcedure
      .input(
        z.object({
          groupId: z.string().min(1),
          endpointUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaPowerhubContext(ctx.user.id);
        const groupId = input.groupId.trim();

        return getTeslaPowerhubGroupUsers(
          {
            clientId: context.clientId,
            clientSecret: context.clientSecret,
            tokenUrl: context.tokenUrl,
            apiBaseUrl: context.apiBaseUrl,
            portalBaseUrl: context.portalBaseUrl,
          },
          {
            groupId,
            endpointUrl: input.endpointUrl,
          }
        );
      }),
    getGroupProductionMetrics: protectedProcedure
      .input(
        z.object({
          groupId: z.string().min(1),
          endpointUrl: z.string().optional(),
          signal: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaPowerhubContext(ctx.user.id);
        const groupId = input.groupId.trim();

        return getTeslaPowerhubGroupProductionMetrics(
          {
            clientId: context.clientId,
            clientSecret: context.clientSecret,
            tokenUrl: context.tokenUrl,
            apiBaseUrl: context.apiBaseUrl,
            portalBaseUrl: context.portalBaseUrl,
          },
          {
            groupId,
            endpointUrl: input.endpointUrl,
            signal: input.signal,
          }
        );
      }),
  }),

  csgPortal: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
      const metadata = parseCsgPortalMetadata(integration?.metadata);
      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.email),
        email: metadata.email,
        baseUrl: metadata.baseUrl,
        hasPassword: Boolean(toNonEmptyString(integration?.accessToken)),
        lastTestedAt: metadata.lastTestedAt,
        lastTestStatus: metadata.lastTestStatus,
        lastTestMessage: metadata.lastTestMessage,
      };
    }),
    saveCredentials: protectedProcedure
      .input(
        z.object({
          email: z.string().email().optional(),
          password: z.string().min(1).optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const existingMetadata = parseCsgPortalMetadata(existing?.metadata);

        const resolvedEmail = toNonEmptyString(input.email)?.toLowerCase() ?? existingMetadata.email;
        const resolvedPassword =
          toNonEmptyString(input.password) ?? toNonEmptyString(existing?.accessToken);
        const resolvedBaseUrl = toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl;

        if (!resolvedEmail) {
          throw new Error("Portal email is required.");
        }
        if (!resolvedPassword) {
          throw new Error("Portal password is required.");
        }

        const metadata = serializeCsgPortalMetadata({
          email: resolvedEmail,
          baseUrl: resolvedBaseUrl,
          lastTestedAt: existingMetadata.lastTestedAt,
          lastTestStatus: existingMetadata.lastTestStatus,
          lastTestMessage: existingMetadata.lastTestMessage,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: CSG_PORTAL_PROVIDER,
          accessToken: resolvedPassword,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    testConnection: protectedProcedure
      .input(
        z
          .object({
            email: z.string().email().optional(),
            password: z.string().min(1).optional(),
            baseUrl: z.string().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const existingMetadata = parseCsgPortalMetadata(existing?.metadata);
        const resolvedEmail = toNonEmptyString(input?.email)?.toLowerCase() ?? existingMetadata.email;
        const resolvedPassword =
          toNonEmptyString(input?.password) ?? toNonEmptyString(existing?.accessToken);
        const resolvedBaseUrl = toNonEmptyString(input?.baseUrl) ?? existingMetadata.baseUrl;

        if (!resolvedEmail || !resolvedPassword) {
          throw new Error("Missing credentials. Save portal email/password first or provide both for testing.");
        }

        try {
          await testCsgPortalCredentials({
            email: resolvedEmail,
            password: resolvedPassword,
            baseUrl: resolvedBaseUrl ?? undefined,
          });

          const metadata = serializeCsgPortalMetadata({
            email: resolvedEmail,
            baseUrl: resolvedBaseUrl,
            lastTestedAt: new Date().toISOString(),
            lastTestStatus: "success",
            lastTestMessage: "Connection successful.",
          });

          await upsertIntegration({
            id: nanoid(),
            userId: ctx.user.id,
            provider: CSG_PORTAL_PROVIDER,
            accessToken: resolvedPassword,
            refreshToken: null,
            expiresAt: null,
            scope: null,
            metadata,
          });

          return {
            success: true,
            message: "Connected successfully.",
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown portal connection error.";
          if (existing && existingMetadata.email && existing.accessToken) {
            const metadata = serializeCsgPortalMetadata({
              email: existingMetadata.email,
              baseUrl: existingMetadata.baseUrl,
              lastTestedAt: new Date().toISOString(),
              lastTestStatus: "failure",
              lastTestMessage: message,
            });

            await upsertIntegration({
              id: nanoid(),
              userId: ctx.user.id,
              provider: CSG_PORTAL_PROVIDER,
              accessToken: existing.accessToken,
              refreshToken: null,
              expiresAt: null,
              scope: null,
              metadata,
            });
          }
          throw new Error(`Portal connection test failed: ${message}`);
        }
      }),
  }),

  abpSettlement: router({
    startContractScanJob: protectedProcedure
      .input(
        z.object({
          csgIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
          email: z.string().email().optional(),
          password: z.string().min(1).optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const existingMetadata = parseCsgPortalMetadata(existing?.metadata);
        const resolvedEmail = toNonEmptyString(input.email)?.toLowerCase() ?? existingMetadata.email;
        const resolvedPassword =
          toNonEmptyString(input.password) ?? toNonEmptyString(existing?.accessToken);
        const resolvedBaseUrl = toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl;
        if (!resolvedEmail || !resolvedPassword) {
          throw new Error("Missing CSG portal credentials. Save portal email/password first.");
        }

        const uniqueIds = Array.from(new Set(input.csgIds.map((value) => value.trim()).filter(Boolean)));
        if (uniqueIds.length === 0) {
          throw new Error("At least one CSG ID is required.");
        }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        pruneAbpSettlementJobs(nowMs);

        const jobId = nanoid();
        const job: AbpSettlementContractScanJob = {
          id: jobId,
          userId: ctx.user.id,
          scanConfig: {
            csgIds: uniqueIds,
            portalEmail: resolvedEmail,
            portalBaseUrl: resolvedBaseUrl ?? null,
          },
          createdAt: nowIso,
          updatedAt: nowIso,
          startedAt: null,
          finishedAt: null,
          status: "queued",
          progress: {
            current: 0,
            total: uniqueIds.length,
            percent: 0,
            message: "Queued",
            currentCsgId: null,
          },
          error: null,
          result: {
            rows: [],
            successCount: 0,
            failureCount: 0,
          },
        };
        abpSettlementJobs.set(jobId, job);
        try {
          await saveAbpSettlementScanJobSnapshot(job);
        } catch (error) {
          console.warn("[contractScan] Snapshot write failed:", error instanceof Error ? error.message : error);
        }
        void runAbpSettlementContractScanJob(jobId);

        return {
          jobId,
          status: "queued" as const,
          total: uniqueIds.length,
        };
      }),
    getJobStatus: protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
        })
      )
      .query(async ({ ctx, input }) => {
        pruneAbpSettlementJobs(Date.now());
        const normalizedJobId = input.jobId.trim();
        let job = abpSettlementJobs.get(normalizedJobId);
        if (!job) {
          const restored = await loadAbpSettlementScanJobSnapshot(ctx.user.id, normalizedJobId);
          if (restored) {
            abpSettlementJobs.set(normalizedJobId, restored);
            job = restored;
          }
        }
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("ABP settlement contract scan job not found.");
        }

        if ((job.status === "queued" || job.status === "running") && !abpSettlementActiveScanRunners.has(job.id)) {
          void runAbpSettlementContractScanJob(job.id);
        }

        return job;
      }),
    // ── DB-backed contract scan job procedures ────────────────────
    startDbContractScanJob: protectedProcedure
      .input(
        z.object({
          csgIds: z.array(z.string().min(1).max(64)).min(1).max(30000),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // Validate credentials exist
        const integration = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const metadata = parseCsgPortalMetadata(integration?.metadata);
        if (!metadata.email || !toNonEmptyString(integration?.accessToken)) {
          throw new Error("Missing CSG portal credentials. Save portal email/password first.");
        }

        const uniqueIds = Array.from(
          new Set(input.csgIds.map((v) => v.trim()).filter(Boolean))
        );
        if (uniqueIds.length === 0) {
          throw new Error("At least one CSG ID is required.");
        }

        const jobId = await createContractScanJob({
          userId: ctx.user.id,
          totalContracts: uniqueIds.length,
        });

        await bulkInsertContractScanJobCsgIds(jobId, uniqueIds);

        void runContractScanJob(jobId);

        return { jobId, status: "queued" as const, total: uniqueIds.length };
      }),

    stopDbContractScanJob: protectedProcedure
      .input(z.object({ jobId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const job = await getContractScanJob(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Contract scan job not found.");
        }
        if (job.status !== "running" && job.status !== "queued") {
          throw new Error(`Cannot stop job with status "${job.status}".`);
        }
        await updateContractScanJob(job.id, { status: "stopping" });
        return { success: true };
      }),

    deleteDbContractScanJob: protectedProcedure
      .input(z.object({ jobId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const job = await getContractScanJob(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Contract scan job not found.");
        }
        if (job.status === "running" || job.status === "queued") {
          throw new Error("Stop the job before deleting.");
        }
        await deleteContractScanJobData(job.id);
        return { success: true };
      }),

    resumeDbContractScanJob: protectedProcedure
      .input(z.object({ jobId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const job = await getContractScanJob(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Contract scan job not found.");
        }
        if (job.status !== "stopped" && job.status !== "failed") {
          throw new Error(`Cannot resume job with status "${job.status}".`);
        }
        const completedIds = await getCompletedCsgIdsForJob(job.id);
        const pendingCount = job.totalContracts - completedIds.size;

        await updateContractScanJob(job.id, {
          status: "queued",
          error: null,
          currentCsgId: null,
        });

        void runContractScanJob(job.id);

        return { success: true, pendingCount };
      }),

    getDbJobStatus: protectedProcedure
      .input(z.object({ jobId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const job = await getContractScanJob(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Contract scan job not found.");
        }

        // Auto-resume if runner died
        if (
          (job.status === "queued" || job.status === "running") &&
          !isContractScanRunnerActive(job.id)
        ) {
          void runContractScanJob(job.id);
        }

        const processed = job.successCount + job.failureCount;
        const percent =
          job.totalContracts > 0
            ? Math.min(100, Math.round((processed / job.totalContracts) * 100))
            : 0;

        return {
          ...job,
          processed,
          remaining: Math.max(0, job.totalContracts - processed),
          percent,
        };
      }),

    listDbContractScanJobs: protectedProcedure
      .input(
        z
          .object({ limit: z.number().int().min(1).max(50).optional() })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        return listContractScanJobs(ctx.user.id, input?.limit ?? 20);
      }),

    getDbContractScanResults: protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
          limit: z.number().int().min(1).max(500).optional(),
          offset: z.number().int().min(0).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const job = await getContractScanJob(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Contract scan job not found.");
        }
        return listContractScanResults(job.id, {
          limit: input.limit ?? 100,
          offset: input.offset ?? 0,
        });
      }),

    exportDbContractScanResultsCsv: protectedProcedure
      .input(z.object({ jobId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const job = await getContractScanJob(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Contract scan job not found.");
        }
        const rows = await getAllContractScanResultsForJob(job.id);
        const headers = [
          "csgId",
          "systemName",
          "vendorFeePercent",
          "additionalCollateralPercent",
          "ccAuthorizationCompleted",
          "additionalFivePercentSelected",
          "ccCardAsteriskCount",
          "paymentMethod",
          "payeeName",
          "mailingAddress1",
          "mailingAddress2",
          "cityStateZip",
          "recQuantity",
          "recPrice",
          "acSizeKw",
          "dcSizeKw",
          "pdfUrl",
          "pdfFileName",
          "error",
          "scannedAt",
        ];
        const csvRows = rows.map((r) =>
          headers
            .map((h) => {
              const val = (r as Record<string, unknown>)[h];
              if (val === null || val === undefined) return "";
              const str = String(val);
              return str.includes(",") || str.includes('"') || str.includes("\n")
                ? `"${str.replace(/"/g, '""')}"`
                : str;
            })
            .join(",")
        );
        return [headers.join(","), ...csvRows].join("\n");
      }),

    getContractScanResultsByCsgIds: protectedProcedure
      .input(
        z.object({
          // 2026-04-11: bumped from max(5000) to max(50000). Users
          // with large ABP portfolios can have 28k+ CSG IDs in the
          // abpCsgSystemMapping dataset; the old 5000 cap caused a
          // Zod validation error that surfaced as query status: error
          // on the Financials debug panel. The underlying DB helper
          // (getLatestScanResultsByCsgIds) already batches the IN
          // clause at 500 per query, so the server handles the volume
          // fine — only the Zod guard was blocking.
          csgIds: z.array(z.string().min(1).max(64)).min(1).max(50000),
        })
      )
      .query(async ({ ctx, input }) => {
        // user-isolation fix 2026-04-11: previously this called
        // getLatestScanResultsByCsgIds(input.csgIds) without a user
        // filter, which returned ANY user's contract scan results
        // matching those csgIds (cross-tenant data leakage).
        // contractScanResults links to a user via contractScanJobs.userId,
        // so the helper now requires a userId param and JOINs through
        // the jobs table.
        return getLatestScanResultsByCsgIds(ctx.user.id, input.csgIds);
      }),

    updateContractOverride: protectedProcedure
      .input(
        z.object({
          csgId: z.string().min(1).max(64),
          vendorFeePercent: z.number().min(0).max(100).nullable().optional(),
          additionalCollateralPercent: z.number().min(0).max(100).nullable().optional(),
          notes: z.string().max(512).nullable().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const result = await updateContractScanResultOverrides(ctx.user.id, input.csgId, {
          vendorFeePercent: input.vendorFeePercent ?? null,
          additionalCollateralPercent: input.additionalCollateralPercent ?? null,
          notes: input.notes ?? null,
        });
        if (!result) {
          throw new Error(`No contract scan result found for CSG ID ${input.csgId}`);
        }
        return result;
      }),
    rescanSingleContract: protectedProcedure
      .input(z.object({ csgId: z.string().min(1).max(64) }))
      .mutation(async ({ ctx, input }) => {
        // 1. Validate CSG portal credentials
        const integration = await getIntegrationByProvider(ctx.user.id, "csg-portal");
        const metadata = integration?.metadata ? (() => {
          try { return JSON.parse(integration.metadata!) as Record<string, unknown>; } catch { return {}; }
        })() : {};
        const email = typeof metadata.email === "string" && metadata.email ? metadata.email : null;
        const password = integration?.accessToken || null;
        if (!email || !password) {
          throw new Error("CSG portal credentials not configured. Go to Settings to add your portal email and password.");
        }

        // 2. Fetch and parse the contract PDF
        const baseUrl = typeof metadata.baseUrl === "string" && metadata.baseUrl ? metadata.baseUrl : undefined;
        const client = new CsgPortalClient({ email, password, baseUrl });
        await client.login();
        const fetchResult = await client.fetchRecContractPdf(input.csgId);

        if (fetchResult.error || !fetchResult.pdfData) {
          throw new Error(fetchResult.error || "No PDF data returned from portal.");
        }

        const extraction = await extractContractDataFromPdfBuffer(fetchResult.pdfData, fetchResult.pdfFileName || `contract-${input.csgId}.pdf`);

        // 3. Get a job ID to associate the result with
        const latestJob = await getLatestContractScanJob(ctx.user.id);
        if (!latestJob) {
          throw new Error("No contract scan job exists. Run a contract scan first, then re-scan individual systems.");
        }

        // 4. Insert/update the result (unique on jobId+csgId, clears overrides)
        await insertContractScanResult({
          id: nanoid(),
          jobId: latestJob.id,
          csgId: input.csgId,
          systemName: extraction.systemName ?? null,
          vendorFeePercent: extraction.vendorFeePercent ?? null,
          additionalCollateralPercent: extraction.additionalCollateralPercent ?? null,
          ccAuthorizationCompleted: extraction.ccAuthorizationCompleted ?? null,
          additionalFivePercentSelected: extraction.additionalFivePercentSelected ?? null,
          ccCardAsteriskCount: extraction.ccCardAsteriskCount ?? null,
          paymentMethod: extraction.paymentMethod ?? null,
          payeeName: extraction.payeeName ?? null,
          mailingAddress1: extraction.mailingAddress1 ?? null,
          mailingAddress2: extraction.mailingAddress2 ?? null,
          cityStateZip: extraction.cityStateZip ?? null,
          recQuantity: extraction.recQuantity ?? null,
          recPrice: extraction.recPrice ?? null,
          acSizeKw: extraction.acSizeKw ?? null,
          dcSizeKw: extraction.dcSizeKw ?? null,
          pdfUrl: fetchResult.pdfUrl ?? null,
          pdfFileName: fetchResult.pdfFileName ?? null,
          error: null,
          scannedAt: new Date(),
          // Clear any previous overrides — fresh scan replaces manual edits
          overrideVendorFeePercent: null,
          overrideAdditionalCollateralPercent: null,
          overrideNotes: null,
          overriddenAt: null,
        });

        return {
          csgId: input.csgId,
          vendorFeePercent: extraction.vendorFeePercent,
          additionalCollateralPercent: extraction.additionalCollateralPercent,
        };
      }),
    cleanMailingData: protectedProcedure
      .input(
        z.object({
          rows: z
            .array(
              z.object({
                key: z.string().min(1).max(128),
                payeeName: z.string().optional(),
                mailingAddress1: z.string().optional(),
                mailingAddress2: z.string().optional(),
                cityStateZip: z.string().optional(),
                city: z.string().optional(),
                state: z.string().optional(),
                zip: z.string().optional(),
              })
            )
            .min(1)
            .max(150),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // ── 1. Deterministic cleaning pass ───────────────────────
        const sourceRows = input.rows.map((row) => ({
          key: row.key,
          payeeName: toNonEmptyString(row.payeeName),
          mailingAddress1: toNonEmptyString(row.mailingAddress1),
          mailingAddress2: toNonEmptyString(row.mailingAddress2),
          cityStateZip: toNonEmptyString(row.cityStateZip),
          city: toNonEmptyString(row.city),
          state: toNonEmptyString(row.state),
          zip: toNonEmptyString(row.zip),
        }));

        const { cleaned: deterministicResults, ambiguousRows } = cleanAddressBatch(sourceRows);
        const resultByKey = new Map(deterministicResults.map((r) => [r.key, r]));

        // ── 2. LLM pass on deterministic results ─────────────────
        // Feed already-cleaned data so the LLM focuses on what
        // regex can't fix: crammed addresses, city inference,
        // misspelling correction.
        const anthropicIntegration = await getIntegrationByProvider(ctx.user.id, "anthropic");
        const openaiIntegration = await getIntegrationByProvider(ctx.user.id, "openai");

        const llmProvider = anthropicIntegration?.accessToken ? "anthropic" : openaiIntegration?.accessToken ? "openai" : null;
        const llmApiKey = llmProvider === "anthropic" ? anthropicIntegration!.accessToken! : llmProvider === "openai" ? openaiIntegration!.accessToken! : null;

        if (llmProvider && llmApiKey) {
          console.log(`[AI Cleaning] Sending ${deterministicResults.length} pre-cleaned rows to ${llmProvider} (${ambiguousRows.length} ambiguous).`);

          try {
            const llmCleaned = await callLlmForAddressCleaning(
              llmProvider,
              llmApiKey,
              llmProvider === "anthropic"
                ? (parseJsonMetadata(anthropicIntegration!.metadata).model as string || "claude-sonnet-4-20250514")
                : resolveOpenAIModel(openaiIntegration!.metadata),
              deterministicResults
            );

            // Merge LLM results, re-sanitizing as a final safety net
            for (const llmRow of llmCleaned) {
              if (resultByKey.has(llmRow.key)) {
                const sanitized = sanitizeMailingFields({
                  payeeName: llmRow.payeeName,
                  mailingAddress1: llmRow.mailingAddress1,
                  mailingAddress2: llmRow.mailingAddress2,
                  city: llmRow.city,
                  state: llmRow.state,
                  zip: llmRow.zip,
                });
                resultByKey.set(llmRow.key, {
                  key: llmRow.key,
                  payeeName: sanitized.payeeName,
                  mailingAddress1: sanitized.mailingAddress1,
                  mailingAddress2: sanitized.mailingAddress2,
                  cityStateZip: resultByKey.get(llmRow.key)?.cityStateZip ?? null,
                  city: sanitized.city,
                  state: sanitized.state,
                  zip: sanitized.zip,
                  ambiguous: false,
                  ambiguousReason: "",
                });
              }
            }
          } catch (llmError) {
            console.error(`[AI Cleaning] LLM failed: ${llmError instanceof Error ? llmError.message : "Unknown error"}. Using deterministic results.`);
          }
        } else {
          console.warn(`[AI Cleaning] No AI provider connected. ${deterministicResults.length} rows cleaned deterministically only.`);
        }

        // ── 3. Build response ────────────────────────────────────
        const warnings: string[] = [];
        const finalRows = sourceRows.map((src) => {
          const result = resultByKey.get(src.key);
          if (!result) {
            return {
              key: src.key,
              payeeName: src.payeeName,
              mailingAddress1: src.mailingAddress1,
              mailingAddress2: src.mailingAddress2,
              city: src.city,
              state: src.state,
              zip: src.zip,
            };
          }
          return {
            key: src.key,
            payeeName: result.payeeName,
            mailingAddress1: result.mailingAddress1,
            mailingAddress2: result.mailingAddress2,
            city: result.city,
            state: result.state,
            zip: result.zip,
          };
        });

        if (ambiguousRows.length > 0) {
          warnings.push(`${ambiguousRows.length} record(s) had ambiguous data and were sent to AI for review.`);
        }

        return {
          rows: finalRows,
          warnings,
          stats: {
            sent: sourceRows.length,
            returnedByAi: ambiguousRows.length,
            missing: 0,
            keptOriginal: 0,
            fieldWarnings: deterministicResults.filter((r) => r.ambiguous).length,
          },
        };

      }),
    saveRun: protectedProcedure
      .input(
        z.object({
          runId: z.string().min(1).max(128).optional(),
          monthKey: z.string().regex(/^\d{4}-\d{2}$/),
          label: z.string().max(200).optional(),
          payload: z.string().min(1),
          rowCount: z.number().int().min(0).max(50000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const runId = toNonEmptyString(input.runId) ?? nanoid();
        const saved = await saveAbpSettlementRun({
          userId: ctx.user.id,
          runId,
          monthKey: input.monthKey,
          label: toNonEmptyString(input.label),
          payload: input.payload,
          rowCount: input.rowCount ?? null,
        });

        return {
          success: true,
          runId,
          summary: saved.summary,
          persistedToDatabase: saved.runWrite.persistedToDatabase || saved.indexWrite.persistedToDatabase,
          storageSynced: saved.runWrite.storageSynced && saved.indexWrite.storageSynced,
        };
      }),
    getRun: protectedProcedure
      .input(
        z.object({
          runId: z.string().min(1).max(128),
        })
      )
      .query(async ({ ctx, input }) => {
        const run = await getAbpSettlementRun(ctx.user.id, input.runId);
        if (!run) {
          throw new Error("ABP settlement run not found.");
        }
        return run;
      }),
    listRuns: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(250).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const runs = await getAbpSettlementRunsIndex(ctx.user.id);
        return runs.slice(0, input?.limit ?? 50);
      }),

    verifyAddresses: protectedProcedure
      .input(
        z.object({
          addresses: z
            .array(
              z.object({
                key: z.string().min(1).max(128),
                address1: z.string().max(256),
                address2: z.string().max(256),
                city: z.string().max(128),
                state: z.string().max(64),
                zip: z.string().max(20),
              })
            )
            .min(1)
            .max(100),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // USPS Address API v3 (OAuth client credentials)
        const uspsClientId = process.env.USPS_CLIENT_ID;
        const uspsClientSecret = process.env.USPS_CLIENT_SECRET;

        if (!uspsClientId || !uspsClientSecret) {
          throw new Error("USPS API not configured. Set USPS_CLIENT_ID and USPS_CLIENT_SECRET environment variables (from developers.usps.com).");
        }

        const results = await verifyAddressBatch(uspsClientId, uspsClientSecret, input.addresses);

        const confirmed = results.filter((r) => r.verdict === "CONFIRMED").length;
        const unconfirmed = results.filter((r) => r.verdict === "UNCONFIRMED").length;
        const errors = results.filter((r) => r.verdict === "ERROR").length;

        return {
          results,
          summary: { total: results.length, confirmed, unconfirmed, errors },
        };
      }),
  }),

  clockify: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
      const metadata = parseClockifyMetadata(integration?.metadata);

      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.workspaceId && metadata.userId),
        workspaceId: metadata.workspaceId,
        workspaceName: metadata.workspaceName,
        userId: metadata.userId,
        userName: metadata.userName,
        userEmail: metadata.userEmail,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          workspaceId: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existingIntegration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
        const existingMetadata = parseClockifyMetadata(existingIntegration?.metadata);

        const apiKey = input.apiKey.trim();
        const user = await getClockifyCurrentUser(apiKey);
        const workspaces = await listClockifyWorkspaces(apiKey);

        const requestedWorkspaceId = toNonEmptyString(input.workspaceId);
        let resolvedWorkspace =
          requestedWorkspaceId
            ? workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ?? null
            : null;

        if (requestedWorkspaceId && !resolvedWorkspace) {
          throw new Error("The selected Clockify workspace ID was not found for this API key.");
        }

        if (!resolvedWorkspace) {
          const preferredWorkspaceId =
            existingMetadata.workspaceId ?? user.activeWorkspaceId ?? user.defaultWorkspaceId;
          resolvedWorkspace =
            (preferredWorkspaceId
              ? workspaces.find((workspace) => workspace.id === preferredWorkspaceId)
              : null) ?? workspaces[0] ?? null;
        }

        if (!resolvedWorkspace) {
          throw new Error("No Clockify workspace was found for this account.");
        }

        const metadata = JSON.stringify({
          workspaceId: resolvedWorkspace.id,
          workspaceName: resolvedWorkspace.name,
          userId: user.id,
          userName: user.name || null,
          userEmail: user.email,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: CLOCKIFY_PROVIDER,
          accessToken: apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          workspaceId: resolvedWorkspace.id,
          workspaceName: resolvedWorkspace.name,
          userName: user.name || null,
          userEmail: user.email,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    getCurrentEntry: protectedProcedure.query(async ({ ctx }) => {
      const context = await getClockifyContext(ctx.user.id);
      return getClockifyInProgressTimeEntry(
        context.apiKey,
        context.workspaceId,
        context.clockifyUserId
      );
    }),
    getRecentEntries: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const context = await getClockifyContext(ctx.user.id);
        return getClockifyRecentTimeEntries(
          context.apiKey,
          context.workspaceId,
          context.clockifyUserId,
          input?.limit ?? 20
        );
      }),
    startTimer: protectedProcedure
      .input(
        z.object({
          description: z.string().min(1).max(300),
          projectId: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getClockifyContext(ctx.user.id);
        const currentEntry = await getClockifyInProgressTimeEntry(
          context.apiKey,
          context.workspaceId,
          context.clockifyUserId
        );
        if (currentEntry?.isRunning) {
          throw new Error("A Clockify timer is already running. Stop it before starting a new one.");
        }

        return startClockifyTimeEntry(context.apiKey, context.workspaceId, {
          description: input.description,
          projectId: toNonEmptyString(input.projectId),
        });
      }),
    stopTimer: protectedProcedure.mutation(async ({ ctx }) => {
      const context = await getClockifyContext(ctx.user.id);
      const stoppedEntry = await stopClockifyInProgressTimeEntry(
        context.apiKey,
        context.workspaceId,
        context.clockifyUserId
      );
      return {
        success: true,
        stopped: Boolean(stoppedEntry),
        entry: stoppedEntry,
      };
    }),
  }),

  todoist: router({
    connect: protectedProcedure
      .input(z.object({ apiToken: z.string().min(1).max(512) }))
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, "todoist");
        const metadata = existing?.metadata ?? JSON.stringify({ defaultFilter: "all" });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "todoist",
          accessToken: input.apiToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });
        return { success: true };
      }),
    getTasks: protectedProcedure
      .input(z.object({ filter: z.string().max(500).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        return getTodoistTasks(integration.accessToken, input?.filter);
      }),
    getProjects: protectedProcedure.query(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      return getTodoistProjects(integration.accessToken);
    }),
    getCompletedCount: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const count = await getTodoistCompletedTaskCount(
          integration.accessToken,
          dateKey,
          input?.timezoneOffsetMinutes
        );
        return { dateKey, count };
      }),
    getCompletedDebug: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const tasks = await getTodoistCompletedTasks(
          integration.accessToken,
          dateKey,
          input?.timezoneOffsetMinutes
        );
        return {
          dateKey,
          timezoneOffsetMinutes: input?.timezoneOffsetMinutes ?? null,
          count: tasks.length,
          tasks: tasks.map((task) => ({
            taskId: task.taskId,
            content: task.content,
            completedAt: task.completedAt,
            dateKey: task.dateKey,
          })),
        };
      }),
    saveSettings: protectedProcedure
      .input(z.object({ defaultFilter: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }

        const existingMetadata = parseJsonMetadata(integration.metadata);
        const metadata = JSON.stringify({
          ...existingMetadata,
          defaultFilter: input.defaultFilter,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "todoist",
          accessToken: integration.accessToken,
          refreshToken: integration.refreshToken,
          expiresAt: integration.expiresAt,
          scope: integration.scope,
          metadata,
        });

        return { success: true, defaultFilter: input.defaultFilter };
      }),
    createTask: protectedProcedure
      .input(z.object({ 
        content: z.string(),
        description: z.string().optional(),
        projectId: z.string().optional(),
        priority: z.number().min(1).max(4).optional(),
        dueString: z.string().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        return createTodoistTask(
          integration.accessToken,
          input.content,
          input.description,
          input.projectId,
          input.priority,
          input.dueString,
          input.dueDate
        );
      }),
    completeTask: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        await completeTodoistTask(integration.accessToken, input.taskId);
        return { success: true };
      }),
    createTaskFromEmail: protectedProcedure
      .input(z.object({
        subject: z.string(),
        emailLink: z.string(),
        body: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        // Find the Inbox project
        const projects = await getTodoistProjects(integration.accessToken);
        const inboxProject = projects.find(p => p.name.toLowerCase() === "inbox");
        
        const taskContent = `[${input.subject}](${input.emailLink})`;
        const taskDescription = input.body || '';
        
        return createTodoistTask(
          integration.accessToken,
          taskContent,
          taskDescription,
          inboxProject?.id,
          undefined
        );
      }),
  }),

  conversations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return getConversations(ctx.user.id);
    }),
    listSummaries: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(300).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        return getConversationSummaries(ctx.user.id, input?.limit ?? 100);
      }),
    create: protectedProcedure
      .input(z.object({ title: z.string().min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const id = await createConversation(ctx.user.id, input.title);
        return { id };
      }),
    getMessages: protectedProcedure
      .input(z.object({ conversationId: z.string().max(64) }))
      .query(async ({ input }) => {
        return getConversationMessages(input.conversationId);
      }),
    delete: protectedProcedure
      .input(z.object({ conversationId: z.string().max(64) }))
      .mutation(async ({ ctx, input }) => {
        await deleteConversation(input.conversationId, ctx.user.id);
        return { success: true };
      }),
  }),

  openai: router({
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().max(512).optional(),
          model: z.string().max(64).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, "openai");
        const incomingKey = input.apiKey?.trim();
        const accessToken = incomingKey || existing?.accessToken || null;

        if (!accessToken) {
          throw new Error("OpenAI API key is required");
        }

        const existingModel = resolveOpenAIModel(existing?.metadata);
        const requestedModel = input.model?.trim();
        const model = requestedModel && requestedModel.length > 0 ? requestedModel : existingModel;

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "openai",
          accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: JSON.stringify({ model }),
        });
        return { success: true, model };
      }),
    generateDailyOverview: protectedProcedure
      .input(
        z.object({
          date: z.string(),
          weather: z
            .object({
              summary: z.string(),
              location: z.string().optional(),
              temperatureF: z.number().optional(),
            })
            .optional(),
          todoistTasks: z
            .array(
              z.object({
                content: z.string(),
                due: z.string().optional(),
                priority: z.number().optional(),
              })
            )
            .max(20),
          calendarEvents: z
            .array(
              z.object({
                summary: z.string(),
                start: z.string().optional(),
                location: z.string().optional(),
              })
            )
            .max(20),
          prioritizedEmails: z
            .array(
              z.object({
                from: z.string().optional(),
                subject: z.string(),
                snippet: z.string().optional(),
                date: z.string().optional(),
                reason: z.string().optional(),
              })
            )
            .max(20),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "openai");
        if (!integration?.accessToken) {
          throw new Error("OpenAI not connected");
        }

        const weatherLine = input.weather
          ? `Weather: ${input.weather.summary}${input.weather.location ? ` in ${input.weather.location}` : ""}`
          : "Weather: unavailable";

        const taskLines =
          input.todoistTasks.length > 0
            ? input.todoistTasks
                .map((task) => {
                  const priority = task.priority ? `P${task.priority}` : "P4";
                  return `- [${priority}] ${task.content}${task.due ? ` (Due: ${task.due})` : ""}`;
                })
                .join("\n")
            : "- None";

        const eventLines =
          input.calendarEvents.length > 0
            ? input.calendarEvents
                .map(
                  (event) =>
                    `- ${event.summary}${event.start ? ` (${event.start})` : ""}${
                      event.location ? ` @ ${event.location}` : ""
                    }`
                )
                .join("\n")
            : "- None";

        const emailLines =
          input.prioritizedEmails.length > 0
            ? input.prioritizedEmails
                .map(
                  (email) =>
                    `- ${email.subject}${email.from ? ` from ${email.from}` : ""}${
                      email.reason ? ` | Reason: ${email.reason}` : ""
                    }${email.date ? ` | Date: ${email.date}` : ""}`
                )
                .join("\n")
            : "- None";

        const safeNumber = (value: unknown): number | null =>
          typeof value === "number" && Number.isFinite(value) ? value : null;

        let whoopLine = "WHOOP: unavailable";
        const whoopIntegration = await getIntegrationByProvider(ctx.user.id, "whoop");
        if (whoopIntegration?.accessToken) {
          try {
            const accessToken = await getValidWhoopToken(ctx.user.id);
            const whoop = await getWhoopSummary(accessToken);

            const recovery = safeNumber(whoop.recoveryScore);
            const sleepHours = safeNumber(whoop.sleepHours);
            const strain = safeNumber(whoop.dayStrain);
            const restingHr = safeNumber(whoop.restingHeartRate);
            const hrv = safeNumber(whoop.hrvRmssdMilli);
            const spo2 = safeNumber(whoop.spo2Percentage);

            whoopLine = [
              `WHOOP: recovery ${recovery !== null ? `${Math.round(recovery)}%` : "N/A"}`,
              `sleep ${sleepHours !== null ? `${sleepHours.toFixed(1)}h` : "N/A"}`,
              `strain ${strain !== null ? strain.toFixed(1) : "N/A"}`,
              `resting HR ${restingHr !== null ? `${Math.round(restingHr)} bpm` : "N/A"}`,
              `HRV ${hrv !== null ? `${Math.round(hrv)} ms` : "N/A"}`,
              `SpO2 ${spo2 !== null ? `${Math.round(spo2)}%` : "N/A"}`,
            ].join(", ");
          } catch (error) {
            console.error("Failed to fetch WHOOP summary for daily overview:", error);
          }
        }

        let samsungLine = "Samsung Health: unavailable";
        const samsungIntegration = await getIntegrationByProvider(ctx.user.id, "samsung-health");
        if (samsungIntegration?.metadata) {
          const metadata = parseJsonMetadata(samsungIntegration.metadata);
          const summary =
            metadata.summary && typeof metadata.summary === "object"
              ? (metadata.summary as Record<string, unknown>)
              : {};
          const manualScores =
            metadata.manualScores && typeof metadata.manualScores === "object"
              ? (metadata.manualScores as Record<string, unknown>)
              : {};

          const steps = safeNumber(summary.steps);
          const sleepMinutes = safeNumber(summary.sleepTotalMinutes);
          const spo2 = safeNumber(summary.spo2AvgPercent);
          const sleepScore = safeNumber(manualScores.sleepScore) ?? safeNumber(summary.sleepScore);
          const energyScore = safeNumber(manualScores.energyScore) ?? safeNumber(summary.energyScore);
          const receivedAt =
            typeof metadata.receivedAt === "string" && metadata.receivedAt.length > 0
              ? metadata.receivedAt
              : null;

          samsungLine = [
            `Samsung Health: steps ${steps !== null ? Math.round(steps).toLocaleString() : "N/A"}`,
            `sleep ${sleepMinutes !== null ? `${(sleepMinutes / 60).toFixed(1)}h` : "N/A"}`,
            `SpO2 ${spo2 !== null ? `${spo2.toFixed(1)}%` : "N/A"}`,
            `sleep score ${sleepScore !== null ? sleepScore : "N/A"}`,
            `energy score ${energyScore !== null ? energyScore : "N/A"}`,
            `last sync ${receivedAt ?? "N/A"}`,
          ].join(", ");
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${integration.accessToken}`,
          },
          body: JSON.stringify({
            model: resolveOpenAIModel(integration.metadata),
            messages: [
              {
                role: "system",
                content:
                  "You generate concise daily productivity overviews in clean GitHub-flavored markdown. Use exactly these headings: '## Summary', '## Must Do Today', '## Priority Emails', '## Risks & Follow-ups'. Under each heading, use 2-5 bullet points with '- '. Keep to about 120-180 words. Do not output any extra headings or prose outside these sections. Explicitly factor in health and recovery context (WHOOP and Samsung Health) when setting workload intensity and sequencing. If health data is available, mention at least one concrete WHOOP or Samsung metric in the output.",
              },
              {
                role: "user",
                content: `Date: ${input.date}\n${weatherLine}\n\nTodoist items due today:\n${taskLines}\n\nToday's calendar events:\n${eventLines}\n\nPriority emails (date/language based):\n${emailLines}\n\nHealth and recovery context:\n- ${whoopLine}\n- ${samsungLine}\n\nGenerate the daily overview now using the exact heading and bullet format.`,
              },
            ],
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error?.error?.message || "Failed to generate daily overview");
        }

        const data = await response.json();
        const overview = data?.choices?.[0]?.message?.content;
        if (!overview || typeof overview !== "string") {
          throw new Error("Invalid overview response from OpenAI");
        }

        return { overview };
      }),
    generatePipelineReport: protectedProcedure
      .input(
        z.object({
          generatedAt: z.string(),
          rows3Year: z.array(
            z.object({
              month: z.string(),
              part1Count: z.number(), part2Count: z.number(),
              part1KwAc: z.number(), part2KwAc: z.number(),
              interconnectedCount: z.number(), interconnectedKwAc: z.number(),
              prevPart1Count: z.number(), prevPart2Count: z.number(),
              prevPart1KwAc: z.number(), prevPart2KwAc: z.number(),
              prevInterconnectedCount: z.number(), prevInterconnectedKwAc: z.number(),
            })
          ),
          rows12Month: z.array(
            z.object({
              month: z.string(),
              part1Count: z.number(), part2Count: z.number(),
              part1KwAc: z.number(), part2KwAc: z.number(),
              interconnectedCount: z.number(), interconnectedKwAc: z.number(),
              prevPart1Count: z.number(), prevPart2Count: z.number(),
              prevPart1KwAc: z.number(), prevPart2KwAc: z.number(),
              prevInterconnectedCount: z.number(), prevInterconnectedKwAc: z.number(),
            })
          ),
          summaryTotals: z.object({
            threeYear: z.object({
              totalPart1: z.number(), totalPart2: z.number(),
              totalPart1KwAc: z.number(), totalPart2KwAc: z.number(),
              totalInterconnected: z.number(), totalInterconnectedKwAc: z.number(),
            }),
            twelveMonth: z.object({
              totalPart1: z.number(), totalPart2: z.number(),
              totalPart1KwAc: z.number(), totalPart2KwAc: z.number(),
              totalInterconnected: z.number(), totalInterconnectedKwAc: z.number(),
            }),
          }),
          cashFlowSummary: z.object({
            rows12Month: z.array(z.object({
              month: z.string(),
              vendorFee: z.number(),
              ccAuthCollateral: z.number(),
              additionalCollateral: z.number(),
              totalCashFlow: z.number(),
              projectCount: z.number(),
            })),
            totalVendorFee12Mo: z.number(),
            totalCollateral12Mo: z.number(),
            totalCashFlow12Mo: z.number(),
          }).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "openai");
        if (!integration?.accessToken) {
          throw new Error("OpenAI not connected. Please add your API key in Settings.");
        }

        const formatRows = (rows: typeof input.rows3Year) =>
          rows
            .map(
              (r) =>
                `${r.month}: P1=${r.part1Count} (${r.part1KwAc.toFixed(1)} kW), P2=${r.part2Count} (${r.part2KwAc.toFixed(1)} kW), IC=${r.interconnectedCount} (${r.interconnectedKwAc.toFixed(1)} kW) | PY: P1=${r.prevPart1Count}, P2=${r.prevPart2Count}, IC=${r.prevInterconnectedCount}`
            )
            .join("\n");

        const systemMessage = {
          role: "system" as const,
          content: `You are a solar energy portfolio analyst generating a professional report on application pipeline trends. Write in clear, professional prose with markdown formatting. Use these exact sections:

## Executive Summary
A 3-4 sentence high-level summary of the pipeline health.

## Application Volume Trends
Analysis of Part I submissions and Part II verifications -- monthly patterns, seasonality, acceleration or deceleration. Use concise prose, not raw data dumps.

## Capacity Trends (kW AC)
Analysis of capacity flowing through the pipeline -- average system sizes, capacity growth, and how kW AC trends differ from count trends.

## Interconnection Analysis
Trends in systems going online -- throughput rates, bottlenecks, and how interconnection volume compares to application volume.

## Year-over-Year Comparison
Summarize YoY changes in 2-3 concise sentences covering the most significant shifts. Focus on the overall trend direction and magnitude rather than listing every month individually. State the trailing-12-month totals vs. prior-year totals for Part I, Part II, and Interconnected with percentage change. Do NOT list individual monthly comparisons.

## Cash Flow Forecast
If cash flow data is provided, analyze the monthly revenue (vendor fee) and collateral obligations (CC Auth 5%, Additional Collateral) flowing to CSG. Note the M+1 lag: Part II verification in month M triggers an invoice on the 1st of M+1, with payment by end of M+1. Identify trends in revenue volume and collateral burden. State trailing-12-month total vendor fee revenue and total cash flow. If no cash flow data is provided, omit this section entirely.

## Key Risks & Opportunities
2-4 bullet points identifying risks (declining volumes, growing backlogs) and opportunities (capacity growth, improving conversion rates).

FORMATTING RULES:
- Write in concise professional prose. Avoid cramming multiple statistics into a single sentence.
- When citing numbers, round kW values to the nearest whole number or one decimal (e.g. 47.6 MW, not 47600.1 kW).
- Use "MW" for values above 1,000 kW (divide by 1,000).
- Do NOT use asterisks for emphasis within numbers or percentages. Use plain text.
- Keep the total analysis to 400-600 words.`,
        };

        const t3 = input.summaryTotals.threeYear;
        const t12 = input.summaryTotals.twelveMonth;
        const userMessage = {
          role: "user" as const,
          content: `Report generated: ${input.generatedAt}

3-YEAR PIPELINE DATA (monthly):
${formatRows(input.rows3Year)}

3-Year Totals: Part I: ${t3.totalPart1} apps (${t3.totalPart1KwAc.toFixed(1)} kW), Part II: ${t3.totalPart2} apps (${t3.totalPart2KwAc.toFixed(1)} kW), Interconnected: ${t3.totalInterconnected} (${t3.totalInterconnectedKwAc.toFixed(1)} kW)

12-MONTH PIPELINE DATA (monthly):
${formatRows(input.rows12Month)}

12-Month Totals: Part I: ${t12.totalPart1} apps (${t12.totalPart1KwAc.toFixed(1)} kW), Part II: ${t12.totalPart2} apps (${t12.totalPart2KwAc.toFixed(1)} kW), Interconnected: ${t12.totalInterconnected} (${t12.totalInterconnectedKwAc.toFixed(1)} kW)
${input.cashFlowSummary ? `
CASH FLOW DATA (Last 12 Months — month shown is the payment month, M+1 from Part II verification):
${input.cashFlowSummary.rows12Month.map((r) => `${r.month}: VendorFee=$${r.vendorFee.toFixed(2)}, CcAuth=$${r.ccAuthCollateral.toFixed(2)}, AddlColl=$${r.additionalCollateral.toFixed(2)}, Total=$${r.totalCashFlow.toFixed(2)}, Projects=${r.projectCount}`).join("\n")}

Cash Flow 12-Month Totals: Vendor Fee Revenue: $${input.cashFlowSummary.totalVendorFee12Mo.toFixed(2)}, Collateral: $${input.cashFlowSummary.totalCollateral12Mo.toFixed(2)}, Total Cash Flow: $${input.cashFlowSummary.totalCashFlow12Mo.toFixed(2)}
` : ""}
Generate the pipeline analysis report now.`,
        };

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${integration.accessToken}`,
          },
          body: JSON.stringify({
            model: resolveOpenAIModel(integration.metadata),
            messages: [systemMessage, userMessage],
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          console.error("OpenAI pipeline report error:", response.status, errorBody);
          let errorMessage = "Failed to generate pipeline report";
          try {
            const parsed = JSON.parse(errorBody);
            errorMessage = parsed?.error?.message || errorMessage;
          } catch {}
          throw new Error(`OpenAI API error (${response.status}): ${errorMessage}`);
        }

        const data = await response.json();
        const analysis = (data as any)?.choices?.[0]?.message?.content;
        if (!analysis || typeof analysis !== "string") {
          throw new Error("Invalid response from OpenAI");
        }

        return { analysis };
      }),
    chat: protectedProcedure
      .input(z.object({ conversationId: z.string().max(64), message: z.string().min(1).max(32000) }))
      .mutation(async ({ ctx, input }) => {
        const integration = await getIntegrationByProvider(ctx.user.id, "openai");
        if (!integration?.accessToken) {
          throw new Error("OpenAI not connected");
        }
        
        // Fetch productivity data if available
        let contextParts: string[] = [];
        
        // Todoist context
        const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (todoistIntegration?.accessToken) {
          try {
            const [tasks, projects] = await Promise.all([
              getTodoistTasks(todoistIntegration.accessToken),
              getTodoistProjects(todoistIntegration.accessToken)
            ]);
            
            const projectMap = new Map(projects.map(p => [p.id, p.name]));
            const taskList = tasks.slice(0, 50).map(t => {
              const projectName = projectMap.get(t.projectId) || "Inbox";
              const priority = ["P4", "P3", "P2", "P1"][t.priority - 1] || "P4";
              return `- [${priority}] ${t.content}${t.description ? ` (${t.description})` : ""} [${projectName}]${t.due ? ` Due: ${t.due.string}` : ""}`;
            }).join("\n");
            
            contextParts.push(`TODOIST TASKS (${tasks.length} total):\n${taskList}`);
          } catch (error) {
            console.error("Failed to fetch Todoist data:", error);
          }
        }
        
        // Google Calendar context
        const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
        if (googleIntegration?.accessToken) {
          try {
            const events = await getGoogleCalendarEvents(googleIntegration.accessToken);
            
            const eventList = events.slice(0, 20).map(e => {
              const start = e.start.dateTime || e.start.date || "";
              const end = e.end.dateTime || e.end.date || "";
              return `- ${e.summary || "Untitled"} (${start} to ${end})${e.location ? ` @ ${e.location}` : ""}`;
            }).join("\n");
            
            contextParts.push(`GOOGLE CALENDAR (${events.length} upcoming events):\n${eventList}`);
          } catch (error) {
            console.error("Failed to fetch Google Calendar data:", error);
          }
        }
        
        // Gmail context
        if (googleIntegration?.accessToken) {
          try {
            const messages = await getGmailMessages(googleIntegration.accessToken, 10);
            
            const emailList = messages.map(m => {
              const from = m.payload.headers.find((h: any) => h.name === "From")?.value || "Unknown";
              const subject = m.payload.headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
              const date = m.payload.headers.find((h: any) => h.name === "Date")?.value || "";
              return `- From: ${from}\n  Subject: ${subject}\n  Date: ${date}\n  Preview: ${m.snippet}`;
            }).join("\n\n");
            
            contextParts.push(`GMAIL (${messages.length} recent emails):\n${emailList}`);
          } catch (error) {
            console.error("Failed to fetch Gmail data:", error);
          }
        }
        
        const productivityContext = contextParts.length > 0 
          ? `\n\nYou have access to the user's productivity data:\n\n${contextParts.join("\n\n")}\n\nYou can analyze, summarize, or provide insights about their tasks, schedule, and emails when relevant to their question.`
          : "";
        
        // Save user message
        await addMessage({ id: nanoid(), conversationId: input.conversationId, role: "user", content: input.message });
        
        // Get conversation history
        const history = await getConversationMessages(input.conversationId);
        const conversationMessages = history.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content
        }));
        
        const systemMessage = {
          role: "system" as const,
          content: `You are a helpful productivity assistant. You help users manage their tasks, schedule, and productivity.${productivityContext}`
        };
        
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${integration.accessToken}`,
          },
          body: JSON.stringify({
            model: resolveOpenAIModel(integration.metadata),
            messages: [
              systemMessage,
              ...conversationMessages
            ],
          }),
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || "OpenAI API error");
        }
        
        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error("Invalid response from OpenAI");
        }
        
        const reply = data.choices[0].message.content;
        
        // Save assistant message
        await addMessage({ id: nanoid(), conversationId: input.conversationId, role: "assistant", content: reply });
        
        return { reply };
      }),
  }),

  google: router({
    getCalendarEvents: protectedProcedure
      .input(
        z
          .object({
            startIso: z.string().datetime().optional(),
            endIso: z.string().datetime().optional(),
            daysAhead: z.number().int().min(1).max(365).optional(),
            maxResults: z.number().int().min(1).max(250).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        try {
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const events = await getGoogleCalendarEvents(accessToken, {
            startIso: input?.startIso,
            endIso: input?.endIso,
            daysAhead: input?.daysAhead,
            maxResults: input?.maxResults,
          });
          console.log(`[Google Calendar] Fetched ${events.length} events`);
          return events;
        } catch (error) {
          console.error("[Google Calendar] Error fetching events:", error);
          throw error;
        }
      }),
    getGmailMessages: protectedProcedure
      .input(z.object({ maxResults: z.number().int().min(1).max(800).optional() }).optional())
      .query(async ({ ctx, input }) => {
      const accessToken = await getValidGoogleToken(ctx.user.id);
      return getGmailMessages(accessToken, input?.maxResults ?? 50);
    }),
    getGmailWaitingOn: protectedProcedure
      .input(z.object({ maxResults: z.number().int().min(1).max(100).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const accessToken = await getValidGoogleToken(ctx.user.id);
        return getGmailWaitingOn(accessToken, input?.maxResults ?? 25);
      }),
    markGmailAsRead: protectedProcedure
      .input(z.object({ messageId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const accessToken = await getValidGoogleToken(ctx.user.id);
        await markGmailMessageAsRead(accessToken, input.messageId);
        return { success: true };
      }),
    getDriveFiles: protectedProcedure.query(async ({ ctx }) => {
      try {
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const files = await getGoogleDriveFiles(accessToken);
        console.log(`[Google Drive] Fetched ${files.length} files`);
        return files;
      } catch (error) {
        console.error("[Google Drive] Error fetching files:", error);
        throw error;
      }
    }),
    createSpreadsheet: protectedProcedure
      .input(z.object({ title: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const result = await createGoogleSpreadsheet(accessToken, input.title);
          console.log(`[Google Sheets] Created spreadsheet: ${input.title}`);
          return result;
        } catch (error) {
          console.error("[Google Sheets] Error creating spreadsheet:", error);
          throw error;
        }
      }),
    searchDrive: protectedProcedure
      .input(z.object({ query: z.string() }))
      .query(async ({ ctx, input }) => {
        try {
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const files = await searchGoogleDrive(accessToken, input.query);
          console.log(`[Google Drive Search] Found ${files.length} files for query: ${input.query}`);
          return files;
        } catch (error) {
          console.error("[Google Drive Search] Error searching Drive:", error);
          throw error;
        }
      }),
  }),

  whoop: router({
    getSummary: protectedProcedure.query(async ({ ctx }) => {
      const accessToken = await getValidWhoopToken(ctx.user.id);
      return getWhoopSummary(accessToken);
    }),
  }),

  samsungHealth: router({
    getConfig: protectedProcedure.query(async () => {
      const syncKey = process.env.SAMSUNG_HEALTH_SYNC_KEY?.trim() || "";
      const userIdRaw = process.env.SAMSUNG_HEALTH_USER_ID?.trim() || "1";
      const userId = Number.parseInt(userIdRaw, 10);
      return {
        syncKey,
        hasSyncKey: syncKey.length > 0,
        userId: Number.isFinite(userId) && userId > 0 ? userId : 1,
      };
    }),
    saveManualScores: protectedProcedure
      .input(
        z.object({
          sleepScore: z.number().min(0).max(100).nullable(),
          energyScore: z.number().min(0).max(100).nullable(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, "samsung-health");
        const existingMetadata = parseJsonMetadata(existing?.metadata);
        const existingSummary =
          existingMetadata.summary && typeof existingMetadata.summary === "object"
            ? (existingMetadata.summary as Record<string, unknown>)
            : {};
        const existingManual =
          existingMetadata.manualScores && typeof existingMetadata.manualScores === "object"
            ? (existingMetadata.manualScores as Record<string, unknown>)
            : {};

        const sleepScore = input.sleepScore;
        const energyScore = input.energyScore;

        const nextMetadata = JSON.stringify({
          ...existingMetadata,
          summary: {
            ...existingSummary,
            sleepScore: toNullableScore(sleepScore),
            energyScore: toNullableScore(energyScore),
          },
          manualScores: {
            sleepScore: toNullableScore(sleepScore),
            energyScore: toNullableScore(energyScore),
          },
          manualScoresUpdatedAt: new Date().toISOString(),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "samsung-health",
          accessToken: existing?.accessToken ?? null,
          refreshToken: existing?.refreshToken ?? null,
          expiresAt: existing?.expiresAt ?? null,
          scope: existing?.scope ?? null,
          metadata: nextMetadata,
        });

        return {
          success: true,
          manualScores: {
            sleepScore: toNullableScore(sleepScore),
            energyScore: toNullableScore(energyScore),
          },
        };
      }),
  }),

  metrics: router({
    getHistory: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(120).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        return getDailyMetricsHistory(ctx.user.id, input?.limit ?? 30);
      }),
    getTrendSeries: protectedProcedure
      .input(
        z
          .object({
            days: z.number().int().min(7).max(365).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const days = input?.days ?? 30;
        const rows = await getDailyMetricsHistory(ctx.user.id, days);
        const ordered = [...rows].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

        const makeSeries = (getter: (row: (typeof ordered)[number]) => number | null) =>
          ordered.map((row) => ({
            dateKey: row.dateKey,
            value: getter(row),
          }));

        const recoverySeries = makeSeries((row) => toFiniteNumber(row.whoopRecoveryScore));
        const sleepSeries = makeSeries(
          (row) => toFiniteNumber(row.whoopSleepHours) ?? toFiniteNumber(row.samsungSleepHours)
        );
        const strainSeries = makeSeries((row) => toFiniteNumber(row.whoopDayStrain));
        const hrvSeries = makeSeries((row) => toFiniteNumber(row.whoopHrvMs));
        const stepsSeries = makeSeries((row) =>
          row.samsungSteps !== null && row.samsungSteps !== undefined ? Number(row.samsungSteps) : null
        );
        const completedTaskSeries = makeSeries((row) =>
          row.todoistCompletedCount !== null && row.todoistCompletedCount !== undefined
            ? Number(row.todoistCompletedCount)
            : null
        );

        const recoveryVsSleep = computePearsonCorrelation(
          ordered.map((row) => ({
            x: toFiniteNumber(row.whoopSleepHours) ?? toFiniteNumber(row.samsungSleepHours),
            y: toFiniteNumber(row.whoopRecoveryScore),
          }))
        );
        const recoveryVsTasks = computePearsonCorrelation(
          ordered.map((row) => ({
            x:
              row.todoistCompletedCount !== null && row.todoistCompletedCount !== undefined
                ? Number(row.todoistCompletedCount)
                : null,
            y: toFiniteNumber(row.whoopRecoveryScore),
          }))
        );

        return {
          days,
          dateRange: {
            startDateKey: ordered[0]?.dateKey ?? null,
            endDateKey: ordered[ordered.length - 1]?.dateKey ?? null,
          },
          pointCount: ordered.length,
          series: {
            recovery: recoverySeries,
            sleepHours: sleepSeries,
            strain: strainSeries,
            hrvMs: hrvSeries,
            steps: stepsSeries,
            tasksCompleted: completedTaskSeries,
          },
          correlations: {
            recoveryVsSleep,
            recoveryVsTasksCompleted: recoveryVsTasks,
          },
        };
      }),
    captureToday: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();
        await captureDailySnapshotForUser(ctx.user.id, dateKey);

        return { success: true, dateKey };
      }),
  }),

  search: router({
    global: protectedProcedure
      .input(
        z.object({
          query: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(100).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const query = normalizeSearchQuery(input.query);
        const limit = input.limit ?? 30;

        const noteRowsPromise = listNotes(ctx.user.id, 300);
        const conversationRowsPromise = getConversationSummaries(ctx.user.id, 200);
        const todoistIntegrationPromise = getIntegrationByProvider(ctx.user.id, "todoist");
        const googleIntegrationPromise = getIntegrationByProvider(ctx.user.id, "google");

        const [noteRows, conversationRows, todoistIntegration, googleIntegration] = await Promise.all([
          noteRowsPromise,
          conversationRowsPromise,
          todoistIntegrationPromise,
          googleIntegrationPromise,
        ]);

        let todoistTasks: any[] = [];
        if (todoistIntegration?.accessToken) {
          try {
            todoistTasks = await getTodoistTasks(todoistIntegration.accessToken);
          } catch (error) {
            console.warn("[Search] Failed to load Todoist tasks:", error);
          }
        }

        let calendarEvents: any[] = [];
        let driveFiles: any[] = [];
        if (googleIntegration) {
          try {
            const accessToken = await getValidGoogleToken(ctx.user.id);
            const [events, files] = await Promise.all([
              getGoogleCalendarEvents(accessToken, { daysAhead: 120, maxResults: 250 }),
              searchGoogleDrive(accessToken, input.query),
            ]);
            calendarEvents = events;
            driveFiles = files;
          } catch (error) {
            console.warn("[Search] Failed to load Google search sources:", error);
          }
        }

        type SearchItem = {
          id: string;
          type: "task" | "note" | "calendar_event" | "conversation" | "drive_file";
          title: string;
          subtitle: string | null;
          url: string | null;
          timestamp: string | null;
          score: number;
        };

        const results: SearchItem[] = [];

        noteRows.forEach((note) => {
          const haystack = `${note.title} ${note.content} ${note.notebook}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: note.id,
            type: "note",
            title: note.title,
            subtitle: truncateText(note.content ?? "", 160),
            url: null,
            timestamp: safeIso(note.updatedAt ?? note.createdAt),
            score: score + 8,
          });
        });

        conversationRows.forEach((conversation) => {
          const title = String(conversation.title ?? "Conversation");
          const preview = String(conversation.lastMessagePreview ?? "");
          const haystack = `${title} ${preview}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: conversation.id,
            type: "conversation",
            title,
            subtitle: truncateText(preview, 160),
            url: null,
            timestamp: safeIso(conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt),
            score: score + 5,
          });
        });

        todoistTasks.forEach((task) => {
          const content = String(task?.content ?? "");
          const description = String(task?.description ?? "");
          const haystack = `${content} ${description}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: String(task?.id ?? ""),
            type: "task",
            title: content || "(Untitled task)",
            subtitle: description ? truncateText(description, 160) : null,
            url: null,
            timestamp: safeIso(task?.createdAt ?? task?.addedAt ?? task?.due?.date),
            score: score + 10,
          });
        });

        calendarEvents.forEach((event) => {
          const title = String(event?.summary ?? "");
          const location = String(event?.location ?? "");
          const description = String(event?.description ?? "");
          const haystack = `${title} ${location} ${description}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: String(event?.id ?? ""),
            type: "calendar_event",
            title: title || "(Untitled event)",
            subtitle: truncateText([location, description].filter(Boolean).join(" | "), 160) || null,
            url: toNonEmptyString(event?.htmlLink),
            timestamp: safeIso(event?.start?.dateTime ?? event?.start?.date),
            score: score + 7,
          });
        });

        driveFiles.forEach((file) => {
          const name = String(file?.name ?? "");
          const mimeType = String(file?.mimeType ?? "");
          const haystack = `${name} ${mimeType}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: String(file?.id ?? ""),
            type: "drive_file",
            title: name || "(Untitled file)",
            subtitle: mimeType || null,
            url: toNonEmptyString(file?.webViewLink),
            timestamp: safeIso(file?.modifiedTime),
            score: score + 4,
          });
        });

        results.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          const aTs = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bTs = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return bTs - aTs;
        });

        return {
          query: input.query,
          totalMatched: results.length,
          items: results.slice(0, limit),
        };
      }),
  }),

  supplements: router({
    listDefinitions: protectedProcedure.query(async ({ ctx }) => {
      return listSupplementDefinitions(ctx.user.id);
    }),
    listPriceLogs: protectedProcedure
      .input(
        z
          .object({
            definitionId: z.string().optional(),
            limit: z.number().min(1).max(500).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        return listSupplementPriceLogs(ctx.user.id, {
          definitionId: input?.definitionId,
          limit: input?.limit ?? 100,
        });
      }),
    createDefinition: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          brand: z.string().max(128).optional(),
          dose: z.string().min(1).max(64),
          doseUnit: z
            .enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"])
            .optional(),
          dosePerUnit: z.string().max(64).optional(),
          productUrl: z.string().max(2048).optional(),
          pricePerBottle: z.number().nonnegative().optional(),
          quantityPerBottle: z.number().nonnegative().optional(),
          timing: z.enum(["am", "pm"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await listSupplementDefinitions(ctx.user.id);
        const nextSortOrder =
          existing.length > 0
            ? Math.max(...existing.map((definition) => definition.sortOrder ?? 0)) + 1
            : 0;

        await createSupplementDefinition({
          id: nanoid(),
          userId: ctx.user.id,
          name: input.name.trim(),
          brand: input.brand?.trim() || null,
          dose: input.dose.trim(),
          doseUnit: input.doseUnit ?? "capsule",
          dosePerUnit: input.dosePerUnit?.trim() || null,
          productUrl: input.productUrl?.trim() || null,
          pricePerBottle: input.pricePerBottle ?? null,
          quantityPerBottle: input.quantityPerBottle ?? null,
          timing: input.timing ?? "am",
          isLocked: false,
          isActive: true,
          sortOrder: nextSortOrder,
        });

        return { success: true };
      }),
    scanBottleWithClaude: protectedProcedure
      .input(
        z.object({
          base64Data: z.string().max(10_000_000),
          contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          fileName: z.string().max(255).optional(),
          timing: z.enum(["am", "pm"]).optional(),
          autoLogPrice: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        performSupplementBottleScanForUser(ctx.user.id, input)
      ),
    mobileScanBottle: publicProcedure
      .input(
        z.object({
          customerEmail: z.string().email(),
          base64Data: z.string().max(10_000_000),
          contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
          timing: z.enum(["am", "pm"]).optional(),
          autoLogPrice: z.boolean().optional(),
          capturedAt: z.string().datetime({ offset: true }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { payload } = verifySupplementIngestSignedRequest({
          req: ctx.req,
          input,
        });

        const user = await getUserByEmail(payload.customerEmail);
        if (!user) {
          throw new Error(
            "No Coherence account found for this email. Sign in to the web app once, then retry."
          );
        }

        return performSupplementBottleScanForUser(user.id, {
          base64Data: payload.base64Data,
          contentType: payload.contentType,
          timing: payload.timing ?? undefined,
          autoLogPrice: payload.autoLogPrice,
        });
      }),
    checkPriceWithClaude: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          autoLogPrice: z.boolean().optional(),
          imageUrl: z.string().max(2048).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const definition = await getSupplementDefinitionById(ctx.user.id, input.definitionId);
        if (!definition) {
          throw new Error("Supplement definition not found.");
        }

        const anthropicIntegration = await getIntegrationByProvider(ctx.user.id, "anthropic");
        const apiKey = toNonEmptyString(anthropicIntegration?.accessToken);
        if (!apiKey) {
          throw new IntegrationNotConnectedError("Claude");
        }

        const anthropicMeta = parseJsonMetadata(anthropicIntegration?.metadata);
        const model =
          typeof anthropicMeta.model === "string" && anthropicMeta.model.trim().length > 0
            ? anthropicMeta.model.trim()
            : "claude-sonnet-4-20250514";

        const priceCheck = await checkSupplementPrice({
          credentials: { apiKey, model },
          supplementName: definition.name,
          brand: definition.brand,
          dosePerUnit: definition.dosePerUnit,
        });

        let priceLogCreated = false;

        if (priceCheck.pricePerBottle !== null) {
          await updateSupplementDefinition(ctx.user.id, definition.id, {
            pricePerBottle: priceCheck.pricePerBottle,
            productUrl: priceCheck.sourceUrl ?? definition.productUrl ?? null,
          });

          if (input.autoLogPrice ?? false) {
            await addSupplementPriceLog({
              id: nanoid(),
              userId: ctx.user.id,
              definitionId: definition.id,
              supplementName: definition.name,
              brand: definition.brand ?? null,
              pricePerBottle: priceCheck.pricePerBottle,
              currency: priceCheck.currency ?? "USD",
              sourceName: priceCheck.sourceName ?? null,
              sourceUrl: priceCheck.sourceUrl ?? null,
              sourceDomain: sourceDomainFromUrl(priceCheck.sourceUrl),
              confidence: priceCheck.confidence,
              imageUrl: input.imageUrl?.trim() || null,
              capturedAt: new Date(),
            });
            priceLogCreated = true;
          }
        }

        const updatedDefinition = await getSupplementDefinitionById(ctx.user.id, definition.id);

        return {
          success: true,
          definition: updatedDefinition,
          priceCheck,
          priceLogCreated,
        };
      }),
    logPrice: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          pricePerBottle: z.number().positive().optional(),
          currency: z.string().max(8).optional(),
          sourceName: z.string().max(128).optional(),
          sourceUrl: z.string().max(2048).optional(),
          confidence: z.number().min(0).max(1).optional(),
          imageUrl: z.string().max(2048).optional(),
          capturedAt: z.string().datetime({ offset: true }).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const definition = await getSupplementDefinitionById(ctx.user.id, input.definitionId);
        if (!definition) {
          throw new Error("Supplement definition not found.");
        }

        const pricePerBottle = input.pricePerBottle ?? definition.pricePerBottle ?? null;
        if (pricePerBottle === null) {
          throw new Error(
            "No price available to log. Add a price first or run Check Price with Claude."
          );
        }

        const sourceUrl = input.sourceUrl?.trim() || definition.productUrl || null;
        let inferredSourceName: string | null = null;
        if (sourceUrl) {
          try {
            inferredSourceName = new URL(sourceUrl).hostname.replace(/^www\./, "");
          } catch {
            inferredSourceName = null;
          }
        }
        const sourceName = input.sourceName?.trim() || inferredSourceName;

        await addSupplementPriceLog({
          id: nanoid(),
          userId: ctx.user.id,
          definitionId: definition.id,
          supplementName: definition.name,
          brand: definition.brand ?? null,
          pricePerBottle,
          currency: input.currency?.trim().toUpperCase() || "USD",
          sourceName,
          sourceUrl,
          sourceDomain: sourceDomainFromUrl(sourceUrl),
          confidence: input.confidence ?? null,
          imageUrl: input.imageUrl?.trim() || null,
          capturedAt: input.capturedAt ? new Date(input.capturedAt) : new Date(),
        });

        return { success: true };
      }),
    updateDefinition: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          name: z.string().min(1).max(128),
          brand: z.string().max(128).nullable().optional(),
          dose: z.string().min(1).max(64),
          doseUnit: z.enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"]),
          dosePerUnit: z.string().max(64).nullable().optional(),
          productUrl: z.string().max(2048).nullable().optional(),
          pricePerBottle: z.number().nonnegative().nullable().optional(),
          quantityPerBottle: z.number().nonnegative().nullable().optional(),
          timing: z.enum(["am", "pm"]),
          isLocked: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await updateSupplementDefinition(ctx.user.id, input.definitionId, {
          name: input.name.trim(),
          brand: input.brand?.trim() || null,
          dose: input.dose.trim(),
          doseUnit: input.doseUnit,
          dosePerUnit: input.dosePerUnit?.trim() || null,
          productUrl: input.productUrl?.trim() || null,
          pricePerBottle: input.pricePerBottle ?? null,
          quantityPerBottle: input.quantityPerBottle ?? null,
          timing: input.timing,
          isLocked: input.isLocked,
        });

        return { success: true };
      }),
    setDefinitionLock: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          isLocked: z.boolean(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await setSupplementDefinitionLock(ctx.user.id, input.definitionId, input.isLocked);
        return { success: true };
      }),
    deleteDefinition: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await deleteSupplementDefinition(ctx.user.id, input.definitionId);
        return { success: true };
      }),
    getLogs: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            limit: z.number().min(1).max(200).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();

        const definitions = await listSupplementDefinitions(ctx.user.id);
        const locked = definitions.filter((definition) => definition.isLocked);

        for (const definition of locked) {
          const existingLog = await getSupplementLogByDefinitionAndDate(
            ctx.user.id,
            definition.id,
            dateKey
          );
          if (!existingLog) {
            await addSupplementLog({
              id: nanoid(),
              userId: ctx.user.id,
              definitionId: definition.id,
              name: definition.name,
              dose: definition.dose,
              doseUnit: definition.doseUnit,
              timing: definition.timing,
              autoLogged: true,
              notes: null,
              dateKey,
              takenAt: new Date(),
            });
          }
        }
        return listSupplementLogs(ctx.user.id, dateKey, input?.limit ?? 100);
      }),
    addLog: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          dose: z.string().min(1).max(64),
          doseUnit: z
            .enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"])
            .optional(),
          timing: z.enum(["am", "pm"]).optional(),
          notes: z.string().max(500).optional(),
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          definitionId: z.string().optional(),
          autoLogged: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const dateKey = input.dateKey ?? getTodayDateKey();

        await addSupplementLog({
          id: nanoid(),
          userId: ctx.user.id,
          definitionId: input.definitionId ?? null,
          name: input.name.trim(),
          dose: input.dose.trim(),
          doseUnit: input.doseUnit ?? "capsule",
          timing: input.timing ?? "am",
          autoLogged: input.autoLogged ?? false,
          notes: input.notes?.trim() || null,
          dateKey,
          takenAt: new Date(),
        });
        return { success: true };
      }),
    deleteLog: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await deleteSupplementLog(ctx.user.id, input.id);
        return { success: true };
      }),
  }),

  habits: router({
    listDefinitions: protectedProcedure.query(async ({ ctx }) => {
      return listHabitDefinitions(ctx.user.id);
    }),
    createDefinition: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(120),
          color: z.string().min(1).max(32).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await listHabitDefinitions(ctx.user.id);
        const nextSortOrder =
          existing.length > 0 ? Math.max(...existing.map((habit) => habit.sortOrder ?? 0)) + 1 : 0;

        await createHabitDefinition({
          id: nanoid(),
          userId: ctx.user.id,
          name: input.name.trim(),
          color: (input.color ?? "slate").trim().toLowerCase(),
          sortOrder: nextSortOrder,
          isActive: true,
        });
        return { success: true };
      }),
    deleteDefinition: protectedProcedure
      .input(z.object({ habitId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await deleteHabitDefinition(ctx.user.id, input.habitId);
        return { success: true };
      }),
    getForDate: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const [definitions, completions] = await Promise.all([
          listHabitDefinitions(ctx.user.id),
          getHabitCompletionsByDate(ctx.user.id, dateKey),
        ]);

        const completedMap = new Map(
          completions.map((completion) => [completion.habitId, Boolean(completion.completed)])
        );

        return definitions.map((habit) => ({
          ...habit,
          completed: completedMap.get(habit.id) ?? false,
          dateKey,
        }));
      }),
    setCompletion: protectedProcedure
      .input(
        z.object({
          habitId: z.string(),
          completed: z.boolean(),
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const dateKey = input.dateKey ?? getTodayDateKey();
        const habits = await listHabitDefinitions(ctx.user.id);
        if (!habits.some((habit) => habit.id === input.habitId)) {
          throw new Error("Habit not found");
        }
        await upsertHabitCompletion(ctx.user.id, input.habitId, dateKey, input.completed);
        return { success: true };
      }),
    getStreaks: protectedProcedure.query(async ({ ctx }) => {
      const today = new Date();
      // Get last 14 days of data for streak calculation (show 7 days, need 14 for streak count)
      const sinceDate = new Date(today);
      sinceDate.setDate(sinceDate.getDate() - 13);
      const sinceDateKey = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")}`;

      const [definitions, completions] = await Promise.all([
        listHabitDefinitions(ctx.user.id),
        getHabitCompletionsRange(ctx.user.id, sinceDateKey),
      ]);

      // Build a map: habitId -> Set of completed dateKeys
      const completionMap = new Map<string, Set<string>>();
      for (const c of completions) {
        if (!completionMap.has(c.habitId)) {
          completionMap.set(c.habitId, new Set());
        }
        completionMap.get(c.habitId)!.add(c.dateKey);
      }

      // Generate last 7 date keys for the dot calendar
      const last7Days: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        last7Days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }

      return definitions.map((habit) => {
        const completedDates = completionMap.get(habit.id) ?? new Set();

        // Calculate current streak (consecutive days ending today or yesterday)
        let streak = 0;
        for (let i = 0; i < 14; i++) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          if (completedDates.has(key)) {
            streak++;
          } else if (i === 0) {
            // Today not done yet — continue checking from yesterday
            continue;
          } else {
            break;
          }
        }

        // Build 7-day calendar
        const calendar = last7Days.map((dateKey) => ({
          dateKey,
          completed: completedDates.has(dateKey),
        }));

        return {
          habitId: habit.id,
          name: habit.name,
          color: habit.color,
          streak,
          calendar,
        };
      });
    }),
  }),

  notes: router({
    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(1000).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limit = input?.limit ?? 100;
        const [noteRows, linkRows] = await Promise.all([
          listNotes(ctx.user.id, limit),
          listNoteLinks(ctx.user.id, undefined, Math.max(limit * 10, 200)),
        ]);

        const linksByNoteId = new Map<string, any[]>();
        for (const link of linkRows) {
          const bucket = linksByNoteId.get(link.noteId) ?? [];
          bucket.push(link);
          linksByNoteId.set(link.noteId, bucket);
        }

        return noteRows.map((note) => ({
          ...note,
          links: linksByNoteId.get(note.id) ?? [],
        }));
      }),
    create: protectedProcedure
      .input(
        z.object({
          notebook: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(180),
          content: z.string().max(250000).optional(),
          pinned: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const noteId = nanoid();
        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: input.notebook?.trim() || "General",
          title: input.title.trim(),
          content: input.content?.trim() || "",
          pinned: input.pinned ?? false,
        });

        return { success: true, noteId };
      }),
    update: protectedProcedure
      .input(
        z.object({
          noteId: z.string(),
          notebook: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(180).optional(),
          content: z.string().max(250000).optional(),
          pinned: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getNoteById(ctx.user.id, input.noteId);
        if (!existing) throw new Error("Note not found");

        await updateNote(ctx.user.id, input.noteId, {
          notebook: input.notebook?.trim(),
          title: input.title?.trim(),
          content: input.content,
          pinned: input.pinned,
        });

        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ noteId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await deleteNote(ctx.user.id, input.noteId);
        return { success: true };
      }),
    addLink: protectedProcedure
      .input(
        z.object({
          noteId: z.string(),
          linkType: z.enum(["todoist_task", "google_calendar_event", "note_link", "google_drive_file"]),
          externalId: z.string().min(1).max(255),
          seriesId: z.string().max(255).optional(),
          occurrenceStartIso: z.string().max(64).optional(),
          sourceUrl: z.string().max(4096).optional(),
          sourceTitle: z.string().max(255).optional(),
          metadata: z.record(z.string(), z.any()).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const note = await getNoteById(ctx.user.id, input.noteId);
        if (!note) throw new Error("Note not found");

        const linkResult = await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId: input.noteId,
          linkType: input.linkType,
          externalId: input.externalId.trim(),
          seriesId: input.seriesId?.trim() || "",
          occurrenceStartIso: input.occurrenceStartIso?.trim() || "",
          sourceUrl: input.sourceUrl?.trim() || null,
          sourceTitle: input.sourceTitle?.trim() || null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        });

        if (linkResult.created) {
          await updateNote(ctx.user.id, input.noteId, {});
        }
        return { success: true, alreadyLinked: !linkResult.created };
      }),
    removeLink: protectedProcedure
      .input(z.object({ linkId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        await deleteNoteLink(ctx.user.id, input.linkId);
        return { success: true };
      }),
    uploadImage: protectedProcedure
      .input(
        z.object({
          base64Data: z.string().max(10_000_000),
          contentType: z.enum([
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/svg+xml",
          ]),
          fileName: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const extMap: Record<string, string> = {
          "image/png": "png",
          "image/jpeg": "jpg",
          "image/gif": "gif",
          "image/webp": "webp",
          "image/svg+xml": "svg",
        };
        const ext = extMap[input.contentType] ?? "png";
        const key = `notes/${ctx.user.id}/images/${nanoid()}.${ext}`;
        const buffer = Buffer.from(input.base64Data, "base64");

        const { url } = await storagePut(key, buffer, input.contentType);
        return { url };
      }),
    createFromTodoistTask: protectedProcedure
      .input(
        z.object({
          taskId: z.string().min(1).max(255),
          taskContent: z.string().min(1).max(1000),
          taskUrl: z.string().max(4096).optional(),
          dueDate: z.string().max(128).optional(),
          projectName: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const noteId = nanoid();

        const title = `Task: ${input.taskContent.slice(0, 120)}`;
        const contentLines = [
          `Task: ${input.taskContent}`,
          input.projectName ? `Project: ${input.projectName}` : null,
          input.dueDate ? `Due: ${input.dueDate}` : null,
          input.taskUrl ? `URL: ${input.taskUrl}` : null,
          "",
        ].filter(Boolean);

        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: "Tasks",
          title,
          content: contentLines.join("\n"),
          pinned: false,
        });

        await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId,
          linkType: "todoist_task",
          externalId: input.taskId,
          seriesId: "",
          occurrenceStartIso: "",
          sourceUrl: input.taskUrl?.trim() || null,
          sourceTitle: input.taskContent.slice(0, 255),
          metadata: JSON.stringify({
            dueDate: input.dueDate ?? null,
            projectName: input.projectName ?? null,
          }),
        });

        return { success: true, noteId };
      }),
    createFromCalendarEvent: protectedProcedure
      .input(
        z.object({
          eventId: z.string().min(1).max(255),
          eventSummary: z.string().min(1).max(1000),
          eventUrl: z.string().max(4096).optional(),
          start: z.string().max(128).optional(),
          location: z.string().max(500).optional(),
          recurringEventId: z.string().max(255).optional(),
          iCalUID: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const noteId = nanoid();

        const title = `Event: ${input.eventSummary.slice(0, 120)}`;
        const contentLines = [
          `Event: ${input.eventSummary}`,
          input.start ? `Start: ${input.start}` : null,
          input.location ? `Location: ${input.location}` : null,
          input.eventUrl ? `URL: ${input.eventUrl}` : null,
          "",
        ].filter(Boolean);

        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: "Meetings",
          title,
          content: contentLines.join("\n"),
          pinned: false,
        });

        await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId,
          linkType: "google_calendar_event",
          externalId: input.eventId,
          seriesId: (input.recurringEventId || input.iCalUID || "").trim(),
          occurrenceStartIso: input.start?.trim() || "",
          sourceUrl: input.eventUrl?.trim() || null,
          sourceTitle: input.eventSummary.slice(0, 255),
          metadata: JSON.stringify({
            location: input.location ?? null,
            recurringEventId: input.recurringEventId ?? null,
            iCalUID: input.iCalUID ?? null,
          }),
        });

        return { success: true, noteId };
      }),
  }),

  dataExport: router({
    dumpAll: protectedProcedure
      .input(
        z
          .object({
            metricsLimit: z.number().min(1).max(3650).optional(),
            logsLimit: z.number().min(1).max(5000).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limits = {
          metrics: input?.metricsLimit ?? 365,
          logs: input?.logsLimit ?? 2000,
        };
        const [
          metrics,
          supplementLogs,
          supplementDefinitions,
          habitDefinitions,
          habitCompletions,
          nightlySnapshots,
          samsungIntegration,
          latestSamsungRaw,
        ] = await Promise.all([
          getDailyMetricsHistory(ctx.user.id, limits.metrics),
          listSupplementLogs(ctx.user.id, undefined, limits.logs),
          listSupplementDefinitions(ctx.user.id),
          listHabitDefinitions(ctx.user.id),
          listHabitCompletions(ctx.user.id, limits.logs),
          listDailySnapshots(ctx.user.id, limits.metrics),
          getIntegrationByProvider(ctx.user.id, "samsung-health"),
          getLatestSamsungSyncPayload(ctx.user.id),
        ]);

        let samsungLatestMetadata: Record<string, unknown> | null = null;
        if (samsungIntegration?.metadata) {
          samsungLatestMetadata = parseJsonMetadata(samsungIntegration.metadata);
        }

        let samsungRawPayload: Record<string, unknown> | null = null;
        if (latestSamsungRaw?.payload) {
          try {
            samsungRawPayload = JSON.parse(latestSamsungRaw.payload) as Record<string, unknown>;
          } catch {
            samsungRawPayload = null;
          }
        }

        return {
          generatedAt: new Date().toISOString(),
          userId: ctx.user.id,
          tables: {
            dailyHealthMetrics: metrics,
            supplementLogs,
            supplementDefinitions,
            habitDefinitions,
            habitCompletions,
            nightlySnapshots,
          },
          latest: {
            samsungIntegrationMetadata: samsungLatestMetadata,
            samsungRawPayload,
          },
        };
      }),
    dumpStructuredCsv: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(3650).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limit = input?.limit ?? 365;
        const [metrics, supplementLogs, supplementDefinitions, habitCompletions, habitDefinitions, snapshots] = await Promise.all([
          getDailyMetricsHistory(ctx.user.id, limit),
          listSupplementLogs(ctx.user.id, undefined, Math.min(limit * 20, 5000)),
          listSupplementDefinitions(ctx.user.id),
          listHabitCompletions(ctx.user.id, Math.min(limit * 20, 5000)),
          listHabitDefinitions(ctx.user.id),
          listDailySnapshots(ctx.user.id, limit),
        ]);

        const dateSet = new Set<string>();
        for (const row of metrics) dateSet.add(row.dateKey);
        for (const row of supplementLogs) dateSet.add(row.dateKey);
        for (const row of habitCompletions) dateSet.add(row.dateKey);
        for (const row of snapshots) dateSet.add(row.dateKey);

        const nextDateKey = (dateKey: string): string => {
          const date = new Date(`${dateKey}T00:00:00`);
          if (Number.isNaN(date.getTime())) return dateKey;
          date.setDate(date.getDate() + 1);
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, "0");
          const d = String(date.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}`;
        };

        const toDateKey = (date: Date): string => {
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, "0");
          const d = String(date.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}`;
        };

        const completedTodoistTaskCountsByDate = new Map<string, number>();

        try {
          const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
          if (todoistIntegration?.accessToken) {
            const todayDateKey = getTodayDateKey();
            const startDate = new Date(`${todayDateKey}T00:00:00`);
            startDate.setDate(startDate.getDate() - (limit - 1));
            const completedTasks = await getTodoistCompletedTasksInRange(
              todoistIntegration.accessToken,
              toDateKey(startDate),
              nextDateKey(todayDateKey)
            );
            for (const task of completedTasks) {
              completedTodoistTaskCountsByDate.set(
                task.dateKey,
                (completedTodoistTaskCountsByDate.get(task.dateKey) ?? 0) + 1
              );
              dateSet.add(task.dateKey);
            }
          }
        } catch (error) {
          console.error("[Data Export] Failed to load Todoist completed counts:", error);
        }

        const dateKeys = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
        const metricsByDate = new Map(metrics.map((row) => [row.dateKey, row]));

        const snapshotsByDate = new Map<string, Record<string, unknown>>();
        for (const snapshot of snapshots) {
          if (!snapshot.samsungPayload && !snapshot.whoopPayload) continue;
          snapshotsByDate.set(snapshot.dateKey, {
            whoopPayload: snapshot.whoopPayload,
            samsungPayload: snapshot.samsungPayload,
          });
        }

        const supplementKey = (name: string, timing: string, doseUnit: string) =>
          `${name.trim().toLowerCase()}|${timing.trim().toLowerCase()}|${doseUnit.trim().toLowerCase()}`;
        const supplementLabel = (name: string, timing: string, doseUnit: string) =>
          `Supplement: ${name} | Timing: ${timing.toUpperCase()} | Unit: ${doseUnit}`;
        const parseDoseNumber = (value: string): number | null => {
          const trimmed = value.trim();
          if (!trimmed) return null;
          const match = trimmed.match(/-?\d+(\.\d+)?/);
          if (!match) return null;
          const parsed = Number(match[0]);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const formatAmount = (value: number): string => {
          if (!Number.isFinite(value)) return "0";
          if (Number.isInteger(value)) return String(value);
          return value.toFixed(3).replace(/\.?0+$/, "");
        };

        const supplementByKey = new Map<
          string,
          { label: string; sortOrder: number }
        >();
        for (const definition of supplementDefinitions) {
          const key = supplementKey(definition.name, definition.timing, definition.doseUnit);
          if (!supplementByKey.has(key)) {
            supplementByKey.set(key, {
              label: supplementLabel(definition.name, definition.timing, definition.doseUnit),
              sortOrder: definition.sortOrder ?? Number.MAX_SAFE_INTEGER,
            });
          }
        }

        const supplementAmountsByKey = new Map<string, Map<string, number>>();
        for (const log of supplementLogs) {
          const key = supplementKey(log.name, log.timing, log.doseUnit);
          if (!supplementByKey.has(key)) {
            supplementByKey.set(key, {
              label: supplementLabel(log.name, log.timing, log.doseUnit),
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          }
          const byDate = supplementAmountsByKey.get(key) ?? new Map<string, number>();
          const numericDose = parseDoseNumber(log.dose);
          const currentTotal = byDate.get(log.dateKey) ?? 0;
          byDate.set(log.dateKey, currentTotal + (numericDose ?? 0));
          supplementAmountsByKey.set(key, byDate);
        }

        const habitById = new Map<
          string,
          { label: string; sortOrder: number }
        >(
          habitDefinitions.map((habit) => [
            habit.id,
            { label: habit.name, sortOrder: habit.sortOrder ?? Number.MAX_SAFE_INTEGER },
          ])
        );
        const habitCompletionsById = new Map<string, Map<string, boolean>>();
        for (const completion of habitCompletions) {
          if (!habitById.has(completion.habitId)) {
            habitById.set(completion.habitId, {
              label: completion.habitId,
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          }
          const byDate = habitCompletionsById.get(completion.habitId) ?? new Map<string, boolean>();
          byDate.set(completion.dateKey, Boolean(completion.completed));
          habitCompletionsById.set(completion.habitId, byDate);
        }

        const supplementRows = Array.from(supplementByKey.entries())
          .map(([key, value]) => ({ key, ...value }))
          .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));
        const habitRows = Array.from(habitById.entries())
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));

        const asObj = (value: unknown): Record<string, unknown> =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const asNum = (value: unknown): number | null =>
          typeof value === "number" && Number.isFinite(value) ? value : null;
        const parseJson = (value: unknown): Record<string, unknown> => {
          if (typeof value !== "string" || !value) return {};
          try {
            return asObj(JSON.parse(value));
          } catch {
            return {};
          }
        };
        const getWhoop = (dateKey: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const whoopPayload = parseJson(row?.whoopPayload);
          return asNum(whoopPayload[key]);
        };
        const getSamsungSummary = (dateKey: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const samsungPayload = parseJson(row?.samsungPayload);
          const summary = asObj(samsungPayload.summary);
          return asNum(summary[key]);
        };
        const getSamsungRaw = (dateKey: string, section: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const samsungPayload = parseJson(row?.samsungPayload);
          const sectionObj = asObj(samsungPayload[section]);
          return asNum(sectionObj[key]);
        };
        const getSamsungSleepHoursFallback = (dateKey: string): number | null => {
          const summaryMinutes = getSamsungSummary(dateKey, "sleepTotalMinutes");
          if (summaryMinutes !== null) {
            return Number((summaryMinutes / 60).toFixed(1));
          }
          const rawMinutes = getSamsungRaw(dateKey, "sleep", "totalSleepMinutes");
          if (rawMinutes !== null) {
            return Number((rawMinutes / 60).toFixed(1));
          }
          return null;
        };

        const csvRows: string[][] = [];
        const addMetricRow = (
          label: string,
          getter: (dateKey: string) => string | number | null | undefined
        ) => {
          csvRows.push([
            label,
            ...dateKeys.map((dateKey) => {
              const value = getter(dateKey);
              return value === null || value === undefined ? "" : String(value);
            }),
          ]);
        };
        const addSectionRow = (label: string) => {
          csvRows.push([label, ...dateKeys.map(() => "")]);
        };

        addMetricRow("WHOOP Recovery %", (dateKey) => metricsByDate.get(dateKey)?.whoopRecoveryScore ?? getWhoop(dateKey, "recoveryScore"));
        addMetricRow("WHOOP Day Strain", (dateKey) => metricsByDate.get(dateKey)?.whoopDayStrain ?? getWhoop(dateKey, "dayStrain"));
        addMetricRow("WHOOP Sleep Hours", (dateKey) => metricsByDate.get(dateKey)?.whoopSleepHours ?? getWhoop(dateKey, "sleepHours"));
        addMetricRow("WHOOP HRV ms", (dateKey) => metricsByDate.get(dateKey)?.whoopHrvMs ?? getWhoop(dateKey, "hrvRmssdMilli"));
        addMetricRow("WHOOP Resting HR bpm", (dateKey) => metricsByDate.get(dateKey)?.whoopRestingHr ?? getWhoop(dateKey, "restingHeartRate"));
        addMetricRow("WHOOP Sleep Performance %", (dateKey) => getWhoop(dateKey, "sleepPerformance"));
        addMetricRow("WHOOP Sleep Efficiency %", (dateKey) => getWhoop(dateKey, "sleepEfficiency"));
        addMetricRow("WHOOP Sleep Consistency %", (dateKey) => getWhoop(dateKey, "sleepConsistency"));
        addMetricRow("WHOOP Respiratory Rate", (dateKey) => getWhoop(dateKey, "respiratoryRate"));
        addMetricRow("WHOOP SpO2 %", (dateKey) => getWhoop(dateKey, "spo2Percentage"));
        addMetricRow("WHOOP Avg HR bpm", (dateKey) => getWhoop(dateKey, "averageHeartRate"));
        addMetricRow("WHOOP Max HR bpm", (dateKey) => getWhoop(dateKey, "maxHeartRate"));

        addMetricRow("Samsung Steps", (dateKey) => metricsByDate.get(dateKey)?.samsungSteps ?? getSamsungSummary(dateKey, "steps") ?? getSamsungRaw(dateKey, "activity", "steps"));
        addMetricRow("Samsung Sleep Hours", (dateKey) => metricsByDate.get(dateKey)?.samsungSleepHours ?? getSamsungSleepHoursFallback(dateKey));
        addMetricRow("Samsung SpO2 Avg %", (dateKey) => metricsByDate.get(dateKey)?.samsungSpo2AvgPercent ?? getSamsungSummary(dateKey, "spo2AvgPercent") ?? getSamsungRaw(dateKey, "oxygenAndTemperature", "spo2AvgPercent"));
        addMetricRow("Samsung Sleep Score", (dateKey) => metricsByDate.get(dateKey)?.samsungSleepScore ?? getSamsungSummary(dateKey, "sleepScore") ?? getSamsungRaw(dateKey, "sleep", "sleepScore"));
        addMetricRow("Samsung Energy Score", (dateKey) => metricsByDate.get(dateKey)?.samsungEnergyScore ?? getSamsungSummary(dateKey, "energyScore") ?? getSamsungRaw(dateKey, "cardio", "recoveryScore"));
        addMetricRow("Todoist Completed Tasks", (dateKey) => {
          const liveCount = completedTodoistTaskCountsByDate.get(dateKey) ?? null;
          if (liveCount !== null) return liveCount;
          return metricsByDate.get(dateKey)?.todoistCompletedCount ?? 0;
        });

        addSectionRow("Habits");
        if (habitRows.length === 0) {
          addMetricRow("No habits configured", () => "");
        } else {
          for (const habit of habitRows) {
            addMetricRow(habit.label, (dateKey) => {
              const completed = habitCompletionsById.get(habit.id)?.get(dateKey) ?? false;
              return completed ? 1 : 0;
            });
          }
        }

        addSectionRow("Supplements");
        if (supplementRows.length === 0) {
          addMetricRow("No supplements configured", () => "");
        } else {
          for (const supplement of supplementRows) {
            addMetricRow(supplement.label, (dateKey) => {
              const amount = supplementAmountsByKey.get(supplement.key)?.get(dateKey) ?? 0;
              return formatAmount(amount);
            });
          }
        }

        const escapeCsv = (value: string) => {
          if (/[",\n]/.test(value)) {
            return `"${value.replace(/"/g, "\"\"")}"`;
          }
          return value;
        };
        const csv = [
          ["Metric", ...dateKeys],
          ...csvRows,
        ]
          .map((row) => row.map((cell) => escapeCsv(cell)).join(","))
          .join("\n");

        return {
          generatedAt: new Date().toISOString(),
          filename: `coherence-structured-metrics-${new Date().toISOString().slice(0, 10)}.csv`,
          csv,
          dates: dateKeys,
          rowCount: csvRows.length,
        };
      }),
  }),

  dock: router({
    getItemDetails: protectedProcedure
      .input(z.object({
        source: z.enum(["gmail", "gcal", "gsheet", "todoist", "url"]),
        url: z.string(),
        meta: z.record(z.string(), z.any()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          if (input.source === "gmail") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Email" };
            }
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            // Extract message ID from parsed metadata or URL fallback.
            let messageId = input.meta?.messageId as string | undefined;
            if (!messageId) {
              try {
                const urlObj = new URL(input.url);
                const hash = urlObj.hash.startsWith("#") ? urlObj.hash.slice(1) : urlObj.hash;
                const hashMessageId = hash.split("/").pop();
                const queryMessageId = urlObj.searchParams.get("th");
                messageId = queryMessageId || hashMessageId || undefined;
              } catch {
                messageId = undefined;
              }
            }
            if (!messageId) return { title: "Email" };
            
            // Fetch email details from Gmail API
            const response = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Email" };
            
            const data = await response.json();
            const subject = data.payload?.headers?.find(
              (h: any) => h.name === "Subject"
            )?.value || "Email";
            
            return { title: subject };
          }
          
          if (input.source === "gcal") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Calendar Event" };
            }
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            // Extract event ID from meta (already decoded in frontend) or eid parameter
            let eventId = input.meta?.eventId as string | undefined;
            
            if (!eventId) {
              const eid = input.meta?.eid as string;
              if (!eid) return { title: "Calendar Event" };
              
              // Decode base64 event ID
              try {
                const decoded = Buffer.from(eid, "base64").toString("utf-8");
                // Event ID format: "eventId calendarId"
                eventId = decoded.split(" ")[0];
              } catch {
                return { title: "Calendar Event" };
              }
            }
            
            if (!eventId) return { title: "Calendar Event" };
            
            // Fetch event details from Calendar API
            const response = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Calendar Event" };
            
            const event = await response.json();
            return { title: event.summary || "Calendar Event" };
          }
          
          if (input.source === "gsheet") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Spreadsheet" };
            }
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            const sheetId = input.meta?.sheetId as string;
            if (!sheetId) return { title: "Spreadsheet" };
            
            // Fetch spreadsheet details from Drive API
            const response = await fetch(
              `https://www.googleapis.com/drive/v3/files/${sheetId}?fields=name`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Spreadsheet" };
            
            const file = await response.json();
            return { title: file.name || "Spreadsheet" };
          }
          
          if (input.source === "todoist") {
            const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
            if (!todoistIntegration?.accessToken) {
              return { title: "Task" };
            }
            
            let taskId = input.meta?.taskId as string | undefined;
            if (!taskId) {
              const taskMatch = input.url.match(/\/task\/([A-Za-z0-9_-]+)/);
              taskId = taskMatch?.[1];
            }
            if (!taskId) return { title: "Task" };
            
            // Fetch task details from Todoist API (v1).
            const response = await fetch(
              `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
              { headers: { Authorization: `Bearer ${todoistIntegration.accessToken}` } }
            );
            
            if (!response.ok) {
              const tasks = await getTodoistTasks(todoistIntegration.accessToken);
              const task = tasks.find((t) => t.id === taskId);
              return { title: task?.content || "Task" };
            }
            
            const data = await response.json();
            const task = data?.task ?? data;
            return { title: task?.content || "Task" };
          }
          
          return { title: input.url };
        } catch (error) {
          console.error(`[Dock] Error fetching details for ${input.source}:`, error);
          return { title: input.source === "gmail" ? "Email" : input.source === "gcal" ? "Calendar Event" : input.source === "gsheet" ? "Spreadsheet" : input.source === "todoist" ? "Task" : input.url };
        }
      }),
  }),

  engagement: router({
    recordBatch: protectedProcedure
      .input(
        z.object({
          events: z.array(
            z.object({
              sectionId: z.string().max(48),
              eventType: z.string().max(32),
              eventValue: z.string().max(64).optional(),
              sessionDate: z.string().length(10),
              durationMs: z.number().int().optional(),
            })
          ),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.events.length === 0) return { ok: true };
        await insertSectionEngagementBatch(
          input.events.map((event) => ({
            userId: ctx.user.id,
            sectionId: event.sectionId,
            eventType: event.eventType,
            eventValue: event.eventValue ?? null,
            sessionDate: event.sessionDate,
            durationMs: event.durationMs ?? null,
          }))
        );
        return { ok: true };
      }),

    setRating: protectedProcedure
      .input(
        z.object({
          sectionId: z.string().max(48),
          rating: z.enum(["essential", "useful", "rarely-use", "remove"]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const now = new Date();
        const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        await insertSectionEngagementBatch([
          {
            userId: ctx.user.id,
            sectionId: input.sectionId,
            eventType: "rating",
            eventValue: input.rating,
            sessionDate: dateKey,
            durationMs: null,
          },
        ]);
        return { ok: true };
      }),

    getRatings: protectedProcedure.query(async ({ ctx }) => {
      return getSectionRatings(ctx.user.id);
    }),

    getSummary: protectedProcedure
      .input(
        z.object({
          sinceDateKey: z.string().length(10),
        })
      )
      .query(async ({ ctx, input }) => {
        return getSectionEngagementSummary(ctx.user.id, input.sinceDateKey);
      }),

    clearAll: protectedProcedure.mutation(async ({ ctx }) => {
      await clearSectionEngagement(ctx.user.id);
      return { ok: true };
    }),
  }),

  anthropic: router({
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().max(512).optional(),
          model: z.string().max(64).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await getIntegrationByProvider(ctx.user.id, "anthropic");
        const incomingKey = input.apiKey?.trim();
        const accessToken = incomingKey || existing?.accessToken || null;

        if (!accessToken) {
          throw new Error("Anthropic API key is required");
        }

        const existingMeta = parseJsonMetadata(existing?.metadata);
        const existingModel = typeof existingMeta.model === "string" ? existingMeta.model : "claude-sonnet-4-20250514";
        const requestedModel = input.model?.trim();
        const model = requestedModel && requestedModel.length > 0 ? requestedModel : existingModel;

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "anthropic",
          accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: JSON.stringify({ model }),
        });
        return { success: true, model };
      }),
  }),

  // ── SunPower PVS production readings (mobile app → DB → dashboard) ──
  solarReadings: router({
    /** Public endpoint secured via HMAC signature headers from the mobile app. */
    submit: publicProcedure
      .input(
        z.object({
          customerEmail: z.string().email(),
          nonId: z.string().optional(),
          lifetimeKwh: z.number().positive(),
          meterSerial: z.string().optional(),
          firmwareVersion: z.string().optional(),
          pvsSerial5: z.string().max(5).optional(),
          readAt: z.string().datetime({ offset: true }),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { payload, readAt } = verifySolarReadingsSignedRequest({
          req: ctx.req,
          input,
        });
        await insertProductionReading({
          id: nanoid(),
          customerEmail: payload.customerEmail,
          nonId: payload.nonId,
          lifetimeKwh: payload.lifetimeKwh,
          meterSerial: payload.meterSerial,
          firmwareVersion: payload.firmwareVersion,
          pvsSerial5: payload.pvsSerial5,
          readAt,
        });
        return { success: true };
      }),

    /** Protected: dashboard summary card. */
    summary: protectedProcedure.query(async () => {
      return getProductionReadingSummary();
    }),

    /** Protected: list readings with optional filters. */
    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(500).optional(),
            email: z.string().optional(),
            nonId: z.string().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return listProductionReadings(input ?? undefined);
      }),
  }),

  // =========================================================================
  // Solis Cloud
  // =========================================================================
  solis: router({
    ...createSolarConnectionRouter({
      providerKey: SOLIS_PROVIDER,
      displayName: "Solis",
      credentialSchema: z.object({ apiKey: z.string().min(1), apiSecret: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseSolisMetadata,
      serializeMetadata: serializeSolisMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `Solis API ${existing.connections.length + 1}`,
        apiKey: (input.apiKey as string).trim(),
        apiSecret: (input.apiSecret as string).trim(),
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.apiKey,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        baseUrl: c.baseUrl,
        apiKeyMasked: maskApiKey(c.apiKey),
        updatedAt: c.updatedAt,
        isActive,
      }),
      includeBaseUrlInStatus: true,
    }),
    listStations: protectedProcedure.query(async ({ ctx }) => { const context = await getSolisContext(ctx.user.id); return listStationsSolis(context); }),
    getProductionSnapshot: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getSolisContext(ctx.user.id); return getStationProductionSnapshotSolis(context, input.stationId.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // GoodWe SEMS
  // =========================================================================
  goodwe: router({
    ...createSolarConnectionRouter({
      providerKey: GOODWE_PROVIDER,
      displayName: "GoodWe",
      credentialSchema: z.object({ account: z.string().min(1), password: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseGoodWeMetadata,
      serializeMetadata: serializeGoodWeMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `GoodWe ${existing.connections.length + 1}`,
        account: (input.account as string).trim(),
        password: input.password as string,
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.account,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        accountMasked: maskApiKey(c.account),
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listStations: protectedProcedure.query(async ({ ctx }) => { const context = await getGoodWeContext(ctx.user.id); return listStationsGoodWe(context); }),
    getProductionSnapshot: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getGoodWeContext(ctx.user.id); return getStationProductionSnapshotGoodWe(context, input.stationId.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // Generac PWRfleet
  // =========================================================================
  generac: router({
    ...createSolarConnectionRouter({
      providerKey: GENERAC_PROVIDER,
      displayName: "Generac",
      credentialSchema: z.object({ apiKey: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseGeneracMetadata,
      serializeMetadata: serializeGeneracMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `Generac API ${existing.connections.length + 1}`,
        apiKey: (input.apiKey as string).trim(),
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.apiKey,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        apiKeyMasked: maskApiKey(c.apiKey),
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listSystems: protectedProcedure.query(async ({ ctx }) => { const context = await getGeneracContext(ctx.user.id); return listSystemsGenerac(context); }),
    getProductionSnapshot: protectedProcedure.input(z.object({ systemId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getGeneracContext(ctx.user.id); return getSystemProductionSnapshotGenerac(context, input.systemId.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // Locus Energy / SolarNOC
  // =========================================================================
  locus: router({
    ...createSolarConnectionRouter({
      providerKey: LOCUS_PROVIDER,
      displayName: "Locus",
      credentialSchema: z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1), partnerId: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseLocusMetadata,
      serializeMetadata: serializeLocusMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `Locus API ${existing.connections.length + 1}`,
        clientId: (input.clientId as string).trim(),
        clientSecret: (input.clientSecret as string).trim(),
        partnerId: (input.partnerId as string).trim(),
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.clientId,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        clientIdMasked: maskApiKey(c.clientId),
        partnerId: c.partnerId,
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listSites: protectedProcedure.query(async ({ ctx }) => { const context = await getLocusContext(ctx.user.id); return listSitesLocus(context); }),
    getProductionSnapshot: protectedProcedure.input(z.object({ siteId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getLocusContext(ctx.user.id); return getSiteProductionSnapshotLocus(context, input.siteId.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // Growatt
  // =========================================================================
  growatt: router({
    ...createSolarConnectionRouter({
      providerKey: GROWATT_PROVIDER,
      displayName: "Growatt",
      credentialSchema: z.object({ username: z.string().min(1), password: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseGrowattMetadata,
      serializeMetadata: serializeGrowattMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `Growatt ${existing.connections.length + 1}`,
        username: (input.username as string).trim(),
        password: input.password as string,
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.username,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        usernameMasked: maskApiKey(c.username),
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listPlants: protectedProcedure.query(async ({ ctx }) => { const context = await getGrowattContext(ctx.user.id); return listPlantsGrowatt(context); }),
    getProductionSnapshot: protectedProcedure.input(z.object({ plantId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getGrowattContext(ctx.user.id); return getPlantProductionSnapshotGrowatt(context, input.plantId.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // APsystems EMA
  // =========================================================================
  apsystems: router({
    ...createSolarConnectionRouter({
      providerKey: APSYSTEMS_PROVIDER,
      displayName: "APsystems",
      credentialSchema: z.object({ appId: z.string().min(1), appSecret: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseAPsystemsMetadata,
      serializeMetadata: serializeAPsystemsMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `APsystems API ${existing.connections.length + 1}`,
        appId: (input.appId as string).trim(),
        appSecret: (input.appSecret as string).trim(),
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.appId,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        apiKeyMasked: maskApiKey(c.appId),
        hasSecret: !!c.appSecret,
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listSystems: protectedProcedure.query(async ({ ctx }) => { const context = await getAPsystemsContext(ctx.user.id); return listSystemsApsystems(context); }),
    listAllSids: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, APSYSTEMS_PROVIDER);
      const metadata = parseAPsystemsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
      if (metadata.connections.length === 0) throw new Error("No APsystems profiles saved.");
      type TaggedSystem = { systemId: string; name: string; capacity: number | null; address: string | null; status: string | null; connectionId: string; connectionName: string };
      const profileResults = await Promise.all(
        metadata.connections.map(async (conn) => {
          try {
            const context = { appId: conn.appId, appSecret: conn.appSecret, baseUrl: conn.baseUrl ?? metadata.baseUrl };
            const result = await listSystemsApsystems(context);
            const systems: TaggedSystem[] = result.systems.map((s) => ({ ...s, connectionId: conn.id, connectionName: conn.name }));
            const raw = result.raw as Record<string, unknown>;
            return {
              connectionId: conn.id, connectionName: conn.name,
              systemCount: result.systems.length,
              ownCount: (raw.uniqueOwnSids as number) ?? 0,
              ownTotal: (raw.ownSystems as number) ?? 0,
              partnerCount: (raw.uniquePartnerSids as number) ?? 0,
              partnerTotal: (raw.partnerSystems as number) ?? 0,
              partnerRawEntries: (raw.fetchedPartner as number) ?? 0,
              error: (raw.ownError || raw.partnerError) ? `own: ${raw.ownError ?? "ok"}, partner: ${raw.partnerError ?? "ok"}` : null,
              systems,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { connectionId: conn.id, connectionName: conn.name, systemCount: 0, ownCount: 0, ownTotal: 0, partnerCount: 0, partnerTotal: 0, partnerRawEntries: 0, error: msg, systems: [] as TaggedSystem[] };
          }
        })
      );
      const allSystems = profileResults.flatMap((r) => r.systems);
      const seen = new Set<string>();
      const deduped = allSystems.filter((s) => { if (seen.has(s.systemId)) return false; seen.add(s.systemId); return true; });
      const perProfile = profileResults.map(({ systems: _s, ...rest }) => rest);
      return { systems: deduped, perProfile, totalProfiles: metadata.connections.length };
    }),
    getProductionSnapshot: protectedProcedure.input(z.object({ systemId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getAPsystemsContext(ctx.user.id); return getSystemProductionSnapshotApsystems(context, input.systemId.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // EKM Encompass
  // =========================================================================
  ekm: router({
    ...createSolarConnectionRouter({
      providerKey: EKM_PROVIDER,
      displayName: "EKM",
      credentialSchema: z.object({ apiKey: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseEkmMetadata,
      serializeMetadata: serializeEkmMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `EKM API ${existing.connections.length + 1}`,
        apiKey: (input.apiKey as string).trim(),
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.apiKey,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        apiKeyMasked: maskApiKey(c.apiKey),
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    getProductionSnapshot: protectedProcedure.input(z.object({ meterNumber: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getEkmContext(ctx.user.id); return getMeterProductionSnapshotEkm(context, input.meterNumber.trim(), input.anchorDate); }),
  }),

  // =========================================================================
  // Hoymiles S-Miles Cloud
  // =========================================================================
  hoymiles: router({
    ...createSolarConnectionRouter({
      providerKey: HOYMILES_PROVIDER,
      displayName: "Hoymiles",
      credentialSchema: z.object({ username: z.string().min(1), password: z.string().min(1), connectionName: z.string().optional(), baseUrl: z.string().optional() }),
      parseMetadata: parseHoymilesMetadata,
      serializeMetadata: serializeHoymilesMetadata,
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `Hoymiles ${existing.connections.length + 1}`,
        username: (input.username as string).trim(),
        password: input.password as string,
        baseUrl: toNonEmptyString(input.baseUrl as string) ?? existing.baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.username,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        usernameMasked: maskApiKey(c.username),
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listStations: protectedProcedure.query(async ({ ctx }) => { const context = await getHoymilesContext(ctx.user.id); return listStationsHoymiles(context); }),
    listAllStations: protectedProcedure.mutation(async ({ ctx }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, HOYMILES_PROVIDER);
      const metadata = parseHoymilesMetadata(integration?.metadata);
      if (metadata.connections.length === 0) throw new Error("No Hoymiles profiles saved.");
      const allStations: Array<{ stationId: string; name: string; capacity: number | null; address: string | null; status: string | null; connectionId: string; connectionName: string }> = [];
      const perProfile: Array<{ connectionId: string; connectionName: string; stationCount: number; error: string | null }> = [];
      for (const conn of metadata.connections) {
        try {
          const context = { username: conn.username, password: conn.password, baseUrl: conn.baseUrl ?? metadata.baseUrl };
          const result = await listStationsHoymiles(context);
          for (const s of result.stations) {
            allStations.push({ ...s, connectionId: conn.id, connectionName: conn.name });
          }
          perProfile.push({ connectionId: conn.id, connectionName: conn.name, stationCount: result.stations.length, error: null });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          perProfile.push({ connectionId: conn.id, connectionName: conn.name, stationCount: 0, error: msg });
        }
      }
      // Deduplicate stations by stationId (keep first occurrence)
      const seen = new Set<string>();
      const deduped = allStations.filter((s) => { if (seen.has(s.stationId)) return false; seen.add(s.stationId); return true; });
      return { stations: deduped, perProfile, totalProfiles: metadata.connections.length };
    }),
    getProductionSnapshot: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getHoymilesContext(ctx.user.id); return getStationProductionSnapshotHoymiles(context, input.stationId.trim(), input.anchorDate); }),
    getProductionSnapshotAllProfiles: protectedProcedure.input(z.object({ stationId: z.string().min(1), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(ctx.user.id, HOYMILES_PROVIDER);
      const metadata = parseHoymilesMetadata(integration?.metadata);
      if (metadata.connections.length === 0) throw new Error("No Hoymiles profiles saved.");
      for (const conn of metadata.connections) {
        try {
          const context = { username: conn.username, password: conn.password, baseUrl: conn.baseUrl ?? metadata.baseUrl };
          const result = await getStationProductionSnapshotHoymiles(context, input.stationId.trim(), input.anchorDate);
          if (result.found) {
            return { ...result, matchedConnectionId: conn.id, matchedConnectionName: conn.name, checkedConnections: metadata.connections.length };
          }
        } catch {
          // Try next profile
        }
      }
      return { stationId: input.stationId, name: null, status: "Not Found" as const, found: false, lifetimeKwh: null, monthlyProductionKwh: null, last12MonthsProductionKwh: null, dailyProductionKwh: null, anchorDate: input.anchorDate ?? new Date().toISOString().slice(0, 10), error: `Station not found in any of ${metadata.connections.length} profiles`, matchedConnectionId: null, matchedConnectionName: null, checkedConnections: metadata.connections.length };
    }),
  }),

  // =========================================================================
  // Solar-Log (local device)
  // =========================================================================
  solarLog: router({
    ...createSolarConnectionRouter({
      providerKey: SOLAR_LOG_PROVIDER,
      displayName: "Solar-Log",
      credentialSchema: z.object({ baseUrl: z.string().min(1), password: z.string().optional(), connectionName: z.string().optional() }),
      parseMetadata: (raw) => ({ ...parseSolarLogMetadata(raw), baseUrl: null }),
      serializeMetadata: (connections, activeId, _baseUrl) => serializeSolarLogMetadata(connections, activeId),
      buildNewConnection: (input, existing, connId, nowIso) => ({
        id: connId,
        name: toNonEmptyString(input.connectionName as string) ?? `Solar-Log ${existing.connections.length + 1}`,
        baseUrl: (input.baseUrl as string).trim(),
        password: toNonEmptyString(input.password as string) ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
      }),
      getAccessToken: (c) => c.baseUrl,
      mapConnectionStatus: (c, isActive) => ({
        id: c.id,
        name: c.name,
        baseUrl: c.baseUrl,
        hasPassword: !!c.password,
        updatedAt: c.updatedAt,
        isActive,
      }),
    }),
    listDevices: protectedProcedure.query(async ({ ctx }) => { const context = await getSolarLogContext(ctx.user.id); return listDevicesSolarLog(context); }),
    getProductionSnapshot: protectedProcedure.input(z.object({ deviceId: z.string().optional(), anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })).mutation(async ({ ctx, input }) => { const context = await getSolarLogContext(ctx.user.id); return getDeviceProductionSnapshot(context, input.deviceId ?? "solar-log-1", input.anchorDate); }),
  }),
});

export type AppRouter = typeof appRouter;
