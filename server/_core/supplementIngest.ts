import crypto from "crypto";
import type { Request } from "express";

export const SUPPLEMENT_INGEST_SIGNATURE_HEADER = "x-solar-signature";
export const SUPPLEMENT_INGEST_TIMESTAMP_HEADER = "x-solar-timestamp";
export const SUPPLEMENT_INGEST_NONCE_HEADER = "x-solar-nonce";

const SIGNATURE_PREFIX = "sha256=";
const MIN_SECRET_LENGTH = 24;
const NONCE_REGEX = /^[A-Za-z0-9_-]{16,120}$/;
const SIGNATURE_REGEX = /^[a-f0-9]{64}$/i;
const ALLOWED_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_CAPTURED_AGE_MS = 45 * 24 * 60 * 60 * 1000;
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

const seenNonces = new Map<string, number>();

export type SupplementIngestSigningInput = {
  customerEmail: string;
  base64Data: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  timing?: "am" | "pm";
  autoLogPrice?: boolean;
  capturedAt: string;
};

export type SupplementIngestSigningPayload = {
  customerEmail: string;
  base64Data: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  timing: "am" | "pm" | null;
  autoLogPrice: boolean;
  capturedAt: string;
};

function getSecret(): string {
  const secret = (process.env.SOLAR_READINGS_INGEST_SECRET ?? "").trim();
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `SOLAR_READINGS_INGEST_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters.`
    );
  }
  return secret;
}

function readHeader(req: Request, headerName: string): string | null {
  const value = req.headers[headerName];
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.trim().length > 0
      ? first.trim()
      : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalTiming(value: string | undefined): "am" | "pm" | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "am" || trimmed === "pm") return trimmed;
  return null;
}

function normalizeSignature(value: string): string {
  if (value.toLowerCase().startsWith(SIGNATURE_PREFIX)) {
    return value.slice(SIGNATURE_PREFIX.length);
  }
  return value;
}

function cleanupExpiredNonces(nowMs: number): void {
  seenNonces.forEach((expiresAt, nonce) => {
    if (expiresAt <= nowMs) {
      seenNonces.delete(nonce);
    }
  });
}

function rememberNonce(nonce: string, nowMs: number): void {
  seenNonces.set(nonce, nowMs + REPLAY_WINDOW_MS);
}

function hasReplayNonce(nonce: string, nowMs: number): boolean {
  const expiresAt = seenNonces.get(nonce);
  if (!expiresAt) return false;
  if (expiresAt <= nowMs) {
    seenNonces.delete(nonce);
    return false;
  }
  return true;
}

function secureHexEquals(leftHex: string, rightHex: string): boolean {
  if (!SIGNATURE_REGEX.test(leftHex)) return false;
  if (!SIGNATURE_REGEX.test(rightHex)) return false;
  const left = Buffer.from(leftHex.toLowerCase(), "utf8");
  const right = Buffer.from(rightHex.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function assertCapturedAtWithinBounds(capturedAt: Date, nowMs: number): void {
  const capturedAtMs = capturedAt.getTime();
  if (!Number.isFinite(capturedAtMs)) {
    throw new Error("Invalid capturedAt timestamp.");
  }
  if (capturedAtMs > nowMs + ALLOWED_FUTURE_SKEW_MS) {
    throw new Error("capturedAt is too far in the future.");
  }
  if (capturedAtMs < nowMs - MAX_CAPTURED_AGE_MS) {
    throw new Error("capturedAt is too old.");
  }
}

export function normalizeSupplementIngestSigningPayload(
  input: SupplementIngestSigningInput
): SupplementIngestSigningPayload {
  return {
    customerEmail: input.customerEmail.trim().toLowerCase(),
    base64Data: input.base64Data,
    contentType: input.contentType,
    timing: normalizeOptionalTiming(input.timing),
    autoLogPrice: input.autoLogPrice ?? true,
    capturedAt: input.capturedAt.trim(),
  };
}

export function buildSupplementIngestSigningMessage(
  payload: SupplementIngestSigningPayload,
  timestampMs: number,
  nonce: string
): string {
  return `${timestampMs}.${nonce}.${JSON.stringify(payload)}`;
}

export function computeSupplementIngestSignature(
  payload: SupplementIngestSigningPayload,
  timestampMs: number,
  nonce: string,
  secret: string
): string {
  const message = buildSupplementIngestSigningMessage(payload, timestampMs, nonce);
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export function verifySupplementIngestSignedRequest(options: {
  req: Request;
  input: SupplementIngestSigningInput;
}): {
  payload: SupplementIngestSigningPayload;
  capturedAt: Date;
  timestampMs: number;
  nonce: string;
} {
  const nowMs = Date.now();
  cleanupExpiredNonces(nowMs);

  const timestampRaw = readHeader(options.req, SUPPLEMENT_INGEST_TIMESTAMP_HEADER);
  if (!timestampRaw) {
    throw new Error(`${SUPPLEMENT_INGEST_TIMESTAMP_HEADER} header is required.`);
  }
  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`${SUPPLEMENT_INGEST_TIMESTAMP_HEADER} must be a unix millisecond timestamp.`);
  }

  const skewMs = Math.abs(nowMs - timestampMs);
  if (skewMs > REPLAY_WINDOW_MS) {
    throw new Error("Request timestamp is outside the allowed replay window.");
  }

  const nonce = readHeader(options.req, SUPPLEMENT_INGEST_NONCE_HEADER);
  if (!nonce) {
    throw new Error(`${SUPPLEMENT_INGEST_NONCE_HEADER} header is required.`);
  }
  if (!NONCE_REGEX.test(nonce)) {
    throw new Error(`${SUPPLEMENT_INGEST_NONCE_HEADER} must be 16-120 URL-safe characters.`);
  }
  if (hasReplayNonce(nonce, nowMs)) {
    throw new Error("Duplicate request nonce detected.");
  }

  const providedSignatureRaw = readHeader(options.req, SUPPLEMENT_INGEST_SIGNATURE_HEADER);
  if (!providedSignatureRaw) {
    throw new Error(`${SUPPLEMENT_INGEST_SIGNATURE_HEADER} header is required.`);
  }
  const providedSignature = normalizeSignature(providedSignatureRaw);

  const payload = normalizeSupplementIngestSigningPayload(options.input);
  const expectedSignature = computeSupplementIngestSignature(
    payload,
    timestampMs,
    nonce,
    getSecret()
  );

  if (!secureHexEquals(providedSignature, expectedSignature)) {
    throw new Error("Invalid request signature.");
  }

  const capturedAt = new Date(payload.capturedAt);
  assertCapturedAtWithinBounds(capturedAt, nowMs);
  rememberNonce(nonce, nowMs);

  return { payload, capturedAt, timestampMs, nonce };
}

export function resetSupplementIngestNonceCacheForTests(): void {
  seenNonces.clear();
}

