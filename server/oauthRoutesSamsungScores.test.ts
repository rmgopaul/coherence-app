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

describe("buildSamsungMetadata — scores-only SDK source must not clobber Health Connect data", () => {
  const RECEIVED_AT = "2026-05-19T12:00:00.000Z";

  // The real Samsung Health Data SDK companion payload: source
  // tagged, the two scores present, and EVERYTHING else empty/0
  // (the Android model defaults steps/sleep-minutes/spo2 to 0).
  const scoresOnlyPayload = {
    date: "2026-05-19",
    capturedAtIso: "2026-05-19T13:47:00.000Z",
    timezone: "America/Chicago",
    source: { provider: "samsung-health-data-sdk" },
    activity: { steps: 0 },
    sleep: { totalSleepMinutes: 0, sleepScore: 0 },
    cardio: { energyScore: 91 },
  };

  // What the Health Connect companion wrote earlier the same day.
  const richPreviousSummary = {
    date: "2026-05-19",
    steps: 9214,
    sleepTotalMinutes: 437,
    spo2AvgPercent: 96,
    restingHeartRateBpm: 51,
    sleepScore: 0,
    energyScore: 0,
  };

  const summaryOf = (metadataJson: string) =>
    JSON.parse(metadataJson).summary as Record<string, unknown>;

  it("preserves HC steps/sleep/spo2 while still writing the SDK Energy Score", () => {
    const meta = buildSamsungMetadata(scoresOnlyPayload, RECEIVED_AT, null, {
      previousSummary: richPreviousSummary,
      scoresOnlySource: true,
    });
    const summary = summaryOf(meta);
    // Rich fields the SDK companion does NOT read → preserved.
    expect(summary.steps).toBe(9214);
    expect(summary.sleepTotalMinutes).toBe(437);
    expect(summary.spo2AvgPercent).toBe(96);
    expect(summary.restingHeartRateBpm).toBe(51);
    // The score the SDK companion DID read → applied (not preserved).
    expect(summary.energyScore).toBe(91);
  });

  it("preserves the HC Sleep Score (78.3) when the SDK Sleep read is empty, while Energy 91 still wins", () => {
    // The exact 2026-05-19 report: webapp showed Sleep Score 78.3
    // (Health Connect companion); the SDK sync's empty Sleep read
    // must NOT overwrite it to null/N/A, but the SDK's real Energy
    // Score (91) must still replace the stale 0.
    const meta = buildSamsungMetadata(
      scoresOnlyPayload,
      RECEIVED_AT,
      null,
      {
        previousSummary: { ...richPreviousSummary, sleepScore: 78.3 },
        scoresOnlySource: true,
      },
    );
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBe(78.3); // preserved, not clobbered
    expect(summary.energyScore).toBe(91); // real SDK score wins
  });

  it("without the scoresOnlySource flag the empty payload still overwrites (gate is load-bearing)", () => {
    const meta = buildSamsungMetadata(scoresOnlyPayload, RECEIVED_AT, null, {
      previousSummary: richPreviousSummary,
      // scoresOnlySource omitted → legacy behaviour, no preserve.
    });
    const summary = summaryOf(meta);
    expect(summary.steps).toBe(0);
    // payload sends totalSleepMinutes:0 → asNumber(0)=0 (the
    // clobber: HC's 437 is gone without the gate).
    expect(summary.sleepTotalMinutes).toBe(0);
    expect(summary.energyScore).toBe(91);
  });

  it("composes with preservePreviousIfDegraded: a degraded scores-only payload preserves both subsets idempotently", () => {
    // Locks the two-block interaction: preservePreviousIfDegraded
    // (subset) runs first, then scoresOnlySource (superset). Both
    // use the same idempotent predicate; the second must not undo
    // or double-apply the first.
    const meta = buildSamsungMetadata(scoresOnlyPayload, RECEIVED_AT, null, {
      previousSummary: {
        ...richPreviousSummary,
        sleepScore: 80,
        steps: 9000,
      },
      preservePreviousIfDegraded: true,
      scoresOnlySource: true,
    });
    const summary = summaryOf(meta);
    expect(summary.sleepScore).toBe(80); // preserved by both blocks, consistently
    expect(summary.steps).toBe(9000); // only scoresOnly covers steps
    expect(summary.energyScore).toBe(91); // real SDK score still wins
  });

  it("scoresOnlySource with no previousSummary is a no-op (no crash, scores still flow)", () => {
    const meta = buildSamsungMetadata(scoresOnlyPayload, RECEIVED_AT, null, {
      scoresOnlySource: true,
    });
    const summary = summaryOf(meta);
    expect(summary.energyScore).toBe(91);
    expect(summary.steps).toBe(0);
  });
});
