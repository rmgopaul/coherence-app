/**
 * Task 5.9 PR-A (2026-04-27) — standalone Solar REC sub-router for
 * the ABP Invoice Settlement page. Migrated out of `abpSettlementRouter`
 * in `server/routers/jobRunners.ts`.
 *
 * Module key: `abp-invoice-settlement`. Reads use `read`, mutations
 * (cleanMailingData, verifyAddresses, saveRun, startContractScanJob)
 * use `edit`.
 *
 * Storage layer note: `saveAbpSettlementRun` / `getAbpSettlementRun`
 * / `getAbpSettlementRunsIndex` still take `userId`. To preserve
 * team-wide visibility post-migration (architectural-split rule:
 * "Data visibility is team-wide within a scope"), every proc that
 * needs the storage layer resolves the canonical owner via
 * `resolveSolarRecOwnerUserId()` and passes that — single-tenant
 * prod is functionally identical, multi-tenant future will switch
 * the storage helpers to scope-keyed paths in a follow-up.
 *
 * Cross-scope safety on `getJobStatus`: ownership check switched
 * from `job.userId !== ctx.user.id` to `job.userId !== ownerUserId`
 * (single-tenant resolves to the same value; multi-tenant prevents
 * cross-team job leakage).
 *
 * Task 2.3 (cross-month contamination override fix) deferred to a
 * follow-up — keeping this PR scoped to the migration mechanics.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { nanoid } from "nanoid";
import { t, requirePermission } from "./solarRecBase";

export const solarRecAbpSettlementRouter = t.router({
  startContractScanJob: requirePermission("abp-invoice-settlement", "edit")
    .input(
      z.object({
        csgIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
        email: z.string().email().optional(),
        password: z.string().min(1).optional(),
        baseUrl: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { getIntegrationByProvider } = await import("../db");
      const { CSG_PORTAL_PROVIDER } = await import(
        "../routers/helpers/constants"
      );
      const { parseCsgPortalMetadata } = await import(
        "../routers/helpers/providerMetadata"
      );
      const { toNonEmptyString } = await import(
        "../services/core/addressCleaning"
      );
      const {
        abpSettlementJobs,
        pruneAbpSettlementJobs,
        saveAbpSettlementScanJobSnapshot,
        runAbpSettlementContractScanJob,
      } = await import("../routers/helpers");
      const { resolveSolarRecOwnerUserId } = await import("./solarRecAuth");

      const existing = await getIntegrationByProvider(
        ctx.userId,
        CSG_PORTAL_PROVIDER
      );
      const existingMetadata = parseCsgPortalMetadata(existing?.metadata);
      const resolvedEmail =
        toNonEmptyString(input.email)?.toLowerCase() ?? existingMetadata.email;
      const resolvedPassword =
        toNonEmptyString(input.password) ??
        toNonEmptyString(existing?.accessToken);
      const resolvedBaseUrl =
        toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl;
      if (!resolvedEmail || !resolvedPassword) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "Missing CSG portal credentials. Save portal email/password first.",
        });
      }

      const uniqueIds = Array.from(
        new Set(input.csgIds.map((value) => value.trim()).filter(Boolean))
      );
      if (uniqueIds.length === 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "At least one CSG ID is required.",
        });
      }

      // Anchor jobs to the scope owner so all team members see the
      // same in-memory state + on-disk snapshot.
      const ownerUserId = await resolveSolarRecOwnerUserId();

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      pruneAbpSettlementJobs(nowMs);

      const jobId = nanoid();
      const job = {
        id: jobId,
        userId: ownerUserId,
        scanConfig: {
          csgIds: uniqueIds,
          portalEmail: resolvedEmail,
          portalBaseUrl: resolvedBaseUrl ?? null,
        },
        createdAt: nowIso,
        updatedAt: nowIso,
        startedAt: null,
        finishedAt: null,
        status: "queued" as const,
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
        console.warn(
          "[contractScan] Snapshot write failed:",
          error instanceof Error ? error.message : error
        );
      }
      void runAbpSettlementContractScanJob(jobId);

      return {
        jobId,
        status: "queued" as const,
        total: uniqueIds.length,
      };
    }),

  getJobStatus: requirePermission("abp-invoice-settlement", "read")
    .input(z.object({ jobId: z.string().min(1) }))
    .query(async ({ input }) => {
      const {
        abpSettlementJobs,
        abpSettlementActiveScanRunners,
        pruneAbpSettlementJobs,
        loadAbpSettlementScanJobSnapshot,
        runAbpSettlementContractScanJob,
      } = await import("../routers/helpers");
      const { resolveSolarRecOwnerUserId } = await import("./solarRecAuth");

      pruneAbpSettlementJobs(Date.now());
      const normalizedJobId = input.jobId.trim();
      const ownerUserId = await resolveSolarRecOwnerUserId();
      let job = abpSettlementJobs.get(normalizedJobId);
      if (!job) {
        const restored = await loadAbpSettlementScanJobSnapshot(
          ownerUserId,
          normalizedJobId
        );
        if (restored) {
          abpSettlementJobs.set(normalizedJobId, restored);
          job = restored;
        }
      }
      if (!job || job.userId !== ownerUserId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "ABP settlement contract scan job not found.",
        });
      }

      if (
        (job.status === "queued" || job.status === "running") &&
        !abpSettlementActiveScanRunners.has(job.id)
      ) {
        void runAbpSettlementContractScanJob(job.id);
      }

      return job;
    }),

  cleanMailingData: requirePermission("abp-invoice-settlement", "edit")
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
      const { getIntegrationByProvider } = await import("../db");
      const {
        callLlmForAddressCleaning,
        sanitizeMailingFields,
        toNonEmptyString,
      } = await import("../services/core/addressCleaning");
      const { cleanAddressBatch } = await import(
        "../services/core/addressCleaner"
      );
      const { parseJsonMetadata, resolveOpenAIModel } = await import(
        "../routers/helpers"
      );

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

      const { cleaned: deterministicResults, ambiguousRows } =
        cleanAddressBatch(sourceRows);
      const resultByKey = new Map(
        deterministicResults.map((r) => [r.key, r])
      );

      // ── 2. LLM pass on deterministic results ─────────────────
      // anthropic / openai integrations are still per-user (Rhett's
      // tokens). Use ctx.userId here — this also matches the
      // pre-migration behavior; multi-user team members would each
      // need their own AI integration to use this feature, same as
      // every other AI-touching proc.
      const anthropicIntegration = await getIntegrationByProvider(
        ctx.userId,
        "anthropic"
      );
      const openaiIntegration = await getIntegrationByProvider(
        ctx.userId,
        "openai"
      );

      const llmProvider = anthropicIntegration?.accessToken
        ? "anthropic"
        : openaiIntegration?.accessToken
          ? "openai"
          : null;
      const llmApiKey =
        llmProvider === "anthropic"
          ? anthropicIntegration!.accessToken!
          : llmProvider === "openai"
            ? openaiIntegration!.accessToken!
            : null;

      if (llmProvider && llmApiKey) {
        try {
          const llmCleaned = await callLlmForAddressCleaning(
            llmProvider,
            llmApiKey,
            llmProvider === "anthropic"
              ? ((parseJsonMetadata(anthropicIntegration!.metadata)
                  .model as string) || "claude-sonnet-4-20250514")
              : resolveOpenAIModel(openaiIntegration!.metadata),
            deterministicResults
          );

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
          console.error(
            `[AI Cleaning] LLM failed: ${
              llmError instanceof Error ? llmError.message : "Unknown error"
            }. Using deterministic results.`
          );
        }
      } else {
        console.warn(
          `[AI Cleaning] No AI provider connected. ${deterministicResults.length} rows cleaned deterministically only.`
        );
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
        warnings.push(
          `${ambiguousRows.length} record(s) had ambiguous data and were sent to AI for review.`
        );
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

  saveRun: requirePermission("abp-invoice-settlement", "edit")
    .input(
      z.object({
        runId: z.string().min(1).max(128).optional(),
        monthKey: z.string().regex(/^\d{4}-\d{2}$/),
        label: z.string().max(200).optional(),
        payload: z.string().min(1),
        rowCount: z.number().int().min(0).max(50000).optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { saveAbpSettlementRun, toNonEmptyString } = await import(
        "../routers/helpers"
      );
      const { resolveSolarRecOwnerUserId } = await import("./solarRecAuth");

      // Anchor saved runs to the scope owner so all team members
      // see the same run history. Single-tenant: same as ctx.userId.
      const ownerUserId = await resolveSolarRecOwnerUserId();
      const runId = toNonEmptyString(input.runId) ?? nanoid();
      const saved = await saveAbpSettlementRun({
        userId: ownerUserId,
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
        persistedToDatabase:
          saved.runWrite.persistedToDatabase ||
          saved.indexWrite.persistedToDatabase,
        storageSynced:
          saved.runWrite.storageSynced && saved.indexWrite.storageSynced,
      };
    }),

  getRun: requirePermission("abp-invoice-settlement", "read")
    .input(
      z.object({
        runId: z.string().min(1).max(128),
      })
    )
    .query(async ({ input }) => {
      const { getAbpSettlementRun } = await import("../routers/helpers");
      const { resolveSolarRecOwnerUserId } = await import("./solarRecAuth");
      const ownerUserId = await resolveSolarRecOwnerUserId();
      const run = await getAbpSettlementRun(ownerUserId, input.runId);
      if (!run) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "ABP settlement run not found.",
        });
      }
      return run;
    }),

  listRuns: requirePermission("abp-invoice-settlement", "read")
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(250).optional(),
        })
        .optional()
    )
    .query(async ({ input }) => {
      const { getAbpSettlementRunsIndex } = await import("../routers/helpers");
      const { resolveSolarRecOwnerUserId } = await import("./solarRecAuth");
      const ownerUserId = await resolveSolarRecOwnerUserId();
      const runs = await getAbpSettlementRunsIndex(ownerUserId);
      return runs.slice(0, input?.limit ?? 50);
    }),

  verifyAddresses: requirePermission("abp-invoice-settlement", "edit")
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
    .mutation(async ({ input }) => {
      const { verifyAddressBatch } = await import(
        "../services/integrations/uspsAddressValidation"
      );
      const uspsClientId = process.env.USPS_CLIENT_ID;
      const uspsClientSecret = process.env.USPS_CLIENT_SECRET;

      if (!uspsClientId || !uspsClientSecret) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message:
            "USPS API not configured. Set USPS_CLIENT_ID and USPS_CLIENT_SECRET environment variables (from developers.usps.com).",
        });
      }

      const results = await verifyAddressBatch(
        uspsClientId,
        uspsClientSecret,
        input.addresses
      );

      const confirmed = results.filter((r) => r.verdict === "CONFIRMED").length;
      const unconfirmed = results.filter(
        (r) => r.verdict === "UNCONFIRMED"
      ).length;
      const errors = results.filter((r) => r.verdict === "ERROR").length;

      return {
        results,
        summary: { total: results.length, confirmed, unconfirmed, errors },
      };
    }),
});
