/**
 * Shared HTTP client utilities for all service integrations.
 *
 * Provides:
 * - `fetchJson()` — typed JSON fetcher with timeout, retries, and structured errors
 * - `RateLimitError`, `TimeoutError`, `AuthError` — structured error types
 * - `sleep()` — promise-based delay
 */

/* ------------------------------------------------------------------ */
/*  Structured error types                                              */
/* ------------------------------------------------------------------ */

export class HttpClientError extends Error {
  readonly statusCode: number | null;
  readonly serviceName: string;

  constructor(message: string, serviceName: string, statusCode: number | null = null) {
    super(message);
    this.name = "HttpClientError";
    this.serviceName = serviceName;
    this.statusCode = statusCode;
  }
}

export class RateLimitError extends HttpClientError {
  readonly retryAfterMs: number | null;

  constructor(serviceName: string, retryAfterMs: number | null = null) {
    super(`${serviceName}: rate limited (429)`, serviceName, 429);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class TimeoutError extends HttpClientError {
  constructor(serviceName: string, timeoutMs: number) {
    super(`${serviceName}: request timed out after ${timeoutMs}ms`, serviceName, null);
    this.name = "TimeoutError";
  }
}

export class AuthError extends HttpClientError {
  constructor(serviceName: string, statusCode: number = 401) {
    super(`${serviceName}: authentication failed (${statusCode})`, serviceName, statusCode);
    this.name = "AuthError";
  }
}

/* ------------------------------------------------------------------ */
/*  Sleep utility                                                       */
/* ------------------------------------------------------------------ */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  fetchJson — the main utility                                        */
/* ------------------------------------------------------------------ */

export interface FetchJsonOptions {
  /** Service name for error messages (e.g. "Zendesk", "Todoist"). */
  service: string;
  /** Request timeout in ms. Default: 15000. */
  timeoutMs?: number;
  /** Max retry attempts on 429 / 5xx. Default: 2. */
  maxRetries?: number;
  /** Custom headers to merge with defaults. */
  headers?: Record<string, string>;
  /** HTTP method. Default: "GET". */
  method?: string;
  /** JSON request body (will be stringified). */
  body?: unknown;
  /** Caller-provided AbortSignal (takes precedence over timeoutMs). */
  signal?: AbortSignal;
}

export interface FetchJsonResult<T> {
  data: T;
  status: number;
  headers: Headers;
}

/**
 * Fetch JSON from a URL with timeout, retries on 429/5xx, and structured errors.
 *
 * Usage:
 * ```ts
 * const { data } = await fetchJson<{ items: Item[] }>("https://api.example.com/items", {
 *   service: "Example",
 *   headers: { Authorization: `Bearer ${token}` },
 * });
 * ```
 */
export async function fetchJson<T = unknown>(
  url: string,
  options: FetchJsonOptions,
): Promise<FetchJsonResult<T>> {
  const {
    service,
    timeoutMs = 15_000,
    maxRetries = 2,
    headers: extraHeaders,
    method = "GET",
    body,
    signal: callerSignal,
  } = options;

  const requestHeaders: Record<string, string> = {
    Accept: "application/json",
    ...extraHeaders,
  };

  if (body !== undefined && !requestHeaders["Content-Type"]) {
    requestHeaders["Content-Type"] = "application/json";
  }

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
      });

      // 429 — rate limited, retry with backoff
      if (response.status === 429 && attempt < maxRetries) {
        const retryAfterHeader = Number(response.headers.get("retry-after") ?? "1");
        const retryMs = Math.max(1000, Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : 1000);
        lastError = new RateLimitError(service, retryMs);
        await sleep(retryMs);
        continue;
      }

      // 5xx — server error, retry with exponential backoff
      if (response.status >= 500 && attempt < maxRetries) {
        const backoffMs = 1000 * Math.pow(2, attempt);
        lastError = new HttpClientError(
          `${service}: server error (${response.status})`,
          service,
          response.status,
        );
        await sleep(backoffMs);
        continue;
      }

      // 401/403 — auth error, don't retry
      if (response.status === 401 || response.status === 403) {
        throw new AuthError(service, response.status);
      }

      // 429 on final attempt
      if (response.status === 429) {
        const retryAfterHeader = Number(response.headers.get("retry-after") ?? "");
        throw new RateLimitError(
          service,
          Number.isFinite(retryAfterHeader) ? retryAfterHeader * 1000 : null,
        );
      }

      // Other non-OK
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new HttpClientError(
          `${service}: request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText.slice(0, 500)}` : ""}`,
          service,
          response.status,
        );
      }

      const data = (await response.json()) as T;
      return { data, status: response.status, headers: response.headers };
    } catch (error) {
      // AbortError from timeout
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new TimeoutError(service, timeoutMs);
      }
      // Re-throw our structured errors
      if (error instanceof HttpClientError) {
        throw error;
      }
      // Network errors — retry
      if (attempt < maxRetries) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw lastError ?? new HttpClientError(`${service}: all retries exhausted`, service);
}

/**
 * Fetch text (non-JSON) from a URL with the same timeout/retry behavior.
 */
export async function fetchText(
  url: string,
  options: Omit<FetchJsonOptions, "body">,
): Promise<{ text: string; status: number; headers: Headers }> {
  const {
    service,
    timeoutMs = 15_000,
    maxRetries = 2,
    headers: extraHeaders,
    method = "GET",
    signal: callerSignal,
  } = options;

  const response = await fetch(url, {
    method,
    headers: extraHeaders,
    signal: callerSignal ?? AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AuthError(service, response.status);
    }
    if (response.status === 429) {
      throw new RateLimitError(service);
    }
    throw new HttpClientError(
      `${service}: request failed (${response.status})`,
      service,
      response.status,
    );
  }

  const text = await response.text();
  return { text, status: response.status, headers: response.headers };
}
