/**
 * Task 5.8 PR-B (2026-04-27) — standalone Solar REC sub-router for
 * the DIN Scrape Manager. Migrated out of `dinScrapeRouter` in
 * `server/routers/jobRunners.ts`, which becomes empty after this PR
 * and is deleted along with its sole import in `server/routers.ts`.
 *
 * Module key: `din-scrape-manager`. Permission classification:
 *   - 6 read: getJobStatus, listJobs, getResults, getDins, debugRaw,
 *     exportDinsCsv
 *   - 3 edit: startJob, stopJob, resumeJob
 *   - 1 admin: deleteJob (destructive — deletes job + all child rows)
 *
 * Cross-scope safety: PR-A (#119) added `scopeId` to all 4
 * `dinScrape*` tables and backfilled. Ownership checks switch from
 * `job.userId !== ctx.user.id` to `job.scopeId !== ctx.scopeId` per
 * the architectural-split rule "data visibility is team-wide within
 * a scope". Single-tenant prod is functionally identical (the scope
 * resolves to `scope-user-${ownerUserId}` and matches the only user);
 * multi-tenant future prevents cross-team job visibility.
 *
 * CSG portal credentials lookup (`startJob`): keeps `ctx.userId`
 * because the `integrations` table is per-user. Single-tenant prod
 * has only Rhett's tokens; multi-user team-shared CSG access is a
 * future migration to `solarRecTeamCredentials`.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t, requirePermission } from "./solarRecBase";

export const solarRecDinScrapeRouter = t.router({
  startJob: requirePermission("din-scrape-manager", "edit")
    .input(
      z.object({
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(10000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        getIntegrationByProvider,
        createDinScrapeJob,
        bulkInsertDinScrapeJobCsgIds,
      } = await import("../db");
      const { CSG_PORTAL_PROVIDER } = await import(
        "../routers/helpers/constants"
      );
      const { parseCsgPortalMetadata } = await import(
        "../routers/helpers/providerMetadata"
      );
      const { toNonEmptyString } = await import(
        "../services/core/addressCleaning"
      );
      const { runDinScrapeJob } = await import(
        "../services/core/dinScrapeJobRunner"
      );

      const integration = await getIntegrationByProvider(
        ctx.userId,
        CSG_PORTAL_PROVIDER
      );
      const metadata = parseCsgPortalMetadata(integration?.metadata);
      if (!metadata.email || !toNonEmptyString(integration?.accessToken)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Missing CSG portal credentials. Save portal email/password first.",
        });
      }

      const uniqueIds = Array.from(
        new Set(input.csgIds.map((v) => v.trim()).filter(Boolean))
      );
      if (uniqueIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "At least one CSG ID is required.",
        });
      }

      const jobId = await createDinScrapeJob({
        userId: ctx.userId,
        scopeId: ctx.scopeId,
        totalSites: uniqueIds.length,
      });
      await bulkInsertDinScrapeJobCsgIds(jobId, uniqueIds);

      void runDinScrapeJob(jobId);

      return { jobId, status: "queued" as const, total: uniqueIds.length };
    }),

  stopJob: requirePermission("din-scrape-manager", "edit")
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { getDinScrapeJob, updateDinScrapeJob } = await import("../db");
      const { isDinScrapeRunnerActive } = await import(
        "../services/core/dinScrapeJobRunner"
      );

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
      }
      if (
        job.status !== "running" &&
        job.status !== "queued" &&
        job.status !== "stopping"
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot stop job with status "${job.status}".`,
        });
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

  resumeJob: requirePermission("din-scrape-manager", "edit")
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const {
        getDinScrapeJob,
        updateDinScrapeJob,
        getCompletedCsgIdsForDinJob,
      } = await import("../db");
      const { runDinScrapeJob } = await import(
        "../services/core/dinScrapeJobRunner"
      );

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
      }
      if (job.status !== "stopped" && job.status !== "failed") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot resume job with status "${job.status}".`,
        });
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

  deleteJob: requirePermission("din-scrape-manager", "admin")
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { getDinScrapeJob, deleteDinScrapeJobData } = await import(
        "../db"
      );

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
      }
      if (job.status === "running" || job.status === "queued") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stop the job before deleting.",
        });
      }
      await deleteDinScrapeJobData(job.id);
      return { success: true };
    }),

  getJobStatus: requirePermission("din-scrape-manager", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { getDinScrapeJob } = await import("../db");
      const { isDinScrapeRunnerActive, runDinScrapeJob, DIN_SCRAPE_RUNNER_VERSION } =
        await import("../services/core/dinScrapeJobRunner");

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
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

  listJobs: requirePermission("din-scrape-manager", "read")
    .input(
      z.object({ limit: z.number().int().min(1).max(50).optional() }).optional()
    )
    .query(async ({ ctx, input }) => {
      const { listDinScrapeJobs } = await import("../db");
      return listDinScrapeJobs(ctx.scopeId, input?.limit ?? 20);
    }),

  getResults: requirePermission("din-scrape-manager", "read")
    .input(
      z.object({
        jobId: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getDinScrapeJob, listDinScrapeResults } = await import("../db");

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
      }
      return listDinScrapeResults(job.id, {
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
      });
    }),

  getDins: requirePermission("din-scrape-manager", "read")
    .input(
      z.object({
        jobId: z.string().min(1),
        limit: z.number().int().min(1).max(2000).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getDinScrapeJob, listDinScrapeDinsForJob } = await import(
        "../db"
      );

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
      }
      return listDinScrapeDinsForJob(job.id, {
        limit: input.limit ?? 500,
        offset: input.offset ?? 0,
      });
    }),

  debugRaw: requirePermission("din-scrape-manager", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { getDinScrapeJob, getDinScrapeDebugSnapshot } = await import(
        "../db"
      );
      const { DIN_SCRAPE_RUNNER_VERSION } = await import(
        "../services/core/dinScrapeJobRunner"
      );

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
      }
      const snapshot = await getDinScrapeDebugSnapshot(job.id);
      return {
        _runnerVersion: DIN_SCRAPE_RUNNER_VERSION,
        ...snapshot,
      };
    }),

  exportDinsCsv: requirePermission("din-scrape-manager", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { getDinScrapeJob, getAllDinScrapeDinsForJob } = await import(
        "../db"
      );

      const job = await getDinScrapeJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "DIN scrape job not found.",
        });
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
