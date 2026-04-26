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

export const csgPortalRouter = router({
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
});

export const abpSettlementRouter = router({
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
});

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

      const jobId = await createDinScrapeJob({
        userId: ctx.user.id,
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
    .query(async ({ ctx, input }) => {
      return listDinScrapeJobs(ctx.user.id, input?.limit ?? 20);
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
