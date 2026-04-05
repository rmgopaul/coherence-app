import { describe, it, expect, beforeEach } from "vitest";
import type { Request } from "express";
import {
  computeSolarReadingsSignature,
  normalizeSolarReadingsSigningPayload,
  resetSolarReadingsNonceCacheForTests,
  SOLAR_READINGS_NONCE_HEADER,
  SOLAR_READINGS_REPLAY_WINDOW_MS,
  SOLAR_READINGS_SIGNATURE_HEADER,
  SOLAR_READINGS_TIMESTAMP_HEADER,
  verifySolarReadingsSignedRequest,
  type SolarReadingsSigningInput,
} from "./_core/solarReadingsIngest";

function buildSignedRequest(options: {
  input: SolarReadingsSigningInput;
  timestampMs: number;
  nonce: string;
  secret: string;
}): Request {
  const payload = normalizeSolarReadingsSigningPayload(options.input);
  const signature = computeSolarReadingsSignature(
    payload,
    options.timestampMs,
    options.nonce,
    options.secret
  );

  return {
    headers: {
      [SOLAR_READINGS_SIGNATURE_HEADER]: signature,
      [SOLAR_READINGS_TIMESTAMP_HEADER]: String(options.timestampMs),
      [SOLAR_READINGS_NONCE_HEADER]: options.nonce,
    },
  } as Request;
}

describe("solar readings ingest signature verification", () => {
  beforeEach(() => {
    process.env.SOLAR_READINGS_INGEST_SECRET = "test-secret-with-at-least-24-characters";
    resetSolarReadingsNonceCacheForTests();
  });

  it("accepts a valid signed request", () => {
    const input: SolarReadingsSigningInput = {
      customerEmail: "Owner@Example.com",
      nonId: " NON-123 ",
      lifetimeKwh: 12345.67,
      meterSerial: "METER-1",
      firmwareVersion: "v1.2.3",
      pvsSerial5: "A1B2C",
      readAt: new Date(Date.now() - 30_000).toISOString(),
    };
    const timestampMs = Date.now();
    const req = buildSignedRequest({
      input,
      timestampMs,
      nonce: "valid_nonce_1234567890",
      secret: process.env.SOLAR_READINGS_INGEST_SECRET!,
    });

    const verified = verifySolarReadingsSignedRequest({ req, input });

    expect(verified.payload.customerEmail).toBe("owner@example.com");
    expect(verified.payload.nonId).toBe("NON-123");
    expect(verified.readAt.toISOString()).toBe(input.readAt);
  });

  it("rejects replayed nonce values inside the replay window", () => {
    const input: SolarReadingsSigningInput = {
      customerEmail: "owner@example.com",
      lifetimeKwh: 1,
      readAt: new Date(Date.now() - 30_000).toISOString(),
    };
    const timestampMs = Date.now();
    const nonce = "replay_nonce_1234567890";
    const req = buildSignedRequest({
      input,
      timestampMs,
      nonce,
      secret: process.env.SOLAR_READINGS_INGEST_SECRET!,
    });

    verifySolarReadingsSignedRequest({ req, input });
    expect(() => verifySolarReadingsSignedRequest({ req, input })).toThrow(
      "Duplicate request nonce detected."
    );
  });

  it("rejects requests with stale timestamps", () => {
    const input: SolarReadingsSigningInput = {
      customerEmail: "owner@example.com",
      lifetimeKwh: 1,
      readAt: new Date(Date.now() - 30_000).toISOString(),
    };
    const staleTimestamp = Date.now() - SOLAR_READINGS_REPLAY_WINDOW_MS - 1;
    const req = buildSignedRequest({
      input,
      timestampMs: staleTimestamp,
      nonce: "stale_nonce_1234567890",
      secret: process.env.SOLAR_READINGS_INGEST_SECRET!,
    });

    expect(() => verifySolarReadingsSignedRequest({ req, input })).toThrow(
      "Request timestamp is outside the allowed replay window."
    );
  });

  it("rejects requests with readAt far in the future", () => {
    const input: SolarReadingsSigningInput = {
      customerEmail: "owner@example.com",
      lifetimeKwh: 1,
      readAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };
    const req = buildSignedRequest({
      input,
      timestampMs: Date.now(),
      nonce: "future_nonce_1234567890",
      secret: process.env.SOLAR_READINGS_INGEST_SECRET!,
    });

    expect(() => verifySolarReadingsSignedRequest({ req, input })).toThrow(
      "readAt is too far in the future."
    );
  });
});
