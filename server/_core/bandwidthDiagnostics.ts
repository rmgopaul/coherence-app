import type { NextFunction, Request, Response } from "express";

const DEFAULT_THRESHOLD_BYTES = 5 * 1024 * 1024;
const INSTALLED_FETCH_WRAPPER = Symbol.for(
  "coherence.bandwidthDiagnostics.fetchWrapperInstalled"
);

function isDiagnosticsDisabled(): boolean {
  return process.env.BANDWIDTH_DIAGNOSTICS_DISABLED === "1";
}

export function getBandwidthLogThresholdBytes(): number {
  const raw = process.env.BANDWIDTH_LOG_THRESHOLD_BYTES?.trim();
  if (!raw) return DEFAULT_THRESHOLD_BYTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_THRESHOLD_BYTES;
  return Math.floor(parsed);
}

function byteLengthOfChunk(chunk: unknown): number {
  if (!chunk) return 0;
  if (typeof chunk === "string") return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (chunk instanceof Uint8Array) return chunk.byteLength;
  return 0;
}

function byteLengthOfBody(body: BodyInit | null | undefined): number | null {
  if (!body) return 0;
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof URLSearchParams) return Buffer.byteLength(String(body));
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  return null;
}

function numberHeader(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?")[0] ?? value;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestMethod(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof input === "object" && "method" in input) {
    return input.method.toUpperCase();
  }
  return "GET";
}

function logBandwidthEvent(
  label: string,
  payload: Record<string, unknown>
): void {
  console.warn(`[bandwidth:${label}] ${JSON.stringify(payload)}`);
}

export function largeResponseLogger() {
  const thresholdBytes = getBandwidthLogThresholdBytes();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (isDiagnosticsDisabled()) {
      next();
      return;
    }

    const startedAt = Date.now();
    let writtenBytes = 0;
    const originalWrite = res.write.bind(res) as Response["write"];
    const originalEnd = res.end.bind(res) as Response["end"];

    res.write = ((chunk: unknown, ...args: unknown[]) => {
      writtenBytes += byteLengthOfChunk(chunk);
      return originalWrite(chunk as never, ...(args as never[]));
    }) as Response["write"];

    res.end = ((chunk?: unknown, ...args: unknown[]) => {
      writtenBytes += byteLengthOfChunk(chunk);
      return originalEnd(chunk as never, ...(args as never[]));
    }) as Response["end"];

    res.on("finish", () => {
      const contentLength = numberHeader(res.getHeader("content-length"));
      const bytes = Math.max(writtenBytes, contentLength ?? 0);
      if (bytes < thresholdBytes) return;

      logBandwidthEvent("http-large-response", {
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        bytes,
        contentLength,
        durationMs: Date.now() - startedAt,
        contentType: res.getHeader("content-type") ?? null,
      });
    });

    next();
  };
}

export function installFetchBandwidthDiagnostics(): void {
  if (isDiagnosticsDisabled()) return;

  const globalWithMarker = globalThis as typeof globalThis & {
    [INSTALLED_FETCH_WRAPPER]?: boolean;
  };
  if (globalWithMarker[INSTALLED_FETCH_WRAPPER]) return;

  const thresholdBytes = getBandwidthLogThresholdBytes();
  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input, init) => {
    const startedAt = Date.now();
    const method = requestMethod(input, init);
    const url = redactUrl(requestUrl(input));
    const requestBytes = byteLengthOfBody(init?.body ?? null);

    const response = await originalFetch(input, init);
    const responseBytes = numberHeader(response.headers.get("content-length"));
    const loggedRequestBytes =
      requestBytes !== null && requestBytes >= thresholdBytes;
    const loggedResponseBytes =
      responseBytes !== null && responseBytes >= thresholdBytes;

    if (loggedRequestBytes || loggedResponseBytes) {
      logBandwidthEvent("service-fetch", {
        method,
        url,
        status: response.status,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startedAt,
        contentType: response.headers.get("content-type"),
      });
    }

    return response;
  }) as typeof fetch;

  globalWithMarker[INSTALLED_FETCH_WRAPPER] = true;
}
