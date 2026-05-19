import { describe, expect, it } from "vitest";
import {
  buildSamsungMetadata,
  pickScoreWithPayloadPrecedence,
} from "./oauth-routes";

describe("pickScoreWithPayloadPrecedence (precedence B — SDK payload wins)", () => {
  it("uses the payload score when it is a real positive value", () => {
    expect(pickScoreWithPayloadPrecedence(84, 70)).toBe(84);
    expect(pickScoreWithPayloadPrecedence(84, null)).toBe(84);
    expect(pickScoreWithPayloadPrecedence(1, 99)).toBe(1);
    expect(pickScoreWithPayloadPrecedence(100, 50)).toBe(100);
  });

  it("falls back to the manual score when the payload score is absent (null / 0 / negative)", () => {
    // 0 is the Android model default for an unmeasured day — must
    // NOT clobber a real manual entry.
    expect(pickScoreWithPayloadPrecedence(0, 70)).toBe(70);
    expect(pickScoreWithPayloadPrecedence(null, 70)).toBe(70);
    expect(pickScoreWithPayloadPrecedence(-5, 70)).toBe(70);
  });

  it("returns null when neither side has a usable score", () => {
    expect(pickScoreWithPayloadPrecedence(0, null)).toBeNull();
    expect(pickScoreWithPayloadPrecedence(null, null)).toBeNull();
    expect(pickScoreWithPayloadPrecedence(0, 0)).toBe(0); // manual 0 is an explicit (clamped) manual value, kept
  });
});

describe("buildSamsungMetadata — SDK payload scores flow into the summary", () => {
  const RECEIVED_AT = "2026-05-19T12:00:00.000Z";

  const payloadWith = (
    sleepScore: number | undefined,
    energyScore: number | undefined,
  ) => ({
    date: "2026-05-18",
    capturedAtIso: "2026-05-19T06:00:00.000Z",
    timezone: "America/Chicago",
    source: { provider: "samsung-health-data-sdk" },
    activity: { steps: 8000 },
    sleep:
      sleepScore === undefined
        ? { totalSleepMinutes: 430 }
        : { totalSleepMinutes: 430, sleepScore },
    cardio:
      energyScore === undefined
        ? { restingHeartRateBpm: 52 }
        : { restingHeartRateBpm: 52, energyScore },
  });

  const summaryOf = (metadataJson: string) =>
    JSON.parse(metadataJson).summary as Record<string, unknown>;

  it("SDK payload score WINS over a manual entry (precedence B)", () => {
    const meta = buildSamsungMetadata(payloadWith(88, 73), RECEIVED_AT, {
      sleepScore: 60,
      energyScore: 40,
    });
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBe(88);
    expect(summary.energyScore).toBe(73);
  });

  it("falls back to the manual entry when the payload sends the 0.0 Android default", () => {
    // Android `SamsungHealthPayload` defaults both fields to 0.0;
    // an unmeasured day arrives as 0, which must not overwrite a
    // real manual score.
    const meta = buildSamsungMetadata(payloadWith(0, 0), RECEIVED_AT, {
      sleepScore: 60,
      energyScore: 40,
    });
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBe(60);
    expect(summary.energyScore).toBe(40);
  });

  it("uses the SDK score with no manual entry present", () => {
    const meta = buildSamsungMetadata(payloadWith(91, 66), RECEIVED_AT, null);
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBe(91);
    expect(summary.energyScore).toBe(66);
  });

  it("is null when neither the payload nor a manual entry has a score", () => {
    const meta = buildSamsungMetadata(payloadWith(0, undefined), RECEIVED_AT, null);
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBeNull();
    expect(summary.energyScore).toBeNull();
  });

  it("clamps an out-of-range SDK payload score to 0-100 (same as the manual path)", () => {
    const meta = buildSamsungMetadata(payloadWith(150, 250), RECEIVED_AT, null);
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBe(100);
    expect(summary.energyScore).toBe(100);
  });

  it("preservePreviousIfDegraded still backfills score from previous when the incoming is absent", () => {
    const meta = buildSamsungMetadata(payloadWith(0, 0), RECEIVED_AT, null, {
      preservePreviousIfDegraded: true,
      previousSummary: { sleepScore: 77, energyScore: 55 },
    });
    const summary = summaryOf(meta);
    // payload 0 → manual null → summary null → degraded block
    // backfills from previousSummary (incoming <= 0 is "missing").
    expect(summary.sleepScore).toBe(77);
    expect(summary.energyScore).toBe(55);
  });
});
