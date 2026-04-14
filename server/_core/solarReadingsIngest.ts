import crypto from "crypto";
import type { Request } from "express";
import { createNonceTracker } from "./nonceTracker";

export const SOLAR_READINGS_SIGNATURE_HEADER = "x-solar-signature";
export const SOLAR_READINGS_TIMESTAMP_HEADER = "x-solar-timestamp";
export const SOLAR_READINGS_NONCE_HEADER = "x-solar-nonce";

const SOLAR_READINGS_SIGNATURE_PREFIX = "sha256=";
const SOLAR_READINGS_MIN_SECRET_LENGTH = 24;
const SOLAR_READINGS_NONCE_REGEX = /^[A-Za-z0-9_-]{16,120}$/;
const SOLAR_READINGS_SIGNATURE_REGEX = /^[a-f0-9]{64}$/i;
const SOLAR_READINGS_ALLOWED_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SOLAR_READINGS_MAX_READING_AGE_MS = 45 * 24 * 60 * 60 * 1000;

export const SOLAR_READINGS_REPLAY_WINDOW_MS = 5 * 60 * 1000;

const nonceTracker = createNonceTracker(SOLAR_READINGS_REPLAY_WINDOW_MS);

export type SolarReadingsSigningInput = {
  customerEmail: string;
  nonId?: string;
  lifetimeKwh: number;
  meterSerial?: string;
  firmwareVersion?: string;
  pvsSerial5?: string;
  readAt: string;
};

export type SolarReadingsSigningPayload = {
  customerEmail: string;
  nonId: string | null;
  lifetimeKwh: number;
  meterSerial: string | null;
  firmwareVersion: string | null;
  pvsSerial5: string | null;
  readAt: string;
};

function getSolarReadingsSecret(): string {
  const secret = (process.env.SOLAR_READINGS_INGEST_SECRET ?? "").trim();
  if (secret.length < SOLAR_READINGS_MIN_SECRET_LENGTH) {
    throw new Error(
      `SOLAR_READINGS_INGEST_SECRET must be set and at least ${SOLAR_READINGS_MIN_SECRET_LENGTH} characters.`
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

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}


function normalizeProvidedSignature(value: string): string {
  if (value.toLowerCase().startsWith(SOLAR_READINGS_SIGNATURE_PREFIX)) {
    return value.slice(SOLAR_READINGS_SIGNATURE_PREFIX.length);
  }
  return value;
}

function secureHexEquals(leftHex: string, rightHex: string): boolean {
  if (!SOLAR_READINGS_SIGNATURE_REGEX.test(leftHex)) return false;
  if (!SOLAR_READINGS_SIGNATURE_REGEX.test(rightHex)) return false;
  const left = Buffer.from(leftHex.toLowerCase(), "utf8");
  const right = Buffer.from(rightHex.toLowerCase(), "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function assertReadAtWithinBounds(readAt: Date, nowMs: number): void {
  const readAtMs = readAt.getTime();
  if (!Number.isFinite(readAtMs)) {
    throw new Error("Invalid readAt timestamp.");
  }
  if (readAtMs > nowMs + SOLAR_READINGS_ALLOWED_FUTURE_SKEW_MS) {
    throw new Error("readAt is too far in the future.");
  }
  if (readAtMs < nowMs - SOLAR_READINGS_MAX_READING_AGE_MS) {
    throw new Error("readAt is too old.");
  }
}

export function normalizeSolarReadingsSigningPayload(
  input: SolarReadingsSigningInput
): SolarReadingsSigningPayload {
  return {
    customerEmail: input.customerEmail.trim().toLowerCase(),
    nonId: normalizeOptionalString(input.nonId),
    lifetimeKwh: input.lifetimeKwh,
    meterSerial: normalizeOptionalString(input.meterSerial),
    firmwareVersion: normalizeOptionalString(input.firmwareVersion),
    pvsSerial5: normalizeOptionalString(input.pvsSerial5),
    readAt: input.readAt.trim(),
  };
}

export function buildSolarReadingsSigningMessage(
  payload: SolarReadingsSigningPayload,
  timestampMs: number,
  nonce: string
): string {
  return `${timestampMs}.${nonce}.${JSON.stringify(payload)}`;
}

export function computeSolarReadingsSignature(
  payload: SolarReadingsSigningPayload,
  timestampMs: number,
  nonce: string,
  secret: string
): string {
  const message = buildSolarReadingsSigningMessage(payload, timestampMs, nonce);
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export function verifySolarReadingsSignedRequest(options: {
  req: Request;
  input: SolarReadingsSigningInput;
}): {
  payload: SolarReadingsSigningPayload;
  readAt: Date;
  timestampMs: number;
  nonce: string;
} {
  const nowMs = Date.now();
  nonceTracker.cleanup(nowMs);

  const timestampRaw = readHeader(options.req, SOLAR_READINGS_TIMESTAMP_HEADER);
  if (!timestampRaw) {
    throw new Error(`${SOLAR_READINGS_TIMESTAMP_HEADER} header is required.`);
  }

  const timestampMs = Number(timestampRaw);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`${SOLAR_READINGS_TIMESTAMP_HEADER} must be a unix millisecond timestamp.`);
  }

  const skewMs = Math.abs(nowMs - timestampMs);
  if (skewMs > SOLAR_READINGS_REPLAY_WINDOW_MS) {
    throw new Error("Request timestamp is outside the allowed replay window.");
  }

  const nonce = readHeader(options.req, SOLAR_READINGS_NONCE_HEADER);
  if (!nonce) {
    throw new Error(`${SOLAR_READINGS_NONCE_HEADER} header is required.`);
  }
  if (!SOLAR_READINGS_NONCE_REGEX.test(nonce)) {
    throw new Error(`${SOLAR_READINGS_NONCE_HEADER} must be 16-120 URL-safe characters.`);
  }
  if (nonceTracker.hasReplay(nonce, nowMs)) {
    throw new Error("Duplicate request nonce detected.");
  }

  const providedSignatureRaw = readHeader(
    options.req,
    SOLAR_READINGS_SIGNATURE_HEADER
  );
  if (!providedSignatureRaw) {
    throw new Error(`${SOLAR_READINGS_SIGNATURE_HEADER} header is required.`);
  }
  const providedSignature = normalizeProvidedSignature(providedSignatureRaw);

  const payload = normalizeSolarReadingsSigningPayload(options.input);
  const secret = getSolarReadingsSecret();
  const expectedSignature = computeSolarReadingsSignature(
    payload,
    timestampMs,
    nonce,
    secret
  );

  if (!secureHexEquals(providedSignature, expectedSignature)) {
    throw new Error("Invalid request signature.");
  }

  const readAt = new Date(payload.readAt);
  assertReadAtWithinBounds(readAt, nowMs);
  nonceTracker.remember(nonce, nowMs);

  return { payload, readAt, timestampMs, nonce };
}

export function resetSolarReadingsNonceCacheForTests(): void {
  nonceTracker.reset();
}
