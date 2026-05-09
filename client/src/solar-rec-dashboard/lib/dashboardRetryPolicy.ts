/**
 * Retry policy for dashboard `useInfiniteQuery` consumers that walk
 * paginated server-side procedures (`getDashboardSystemsPage`,
 * `getDashboardChangeOwnershipPage`, monitoring details pages, etc.).
 *
 * 2026-05-09 — Bug #1 from the prod QA walk: Snapshot Log activation
 * fired ~24 sequential `getDashboardSystemsPage` calls; under heap
 * pressure the dashboard middleware (`dashboardResponseGuard.ts`)
 * rejects requests 21–28 with `TRPCError({ code:
 * "TOO_MANY_REQUESTS" })`. tRPC translates that to HTTP 429, but
 * Render's load balancer re-codes non-2xx-from-origin to 502 at the
 * gateway layer. With `retry: false` (the legacy pre-fix config on
 * ComparisonsTab / AlertsTab / OwnershipTab), those 502s never
 * recover — the user is stuck on a broken tab until manual refresh.
 *
 * The fix: retry transient overload responses (429 / 502 / 503 /
 * 504) with bounded exponential backoff. NEVER retry 4xx-other (those
 * are deterministic client errors and retrying them just hides the
 * bug). NEVER retry indefinitely — cap at a small number of attempts
 * so a sustained outage surfaces an error UI rather than spinning
 * forever.
 *
 * The PR-5 fix (Snapshot Log lazy walk) reduces the trigger surface;
 * this PR closes the resilience side. Together they make a
 * heap-pressure event self-recover instead of cascading.
 */

const TRANSIENT_OVERLOAD_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Best-effort HTTP status extraction from a tRPC client error. The
 * tRPC error shape varies by version + transport, so this checks
 * several common shapes. Returns `null` when no recognizable status
 * is present.
 */
export function extractTransportHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    httpStatus?: unknown;
    data?: { httpStatus?: unknown };
    cause?: { status?: unknown };
  };
  if (typeof candidate.httpStatus === "number") return candidate.httpStatus;
  if (typeof candidate.data?.httpStatus === "number") {
    return candidate.data.httpStatus;
  }
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.cause?.status === "number") return candidate.cause.status;
  return null;
}

/**
 * `retry` predicate for React Query. Returns true when the failure
 * is a transient overload AND we're under the attempt cap.
 *
 * Defaults: max 3 attempts (= the failed call + 2 retries). The
 * legacy in-tab `retry: 2` config matches; keeping the same cap on
 * paginated walks gives 3 chances per page to ride through a brief
 * heap-pressure window.
 */
export const DASHBOARD_TRANSIENT_RETRY_LIMIT = 2;

export function shouldRetryDashboardTransient(
  failureCount: number,
  error: unknown,
  options: { maxAttempts?: number } = {}
): boolean {
  const max = options.maxAttempts ?? DASHBOARD_TRANSIENT_RETRY_LIMIT;
  if (failureCount > max) return false;
  const status = extractTransportHttpStatus(error);
  if (status === null) return false;
  return TRANSIENT_OVERLOAD_STATUSES.has(status);
}

/**
 * Bounded exponential backoff. Pre-fix the QueryClient default
 * (`(attempt) => Math.min(1000 * 2**attempt, 30000)`) was fine, but
 * for paginated dashboard walks the pages are sequential so a fast
 * cascade of failures shouldn't all retry simultaneously. The
 * 1.5s × 2^n / 15s cap gives the worker enough time to GC between
 * retries while keeping total recovery under ~15s for a
 * 3-attempt sequence.
 */
export function dashboardTransientRetryDelay(attempt: number): number {
  return Math.min(15_000, 1500 * Math.pow(2, attempt));
}
