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
 * Cap semantic: `failureCount > maxAttempts` returns false. With
 * `DASHBOARD_TRANSIENT_RETRY_LIMIT = 2`, `failureCount` of 0/1/2
 * all pass the cap → up to 3 RETRIES after the initial failure =
 * **4 total attempts**, total backoff window ~10.5s (1.5s + 3s +
 * 6s before any jitter). Documented here because the count is
 * easy to misread.
 *
 * 500 (Internal Server Error) is intentionally NOT retried —
 * partial-data aggregator throws can produce transient 500s, but
 * conservatively we'd rather surface them loudly than silently
 * mask. If a future incident shows transient 500s are the norm
 * during builds, expand `TRANSIENT_OVERLOAD_STATUSES` and add
 * tests.
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
 * Bounded exponential backoff with full jitter.
 *
 * Pre-jitter: 1.5s × 2^attempt capped at 15s — works for one
 * caller, but on a paginated walk where 24 pages all hit a 502
 * simultaneously, retrying each at exactly +1.5s recreates the
 * cascade. Full jitter (uniform random in `[0, base * 2^n]`) breaks
 * the synchronization without sacrificing the worst-case bound.
 *
 * Total recovery window for a 3-retry sequence: worst case ≈
 * 1.5s + 3s + 6s = 10.5s. Best case (all jitters near 0): instant
 * retries, but the heap-pressure window typically requires at
 * least one GC cycle (2-3s) to clear, so the FIRST attempt's
 * jitter should not collapse to 0 in practice. Acceptable
 * tradeoff: jitter trades small probability of a too-fast retry
 * against the certainty of synchronized cascades.
 *
 * Honoring `Retry-After` is a future enhancement — the server
 * sends it (via `dashboardResponseMeta.ts`), but React Query
 * doesn't surface response headers to `retryDelay` callbacks.
 * Bridging that gap requires either a custom tRPC link that
 * reads the header off the failed response and stuffs it into
 * the error data, or a separate retry layer below React Query.
 * Out of scope for this PR.
 */
export function dashboardTransientRetryDelay(attempt: number): number {
  const ceiling = Math.min(15_000, 1500 * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceiling);
}
