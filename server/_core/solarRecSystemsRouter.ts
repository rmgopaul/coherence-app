/**
 * Task 9.1 (2026-04-28) — Solar REC `systems.*` standalone sub-router.
 *
 * First Phase 9 (Portfolio Workbench) primitive: take a canonical
 * CSG ID and return the joined registry record (Solar Applications
 * + ABP CSG-System Mapping + Contracted Date). Built on the new
 * `getSystemByCsgId` db helper.
 *
 * Module gate: `portfolio-workbench` (read for the lookup, future
 * Tasks 9.2–9.5 will add edit-level procs for worksets and the
 * detail page composer).
 *
 * Versioning: `_runnerVersion: "solar-rec-systems@1"`. Bump when
 * the response shape changes — every Phase 9 client surface that
 * depends on this proc reads the version on every render so a deploy
 * mismatch is observable.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { t, requirePermission } from "./solarRecBase";

export const SOLAR_REC_SYSTEMS_ROUTER_VERSION = "solar-rec-systems@1";

export const solarRecSystemsRouter = t.router({
  /**
   * Look up one system by canonical CSG ID. Returns `null` when no
   * Solar Applications row matches (with or without the legacy
   * applicationId fallback). Phase 9 callers render a clear
   * "system not yet imported" state in that case.
   */
  getByCsgId: requirePermission("portfolio-workbench", "read")
    .input(
      z.object({
        csgId: z
          .string()
          .trim()
          .min(1, "csgId is required")
          .max(64, "csgId too long"),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getSystemByCsgId } = await import("../db");
      const system = await getSystemByCsgId(ctx.scopeId, input.csgId);
      return {
        _runnerVersion: SOLAR_REC_SYSTEMS_ROUTER_VERSION,
        system,
      };
    }),

  /**
   * Batch variant — for the future workset detail panes that load
   * 10–500 systems at once. Bounds at 500 so we don't accidentally
   * fan out to a five-figure CSG list. Same join chain as the
   * single-csgId path; runs the lookups serially to keep DB load
   * predictable.
   *
   * Returned as a parallel array so callers can zip it with their
   * input list. Missing systems surface as `null` slots — distinct
   * from "system row found but field is null" so Phase 9 detail
   * panels can render an "unknown CSG ID" badge.
   */
  /**
   * Task 9.4 detail composer. Joins the registry record (Task 9.1)
   * with the latest contract scan, DIN scrape, and Schedule B
   * import data for one CSG ID. The four sections render
   * independently — any of them can be `null` and the page renders
   * a clear missing-data state.
   *
   * Cross-section reads run in parallel; total round-trip is
   * dominated by the slowest of the three (contract / DIN /
   * Schedule B). Targets the ≤1s page-load DoD from Task 9.4.
   */
  getDetailByCsgId: requirePermission("portfolio-workbench", "read")
    .input(
      z.object({
        csgId: z
          .string()
          .trim()
          .min(1, "csgId is required")
          .max(64, "csgId too long"),
      })
    )
    .query(async ({ ctx, input }) => {
      const {
        getSystemByCsgId,
        getLatestScanResultsByCsgIds,
        getLatestDinScrapeForCsgId,
        getLatestScheduleBResultForSystem,
        getLatestMeterReadsForCsgId,
        getInvoiceStatusForCsgId,
        getOwnershipForCsgId,
        getMonitoringHistoryForCsgId,
      } = await import("../db");

      // Pull the registry first — its fields drive several
      // downstream join keys (trackingSystemRefId for Schedule B +
      // meter reads + ownership, systemId for Schedule B,
      // applicationId for ICC report). We then fan out the
      // remaining reads in parallel.
      const registry = await getSystemByCsgId(ctx.scopeId, input.csgId);

      const [
        contractScans,
        dinScrape,
        scheduleBResult,
        meterReads,
        invoiceStatus,
        ownership,
        monitoringHistory,
      ] = await Promise.all([
        getLatestScanResultsByCsgIds(ctx.scopeId, [input.csgId]),
        getLatestDinScrapeForCsgId(ctx.scopeId, input.csgId),
        getLatestScheduleBResultForSystem(ctx.scopeId, {
          csgId: input.csgId,
          systemId: registry?.systemId ?? null,
          trackingSystemRefId: registry?.trackingSystemRefId ?? null,
        }),
        // Task 9.5 PR-1 (2026-04-28): meter-read history.
        getLatestMeterReadsForCsgId(ctx.scopeId, input.csgId, {
          preResolvedRegistry: registry,
          limit: 30,
        }),
        // Task 9.5 PR-2 (2026-04-28): invoice status (utility
        // invoices + ICC contract value).
        getInvoiceStatusForCsgId(ctx.scopeId, input.csgId, {
          preResolvedRegistry: registry,
          limit: 12,
        }),
        // Task 9.5 PR-5 (2026-04-28): transfer history + ownership
        // rollup. Joins srDsTransferHistory by GATS Unit ID; falls
        // through to empty when the registry has no trackingId.
        getOwnershipForCsgId(ctx.scopeId, input.csgId, {
          preResolvedRegistry: registry,
          limit: 30,
        }),
        // Task 9.5 PR-6 (2026-04-28): monitoring history. 7d/30d
        // rollups + recent-runs table from `monitoringApiRuns`,
        // joined to the system via the same vendor-resolution chain
        // that meter-reads uses (`srDsGenerationEntry` →
        // `onlineMonitoring` + `onlineMonitoringSystemId`).
        getMonitoringHistoryForCsgId(ctx.scopeId, input.csgId, {
          preResolvedRegistry: registry,
        }),
      ]);

      const contractScan = contractScans[0] ?? null;

      return {
        _runnerVersion: SOLAR_REC_SYSTEMS_ROUTER_VERSION,
        csgId: input.csgId,
        registry,
        contractScan,
        dinScrape,
        scheduleBResult,
        meterReads,
        invoiceStatus,
        ownership,
        monitoringHistory,
      };
    }),

  getManyByCsgId: requirePermission("portfolio-workbench", "read")
    .input(
      z.object({
        csgIds: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(64)
          )
          .min(1)
          .max(500),
      })
    )
    .query(async ({ ctx, input }) => {
      const { getSystemByCsgId } = await import("../db");
      // Dedupe input so a list with repeats doesn't pay the lookup
      // cost twice. Map back to the input order at the end so the
      // response array aligns 1:1.
      const unique = Array.from(new Set(input.csgIds));
      if (unique.length > 500) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Too many unique CSG IDs (max 500)",
        });
      }
      const lookupResults = new Map<
        string,
        Awaited<ReturnType<typeof getSystemByCsgId>>
      >();
      for (const id of unique) {
        const record = await getSystemByCsgId(ctx.scopeId, id);
        lookupResults.set(id, record);
      }
      const systems = input.csgIds.map((id) => lookupResults.get(id) ?? null);
      return {
        _runnerVersion: SOLAR_REC_SYSTEMS_ROUTER_VERSION,
        systems,
      };
    }),
});

export type SolarRecSystemsRouter = typeof solarRecSystemsRouter;
