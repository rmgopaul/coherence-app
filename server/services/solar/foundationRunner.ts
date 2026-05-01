/**
 * Phase 2.3 of the dashboard foundation repair (2026-04-30) —
 * cache-or-compute wrapper around `buildFoundationArtifact`.
 *
 * Two-layer single-flight protection:
 *
 *   1. **In-process Promise registry**: same-dyno concurrent
 *      callers share one in-flight Promise per
 *      `(scopeId, foundationHash)` key. Cleans up after settle so
 *      the next miss is genuinely fresh.
 *
 *   2. **Cross-process via `solarRecComputeRuns`**: different
 *      dynos coordinate via the unique
 *      `(scopeId, artifactType, inputVersionHash)` claim row.
 *      First caller wins the claim and runs the builder. Other
 *      callers poll the cache row until the leader's result lands
 *      (≤ 30 s timeout, 500 ms interval), then return the cached
 *      payload. Stuck claims older than 10 minutes are reclaimed.
 *
 * Sync-vs-runner-job decision (per the v3 plan): build runs
 * **synchronously** inside the runner. Bounded by the locked
 * <5 s target on production-size datasets and well within the
 * 100 s tRPC budget. Phase 5.2 measures cache-miss p99; if it
 * exceeds 30 s we escalate to a fire-and-forget runner job in
 * Phase 6.2 (the `getOrBuildSystemSnapshot` pattern).
 */

import {
  FOUNDATION_ARTIFACT_TYPE,
  FOUNDATION_DEFINITION_VERSION,
  FOUNDATION_RUNNER_VERSION,
  type FoundationArtifactPayload,
  assertFoundationInvariants,
} from "../../../shared/solarRecFoundation";
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
  computeFoundationHash,
  loadInputVersions,
} from "./buildFoundationArtifact";

export { FOUNDATION_RUNNER_VERSION, FOUNDATION_ARTIFACT_TYPE };

// ---------------------------------------------------------------------------
// In-process Promise registry
// ---------------------------------------------------------------------------

type FoundationRunResult = {
  payload: FoundationArtifactPayload;
  fromCache: boolean;
};

/**
 * Map keyed on `${scopeId}:${foundationHash}` so two requests
 * with the same scope but different active dataset versions
 * (i.e. different hashes) don't share a build. Cleared on settle.
 */
const inflightByKey = new Map<string, Promise<FoundationRunResult>>();

/**
 * Test-only escape hatch — Phase 2.3's vitest suite uses this to
 * reset state between tests. Production callers MUST NOT touch.
 */
export function _resetFoundationRunnerForTests(): void {
  inflightByKey.clear();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Time-to-give-up when polling for another dyno's compute. */
const CROSS_PROCESS_POLL_TIMEOUT_MS = 30_000;

/** Pause between cross-process cache reads. */
const CROSS_PROCESS_POLL_INTERVAL_MS = 500;

/**
 * Reclaim runs older than this — usually a previous dyno
 * crashed mid-build. Mirrors the `STUCK_RUN_THRESHOLD_MS` in
 * `buildSystemSnapshot.ts` (10 minutes is generous for the
 * foundation; the build itself targets <5 s).
 */
const STUCK_RUN_THRESHOLD_MS = 10 * 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseCachedPayload(payload: string): FoundationArtifactPayload | null {
  try {
    const parsed = JSON.parse(payload) as FoundationArtifactPayload;
    // Validate against invariants — corrupt cached payloads are
    // treated as a miss so the next call rebuilds. Logging at
    // warn (not error) because a stale-cache eviction is a
    // recoverable cache-miss, not a data-loss surface.
    assertFoundationInvariants(parsed);
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[foundationRunner] cached payload failed invariant check; treating as cache miss:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function readCachedPayload(
  scopeId: string,
  inputVersionHash: string
): Promise<FoundationArtifactPayload | null> {
  const cached = await getComputedArtifact(
    scopeId,
    FOUNDATION_ARTIFACT_TYPE,
    inputVersionHash
  );
  if (!cached?.payload) return null;
  return parseCachedPayload(cached.payload);
}

async function writeArtifactToCache(
  scopeId: string,
  inputVersionHash: string,
  payload: FoundationArtifactPayload
): Promise<void> {
  // Cache write is best-effort — a failure means the next call
  // rebuilds. Logged at warn (not error) so transient DB hiccups
  // don't trigger error-tracking alerts. Mirrors
  // `withArtifactCache.ts`'s policy.
  try {
    await upsertComputedArtifact({
      scopeId,
      artifactType: FOUNDATION_ARTIFACT_TYPE,
      inputVersionHash,
      payload: JSON.stringify(payload),
      rowCount: payload.summaryCounts.totalSystems,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[foundationRunner] cache write failed for ${scopeId}:${inputVersionHash}:`,
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Poll the cache row at fixed intervals until the artifact
 * appears or the timeout elapses. Used when a concurrent dyno
 * has the claim row.
 */
async function pollForCachedPayload(
  scopeId: string,
  inputVersionHash: string,
  options: { timeoutMs: number; intervalMs: number }
): Promise<FoundationArtifactPayload | null> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const cached = await readCachedPayload(scopeId, inputVersionHash);
    if (cached) return cached;
    await new Promise((resolve) =>
      setTimeout(resolve, options.intervalMs)
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inner cache-or-compute (no in-process registry layer)
// ---------------------------------------------------------------------------

async function buildOrFetch(
  scopeId: string,
  inputVersionHash: string
): Promise<FoundationRunResult> {
  // Cache check first — most calls hit here.
  const cached = await readCachedPayload(scopeId, inputVersionHash);
  if (cached) return { payload: cached, fromCache: true };

  // Cross-process claim. First caller wins; losers poll.
  const existing = await getComputeRun(
    scopeId,
    FOUNDATION_ARTIFACT_TYPE,
    inputVersionHash
  );
  let runId: string | null = null;
  let reclaimed = false;

  if (existing) {
    const startedAtMs = existing.startedAt
      ? new Date(existing.startedAt).getTime()
      : 0;
    const ageMs = Date.now() - startedAtMs;

    if (existing.status === "running" && ageMs < STUCK_RUN_THRESHOLD_MS) {
      // Another live caller is building. Poll for their result.
      const polled = await pollForCachedPayload(scopeId, inputVersionHash, {
        timeoutMs: CROSS_PROCESS_POLL_TIMEOUT_MS,
        intervalMs: CROSS_PROCESS_POLL_INTERVAL_MS,
      });
      if (polled) return { payload: polled, fromCache: true };
      // Timed out. Fall through to reclaim + retry the build.
      // eslint-disable-next-line no-console
      console.warn(
        `[foundationRunner] poll timeout for ${scopeId}:${inputVersionHash} (${CROSS_PROCESS_POLL_TIMEOUT_MS}ms); reclaiming run ${existing.id}`
      );
    }

    // Stale or completed/failed claim — reclaim it for our build.
    await reclaimComputeRun(existing.id);
    runId = existing.id;
    reclaimed = true;
  }

  if (runId === null) {
    runId = await claimComputeRun({
      scopeId,
      artifactType: FOUNDATION_ARTIFACT_TYPE,
      inputVersionHash,
      status: "running",
      rowCount: null,
      error: null,
    });
  }

  if (runId === null) {
    // Lost the claim race. One last cache read; if still empty,
    // poll briefly for the winner's result.
    const racedCache = await readCachedPayload(scopeId, inputVersionHash);
    if (racedCache) return { payload: racedCache, fromCache: true };
    const polled = await pollForCachedPayload(scopeId, inputVersionHash, {
      timeoutMs: CROSS_PROCESS_POLL_TIMEOUT_MS,
      intervalMs: CROSS_PROCESS_POLL_INTERVAL_MS,
    });
    if (polled) return { payload: polled, fromCache: true };
    throw new Error(
      `[foundationRunner] lost claim for ${scopeId}:${inputVersionHash} but no cached result appeared after ${CROSS_PROCESS_POLL_TIMEOUT_MS}ms`
    );
  }

  // We have the claim. Build synchronously, then write back.
  try {
    const payload = await buildFoundationArtifact(scopeId);
    await writeArtifactToCache(scopeId, inputVersionHash, payload);
    await completeComputeRun(runId, payload.summaryCounts.totalSystems);
    return { payload, fromCache: false };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "foundation build failed";
    // Mark the run failed so future callers don't think we still
    // own the claim. Best-effort — if this throws too we still
    // re-throw the original error below.
    try {
      await failComputeRun(runId, message);
    } catch (failErr) {
      // eslint-disable-next-line no-console
      console.warn(
        `[foundationRunner] failComputeRun(${runId}) errored:`,
        failErr instanceof Error ? failErr.message : failErr
      );
    }
    // eslint-disable-next-line no-console
    console.error(
      `[foundationRunner] build failed for ${scopeId}:${inputVersionHash}${reclaimed ? " (reclaimed run)" : ""}:`,
      message
    );
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public entry point — combines in-process registry + buildOrFetch
// ---------------------------------------------------------------------------

/**
 * Cache-or-compute the foundation artifact for `scopeId`.
 *
 *   - `fromCache: true` when the artifact came from
 *     `solarRecComputedArtifacts` (or another dyno's just-completed
 *     build that we polled for).
 *   - `fromCache: false` when this caller ran the builder.
 *   - `fromInflight: true` when this caller piggy-backed on an
 *     in-flight Promise from a previous request on the same dyno.
 *
 * The triple lets callers distinguish "real cache hit" from
 * "concurrent piggyback" in their own metrics.
 */
export async function getOrBuildFoundation(
  scopeId: string
): Promise<{
  payload: FoundationArtifactPayload;
  fromCache: boolean;
  fromInflight: boolean;
  inputVersionHash: string;
}> {
  const inputVersions = await loadInputVersions(scopeId);
  const inputVersionHash = computeFoundationHash(inputVersions);
  const key = `${scopeId}:${inputVersionHash}`;

  // Layer 1: in-process registry. Same-dyno concurrent callers
  // share one Promise.
  const inflight = inflightByKey.get(key);
  if (inflight) {
    const result = await inflight;
    return {
      payload: result.payload,
      fromCache: result.fromCache,
      fromInflight: true,
      inputVersionHash,
    };
  }

  // Layer 2: kick off the build via the cache-or-compute path.
  // Register the Promise IMMEDIATELY (before any await) so a
  // concurrent caller in the same tick sees us.
  const promise = buildOrFetch(scopeId, inputVersionHash);
  inflightByKey.set(key, promise);
  // Always clean up the registry slot once the build settles —
  // even on rejection — so the next miss is genuinely fresh.
  // Use `.then(onFulfilled, onRejected)` (both handlers identical)
  // instead of `.finally()` because `.finally()` re-emits the
  // rejection on the returned Promise, which produces an
  // unhandled-rejection warning. The primary await below handles
  // the rejection for the caller.
  const cleanup = () => {
    if (inflightByKey.get(key) === promise) {
      inflightByKey.delete(key);
    }
  };
  promise.then(cleanup, cleanup);

  const result = await promise;
  return {
    payload: result.payload,
    fromCache: result.fromCache,
    fromInflight: false,
    inputVersionHash,
  };
}

// ---------------------------------------------------------------------------
// Slim view — what the tRPC procedure ships to clients
// ---------------------------------------------------------------------------

/**
 * Dashboard-safe foundation summary. Excludes
 * `canonicalSystemsByCsgId` (the per-system row map can hit
 * 25 MB on the wire) and other large fields. The Phase 4 Core
 * System List has its own paginated procedure for the wide rows;
 * Phase 3 tab aggregators read the full artifact server-side via
 * `getOrBuildFoundation` directly and project just what they
 * need into per-tab responses.
 */
export type FoundationSummaryView = {
  schemaVersion: 1;
  definitionVersion: number;
  foundationHash: string;
  builtAt: string;
  reportingAnchorDateIso: string | null;
  inputVersions: FoundationArtifactPayload["inputVersions"];
  summaryCounts: FoundationArtifactPayload["summaryCounts"];
  /** Full warning list. ~hundreds of entries even on a degraded scope. */
  integrityWarnings: FoundationArtifactPayload["integrityWarnings"];
  populatedDatasets: FoundationArtifactPayload["populatedDatasets"];
};

export function projectFoundationSummary(
  payload: FoundationArtifactPayload
): FoundationSummaryView {
  return {
    schemaVersion: payload.schemaVersion,
    definitionVersion: payload.definitionVersion,
    foundationHash: payload.foundationHash,
    builtAt: payload.builtAt,
    reportingAnchorDateIso: payload.reportingAnchorDateIso,
    inputVersions: payload.inputVersions,
    summaryCounts: payload.summaryCounts,
    integrityWarnings: payload.integrityWarnings,
    populatedDatasets: payload.populatedDatasets,
  };
}
