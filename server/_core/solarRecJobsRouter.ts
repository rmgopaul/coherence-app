/**
 * Task 8.2 (2026-04-27) — Solar REC Jobs index sub-router.
 *
 * Surfaces the unified jobs feed for `/solar-rec/jobs`. Reads come
 * from `listRecentJobsAcrossRunners` which queries all 3 job tables
 * (contractScanJobs, dinScrapeJobs, scheduleBImportJobs) in one
 * scope-keyed Promise.all — no client-side fan-out, no N+1.
 *
 * Module key: `jobs`. Read-only — there are no mutations here. The
 * row link in the UI hands off to the per-runner manager which has
 * its own start/stop/cancel mutations gated by their own module key.
 *
 * The status of each runner is decorated with `liveOnThisProcess`
 * derived from the in-process `isXxxRunnerActive` registry. Useful
 * for diagnosing "the DB says running but the runner died" — the
 * Schedule B Manager has the same flag visible since the 2026-04-10
 * rewrite. False on web instances that aren't actively crunching
 * (multi-instance deploys).
 */

import { z } from "zod";
import { t, requirePermission } from "./solarRecBase";

/** Bumped when the response shape or filter logic changes. Surfaced
 *  on every `getJobsIndex` response per the CLAUDE.md hard rule for
 *  long-running server jobs / observability of deploys. */
export const SOLAR_REC_JOBS_ROUTER_VERSION = "solar-rec-jobs@1";

export const solarRecJobsRouter = t.router({
  getJobsIndex: requirePermission("jobs", "read")
    .input(
      z
        .object({
          /**
           * Per-table cap. Default 25 → up to 75 rows total across
           * the three tables. Bounded to avoid pathological pulls.
           */
          limitPerRunner: z.number().int().min(1).max(100).optional(),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const { listRecentJobsAcrossRunners } = await import("../db");
      const {
        isContractScanRunnerActive,
      } = await import("../services/core/contractScanJobRunner");
      const { isDinScrapeRunnerActive } = await import(
        "../services/core/dinScrapeJobRunner"
      );
      const { isScheduleBImportRunnerActive } = await import(
        "../services/core/scheduleBImportJobRunner"
      );
      const { isCsgScheduleBImportRunnerActive } = await import(
        "../services/core/csgScheduleBImportJobRunner"
      );

      const limit = input?.limitPerRunner ?? 25;
      const rows = await listRecentJobsAcrossRunners(ctx.scopeId, limit);

      const decorated = rows.map((row) => {
        let liveOnThisProcess = false;
        if (row.runnerKind === "contract-scan") {
          liveOnThisProcess = isContractScanRunnerActive(row.id);
        } else if (row.runnerKind === "din-scrape") {
          liveOnThisProcess = isDinScrapeRunnerActive(row.id);
        } else if (row.runnerKind === "schedule-b-import") {
          // Either the upload runner OR the CSG-portal runner may be
          // actively processing this job. The UI doesn't need to
          // distinguish; "is anything churning on this job right now"
          // is the question we're answering.
          liveOnThisProcess =
            isScheduleBImportRunnerActive(row.id) ||
            isCsgScheduleBImportRunnerActive(row.id);
        }
        return { ...row, liveOnThisProcess };
      });

      return {
        _runnerVersion: SOLAR_REC_JOBS_ROUTER_VERSION,
        jobs: decorated,
      };
    }),
});

export type SolarRecJobsRouter = typeof solarRecJobsRouter;
