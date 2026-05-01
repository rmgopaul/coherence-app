/**
 * Dashboard response-size guardrail.
 *
 * Phase 1 of the Solar REC Dashboard data-plane rebuild. Every procedure
 * mounted on `solarRecDashboardRouter` is required to keep its response
 * payload under a configurable byte budget (default 1 MB uncompressed)
 * once the data-plane rebuild lands. Today, four legacy procedures plus
 * one export procedure exceed that budget and are explicitly listed in
 * `DASHBOARD_OVERSIZE_ALLOWLIST`. Each entry here is a known regression
 * the rebuild is scheduled to retire.
 *
 * Behavior:
 *   - The middleware serializes the procedure result via the same
 *     superjson transformer the router uses on the wire and measures
 *     `Buffer.byteLength` on the JSON-encoded output. This matches the
 *     bytes the client actually receives (modulo HTTP framing/gzip).
 *   - If the size is at or below the limit, the middleware is a no-op.
 *   - If the size exceeds the limit, the middleware always logs a
 *     `[dashboard:oversize-response]` warning. Whether it ALSO throws
 *     depends on `DASHBOARD_RESPONSE_ENFORCEMENT`:
 *       * `throw` — TRPCError unless the procedure is allowlisted.
 *       * `warn`  — log only.
 *       * `off`   — bypass entirely.
 *     Default: `throw` in non-production, `warn` in production. We do
 *     not throw in production yet because the four allowlisted
 *     procedures still ship oversized responses there; flipping prod to
 *     `throw` is gated on the per-tab pagination/derived-table work.
 *
 * Design notes:
 *   - The size check runs AFTER the procedure body completes, so it
 *     does not protect against in-process heap pressure during the
 *     build itself. Heap-side mitigation (single-flight, streaming row
 *     loads, derived-table materialization) is tracked in subsequent
 *     phases of the data-plane rebuild and is out of scope here.
 *   - The pure helper `checkDashboardResponseSize` is exported so tests
 *     can exercise the size logic without standing up a tRPC pipeline.
 *   - The allowlist matches on the short procedure name (the last
 *     dot-separated segment of `path`) so the guard remains correct if
 *     the dashboard router is ever re-mounted under a different parent
 *     key.
 */

import { TRPCError } from "@trpc/server";
import superjson from "superjson";
import {
  t,
  requirePermission,
  type SolarRecContext,
} from "./solarRecBase";
import type { ModuleKey } from "../../shared/solarRecModules";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Budget in bytes that a single dashboard tRPC response is allowed to
 * occupy on the wire (uncompressed, post-superjson). Mirrors the
 * "Wire payload contracts" rule in CLAUDE.md.
 */
export const DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT = 1024 * 1024;

/**
 * Procedures that are known to exceed the dashboard response budget on
 * production-shaped data. Each entry is paired with the migration that
 * is expected to retire it; do not add new entries without a pointer to
 * the work that will remove them.
 *
 * Stored as short procedure names (the last dot-separated segment of
 * `path`) so the guard works regardless of how the dashboard router is
 * composed into the parent tRPC tree.
 */
export const DASHBOARD_OVERSIZE_ALLOWLIST: ReadonlySet<string> = new Set([
  // Returns the full pre-computed system record set; rebuild plan replaces
  // this with `getDashboardSystemsPage` + a derived `solarRecDashboardSystemFacts`
  // table.
  "getSystemSnapshot",
  // Embeds `ownershipRows: OwnershipOverviewExportRow[]`; rebuild plan
  // splits this into `getDashboardSummary` + `getDashboardOwnershipRowsPage`.
  "getDashboardOverviewSummary",
  // Embeds the full Change-of-Ownership row set; rebuild plan splits
  // detail rows into `getDashboardChangeOwnershipRowsPage`.
  "getDashboardChangeOwnership",
  // Ships per-system lookup objects keyed by ~21k systems
  // (`monitoringDetailsBySystemKey` etc.); rebuild plan paginates via
  // `getDashboardMonitoringDetailsPage`.
  "getDashboardOfflineMonitoring",
  // Paginates DB reads internally but joins the full CSV in memory before
  // returning. Rebuild plan replaces this with a streaming background
  // export job (`startDashboardExport` + signed download URL).
  "getDatasetCsv",
]);

export type DashboardResponseEnforcement = "warn" | "throw" | "off";

const ENFORCEMENT_VALUES: ReadonlySet<DashboardResponseEnforcement> =
  new Set<DashboardResponseEnforcement>(["warn", "throw", "off"]);

// ---------------------------------------------------------------------------
// Env accessors
// ---------------------------------------------------------------------------

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
  if (raw && ENFORCEMENT_VALUES.has(raw as DashboardResponseEnforcement)) {
    return raw as DashboardResponseEnforcement;
  }
  // Default: throw in dev/test so any new regression fails fast in CI;
  // warn in production until the per-tab paginated replacements ship.
  return process.env.NODE_ENV === "production" ? "warn" : "throw";
}

// ---------------------------------------------------------------------------
// Pure size check
// ---------------------------------------------------------------------------

export type DashboardResponseSizeCheck =
  | {
      ok: true;
      bytes: number;
      limit: number;
      enforcement: DashboardResponseEnforcement;
    }
  | {
      ok: false;
      bytes: number;
      limit: number;
      enforcement: DashboardResponseEnforcement;
      allowlisted: boolean;
      shouldThrow: boolean;
      procedureName: string;
    };

export interface DashboardResponseSizeCheckOptions {
  limitBytes?: number;
  enforcement?: DashboardResponseEnforcement;
  allowlist?: ReadonlySet<string>;
}

/**
 * Pure helper exposed for tests. Serializes the value the same way the
 * tRPC handler does (superjson → JSON.stringify → utf-8 bytes) and
 * compares against the limit. Returns a structured verdict; never
 * throws.
 */
export function checkDashboardResponseSize(
  value: unknown,
  path: string,
  options: DashboardResponseSizeCheckOptions = {}
): DashboardResponseSizeCheck {
  const limit = options.limitBytes ?? getDashboardResponseLimitBytes();
  const enforcement = options.enforcement ?? getDashboardResponseEnforcement();
  if (enforcement === "off") {
    return { ok: true, bytes: 0, limit, enforcement };
  }

  const serialized = JSON.stringify(superjson.serialize(value));
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= limit) {
    return { ok: true, bytes, limit, enforcement };
  }

  const procedureName = procedureNameFromPath(path);
  const allowlist = options.allowlist ?? DASHBOARD_OVERSIZE_ALLOWLIST;
  const allowlisted = allowlist.has(procedureName);
  const shouldThrow = enforcement === "throw" && !allowlisted;
  return {
    ok: false,
    bytes,
    limit,
    enforcement,
    allowlisted,
    shouldThrow,
    procedureName,
  };
}

function procedureNameFromPath(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? path : path.slice(idx + 1);
}

// ---------------------------------------------------------------------------
// tRPC middleware + procedure builder
// ---------------------------------------------------------------------------

const dashboardResponseGuardMiddleware = t.middleware(
  async ({ next, path }) => {
    const result = await next();
    if (!result.ok) return result;

    const verdict = checkDashboardResponseSize(result.data, path);
    if (verdict.ok) return result;

    const logPayload = {
      path,
      procedure: verdict.procedureName,
      bytes: verdict.bytes,
      limit: verdict.limit,
      enforcement: verdict.enforcement,
      allowlisted: verdict.allowlisted,
    };
    console.warn(
      `[dashboard:oversize-response] ${JSON.stringify(logPayload)}`
    );

    if (verdict.shouldThrow) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          `Dashboard response for ${path} exceeded ${verdict.limit} bytes ` +
          `(got ${verdict.bytes}). Tighten the procedure or, if this is a ` +
          `known regression scheduled for migration, add the procedure name ` +
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
 * the dashboard response-size budget.
 */
export function dashboardProcedure(
  moduleKey: ModuleKey,
  minLevel: "read" | "edit" | "admin"
) {
  return requirePermission(moduleKey, minLevel).use(
    dashboardResponseGuardMiddleware
  );
}

// Re-export the context type for callers that want to type their handlers
// against the same shape `requirePermission` produces.
export type { SolarRecContext };
