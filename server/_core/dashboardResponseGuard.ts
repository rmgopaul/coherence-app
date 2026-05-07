/**
 * Dashboard response-size guardrail.
 *
 * Every procedure mounted on `solarRecDashboardRouter` must keep its
 * response payload under a configurable byte budget (default 1 MB,
 * env `DASHBOARD_RESPONSE_LIMIT_BYTES`). Legacy procedures that
 * exceed that budget on production-shaped data are listed in
 * `DASHBOARD_OVERSIZE_ALLOWLIST` (the Set itself is the source of
 * truth — no maintained count in the prose) with a comment naming
 * the rebuild phase that retires each.
 *
 * Enforcement (`DASHBOARD_RESPONSE_ENFORCEMENT`):
 *   - `throw`  — TRPCError unless allowlisted. Default in dev/test.
 *   - `warn`   — log only. Default in production until the per-tab
 *                paginated replacements ship.
 *   - `off`    — bypass entirely. Incident kill switch.
 *
 * The allowlist matches on the **fully-qualified** procedure path
 * (e.g. `"solarRecDashboard.getDashboardChangeOwnership"`) so a
 * same-named procedure on a different router is not silently
 * allowlisted.
 *
 * The middleware also records lightweight request-level heap
 * telemetry. That path never serializes `result.data`; it only logs
 * small scalar fields when the request crosses heap thresholds or an
 * explicit diagnostic env flag is enabled.
 *
 * **Warn-mode measurement must not worsen heap pressure.** Running
 * `JSON.stringify` on a 20–60 MB response would itself make a full
 * extra copy in the heap — exactly the pressure this guard is
 * supposed to surface. In warn mode, allowlisted procedures skip
 * measurement entirely, and non-allowlisted procedures skip
 * measurement when request heap thresholds have already been
 * crossed. In `throw` mode (dev/test) we still measure so regressions
 * fail loudly. The global `largeResponseLogger` already covers prod
 * observability for responses ≥ 5 MB by streaming-byte counting (no
 * double serialization).
 */

import { TRPCError } from "@trpc/server";
import { t, requirePermission } from "./solarRecBase";
import type { ModuleKey } from "../../shared/solarRecModules";
import { maybeLogDashboardTidbDiagnostics } from "../services/solar/dashboardTidbDiagnostics";

export const DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT = 1024 * 1024;
export const DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES_DEFAULT =
  64 * 1024 * 1024;
export const DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES_DEFAULT =
  700 * 1024 * 1024;

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
 *   - `solarRecDashboard.getDatasetCsv` — replaced by the same
 *     background-job flow with `exportType: "datasetCsv"`. The full
 *     raw dataset CSV is written to storage and downloaded by URL
 *     instead of crossing tRPC as a string.
 *   - `solarRecDashboard.getDashboardChangeOwnership` — Phase 2
 *     PR-D-4 stripped `rows: ChangeOwnershipExportRow[]` from the
 *     wire shape (~19 MB on prod). The ChangeOwnershipTab + the
 *     snapshot-log creation flow now read those rows via
 *     `getDashboardChangeOwnershipPage`'s `useInfiniteQuery` walk
 *     (each page bounded under 1 MB; backed by the
 *     `solarRecDashboardChangeOwnershipFacts` table the build
 *     runner populates). The slim aggregator response is now a
 *     few KB (summary + chart + counter) and stays well under the
 *     1 MB budget without an allowlist entry.
 *   - `solarRecDashboard.getDashboardOverviewSummary` — Phase 2
 *     PR-E-4-supplement (2026-05-06) stripped
 *     `ownershipRows: OwnershipOverviewExportRow[]` from the wire
 *     shape (~5–15 MB on prod). The OwnershipTab moved onto the
 *     paginated `getDashboardOwnershipPage` proc in PR #434 and no
 *     other client path read `summary.ownershipRows` — the field
 *     was vestigial after that migration. The aggregator still
 *     computes the array internally (the dashboard CSV export job
 *     + the `ownership` fact builder read it in-process); only the
 *     wire output shrinks. The slim response is now a few KB of
 *     scalars + the small `ownershipOverview` count object — well
 *     under the 1 MB budget.
 *   - `solarRecDashboard.getSystemSnapshot` — Phase 2 PR-F-4-h
 *     removed the last parent-level `useSystemSnapshot` consumer.
 *     Tabs now read bounded aggregate/fact-table endpoints instead
 *     of hydrating the legacy full `SystemRecord[]` payload.
 *   - `solarRecDashboard.getDashboardOfflineMonitoring` — Phase 2
 *     PR-F-4-i removed the parent client call, moved counts to
 *     `getDashboardSummary`, and moved detail rows to bounded
 *     fact-page reads. The router proc was later removed entirely.
 *
 * **The allowlist is now empty.** Phase 2 has retired every
 * known oversized response from the dashboard router. New procs
 * must stay under the 1 MB budget; if a future regression
 * genuinely needs the allowlist mechanism, add the entry here
 * with an inline replacement plan.
 */
export const DASHBOARD_OVERSIZE_ALLOWLIST: ReadonlySet<string> = new Set([]);

export type DashboardResponseEnforcement = "warn" | "throw" | "off";

function getPositiveIntegerEnv(
  key: string,
  defaultValue: number
): number {
  const raw = process.env[key]?.trim();
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return defaultValue;
  }
  return Math.floor(parsed);
}

export function getDashboardResponseLimitBytes(): number {
  return getPositiveIntegerEnv(
    "DASHBOARD_RESPONSE_LIMIT_BYTES",
    DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
  );
}

export function getDashboardResponseEnforcement(): DashboardResponseEnforcement {
  const raw = process.env.DASHBOARD_RESPONSE_ENFORCEMENT?.trim().toLowerCase();
  if (raw === "warn" || raw === "throw" || raw === "off") return raw;
  // Default: throw in dev/test so any new regression fails fast in CI;
  // warn in production until the per-tab paginated replacements ship.
  return process.env.NODE_ENV === "production" ? "warn" : "throw";
}

export function getDashboardRequestHeapDeltaWarnBytes(): number {
  return getPositiveIntegerEnv(
    "DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES",
    DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES_DEFAULT
  );
}

export function getDashboardRequestHeapAfterWarnBytes(): number {
  return getPositiveIntegerEnv(
    "DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES",
    DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES_DEFAULT
  );
}

export function getDashboardRequestHeapLogAll(): boolean {
  const raw =
    process.env.DASHBOARD_REQUEST_HEAP_LOG_ALL?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
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

type DashboardRequestHeapOutcome = "success" | "failed";
type DashboardHeapWarningReason = "heap-delta" | "heap-after";

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function getDashboardHeapWarningReasons(input: {
  heapBeforeBytes: number;
  heapAfterBytes: number;
}): DashboardHeapWarningReason[] {
  const heapDeltaBytes = input.heapAfterBytes - input.heapBeforeBytes;
  const reasons: DashboardHeapWarningReason[] = [];
  if (heapDeltaBytes > getDashboardRequestHeapDeltaWarnBytes()) {
    reasons.push("heap-delta");
  }
  if (input.heapAfterBytes > getDashboardRequestHeapAfterWarnBytes()) {
    reasons.push("heap-after");
  }
  return reasons;
}

function maybeLogDashboardRequestHeap(input: {
  path: string;
  outcome: DashboardRequestHeapOutcome;
  startedAt: number;
  heapBeforeBytes: number;
  heapAfterBytes: number;
  enforcement: DashboardResponseEnforcement;
  allowlisted: boolean;
  error?: unknown;
}): void {
  const heapDeltaBytes = input.heapAfterBytes - input.heapBeforeBytes;
  const heapDeltaWarnBytes = getDashboardRequestHeapDeltaWarnBytes();
  const heapAfterWarnBytes = getDashboardRequestHeapAfterWarnBytes();
  const reasons: string[] = getDashboardHeapWarningReasons(input);
  if (getDashboardRequestHeapLogAll()) {
    reasons.push("log-all");
  }
  if (reasons.length === 0) return;

  const payload: Record<string, unknown> = {
    path: input.path,
    outcome: input.outcome,
    elapsedMs: Date.now() - input.startedAt,
    enforcement: input.enforcement,
    allowlisted: input.allowlisted,
    heapBeforeBytes: input.heapBeforeBytes,
    heapAfterBytes: input.heapAfterBytes,
    heapDeltaBytes,
    heapDeltaWarnBytes,
    heapAfterWarnBytes,
    reasons,
  };
  if (input.error !== undefined) {
    payload.error = formatErrorMessage(input.error);
  }

  console.warn(`[dashboard:request-heap] ${JSON.stringify(payload)}`);
}

function maybeSkipDashboardResponseMeasurementForHeap(input: {
  path: string;
  enforcement: DashboardResponseEnforcement;
  allowlisted: boolean;
  heapBeforeBytes: number;
  heapAfterBytes: number;
}): boolean {
  if (input.enforcement !== "warn" || input.allowlisted) return false;
  const reasons = getDashboardHeapWarningReasons(input);
  if (reasons.length === 0) return false;
  const heapDeltaBytes = input.heapAfterBytes - input.heapBeforeBytes;
  console.warn(
    `[dashboard:response-size-skip] ${JSON.stringify({
      path: input.path,
      enforcement: input.enforcement,
      allowlisted: input.allowlisted,
      heapBeforeBytes: input.heapBeforeBytes,
      heapAfterBytes: input.heapAfterBytes,
      heapDeltaBytes,
      heapDeltaWarnBytes: getDashboardRequestHeapDeltaWarnBytes(),
      heapAfterWarnBytes: getDashboardRequestHeapAfterWarnBytes(),
      reasons,
    })}`
  );
  return true;
}

const dashboardResponseGuardMiddleware = t.middleware(
  async ({ next, path }) => {
    const heapBeforeBytes = process.memoryUsage().heapUsed;
    const startedAt = Date.now();
    const allowlisted = DASHBOARD_OVERSIZE_ALLOWLIST.has(path);
    let result: Awaited<ReturnType<typeof next>>;
    try {
      result = await next();
    } catch (error) {
      const heapAfterBytes = process.memoryUsage().heapUsed;
      const elapsedMs = Date.now() - startedAt;
      maybeLogDashboardRequestHeap({
        path,
        outcome: "failed",
        startedAt,
        heapBeforeBytes,
        heapAfterBytes,
        enforcement: getDashboardResponseEnforcement(),
        allowlisted,
        error,
      });
      void maybeLogDashboardTidbDiagnostics({
        path,
        outcome: "failed",
        elapsedMs,
        enforcement: getDashboardResponseEnforcement(),
        allowlisted,
        heapBeforeBytes,
        heapAfterBytes,
      });
      throw error;
    }
    const enforcement = getDashboardResponseEnforcement();
    const heapAfterBytes = process.memoryUsage().heapUsed;
    const elapsedMs = Date.now() - startedAt;
    const outcome = result.ok ? "success" : "failed";

    maybeLogDashboardRequestHeap({
      path,
      outcome,
      startedAt,
      heapBeforeBytes,
      heapAfterBytes,
      enforcement,
      allowlisted,
      error: result.ok ? undefined : result.error,
    });
    void maybeLogDashboardTidbDiagnostics({
      path,
      outcome,
      elapsedMs,
      enforcement,
      allowlisted,
      heapBeforeBytes,
      heapAfterBytes,
    });

    if (!result.ok) return result;

    if (enforcement === "off") return result;

    // In warn mode, allowlisted oversized responses are accepted as a
    // known regression. Measuring them would mean serializing the
    // whole 20–60 MB payload to bytes just to log a number — a full
    // extra copy in the heap, paid on every request, for no behavior
    // change. Skip the measurement entirely. Prod observability for
    // these procedures comes from the global `largeResponseLogger`
    // (5 MB streaming-byte threshold; no double serialization).
    if (enforcement === "warn" && allowlisted) {
      return result;
    }

    if (
      maybeSkipDashboardResponseMeasurementForHeap({
        path,
        enforcement,
        allowlisted,
        heapBeforeBytes,
        heapAfterBytes,
      })
    ) {
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
