/**
 * Task 5.7 PR-B (2026-04-26) — standalone Solar REC sub-router for
 * the DB-backed contract scan flow (the "Contract Scrape Manager"
 * page). Migrated out of the main `abpSettlementRouter` in
 * `server/routers/jobRunners.ts`, which historically housed both
 * Contract Scrape and ABP Invoice Settlement procedures (Task 5.9
 * will migrate the remainder).
 *
 * Module key: `contract-scrape-manager`. Reads use `read`,
 * mutations use `edit`, destructive ops (`deleteDbContractScanJob`)
 * use `admin`.
 *
 * Cross-scope safety: every fetch-by-jobId now checks
 * `job.scopeId !== ctx.scopeId` and 404s if mismatched. Pre-PR-B the
 * check was `job.userId !== ctx.user.id` (per-user ownership). The
 * shift to per-scope matches the architectural-split rule "data
 * visibility is team-wide within a scope" — any team member with the
 * `contract-scrape-manager` permission can manage any job in their
 * scope.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { t, requirePermission } from "./solarRecBase";

export const solarRecContractScanRouter = t.router({
  startDbContractScanJob: requirePermission("contract-scrape-manager", "edit")
    .input(
      z.object({
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(30000),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const {
        getIntegrationByProvider,
        createContractScanJob,
        bulkInsertContractScanJobCsgIds,
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
      const { runContractScanJob } = await import(
        "../services/core/contractScanJobRunner"
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

      const jobId = await createContractScanJob({
        userId: ctx.userId,
        scopeId: ctx.scopeId,
        totalContracts: uniqueIds.length,
      });

      await bulkInsertContractScanJobCsgIds(jobId, uniqueIds);

      void runContractScanJob(jobId);

      return { jobId, status: "queued" as const, total: uniqueIds.length };
    }),

  stopDbContractScanJob: requirePermission("contract-scrape-manager", "edit")
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { getContractScanJob, updateContractScanJob } = await import(
        "../db"
      );
      const job = await getContractScanJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contract scan job not found.",
        });
      }
      if (job.status !== "running" && job.status !== "queued") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot stop job with status "${job.status}".`,
        });
      }
      await updateContractScanJob(job.id, { status: "stopping" });
      return { success: true };
    }),

  deleteDbContractScanJob: requirePermission("contract-scrape-manager", "admin")
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const { getContractScanJob, deleteContractScanJobData } = await import(
        "../db"
      );
      const job = await getContractScanJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contract scan job not found.",
        });
      }
      if (job.status === "running" || job.status === "queued") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Stop the job before deleting.",
        });
      }
      await deleteContractScanJobData(job.id);
      return { success: true };
    }),

  resumeDbContractScanJob: requirePermission("contract-scrape-manager", "edit")
    .input(z.object({ jobId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const {
        getContractScanJob,
        updateContractScanJob,
        getCompletedCsgIdsForJob,
      } = await import("../db");
      const { runContractScanJob } = await import(
        "../services/core/contractScanJobRunner"
      );
      const job = await getContractScanJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contract scan job not found.",
        });
      }
      if (job.status !== "stopped" && job.status !== "failed") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Cannot resume job with status "${job.status}".`,
        });
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

  getDbJobStatus: requirePermission("contract-scrape-manager", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { getContractScanJob } = await import("../db");
      const { isContractScanRunnerActive, runContractScanJob } = await import(
        "../services/core/contractScanJobRunner"
      );
      const job = await getContractScanJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contract scan job not found.",
        });
      }

      // Auto-resume if runner died (unchanged from main-router copy).
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

  listDbContractScanJobs: requirePermission("contract-scrape-manager", "read")
    .input(
      z
        .object({ limit: z.number().int().min(1).max(50).optional() })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { listContractScanJobs } = await import("../db");
      return listContractScanJobs(ctx.scopeId, input?.limit ?? 20);
    }),

  getDbContractScanResults: requirePermission("contract-scrape-manager", "read")
    .input(
      z.object({
        jobId: z.string().min(1),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getContractScanJob, listContractScanResults } = await import(
        "../db"
      );
      const job = await getContractScanJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contract scan job not found.",
        });
      }
      return listContractScanResults(job.id, {
        limit: input.limit ?? 100,
        offset: input.offset ?? 0,
      });
    }),

  exportDbContractScanResultsCsv: requirePermission(
    "contract-scrape-manager",
    "read"
  )
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const { getContractScanJob, getAllContractScanResultsForJob } =
        await import("../db");
      const job = await getContractScanJob(input.jobId.trim());
      if (!job || job.scopeId !== ctx.scopeId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Contract scan job not found.",
        });
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

  getContractScanResultsByCsgIds: requirePermission(
    "contract-scrape-manager",
    "read"
  )
    .input(
      z.object({
        // 2026-04-11: bumped from max(5000) to max(50000). Users
        // with large ABP portfolios can have 28k+ CSG IDs in the
        // abpCsgSystemMapping dataset; the old 5000 cap caused a
        // Zod validation error on the Financials debug panel. The
        // underlying DB helper batches the IN clause at 500 per
        // query so the server handles the volume fine.
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(50000),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getLatestScanResultsByCsgIds } = await import("../db");
      return getLatestScanResultsByCsgIds(ctx.scopeId, input.csgIds);
    }),

  updateContractOverride: requirePermission("contract-scrape-manager", "edit")
    .input(
      z.object({
        csgId: z.string().min(1).max(64),
        vendorFeePercent: z.number().min(0).max(100).nullable().optional(),
        additionalCollateralPercent: z
          .number()
          .min(0)
          .max(100)
          .nullable()
          .optional(),
        notes: z.string().max(512).nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { updateContractScanResultOverrides } = await import("../db");
      const { bumpScopeContractScanOverrideVersion } = await import(
        "../db/solarRecDatasets"
      );
      const result = await updateContractScanResultOverrides(
        ctx.scopeId,
        input.csgId,
        {
          vendorFeePercent: input.vendorFeePercent ?? null,
          additionalCollateralPercent: input.additionalCollateralPercent ?? null,
          notes: input.notes ?? null,
        }
      );
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No contract scan result found for CSG ID ${input.csgId}`,
        });
      }
      // PR #338 follow-up item 1 (2026-05-04). Bump the scope's
      // override-version row so the canonical financials hash
      // (`computeFinancialsHash`) advances. Without this, slim KPI
      // side-cache reads would keep returning pre-edit totals on the
      // next Overview mount until something else mutates the scope's
      // dataset versions. The bump is fire-and-forget — a failure to
      // record the version doesn't roll back the override (the user
      // already saw the success toast); we log + move on so the
      // override itself stays committed.
      await bumpScopeContractScanOverrideVersion(
        ctx.scopeId,
        result.overriddenAt
      ).catch((error) => {
        console.warn(
          `[solarRecContractScanRouter.updateContractOverride] override-version bump failed for scope=${ctx.scopeId}:`,
          error instanceof Error ? error.message : error
        );
      });
      return result;
    }),

  rescanSingleContract: requirePermission("contract-scrape-manager", "edit")
    .input(z.object({ csgId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const {
        getIntegrationByProvider,
        getLatestContractScanJob,
        insertContractScanResult,
      } = await import("../db");
      const { CsgPortalClient } = await import(
        "../services/integrations/csgPortal"
      );
      const { extractContractDataFromPdfBuffer } = await import(
        "../services/core/contractScannerServer"
      );

      // 1. Validate CSG portal credentials (resolved against the calling user;
      //    matches main-router behavior pre-PR-B).
      const integration = await getIntegrationByProvider(
        ctx.userId,
        "csg-portal"
      );
      const metadata = integration?.metadata
        ? (() => {
            try {
              return JSON.parse(integration.metadata!) as Record<
                string,
                unknown
              >;
            } catch {
              return {};
            }
          })()
        : {};
      const email =
        typeof metadata.email === "string" && metadata.email
          ? metadata.email
          : null;
      const password = integration?.accessToken || null;
      if (!email || !password) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "CSG portal credentials not configured. Go to Settings to add your portal email and password.",
        });
      }

      // 2. Fetch and parse the contract PDF
      const baseUrl =
        typeof metadata.baseUrl === "string" && metadata.baseUrl
          ? metadata.baseUrl
          : undefined;
      const client = new CsgPortalClient({ email, password, baseUrl });
      await client.login();
      const fetchResult = await client.fetchRecContractPdf(input.csgId);

      if (fetchResult.error || !fetchResult.pdfData) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message:
            fetchResult.error || "No PDF data returned from portal.",
        });
      }

      const extraction = await extractContractDataFromPdfBuffer(
        fetchResult.pdfData,
        fetchResult.pdfFileName || `contract-${input.csgId}.pdf`
      );

      // 3. Get a job ID to associate the result with — uses scope, not
      //    user, since the latest-job-per-scope is the right answer
      //    after Task 5.7 PR-A.
      const latestJob = await getLatestContractScanJob(ctx.scopeId);
      if (!latestJob) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "No contract scan job exists. Run a contract scan first, then re-scan individual systems.",
        });
      }

      // 4. Insert/update the result (unique on jobId+csgId, clears overrides)
      await insertContractScanResult({
        id: nanoid(),
        jobId: latestJob.id,
        scopeId: latestJob.scopeId,
        csgId: input.csgId,
        systemName: extraction.systemName ?? null,
        vendorFeePercent: extraction.vendorFeePercent ?? null,
        additionalCollateralPercent:
          extraction.additionalCollateralPercent ?? null,
        ccAuthorizationCompleted: extraction.ccAuthorizationCompleted ?? null,
        additionalFivePercentSelected:
          extraction.additionalFivePercentSelected ?? null,
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

      // PR #338 follow-up item 1 (2026-05-04). A successful single-
      // row rescan changed the latest scan-result row for this CSG.
      // The heavy financials aggregator's `scanResultsHash` will
      // change next read (its hash is a SHA over scan rows), but
      // the canonical `computeFinancialsHash` for slim invalidation
      // is bound to `latestCompletedJobId` / `latestOverrideAt`. A
      // single-row rescan doesn't bump either by default — bump
      // the override-version timestamp so the slim KPI side cache
      // invalidates too. Using overrideVersion (not jobVersion)
      // because re-using the same `latestJob.id` would be a no-op
      // for `bumpScopeContractScanJobVersion` (the value matches
      // what's already in the version row).
      const { bumpScopeContractScanOverrideVersion } = await import(
        "../db/solarRecDatasets"
      );
      await bumpScopeContractScanOverrideVersion(
        ctx.scopeId,
        new Date()
      ).catch((error) => {
        console.warn(
          `[solarRecContractScanRouter.rescanSingleContract] scan-version bump failed for scope=${ctx.scopeId}:`,
          error instanceof Error ? error.message : error
        );
      });

      return {
        csgId: input.csgId,
        vendorFeePercent: extraction.vendorFeePercent,
        additionalCollateralPercent: extraction.additionalCollateralPercent,
      };
    }),
});
