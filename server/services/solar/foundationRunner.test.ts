/**
 * Phase 2.3 of the dashboard foundation repair (2026-04-30) —
 * tests for the foundation runner's cache-or-compute behavior.
 *
 * Mocks the DB helpers + the builder so the test surface is the
 * runner's coordination logic: in-process registry, cross-process
 * claim handoff, stale-run reclaim, error propagation.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import {
  EMPTY_FOUNDATION_ARTIFACT,
  FOUNDATION_ARTIFACT_TYPE,
  type FoundationArtifactPayload,
} from "../../../shared/solarRecFoundation";

// ---------------------------------------------------------------------------
// Module mocks. These have to land before importing the runner.
// ---------------------------------------------------------------------------

vi.mock("./buildFoundationArtifact", async () => {
  const actual = await vi.importActual<
    typeof import("./buildFoundationArtifact")
  >("./buildFoundationArtifact");
  return {
    ...actual,
    buildFoundationArtifact: vi.fn(),
    loadInputVersions: vi.fn(),
  };
});

vi.mock("../../db/solarRecDatasets", () => ({
  claimComputeRun: vi.fn(),
  getComputeRun: vi.fn(),
  getComputedArtifact: vi.fn(),
  upsertComputedArtifact: vi.fn(),
  completeComputeRun: vi.fn(),
  failComputeRun: vi.fn(),
  reclaimComputeRun: vi.fn(),
}));

import {
  claimComputeRun,
  completeComputeRun,
  failComputeRun,
  getComputeRun,
  getComputedArtifact,
  reclaimComputeRun,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";
import {
  buildFoundationArtifact,
  loadInputVersions,
} from "./buildFoundationArtifact";
import {
  FOUNDATION_RUNNER_VERSION,
  _resetFoundationRunnerForTests,
  getOrBuildFoundation,
  projectFoundationSummary,
} from "./foundationRunner";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(
  overrides: Partial<FoundationArtifactPayload> = {}
): FoundationArtifactPayload {
  return {
    ...EMPTY_FOUNDATION_ARTIFACT,
    foundationHash: "a".repeat(64),
    builtAt: new Date("2026-04-30T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function setLoadInputVersionsToConstantHash() {
  // Deterministic input versions → deterministic hash so each
  // test starts from a known cache key.
  (loadInputVersions as Mock).mockResolvedValue(
    EMPTY_FOUNDATION_ARTIFACT.inputVersions
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  _resetFoundationRunnerForTests();
  setLoadInputVersionsToConstantHash();
});

afterEach(() => {
  _resetFoundationRunnerForTests();
});

// ---------------------------------------------------------------------------
// Cache hit
// ---------------------------------------------------------------------------

describe("getOrBuildFoundation — cache hit", () => {
  it("returns the cached payload without invoking the builder", async () => {
    const cachedPayload = makePayload({
      summaryCounts: {
        totalSystems: 5,
        terminated: 0,
        part2Verified: 3,
        reporting: 2,
        part2VerifiedAndReporting: 1,
      },
      part2EligibleCsgIds: ["A", "B", "C"],
      reportingCsgIds: ["A", "D"],
      canonicalSystemsByCsgId: {
        A: {
          ...EMPTY_FOUNDATION_ARTIFACT.canonicalSystemsByCsgId,
          csgId: "A",
          abpIds: [],
          sizeKwAc: null,
          sizeKwDc: null,
          contractValueUsd: null,
          isTerminated: false,
          isPart2Verified: true,
          isReporting: true,
          anchorMonthIso: null,
          contractType: null,
          ownershipStatus: null,
          monitoringPlatform: null,
          gatsId: null,
          lastMeterReadDateIso: null,
          lastMeterReadKwh: null,
          abpStatus: null,
          part2VerificationDateIso: null,
          contractedDateIso: null,
          energyYear: null,
          integrityWarningCodes: [],
        },
        B: {
          ...EMPTY_FOUNDATION_ARTIFACT.canonicalSystemsByCsgId,
          csgId: "B",
          abpIds: [],
          sizeKwAc: null,
          sizeKwDc: null,
          contractValueUsd: null,
          isTerminated: false,
          isPart2Verified: true,
          isReporting: false,
          anchorMonthIso: null,
          contractType: null,
          ownershipStatus: null,
          monitoringPlatform: null,
          gatsId: null,
          lastMeterReadDateIso: null,
          lastMeterReadKwh: null,
          abpStatus: null,
          part2VerificationDateIso: null,
          contractedDateIso: null,
          energyYear: null,
          integrityWarningCodes: [],
        },
        C: {
          ...EMPTY_FOUNDATION_ARTIFACT.canonicalSystemsByCsgId,
          csgId: "C",
          abpIds: [],
          sizeKwAc: null,
          sizeKwDc: null,
          contractValueUsd: null,
          isTerminated: false,
          isPart2Verified: true,
          isReporting: false,
          anchorMonthIso: null,
          contractType: null,
          ownershipStatus: null,
          monitoringPlatform: null,
          gatsId: null,
          lastMeterReadDateIso: null,
          lastMeterReadKwh: null,
          abpStatus: null,
          part2VerificationDateIso: null,
          contractedDateIso: null,
          energyYear: null,
          integrityWarningCodes: [],
        },
        D: {
          ...EMPTY_FOUNDATION_ARTIFACT.canonicalSystemsByCsgId,
          csgId: "D",
          abpIds: [],
          sizeKwAc: null,
          sizeKwDc: null,
          contractValueUsd: null,
          isTerminated: false,
          isPart2Verified: false,
          isReporting: true,
          anchorMonthIso: null,
          contractType: null,
          ownershipStatus: null,
          monitoringPlatform: null,
          gatsId: null,
          lastMeterReadDateIso: null,
          lastMeterReadKwh: null,
          abpStatus: null,
          part2VerificationDateIso: null,
          contractedDateIso: null,
          energyYear: null,
          integrityWarningCodes: [],
        },
        E: {
          ...EMPTY_FOUNDATION_ARTIFACT.canonicalSystemsByCsgId,
          csgId: "E",
          abpIds: [],
          sizeKwAc: null,
          sizeKwDc: null,
          contractValueUsd: null,
          isTerminated: false,
          isPart2Verified: false,
          isReporting: false,
          anchorMonthIso: null,
          contractType: null,
          ownershipStatus: null,
          monitoringPlatform: null,
          gatsId: null,
          lastMeterReadDateIso: null,
          lastMeterReadKwh: null,
          abpStatus: null,
          part2VerificationDateIso: null,
          contractedDateIso: null,
          energyYear: null,
          integrityWarningCodes: [],
        },
      },
    });
    (getComputedArtifact as Mock).mockResolvedValue({
      payload: JSON.stringify(cachedPayload),
    });

    const result = await getOrBuildFoundation("scope-1");

    expect(result.fromCache).toBe(true);
    expect(result.fromInflight).toBe(false);
    expect(result.payload.summaryCounts.totalSystems).toBe(5);
    expect(buildFoundationArtifact).not.toHaveBeenCalled();
    expect(claimComputeRun).not.toHaveBeenCalled();
  });

  it("treats a corrupt cached payload as a miss and rebuilds", async () => {
    (getComputedArtifact as Mock).mockResolvedValue({
      payload: "not valid json {",
    });
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");
    (buildFoundationArtifact as Mock).mockResolvedValue(makePayload());

    const result = await getOrBuildFoundation("scope-1");

    expect(buildFoundationArtifact).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(completeComputeRun).toHaveBeenCalledWith("run-1", 0);
  });
});

// ---------------------------------------------------------------------------
// Cache miss + first claim wins
// ---------------------------------------------------------------------------

describe("getOrBuildFoundation — cache miss, first claim wins", () => {
  it("invokes the builder, writes cache, marks run completed", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");
    (buildFoundationArtifact as Mock).mockResolvedValue(
      makePayload({
        summaryCounts: {
          totalSystems: 7,
          terminated: 1,
          part2Verified: 4,
          reporting: 0,
          part2VerifiedAndReporting: 0,
        },
      })
    );

    const result = await getOrBuildFoundation("scope-1");

    expect(result.fromCache).toBe(false);
    expect(result.fromInflight).toBe(false);
    expect(result.payload.summaryCounts.totalSystems).toBe(7);
    expect(buildFoundationArtifact).toHaveBeenCalledWith("scope-1");
    expect(claimComputeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: "scope-1",
        artifactType: FOUNDATION_ARTIFACT_TYPE,
        status: "running",
      })
    );
    expect(upsertComputedArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        scopeId: "scope-1",
        artifactType: FOUNDATION_ARTIFACT_TYPE,
      })
    );
    expect(completeComputeRun).toHaveBeenCalledWith("run-1", 7);
    expect(failComputeRun).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// In-process registry
// ---------------------------------------------------------------------------

describe("getOrBuildFoundation — in-process registry", () => {
  it("two concurrent calls share one builder invocation", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");

    let resolveBuilder: (payload: FoundationArtifactPayload) => void = () => {};
    const builderPromise = new Promise<FoundationArtifactPayload>((res) => {
      resolveBuilder = res;
    });
    (buildFoundationArtifact as Mock).mockReturnValue(builderPromise);

    const callA = getOrBuildFoundation("scope-1");
    const callB = getOrBuildFoundation("scope-1");

    // Let both calls reach the registry layer.
    await Promise.resolve();

    resolveBuilder(makePayload({ summaryCounts: { ...makePayload().summaryCounts, totalSystems: 9 } }));

    const [a, b] = await Promise.all([callA, callB]);

    expect(buildFoundationArtifact).toHaveBeenCalledTimes(1);
    expect(a.payload.summaryCounts.totalSystems).toBe(9);
    expect(b.payload.summaryCounts.totalSystems).toBe(9);
    // Exactly one of them is fromInflight=true. The other is the
    // primary builder. The order is determined by which Promise
    // wins the registry race; either ordering is valid.
    const inflightCount = [a.fromInflight, b.fromInflight].filter(Boolean).length;
    expect(inflightCount).toBe(1);
  });

  it("registry slot is cleared after a build completes", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");
    (buildFoundationArtifact as Mock).mockResolvedValue(makePayload());

    const first = await getOrBuildFoundation("scope-1");
    expect(first.fromInflight).toBe(false);

    // Second call after the first settles — should NOT see an
    // in-flight Promise (slot was cleaned up). It hits the cache
    // path (we set up cache miss → claim won → builder ran), but
    // the second call's path goes:
    //   - cache check → miss (still mocked as null)
    //   - claim → won (mock returns same runId)
    // So the builder runs again. That's expected for a stand-
    // alone second call once the first's Promise has resolved.
    const second = await getOrBuildFoundation("scope-1");
    expect(second.fromInflight).toBe(false);
    // Builder was called twice (once per non-piggybacked call).
    expect(buildFoundationArtifact).toHaveBeenCalledTimes(2);
  });

  it("registry slot is cleared after a build rejects", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");

    (buildFoundationArtifact as Mock).mockRejectedValueOnce(
      new Error("first build failed")
    );

    await expect(getOrBuildFoundation("scope-1")).rejects.toThrow(
      "first build failed"
    );
    expect(failComputeRun).toHaveBeenCalledWith("run-1", "first build failed");

    // Second call should kick off a fresh build (registry slot
    // is empty). Make this one succeed.
    (buildFoundationArtifact as Mock).mockResolvedValueOnce(makePayload());
    const result = await getOrBuildFoundation("scope-1");
    expect(result.fromCache).toBe(false);
    expect(buildFoundationArtifact).toHaveBeenCalledTimes(2);
  });

  it("different scopes don't share registry slots", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");
    (buildFoundationArtifact as Mock).mockResolvedValue(makePayload());

    await Promise.all([
      getOrBuildFoundation("scope-1"),
      getOrBuildFoundation("scope-2"),
    ]);

    expect(buildFoundationArtifact).toHaveBeenCalledTimes(2);
    expect(buildFoundationArtifact).toHaveBeenNthCalledWith(1, "scope-1");
    expect(buildFoundationArtifact).toHaveBeenNthCalledWith(2, "scope-2");
  });
});

// ---------------------------------------------------------------------------
// Cross-process claim handoff
// ---------------------------------------------------------------------------

describe("getOrBuildFoundation — cross-process claim handoff", () => {
  it("polls cache when a live claim row exists from another dyno", async () => {
    // Simulated: another dyno has the claim, just-now started.
    (getComputeRun as Mock).mockResolvedValue({
      id: "run-from-other-dyno",
      status: "running",
      startedAt: new Date(),
    });

    // First poll: cache miss. Second poll: cache hit.
    let pollCount = 0;
    (getComputedArtifact as Mock).mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) return null; // initial check
      if (pollCount === 2) return null; // first poll
      return { payload: JSON.stringify(makePayload()) };
    });

    // Speed up the test by stubbing setTimeout — the runner
    // pauses 500ms between polls; we don't want the test to.
    vi.useFakeTimers();
    const promise = getOrBuildFoundation("scope-1");

    // Drain the pending mock promise queue + advance fake timer
    // through both poll intervals.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);

    const result = await promise;
    vi.useRealTimers();

    expect(result.fromCache).toBe(true);
    expect(buildFoundationArtifact).not.toHaveBeenCalled();
    expect(claimComputeRun).not.toHaveBeenCalled();
  });

  it("reclaims a stale claim (>10 min old) and rebuilds", async () => {
    const staleAge = new Date(Date.now() - 11 * 60_000);
    (getComputeRun as Mock).mockResolvedValue({
      id: "run-stale",
      status: "running",
      startedAt: staleAge,
    });
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (buildFoundationArtifact as Mock).mockResolvedValue(makePayload());

    const result = await getOrBuildFoundation("scope-1");

    expect(reclaimComputeRun).toHaveBeenCalledWith("run-stale");
    expect(buildFoundationArtifact).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    // Reclaimed run id is reused — no fresh claim.
    expect(claimComputeRun).not.toHaveBeenCalled();
    expect(completeComputeRun).toHaveBeenCalledWith("run-stale", 0);
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe("getOrBuildFoundation — failure modes", () => {
  it("calls failComputeRun and rethrows when the builder errors", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");
    (buildFoundationArtifact as Mock).mockRejectedValue(
      new Error("DB query timed out")
    );

    await expect(getOrBuildFoundation("scope-1")).rejects.toThrow(
      "DB query timed out"
    );
    expect(failComputeRun).toHaveBeenCalledWith("run-1", "DB query timed out");
    expect(completeComputeRun).not.toHaveBeenCalled();
    expect(upsertComputedArtifact).not.toHaveBeenCalled();
  });

  it("swallows failComputeRun errors and still rethrows the build error", async () => {
    (getComputedArtifact as Mock).mockResolvedValue(null);
    (getComputeRun as Mock).mockResolvedValue(null);
    (claimComputeRun as Mock).mockResolvedValue("run-1");
    (buildFoundationArtifact as Mock).mockRejectedValue(
      new Error("real build error")
    );
    (failComputeRun as Mock).mockRejectedValue(
      new Error("DB unreachable for fail update")
    );

    await expect(getOrBuildFoundation("scope-1")).rejects.toThrow(
      "real build error"
    );
  });
});

// ---------------------------------------------------------------------------
// projectFoundationSummary — wire-payload safety
// ---------------------------------------------------------------------------

describe("projectFoundationSummary", () => {
  it("excludes canonicalSystemsByCsgId (the wide row map)", () => {
    const payload = makePayload({
      canonicalSystemsByCsgId: {
        A: {
          ...EMPTY_FOUNDATION_ARTIFACT.canonicalSystemsByCsgId,
          csgId: "A",
          abpIds: [],
          sizeKwAc: 5,
          sizeKwDc: 6,
          contractValueUsd: null,
          isTerminated: false,
          isPart2Verified: false,
          isReporting: false,
          anchorMonthIso: null,
          contractType: null,
          ownershipStatus: null,
          monitoringPlatform: null,
          gatsId: null,
          lastMeterReadDateIso: null,
          lastMeterReadKwh: null,
          abpStatus: null,
          part2VerificationDateIso: null,
          contractedDateIso: null,
          energyYear: null,
          integrityWarningCodes: [],
        },
      },
    });
    const summary = projectFoundationSummary(payload);
    expect(summary).not.toHaveProperty("canonicalSystemsByCsgId");
    expect(summary).not.toHaveProperty("part2EligibleCsgIds");
    expect(summary).not.toHaveProperty("reportingCsgIds");
  });

  it("includes summaryCounts, integrityWarnings, populatedDatasets, metadata", () => {
    const payload = makePayload({
      summaryCounts: {
        totalSystems: 10,
        terminated: 0,
        part2Verified: 0,
        reporting: 0,
        part2VerifiedAndReporting: 0,
      },
      integrityWarnings: [
        { code: "UNMATCHED_PART2_ABP_ID", abpId: "ABP-99" },
      ],
      populatedDatasets: ["solarApplications", "abpReport"],
      reportingAnchorDateIso: "2026-04-01",
    });
    const summary = projectFoundationSummary(payload);
    expect(summary.summaryCounts.totalSystems).toBe(10);
    expect(summary.integrityWarnings).toEqual([
      { code: "UNMATCHED_PART2_ABP_ID", abpId: "ABP-99" },
    ]);
    expect(summary.populatedDatasets).toEqual([
      "solarApplications",
      "abpReport",
    ]);
    expect(summary.reportingAnchorDateIso).toBe("2026-04-01");
    expect(summary.foundationHash).toBe(payload.foundationHash);
    expect(summary.builtAt).toBe(payload.builtAt);
    expect(summary.definitionVersion).toBe(payload.definitionVersion);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("FOUNDATION_RUNNER_VERSION", () => {
  it("is exported and stable", () => {
    expect(FOUNDATION_RUNNER_VERSION).toBe("foundation-v1");
  });
});
