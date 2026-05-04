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
 * **Allowlisted procedures in warn mode are not measured.** Running
 * `JSON.stringify` on a 20–60 MB allowlisted response would itself
 * make a full extra copy in the heap — exactly the heap pressure
 * the guard is supposed to protect against. In warn mode we
 * already accept that the response is oversized; measuring it adds
 * memory cost without changing behavior. In `throw` mode (dev/test)
 * we still measure: a regression that pushes a non-allowlisted
 * proc over the budget must fail loudly, and dev/test traffic is
 * low enough that the measurement cost is irrelevant. The global
 * `largeResponseLogger` already covers prod observability for
 * responses ≥ 5 MB by streaming-byte counting (no double
 * serialization).
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
 *
 * Retired entries (kept here as searchable history):
 *   - `solarRecDashboard.exportOwnershipTileCsv` — replaced by the
 *     `startDashboardCsvExport` + `getDashboardCsvExportJobStatus`
 *     background-job flow. The MB-scale CSV no longer passes
 *     through tRPC; the worker writes to storage and the client
 *     polls a slim status endpoint.
 *   - `solarRecDashboard.exportChangeOwnershipTileCsv` — same
 *     replacement, same flow.
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
 * report whether it fits within the budget. Allocates one
 * intermediate string the size of the response — callers that
 * cannot afford that allocation must short-circuit before invoking
 * this helper.
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

    // In warn mode, allowlisted oversized responses are accepted as a
    // known regression. Measuring them would mean serializing the
    // whole 20–60 MB payload to bytes just to log a number — a full
    // extra copy in the heap, paid on every request, for no behavior
    // change. Skip the measurement entirely. Prod observability for
    // these procedures comes from the global `largeResponseLogger`
    // (5 MB streaming-byte threshold; no double serialization).
    if (enforcement === "warn" && DASHBOARD_OVERSIZE_ALLOWLIST.has(path)) {
      return result;
    }

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
