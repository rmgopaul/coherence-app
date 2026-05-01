/**
 * Phase 2.1 of the dashboard foundation repair (2026-04-30) —
 * skeleton for the canonical foundation artifact builder.
 *
 * Type contract + runtime invariants live in
 * `shared/solarRecFoundation.ts`. This file is the server-side entry
 * point that downstream Phase 2 tasks fill in:
 *
 *   - Phase 2.2 — implement `buildFoundationArtifact()` proper:
 *     read every `srDs*` row table, encode the locked Part II /
 *     Reporting / ABP-mapping definitions, populate
 *     `canonicalSystemsByCsgId`, surface integrity warnings,
 *     compute `foundationHash`.
 *   - Phase 2.3 — wrap with single-flight via `solarRecComputeRuns`
 *     + cache via `solarRecComputedArtifacts` (the
 *     `solarRecDashboardRouter.getFoundationArtifact` procedure
 *     calls into here).
 *   - Phase 2.4 — the dedupe-by-ABP-ID + numerator-vs-denominator
 *     assertions that close the 24,275/24,274 off-by-one loop.
 *
 * Until Phase 2.2 lands, this returns a typed empty artifact that
 * passes every invariant in `shared/solarRecFoundation.ts`. Callers
 * compile against the real signature now; the contents fill in
 * later. Concretely: any test or scaffolding wired to
 * `buildFoundationArtifact` during Phase 2.1 will see "no systems,
 * no warnings, no populated datasets" — useful for proving the
 * type-graph compiles; not useful for any real query.
 *
 * Phase 2.2 will replace the body, NOT the export signature.
 */

import {
  EMPTY_FOUNDATION_ARTIFACT,
  FOUNDATION_RUNNER_VERSION,
  type FoundationArtifactPayload,
  assertFoundationInvariants,
} from "../../../shared/solarRecFoundation";

export { FOUNDATION_RUNNER_VERSION };

/**
 * Phase 2.1 stub. Returns the empty artifact unconditionally. Phase 2.2
 * replaces this body with the real reconciliation walk.
 *
 * The signature is intentionally locked here — Phase 2.3's single-flight
 * wrapper, the new `getFoundationArtifact` tRPC procedure, and the
 * Phase 3 tab migrations all import this exported function and will
 * not need to change when Phase 2.2 lands.
 */
export async function buildFoundationArtifact(
  _scopeId: string
): Promise<FoundationArtifactPayload> {
  // Phase 2.2: replace the body of this function. Read each `srDs*`
  // active batch via `loadDatasetRowsPage` (NOT `loadDatasetRows` —
  // chunked DB scans only, per CLAUDE.md "Hard rules" #1). Encode the
  // four locked definitions. Surface integrity warnings. Hash the
  // canonicalized inputs into `foundationHash`.
  //
  // The output MUST satisfy `assertFoundationInvariants` — that's the
  // server-side contract every cached payload upholds. The skeleton
  // returns the empty artifact so the assertion still passes.
  const artifact: FoundationArtifactPayload = EMPTY_FOUNDATION_ARTIFACT;
  assertFoundationInvariants(artifact);
  return artifact;
}
