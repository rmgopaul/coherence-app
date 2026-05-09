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
 * Bounded exponential backoff with full jitter, optionally taking
 * the server's `Retry-After` hint as a floor.
 *
 * 2026-05-09 follow-up to PR-6 (#535) — the server emits
 * `Retry-After: 5` on heap-pressure rejections via
 * `server/_core/dashboardResponseMeta.ts`. The fetch wrapper in
 * `dashboardRetryAfter.ts` plumbs the header into the tRPC
 * client-error's `data.retryAfterMs` field; this function reads
 * it and uses `max(retryAfterMs, jitteredCeiling)` so the
 * server's hint wins when it would force a longer wait, and the
 * jittered backoff still applies otherwise. When the header is
 * absent (any non-tRPC error path, or pre-PR-6 server) the
 * function falls back to pure jittered backoff.
 *
 * Pre-jitter: 1.5s × 2^attempt capped at 15s — works for one
 * caller, but on a paginated walk where 24 pages all hit a 502
 * simultaneously, retrying each at exactly +1.5s recreates the
 * cascade. Full jitter (uniform random in `[0, base * 2^n]`) breaks
 * the synchronization without sacrificing the worst-case bound.
 *
 * Total recovery window for a 3-retry sequence (no Retry-After):
 * worst case ≈ 1.5s + 3s + 6s = 10.5s. With `Retry-After: 5` on
 * each retry, the floor pushes EVERY retry to ≥5s and jitter
 * still spreads them slightly, so 24 simultaneous failures don't
 * synchronize on the same retry instant.
 */
export function dashboardTransientRetryDelay(
  attempt: number,
  error?: unknown
): number {
  const ceiling = Math.min(15_000, 1500 * Math.pow(2, attempt));
  const jittered = Math.floor(Math.random() * ceiling);
  // Read `error.data.retryAfterMs` directly here (instead of
  // importing `extractRetryAfterMsFromError` from
  // `dashboardRetryAfter.ts`) to keep this module's only
  // dependency surface to the standard library. The other module
  // is the source of truth for the field's shape; this duplication
  // is intentional and small. When the field is absent, fall back
  // to pure jittered backoff.
  if (error && typeof error === "object") {
    const candidate = error as { data?: { retryAfterMs?: unknown } };
    const retryAfterMs = candidate.data?.retryAfterMs;
    if (
      typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs >= 0
    ) {
      return Math.max(retryAfterMs, jittered);
    }
  }
  return jittered;
}
