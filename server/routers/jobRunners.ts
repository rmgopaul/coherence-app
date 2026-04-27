import { protectedProcedure, router } from "../_core/trpc";
import { z } from "zod";
import { nanoid } from "nanoid";
import { callLlmForAddressCleaning, sanitizeMailingFields, toNonEmptyString } from "../services/core/addressCleaning";
import {
  bulkInsertContractScanJobCsgIds,
  createContractScanJob,
  deleteContractScanJobData,
  deleteIntegration,
  getAllContractScanResultsForJob,
  getCompletedCsgIdsForJob,
  getContractScanJob,
  getIntegrationByProvider,
  getLatestContractScanJob,
  getLatestScanResultsByCsgIds,
  insertContractScanResult,
  listContractScanJobs,
  listContractScanResults,
  updateContractScanJob,
  updateContractScanResultOverrides,
  upsertIntegration,
} from "../db";
// Task 5.7 PR-A (2026-04-26): contract-scan tables are now scope-keyed.
// Until Task 5.7 PR-B moves these procedures onto the standalone Solar
// REC router (where `ctx.scopeId` is part of the context), the procs
// resolve scope inline via the canonical helper. Single-tenant prod
// returns `scope-user-${ownerUserId}` so this matches what
// `getLatestContractScanJob` etc. now filter on.
import { resolveSolarRecScopeId } from "../_core/solarRecAuth";
import {
  CSG_PORTAL_PROVIDER,
  parseCsgPortalMetadata,
  serializeCsgPortalMetadata,
  abpSettlementJobs,
  abpSettlementActiveScanRunners,
  pruneAbpSettlementJobs,
  saveAbpSettlementScanJobSnapshot,
  loadAbpSettlementScanJobSnapshot,
  runAbpSettlementContractScanJob,
  saveAbpSettlementRun,
  getAbpSettlementRun,
  getAbpSettlementRunsIndex,
  parseJsonMetadata,
  resolveOpenAIModel,
} from "./helpers";
import type {
  AbpSettlementContractScanJob,
} from "./helpers";
import {
  CsgPortalClient,
  testCsgPortalCredentials,
} from "../services/integrations/csgPortal";
import {
  runContractScanJob,
  isContractScanRunnerActive,
} from "../services/core/contractScanJobRunner";
import { extractContractDataFromPdfBuffer } from "../services/core/contractScannerServer";
import { cleanAddressBatch } from "../services/core/addressCleaner";
import { verifyAddressBatch } from "../services/integrations/uspsAddressValidation";


// ---------------------------------------------------------------------------
// DIN scrape router — inverter/meter photo → DIN extraction
// ---------------------------------------------------------------------------

import {
  createDinScrapeJob,
  getDinScrapeJob,
  listDinScrapeJobs,
  updateDinScrapeJob,
  bulkInsertDinScrapeJobCsgIds,
  listDinScrapeResults,
  listDinScrapeDinsForJob,
  getAllDinScrapeDinsForJob,
  getCompletedCsgIdsForDinJob,
  deleteDinScrapeJobData,
  getDinScrapeDebugSnapshot,
} from "../db";
import {
  runDinScrapeJob,
  isDinScrapeRunnerActive,
  DIN_SCRAPE_RUNNER_VERSION,
} from "../services/core/dinScrapeJobRunner";

export const dinScrapeRouter = router({
  startJob: protectedProcedure
    .input(
      z.object({
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(10000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const integration = await getIntegrationByProvider(
        ctx.user.id,
        CSG_PORTAL_PROVIDER
      );
      const metadata = parseCsgPortalMetadata(integration?.metadata);
      if (!metadata.email || !toNonEmptyString(integration?.accessToken)) {
        throw new Error(
          "Missing CSG portal credentials. Save portal email/password first."
        );
      }

      const uniqueIds = Array.from(
        new Set(input.csgIds.map((v) => v.trim()).filter(Boolean))
      );
      if (uniqueIds.length === 0) {
        throw new Error("At least one CSG ID is required.");
      }

      const scopeId = await resolveSolarRecScopeId();
      const jobId = await createDinScrapeJob({
        userId: ctx.user.id,
        scopeId,
        totalSites: uniqueIds.length,
      });
      await bulkInsertDinScrapeJobCsgIds(jobId, uniqueIds);

      void runDinScrapeJob(jobId);

      return { jobId, status: "queued" as const, total: uniqueIds.length };
    }),

  stopJob: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      if (
        job.status !== "running" &&
        job.status !== "queued" &&
        job.status !== "stopping"
      ) {
        throw new Error(`Cannot stop job with status "${job.status}".`);
      }
      // If no runner is actually alive on this process, don't bother
      // with the "stopping" dance — nobody's polling to flip it to
      // "stopped". Skip straight to terminal. Covers two cases:
      //   - Stop clicked after a Render redeploy killed the worker.
      //   - Stop clicked on a stale job stuck in "stopping" from a
      //     prior session.
      if (!isDinScrapeRunnerActive(job.id)) {
        await updateDinScrapeJob(job.id, {
          status: "stopped",
          stoppedAt: new Date(),
          currentCsgId: null,
        });
        return { success: true, forced: true };
      }
      await updateDinScrapeJob(job.id, { status: "stopping" });
      return { success: true, forced: false };
    }),

  resumeJob: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      if (job.status !== "stopped" && job.status !== "failed") {
        throw new Error(`Cannot resume job with status "${job.status}".`);
      }
      const completedIds = await getCompletedCsgIdsForDinJob(job.id);
      const pendingCount = job.totalSites - completedIds.size;
      await updateDinScrapeJob(job.id, {
        status: "queued",
        error: null,
        currentCsgId: null,
      });
      void runDinScrapeJob(job.id);
      return { success: true, pendingCount };
    }),

  deleteJob: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      if (job.status === "running" || job.status === "queued") {
        throw new Error("Stop the job before deleting.");
      }
      await deleteDinScrapeJobData(job.id);
      return { success: true };
    }),

  getJobStatus: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      // Auto-resume if the runner died (process restart, etc.).
      // Also covers "stopping" — when the runner is dead and status
      // is "stopping", runDinScrapeJob will see that and flip to
      // "stopped" (see dinScrapeJobRunner.ts). Without including
      // "stopping" here, a stop-in-flight across a deploy just sits
      // forever because getJobStatus never wakes the runner.
      if (
        (job.status === "queued" ||
          job.status === "running" ||
          job.status === "stopping") &&
        !isDinScrapeRunnerActive(job.id)
      ) {
        void runDinScrapeJob(job.id);
      }
      const processed = job.successCount + job.failureCount;
      const percent =
        job.totalSites > 0
          ? Math.min(100, Math.round((processed / job.totalSites) * 100))
          : 0;
      return {
        ...job,
        processed,
        remaining: Math.max(0, job.totalSites - processed),
        percent,
        _runnerVersion: DIN_SCRAPE_RUNNER_VERSION,
      };
    }),

  listJobs: protectedProcedure
    .input(
      z.object({ limit: z.number().int().min(1).max(50).optional() }).optional()
    )
    .query(async ({ input }) => {
      const scopeId = await resolveSolarRecScopeId();
      return listDinScrapeJobs(scopeId, input?.limit ?? 20);
    }),

  getResults: protectedProcedure
    .input(
      z.object({
        jobId: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      return listDinScrapeResults(job.id, {
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
      });
    }),

  getDins: protectedProcedure
    .input(
      z.object({
        jobId: z.string().min(1),
        limit: z.number().int().min(1).max(2000).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      return listDinScrapeDinsForJob(job.id, {
        limit: input.limit ?? 500,
        offset: input.offset ?? 0,
      });
    }),

  debugRaw: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      const snapshot = await getDinScrapeDebugSnapshot(job.id);
      return {
        _runnerVersion: DIN_SCRAPE_RUNNER_VERSION,
        ...snapshot,
      };
    }),

  exportDinsCsv: protectedProcedure
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.userId !== ctx.user.id) {
        throw new Error("DIN scrape job not found.");
      }
      const rows = await getAllDinScrapeDinsForJob(job.id);
      const headers = [
        "csgId",
        "dinValue",
        "sourceType",
        "extractedBy",
        "sourceFileName",
        "sourceUrl",
        "foundAt",
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
});
