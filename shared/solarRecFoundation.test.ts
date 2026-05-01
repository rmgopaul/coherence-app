/**
 * Phase 2.1 of the dashboard foundation repair (2026-04-30) —
 * tests for the foundation artifact's type contract + runtime
 * invariants.
 *
 * The Phase 2.2 builder calls `assertFoundationInvariants` before
 * writing the artifact to the cache. Every invariant violation
 * here corresponds to a class of bug that the v3 plan calls out
 * (the 24,275/24,274 off-by-one, the four-different-Reporting-counts
 * cross-tab inconsistency, etc.). The tests are the canonical
 * regression guard.
 */

import { describe, expect, it } from "vitest";
import { DATASET_KEYS, type DatasetKey } from "./datasetUpload.helpers";
import {
  EMPTY_FOUNDATION_ARTIFACT,
  FOUNDATION_ARTIFACT_TYPE,
  FOUNDATION_DEFINITION_VERSION,
  FOUNDATION_RUNNER_VERSION,
  type FoundationArtifactPayload,
  type FoundationCanonicalSystem,
  assertFoundationInvariants,
} from "./solarRecFoundation";

const VALID_HASH =
  "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

/**
 * Build a single canonical system with sensible defaults; tests
 * override only the fields they care about. Avoids re-typing the
 * 22-field shape in every fixture.
 */
function makeSystem(
  overrides: Partial<FoundationCanonicalSystem> & { csgId: string }
): FoundationCanonicalSystem {
  return {
    csgId: overrides.csgId,
    abpIds: overrides.abpIds ?? [],
    sizeKwAc: overrides.sizeKwAc ?? null,
    sizeKwDc: overrides.sizeKwDc ?? null,
    contractValueUsd: overrides.contractValueUsd ?? null,
    isTerminated: overrides.isTerminated ?? false,
    isPart2Verified: overrides.isPart2Verified ?? false,
    isReporting: overrides.isReporting ?? false,
    anchorMonthIso: overrides.anchorMonthIso ?? null,
    contractType: overrides.contractType ?? null,
    ownershipStatus: overrides.ownershipStatus ?? null,
    monitoringPlatform: overrides.monitoringPlatform ?? null,
    gatsId: overrides.gatsId ?? null,
    lastMeterReadDateIso: overrides.lastMeterReadDateIso ?? null,
    lastMeterReadKwh: overrides.lastMeterReadKwh ?? null,
    abpStatus: overrides.abpStatus ?? null,
    part2VerificationDateIso: overrides.part2VerificationDateIso ?? null,
    contractedDateIso: overrides.contractedDateIso ?? null,
    energyYear: overrides.energyYear ?? null,
    integrityWarningCodes: overrides.integrityWarningCodes ?? [],
  };
}

/**
 * Build a minimal valid payload starting from the empty artifact +
 * the supplied systems. Rolls up `summaryCounts` automatically so
 * each test can focus on the one field it wants to break.
 */
function makePayload(
  systems: FoundationCanonicalSystem[],
  overrides: Partial<FoundationArtifactPayload> = {}
): FoundationArtifactPayload {
  const canonicalSystemsByCsgId = Object.fromEntries(
    systems.map((s) => [s.csgId, s])
  );
  const part2EligibleCsgIds = systems
    .filter((s) => s.isPart2Verified && !s.isTerminated)
    .map((s) => s.csgId)
    .sort();
  const reportingCsgIds = systems
    .filter((s) => s.isReporting && !s.isTerminated)
    .map((s) => s.csgId)
    .sort();
  const totalSystems = systems.filter((s) => !s.isTerminated).length;
  const terminated = systems.filter((s) => s.isTerminated).length;

  const inputVersions = Object.fromEntries(
    DATASET_KEYS.map((k) => [k, { batchId: "batch-1", rowCount: 1 }])
  ) as Record<DatasetKey, { batchId: string | null; rowCount: number }>;

  return {
    schemaVersion: 1,
    definitionVersion: FOUNDATION_DEFINITION_VERSION,
    foundationHash: VALID_HASH,
    builtAt: new Date().toISOString(),
    reportingAnchorDateIso: "2026-04-01",
    inputVersions,
    canonicalSystemsByCsgId,
    part2EligibleCsgIds,
    reportingCsgIds,
    summaryCounts: {
      totalSystems,
      terminated,
      part2Verified: part2EligibleCsgIds.length,
      reporting: reportingCsgIds.length,
      part2VerifiedAndReporting: systems.filter(
        (s) => s.isPart2Verified && s.isReporting && !s.isTerminated
      ).length,
    },
    integrityWarnings: [],
    populatedDatasets: ["solarApplications"],
    ...overrides,
  };
}

describe("foundation constants", () => {
  it("exports stable artifact type + runner version + definition version", () => {
    expect(FOUNDATION_ARTIFACT_TYPE).toBe("foundation-v1");
    expect(FOUNDATION_RUNNER_VERSION).toBe("foundation-v1");
    // Phase 2.7 (2026-05-01) bumped to 2 — invalidates v1 cached
    // artifacts that have stale `isReporting: false` everywhere.
    // Phase 2.7 follow-up bumped to 3 — invalidates v2 cached
    // artifacts that pre-date the trackingRef collision warning +
    // first-claim winner fix.
    expect(FOUNDATION_DEFINITION_VERSION).toBe(3);
  });

  it("definition version matches the empty artifact's version", () => {
    expect(EMPTY_FOUNDATION_ARTIFACT.definitionVersion).toBe(
      FOUNDATION_DEFINITION_VERSION
    );
  });
});

describe("EMPTY_FOUNDATION_ARTIFACT", () => {
  it("satisfies every invariant out of the box", () => {
    expect(() => assertFoundationInvariants(EMPTY_FOUNDATION_ARTIFACT)).not.toThrow();
  });

  it("includes every DatasetKey in inputVersions", () => {
    for (const key of DATASET_KEYS) {
      expect(EMPTY_FOUNDATION_ARTIFACT.inputVersions).toHaveProperty(key);
      expect(EMPTY_FOUNDATION_ARTIFACT.inputVersions[key]).toEqual({
        batchId: null,
        rowCount: 0,
      });
    }
  });

  it("is exactly 18 dataset entries — matches the DatasetKey union", () => {
    expect(Object.keys(EMPTY_FOUNDATION_ARTIFACT.inputVersions)).toHaveLength(18);
    expect(DATASET_KEYS.length).toBe(18);
  });

  it("is frozen — accidental mutation throws", () => {
    expect(Object.isFrozen(EMPTY_FOUNDATION_ARTIFACT)).toBe(true);
  });

  it("has zeroed summaryCounts", () => {
    expect(EMPTY_FOUNDATION_ARTIFACT.summaryCounts).toEqual({
      totalSystems: 0,
      terminated: 0,
      part2Verified: 0,
      reporting: 0,
      part2VerifiedAndReporting: 0,
    });
  });
});

describe("assertFoundationInvariants — happy paths", () => {
  it("accepts a non-trivial valid payload", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isPart2Verified: true, isReporting: true }),
      makeSystem({ csgId: "CSG-2", isPart2Verified: true, isReporting: false }),
      makeSystem({ csgId: "CSG-3", isPart2Verified: false, isReporting: true }),
      makeSystem({ csgId: "CSG-4", isTerminated: true }),
    ]);
    expect(() => assertFoundationInvariants(payload)).not.toThrow();

    // Sanity: the sums match.
    expect(payload.summaryCounts.totalSystems).toBe(3);
    expect(payload.summaryCounts.terminated).toBe(1);
    expect(payload.summaryCounts.part2Verified).toBe(2);
    expect(payload.summaryCounts.reporting).toBe(2);
    expect(payload.summaryCounts.part2VerifiedAndReporting).toBe(1);
  });

  it("accepts an artifact with a 64-char lowercase hex hash", () => {
    const payload = makePayload(
      [makeSystem({ csgId: "CSG-1" })],
      { foundationHash: VALID_HASH }
    );
    expect(() => assertFoundationInvariants(payload)).not.toThrow();
  });

  it("accepts an artifact with empty hash (placeholder shape)", () => {
    const payload = makePayload(
      [makeSystem({ csgId: "CSG-1" })],
      { foundationHash: "" }
    );
    expect(() => assertFoundationInvariants(payload)).not.toThrow();
  });
});

describe("assertFoundationInvariants — Part II count violations", () => {
  it("throws when summaryCounts.part2Verified disagrees with part2EligibleCsgIds.length", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isPart2Verified: true }),
      makeSystem({ csgId: "CSG-2", isPart2Verified: true }),
    ]);
    payload.summaryCounts.part2Verified = 3; // lie
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /summaryCounts.part2Verified \(3\) !== part2EligibleCsgIds.length \(2\)/
    );
  });

  it("throws when part2EligibleCsgIds has duplicates", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isPart2Verified: true }),
    ]);
    payload.part2EligibleCsgIds = ["CSG-1", "CSG-1"];
    payload.summaryCounts.part2Verified = 2;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /part2EligibleCsgIds has duplicates: 2 entries → 1 unique/
    );
  });

  it("catches the 24,275/24,274 shape — phantom CSG inflates the map without bumping totalSystems", () => {
    // Reproduce the exact bug shape the user observed during testing:
    // Part II count claims 24,275 systems but the underlying total is
    // 24,274. The mechanism: an extra ABP row mapped to a phantom
    // CSG ID got added to canonicalSystemsByCsgId AND to
    // part2EligibleCsgIds, but the totalSystems counter stayed flat.
    //
    // Under the assertion's diagnostic order, this fires invariant
    // #5 (totalSystems disagrees with non-terminated count in map)
    // BEFORE invariant #11 (numerator > denominator) — invariant #11
    // is a backstop that's unreachable through structural setups.
    // The intent of the test is to verify the buggy shape gets
    // caught, regardless of which structural invariant catches it.
    const systems: FoundationCanonicalSystem[] = [];
    for (let i = 0; i < 24_274; i++) {
      systems.push(makeSystem({ csgId: `CSG-${i}`, isPart2Verified: true }));
    }
    const payload = makePayload(systems);
    expect(payload.summaryCounts.totalSystems).toBe(24_274);
    expect(payload.summaryCounts.part2Verified).toBe(24_274);

    // Add a phantom CSG to the map AND to part2EligibleCsgIds, mirror
    // the part2Verified count to preserve invariant #3, but leave
    // totalSystems pinned at 24,274. The map now has 24,275 entries;
    // the structural check fires.
    payload.canonicalSystemsByCsgId["CSG-PHANTOM"] = makeSystem({
      csgId: "CSG-PHANTOM",
      isPart2Verified: true,
    });
    payload.part2EligibleCsgIds = [...payload.part2EligibleCsgIds, "CSG-PHANTOM"];
    payload.summaryCounts.part2Verified = 24_275;

    expect(() => assertFoundationInvariants(payload)).toThrow(
      /summaryCounts.totalSystems \(24274\) !== non-terminated count in map \(24275\)/
    );
  });

  it("throws when part2EligibleCsgIds references a missing CSG", () => {
    // Reordered invariants (#9 — part2 CSG must exist in map) catch
    // this with a specific error message rather than the generic
    // numerator-vs-denominator backstop.
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isPart2Verified: true }),
    ]);
    payload.part2EligibleCsgIds = ["CSG-1", "CSG-MISSING"];
    payload.summaryCounts.part2Verified = 2;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /part2EligibleCsgIds contains "CSG-MISSING" but it's missing from canonicalSystemsByCsgId/
    );
  });

  it("throws when a part2 CSG exists in the map but isPart2Verified=false (drift)", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isPart2Verified: false }),
    ]);
    payload.part2EligibleCsgIds = ["CSG-1"];
    payload.summaryCounts.part2Verified = 1;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /part2EligibleCsgIds contains "CSG-1" but its system has isPart2Verified=false/
    );
  });
});

describe("assertFoundationInvariants — reporting count violations", () => {
  it("throws when summaryCounts.reporting disagrees with reportingCsgIds.length", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isReporting: true }),
    ]);
    payload.summaryCounts.reporting = 5; // lie
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /summaryCounts.reporting \(5\) !== reportingCsgIds.length \(1\)/
    );
  });

  it("throws when reportingCsgIds has duplicates", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isReporting: true }),
    ]);
    payload.reportingCsgIds = ["CSG-1", "CSG-1"];
    payload.summaryCounts.reporting = 2;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /reportingCsgIds has duplicates: 2 entries → 1 unique/
    );
  });

  it("throws when reportingCsgIds references a system with isReporting=false (drift)", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isReporting: false }),
    ]);
    payload.reportingCsgIds = ["CSG-1"];
    payload.summaryCounts.reporting = 1;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /reportingCsgIds contains "CSG-1" but its system has isReporting=false/
    );
  });
});

describe("assertFoundationInvariants — totalSystems / terminated violations", () => {
  it("throws when totalSystems disagrees with non-terminated count in map", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1" }),
      makeSystem({ csgId: "CSG-2" }),
    ]);
    payload.summaryCounts.totalSystems = 5;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /summaryCounts.totalSystems \(5\) !== non-terminated count in map \(2\)/
    );
  });

  it("throws when terminated count disagrees", () => {
    const payload = makePayload([
      makeSystem({ csgId: "CSG-1", isTerminated: true }),
      makeSystem({ csgId: "CSG-2" }),
    ]);
    payload.summaryCounts.terminated = 0;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /summaryCounts.terminated \(0\) !== terminated count in map \(1\)/
    );
  });
});

describe("assertFoundationInvariants — part2VerifiedAndReporting bound", () => {
  it("throws when intersection exceeds min(part2Verified, reporting)", () => {
    const payload = makePayload([
      makeSystem({
        csgId: "CSG-1",
        isPart2Verified: true,
        isReporting: false,
      }),
      makeSystem({
        csgId: "CSG-2",
        isPart2Verified: false,
        isReporting: true,
      }),
    ]);
    // part2Verified=1, reporting=1, so intersection max is 1.
    payload.summaryCounts.part2VerifiedAndReporting = 2;
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /part2VerifiedAndReporting \(2\) > min\(part2Verified, reporting\) \(1\)/
    );
  });
});

describe("assertFoundationInvariants — inputVersions violations", () => {
  it("throws when a DatasetKey is missing from inputVersions", () => {
    const payload = makePayload([makeSystem({ csgId: "CSG-1" })]);
    // Delete one key.
    delete (payload.inputVersions as Partial<typeof payload.inputVersions>)[
      "abpReport"
    ];
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /inputVersions missing DatasetKey "abpReport"/
    );
  });
});

describe("assertFoundationInvariants — populatedDatasets violations", () => {
  it("throws when populatedDatasets contains a non-DatasetKey", () => {
    const payload = makePayload([makeSystem({ csgId: "CSG-1" })]);
    payload.populatedDatasets = ["solarApplications", "notARealKey" as DatasetKey];
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /populatedDatasets contains invalid DatasetKey "notARealKey"/
    );
  });
});

describe("assertFoundationInvariants — foundationHash format", () => {
  it("throws when foundationHash is non-empty but malformed", () => {
    const payload = makePayload(
      [makeSystem({ csgId: "CSG-1" })],
      { foundationHash: "not-a-real-hash" }
    );
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /foundationHash format invalid: "not-a-real-hash"/
    );
  });

  it("throws when foundationHash is uppercase hex", () => {
    const payload = makePayload(
      [makeSystem({ csgId: "CSG-1" })],
      { foundationHash: VALID_HASH.toUpperCase() }
    );
    expect(() => assertFoundationInvariants(payload)).toThrow(
      /foundationHash format invalid/
    );
  });

  it("accepts the empty hash (placeholder)", () => {
    const payload = makePayload(
      [makeSystem({ csgId: "CSG-1" })],
      { foundationHash: "" }
    );
    expect(() => assertFoundationInvariants(payload)).not.toThrow();
  });
});
