/**
 * Dashboard response-size guardrail.
 *
 * Every procedure mounted on `solarRecDashboardRouter` must keep its
 * response payload under a configurable byte budget (default 1 MB,
 * env `DASHBOARD_RESPONSE_LIMIT_BYTES`). Five legacy procedures
 * exceed that budget today and are listed in
 * `DASHBOARD_OVERSIZE_ALLOWLIST` with a comment naming the rebuild
 * phase that retires each.
 *
 * Enforcement (`DASHBOARD_RESPONSE_ENFORCEMENT`):
 *   - `throw`  — TRPCError unless allowlisted. Default in dev/test.
 *   - `warn`   — log only. Default in production until the per-tab
 *                paginated replacements ship.
 *   - `off`    — bypass entirely. Incident kill switch.
 *
 * The allowlist matches on the **fully-qualified** procedure path
 * (e.g. `"solarRecDashboard.getSystemSnapshot"`) so a same-named
 * procedure on a different router is not silently allowlisted.
 *
 * The size measurement uses plain `JSON.stringify` rather than the
 * router's superjson transformer. This under-counts wire bytes for
 * Date-heavy responses (superjson adds a meta tree for each Date
 * cell), but the budget has plenty of headroom for the under-count
 * to be irrelevant — and JSON.stringify is ~5× cheaper, which
 * matters because the middleware runs on every dashboard response.
 */

import { TRPCError } from "@trpc/server";
import { t, requirePermission } from "./solarRecBase";
import type { ModuleKey } from "../../shared/solarRecModules";

export const DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT = 1024 * 1024;

/**
 * Procedures known to exceed the response budget on production-shaped
 * data. Each entry is the fully-qualified tRPC path (router key dot
 * procedure name). Add an entry only with a pointer to the migration
 * that will retire it.
 */
export const DASHBOARD_OVERSIZE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Returns the full pre-computed system record set; rebuild plan replaces
  // with `getDashboardSystemsPage` + a derived `solarRecDashboardSystemFacts`
  // table.
  "solarRecDashboard.getSystemSnapshot",
  // Embeds `ownershipRows: OwnershipOverviewExportRow[]`; rebuild plan
  // splits into `getDashboardSummary` + `getDashboardOwnershipRowsPage`.
  "solarRecDashboard.getDashboardOverviewSummary",
  // Embeds the full Change-of-Ownership row set; rebuild plan splits into
  // `getDashboardChangeOwnershipRowsPage`.
  "solarRecDashboard.getDashboardChangeOwnership",
  // Ships per-system lookup objects keyed by ~21k systems
  // (`monitoringDetailsBySystemKey` etc.); rebuild plan paginates via
  // `getDashboardMonitoringDetailsPage`.
  "solarRecDashboard.getDashboardOfflineMonitoring",
  // Paginates DB reads but joins the full CSV in memory before returning.
  // Rebuild plan replaces with a streaming background export job.
  "solarRecDashboard.getDatasetCsv",
]);

export type DashboardResponseEnforcement = "warn" | "throw" | "off";

export function getDashboardResponseLimitBytes(): number {
  const raw = process.env.DASHBOARD_RESPONSE_LIMIT_BYTES?.trim();
  if (!raw) return DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT;
  }
  return Math.floor(parsed);
}

export function getDashboardResponseEnforcement(): DashboardResponseEnforcement {
  const raw = process.env.DASHBOARD_RESPONSE_ENFORCEMENT?.trim().toLowerCase();
  if (raw === "warn" || raw === "throw" || raw === "off") return raw;
  // Default: throw in dev/test so any new regression fails fast in CI;
  // warn in production until the per-tab paginated replacements ship.
  return process.env.NODE_ENV === "production" ? "warn" : "throw";
}

export type DashboardResponseSizeCheck =
  | { ok: true; bytes: number; limit: number }
  | {
      ok: false;
      bytes: number;
      limit: number;
      allowlisted: boolean;
    };

export interface DashboardResponseSizeCheckOptions {
  limitBytes?: number;
  allowlist?: ReadonlySet<string>;
}

/**
 * Pure helper: measure the JSON-encoded byte size of `value` and
 * report whether it fits within the budget. The verdict carries
 * facts only; callers decide what action to take.
 */
export function checkDashboardResponseSize(
  value: unknown,
  path: string,
  options: DashboardResponseSizeCheckOptions = {}
): DashboardResponseSizeCheck {
  const limit = options.limitBytes ?? getDashboardResponseLimitBytes();
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes <= limit) return { ok: true, bytes, limit };
  const allowlist = options.allowlist ?? DASHBOARD_OVERSIZE_ALLOWLIST;
  return { ok: false, bytes, limit, allowlisted: allowlist.has(path) };
}

const dashboardResponseGuardMiddleware = t.middleware(
  async ({ next, path }) => {
    const result = await next();
    if (!result.ok) return result;

    const enforcement = getDashboardResponseEnforcement();
    if (enforcement === "off") return result;

    const verdict = checkDashboardResponseSize(result.data, path);
    if (verdict.ok) return result;

    console.warn(
      `[dashboard:oversize-response] ${JSON.stringify({
        path,
        bytes: verdict.bytes,
        limit: verdict.limit,
        enforcement,
        allowlisted: verdict.allowlisted,
      })}`
    );

    if (enforcement === "throw" && !verdict.allowlisted) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          `Dashboard response for ${path} exceeded ${verdict.limit} bytes ` +
          `(got ${verdict.bytes}). Tighten the procedure or, if this is a ` +
          `known regression scheduled for migration, add the procedure path ` +
          `to DASHBOARD_OVERSIZE_ALLOWLIST in dashboardResponseGuard.ts ` +
          `with a comment naming the rebuild phase that retires it.`,
      });
    }

    return result;
  }
);

/**
 * Procedure builder for the solar-rec-dashboard router. Drop-in
 * replacement for `requirePermission(...)` that additionally enforces
 * the response-size budget.
 */
export function dashboardProcedure(
  moduleKey: ModuleKey,
  minLevel: "read" | "edit" | "admin"
) {
  return requirePermission(moduleKey, minLevel).use(
    dashboardResponseGuardMiddleware
  );
}
