/**
 * tRPC `responseMeta` builder for the solar-rec router.
 *
 * 2026-05-09 — Bug #1 from the prod QA walk. The dashboard
 * middleware (`dashboardResponseGuard.ts:380–393`) throws
 * `TRPCError({ code: "TOO_MANY_REQUESTS" })` when worker heap
 * crosses `DASHBOARD_HEAP_PRESSURE_REJECT_BYTES` (default 2 GB).
 * tRPC's HTTP adapter translates that to HTTP 429, but Render's
 * load balancer re-codes non-2xx responses from origin to 502 at
 * the gateway layer — so the client never sees the 429 directly.
 *
 * This `responseMeta` builder sets a `Retry-After` header on every
 * response carrying a `TOO_MANY_REQUESTS` error. Two motivations:
 *
 *   1. **Correct semantics.** Even if Render's LB strips the header
 *      today, this is the right thing to send. Future LB tuning,
 *      direct-to-origin requests, or a non-Render deployment all
 *      benefit.
 *   2. **Client-visible signal.** When the LB does pass the 429
 *      through (e.g. on a different load path or with a future LB
 *      configuration), the client's `Retry-After`-aware retry can
 *      pick the suggested delay instead of falling back to the
 *      generic exponential backoff.
 *
 * Pure function — no I/O. Receives the tRPC response context (the
 * resolved/errored procedure batch) and returns the headers + status
 * to apply. Tested independently of the express middleware.
 */
import type { TRPCError } from "@trpc/server";

const RETRY_AFTER_SECONDS_DEFAULT = 5;

export type DashboardResponseMetaArgs = {
  /**
   * Errors thrown by the procedure(s) in this batch. tRPC supplies
   * this to `responseMeta`. Pre-fix the dashboard's responseMeta was
   * `undefined` so the heap-pressure 429 carried no Retry-After.
   */
  errors: readonly TRPCError[];
};

export type DashboardResponseMetaResult = {
  status?: number;
  headers?: Record<string, string>;
};

/**
 * Build the response metadata for a tRPC batch response. Currently
 * only acts on `TOO_MANY_REQUESTS` errors; other error codes pass
 * through unmodified.
 */
export function buildDashboardResponseMeta(
  args: DashboardResponseMetaArgs
): DashboardResponseMetaResult {
  const hasHeapPressure = args.errors.some(
    (error) => error.code === "TOO_MANY_REQUESTS"
  );
  if (!hasHeapPressure) return {};
  return {
    headers: {
      "Retry-After": String(RETRY_AFTER_SECONDS_DEFAULT),
    },
  };
}
