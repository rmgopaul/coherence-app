/**
 * Phase E (2026-04-28) — tests for the meter-read probe helpers.
 */
import { describe, expect, it } from "vitest";
import {
  formatProbeLatency,
  summarizeProbeResult,
  trimProbeErrorMessage,
} from "./meterReadProbe";

describe("formatProbeLatency", () => {
  it("formats sub-second durations in milliseconds", () => {
    expect(formatProbeLatency(0)).toBe("0ms");
    expect(formatProbeLatency(312)).toBe("312ms");
    expect(formatProbeLatency(999)).toBe("999ms");
  });

  it("formats second-scale durations to one decimal", () => {
    expect(formatProbeLatency(1_000)).toBe("1.0s");
    expect(formatProbeLatency(1_245)).toBe("1.2s");
    expect(formatProbeLatency(12_500)).toBe("12.5s");
  });

  it("rounds milliseconds to the nearest integer", () => {
    expect(formatProbeLatency(123.6)).toBe("124ms");
    expect(formatProbeLatency(123.4)).toBe("123ms");
  });

  it("handles invalid inputs gracefully", () => {
    expect(formatProbeLatency(Number.NaN)).toBe("—");
    expect(formatProbeLatency(-1)).toBe("—");
    expect(formatProbeLatency(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("trimProbeErrorMessage", () => {
  it("strips the TRPCClientError prefix", () => {
    expect(trimProbeErrorMessage("TRPCClientError: 401 Unauthorized")).toBe(
      "401 Unauthorized"
    );
  });

  it("strips a generic Error: prefix", () => {
    expect(trimProbeErrorMessage("Error: connection refused")).toBe(
      "connection refused"
    );
  });

  it("keeps only the first line of a multi-line message", () => {
    expect(
      trimProbeErrorMessage("First problem\n  at someStack:42\n  at more")
    ).toBe("First problem");
  });

  it("returns 'Unknown error' for empty / whitespace input", () => {
    expect(trimProbeErrorMessage("")).toBe("Unknown error");
    expect(trimProbeErrorMessage("   ")).toBe("Unknown error");
    expect(trimProbeErrorMessage(null)).toBe("Unknown error");
    expect(trimProbeErrorMessage(undefined)).toBe("Unknown error");
  });

  it("accepts an Error instance", () => {
    expect(trimProbeErrorMessage(new Error("ETIMEDOUT"))).toBe("ETIMEDOUT");
  });

  it("accepts an object with a `.message` field", () => {
    expect(trimProbeErrorMessage({ message: "vendor 503" })).toBe("vendor 503");
  });

  it("clips messages longer than 160 chars with an ellipsis", () => {
    const long = "a".repeat(200);
    const trimmed = trimProbeErrorMessage(long);
    expect(trimmed.length).toBe(160);
    expect(trimmed.endsWith("…")).toBe(true);
  });
});

describe("summarizeProbeResult", () => {
  it("formats a happy result with sample count", () => {
    expect(
      summarizeProbeResult({ ok: true, latencyMs: 312, sampleCount: 7 })
    ).toBe("Connected — 7 systems · 312ms");
  });

  it("singularizes the sample noun for a count of 1", () => {
    expect(
      summarizeProbeResult({ ok: true, latencyMs: 312, sampleCount: 1 })
    ).toBe("Connected — 1 system · 312ms");
  });

  it("uses a custom sample noun when provided", () => {
    expect(
      summarizeProbeResult(
        { ok: true, latencyMs: 100, sampleCount: 4 },
        { sampleNoun: "sites" }
      )
    ).toBe("Connected — 4 sites · 100ms");
    expect(
      summarizeProbeResult(
        { ok: true, latencyMs: 100, sampleCount: 1 },
        { sampleNoun: "sites" }
      )
    ).toBe("Connected — 1 site · 100ms");
  });

  it("omits the sample-count clause when the field is missing", () => {
    expect(summarizeProbeResult({ ok: true, latencyMs: 245 })).toBe(
      "Connected · 245ms"
    );
  });

  it("formats a failure with the trimmed error message", () => {
    expect(
      summarizeProbeResult({
        ok: false,
        latencyMs: 1_234,
        error: "TRPCClientError: 401 Unauthorized",
      })
    ).toBe("Failed: 401 Unauthorized · 1.2s");
  });

  it("omits the latency clause when the probe didn't run", () => {
    expect(
      summarizeProbeResult({
        ok: false,
        latencyMs: 0,
        error: "Not connected",
      })
    ).toBe("Failed: Not connected");
  });

  it("falls back to 'Unknown error' when error is missing", () => {
    expect(
      summarizeProbeResult({ ok: false, latencyMs: 100 })
    ).toBe("Failed: Unknown error · 100ms");
  });

  it("handles plural irregulars for 'queries' → 'query'", () => {
    expect(
      summarizeProbeResult(
        { ok: true, latencyMs: 50, sampleCount: 1 },
        { sampleNoun: "queries" }
      )
    ).toBe("Connected — 1 query · 50ms");
  });
});
