/**
 * Retry-After header → tRPC error data plumbing.
 *
 * 2026-05-09 follow-up to PR-6 (#535). PR-6 added `Retry-After: 5` to
 * the server's heap-pressure rejection (via
 * `dashboardResponseMeta.ts`), but the client's `dashboardTransientRetryDelay`
 * never read the header — React Query's `retryDelay` callback only
 * sees the error, not the underlying HTTP response, so the server's
 * hint was effectively unused.
 *
 * This module bridges the gap. `wrapFetchWithRetryAfterCapture`
 * wraps an existing fetch implementation: when the server returns a
 * transient-overload status (429 / 503 / 502 / 504) AND a
 * `Retry-After` header, the wrapper mutates the JSON response body
 * to embed `retryAfterMs` into the tRPC error's `data` field. The
 * normal tRPC error parser surfaces it as `error.data.retryAfterMs`
 * on the `TRPCClientError`. The retry policy reads it and uses
 * `max(retryAfterMs, jitteredDelay)` so the server's hint wins when
 * present and the client's exponential backoff applies as a floor
 * otherwise.
 *
 * **Why mutate the body, not stash on a side-channel.** A WeakMap
 * keyed on the response object would be invisible to the consumer
 * (the response is consumed by tRPC and discarded). A keyed Map
 * indexed by URL+timestamp would be inherently racy with retries.
 * Mutating the JSON body is invasive but lossless — the value
 * propagates through tRPC's existing error-marshalling path with
 * no separate registry to maintain.
 */

const RETRY_AFTER_HEADER = "Retry-After";

const TRANSIENT_OVERLOAD_STATUSES = new Set([429, 502, 503, 504]);

/**
 * Parse a `Retry-After` header value into milliseconds. Per RFC 9110
 * §10.2.3 the header can be either:
 *   - A non-negative integer number of seconds (`5`)
 *   - An HTTP-date (`Wed, 21 Oct 2015 07:28:00 GMT`)
 *
 * The server emits the integer-seconds form (5). The HTTP-date form
 * is supported for completeness but in practice every dashboard
 * Retry-After we send is integer-seconds.
 *
 * Returns `null` when the value is missing, malformed, or in the
 * past.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  nowMs: number = Date.now()
): number | null {
  if (!headerValue) return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds)) {
    // Numeric form parsed cleanly. Negative seconds are spec-non-
    // compliant (RFC 9110 §10.2.3 requires non-negative); refuse
    // to fall through to date parsing because `Date.parse("-1")`
    // happens to interpret it as year -1 BCE and would silently
    // return 0 for the "past date" branch.
    if (asSeconds < 0) return null;
    return Math.round(asSeconds * 1000);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    const delta = parsed - nowMs;
    if (delta > 0) return delta;
    return 0;
  }
  return null;
}

/**
 * tRPC error response shape. The body of a tRPC error response is
 * either:
 *
 * - Single procedure call: `{ error: { json: { message, code, data: { code, httpStatus, ... } } } }`
 * - Batched call: `[{ error: { json: ... } }, { result: { ... } }, ...]`
 *
 * This module's responsibility is to add `retryAfterMs` into the
 * `data` field of every error in the body. Other shapes (HTML error
 * pages, malformed JSON) pass through untouched — `trpcFetch`
 * upstream throws on `text/html` content-type, so we don't need to
 * defend against it here.
 */
type TrpcErrorEnvelope = {
  error?: { json?: { data?: Record<string, unknown> } };
};

function injectRetryAfterIntoEnvelope(
  envelope: TrpcErrorEnvelope,
  retryAfterMs: number
): void {
  const data = envelope?.error?.json?.data;
  if (!data || typeof data !== "object") return;
  data.retryAfterMs = retryAfterMs;
}

/**
 * Inject `retryAfterMs` into every error envelope in a tRPC response
 * body. Single-call responses are objects; batched responses are
 * arrays. Returns the mutated value (callers can serialize it back
 * to JSON for a synthesized response body).
 */
export function injectRetryAfterIntoBody(
  body: unknown,
  retryAfterMs: number
): unknown {
  if (Array.isArray(body)) {
    body.forEach((entry) => injectRetryAfterIntoEnvelope(entry, retryAfterMs));
    return body;
  }
  if (body && typeof body === "object") {
    injectRetryAfterIntoEnvelope(body as TrpcErrorEnvelope, retryAfterMs);
  }
  return body;
}

/**
 * Wrap an existing `fetch` so transient-overload responses with a
 * `Retry-After` header have the header value plumbed into the tRPC
 * error data. Pass-through for non-transient and non-Retry-After
 * responses.
 *
 * The wrapper preserves the original Response shape (status, status
 * text, headers) so any downstream code that inspects them still
 * works. Only the response BODY is rewritten when the conditions
 * apply.
 */
export function wrapFetchWithRetryAfterCapture(
  innerFetch: typeof fetch,
  options: { now?: () => number } = {}
): typeof fetch {
  const now = options.now ?? (() => Date.now());
  return async (input, init) => {
    const response = await innerFetch(input, init);
    if (!TRANSIENT_OVERLOAD_STATUSES.has(response.status)) {
      return response;
    }
    const headerValue = response.headers.get(RETRY_AFTER_HEADER);
    const retryAfterMs = parseRetryAfterMs(headerValue, now());
    if (retryAfterMs === null) return response;

    // Read + rewrite the body. We must clone to consume the body
    // safely; the original response stream is gone after .text(),
    // so a fresh Response is constructed.
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Non-JSON error body — the consumer already throws on
      // unexpected content types; we just pass the original
      // response shape through unchanged via a clone.
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    const mutated = injectRetryAfterIntoBody(parsed, retryAfterMs);
    return new Response(JSON.stringify(mutated), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Read `retryAfterMs` from a tRPC client error. Returns `null` when
 * absent (the typical case — only transient-overload errors carry
 * the field).
 */
export function extractRetryAfterMsFromError(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { data?: { retryAfterMs?: unknown } };
  const value = candidate.data?.retryAfterMs;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return null;
}
