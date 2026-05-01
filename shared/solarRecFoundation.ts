/**
 * Phase 2.1 of the dashboard foundation repair (2026-04-30) —
 * type contract for the canonical dashboard "foundation artifact."
 *
 * Why this exists. Every dashboard tab today re-derives the same
 * canonical state ("what is a system?", "is this Part II Verified?",
 * "is this reporting?") from raw `srDs*` rows. Each tab's answer
 * differs slightly — see the test session findings of 4 different
 * Reporting counts on 4 tabs and the 24,275/24,274 numerator-greater-
 * than-denominator off-by-one. The foundation collapses that surface
 * to a single artifact: server builds it once per
 * `(scopeId, definitionVersion, foundationHash)`, every aggregator
 * reads from it.
 *
 * This file is types + invariants only. The builder (which materializes
 * a real artifact from `srDs*` rows) lands in Phase 2.2 at
 * `server/services/solar/buildFoundationArtifact.ts`. The cache /
 * single-flight wiring lands in Phase 2.3.
 *
 * Locked business definitions (encoded by the builder, asserted here):
 *
 *   - **System** = canonical CSG ID from `srDsSolarApplications`. ABP
 *     Application_ID is never a fallback. Terminated systems are
 *     excluded from KPI denominators but stay in the canonical map
 *     with `isTerminated: true`.
 *   - **Reporting** = positive generation in
 *     `[firstDayOfAnchorMonth − 2 calendar months 00:00:00 America/
 *      Chicago, firstDayOfAnchorMonth + 1 calendar month 00:00:00
 *      America/Chicago)`, where anchor = newest valid generation date
 *     in `srDsAccountSolarGeneration` ∪ `srDsGenerationEntry`. Transfer
 *     History never affects reporting. Zero-production rows do not
 *     count.
 *   - **Part II Verified** = mapped CSG ID + valid Part II date
 *     (`Part_2_App_Verification_Date` or `part_2_app_verification_date`)
 *     + ABP status NOT in {rejected, cancelled, canceled, withdrawn}.
 *     Verified ABP IDs without a mapped CSG ID surface as
 *     `UNMATCHED_PART2_ABP_ID` integrity warnings and do NOT count
 *     as systems.
 *   - **Populated dataset** = active batch in
 *     `solarRecActiveDatasetVersions` with `COUNT(*) > 0` in the
 *     matching `srDs*` table.
 *
 * Bumping any of these definitions requires bumping
 * `FOUNDATION_DEFINITION_VERSION` so cached artifacts under the old
 * meaning are invalidated.
 */

import { DATASET_KEYS, type DatasetKey } from "./datasetUpload.helpers";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * `solarRecComputedArtifacts.artifactType` for the foundation.
 * Bump to `"foundation-v2"` (etc.) when the artifact's persisted
 * shape changes in a way old callers can't read — analogous to
 * the `_runnerVersion` pattern in CLAUDE.md.
 */
export const FOUNDATION_ARTIFACT_TYPE = "foundation-v1" as const;

/**
 * Bump when any locked business definition above changes (new
 * Part II status filter, new reporting window, etc.). Cached
 * artifacts whose `definitionVersion` doesn't match the current
 * value are stale even if the input dataset versions haven't
 * changed.
 *
 * v2 (2026-05-01, Phase 2.7) — extended the builder to populate
 * reporting + ownership fields. Cached v1 artifacts had
 * `isReporting: false` everywhere with `summaryCounts.reporting: 0`;
 * bumping invalidates them so the first dashboard load after deploy
 * rebuilds with real values.
 *
 * v3 (2026-05-01, Phase 2.7 follow-up) — added
 * `TRACKING_REF_COLLISION` warning + first-claim winner on the
 * inverse tracking-ref map. Cached v2 artifacts for scopes with
 * cross-CSG trackingRef collisions had silently mis-attributed
 * generation rows to whichever CSG happened to be processed last.
 * Bumping invalidates them so the first dashboard load after
 * deploy rebuilds with deterministic linkage + the new warning.
 */
export const FOUNDATION_DEFINITION_VERSION = 4;

/**
 * `_runnerVersion` shipped on every response that surfaces
 * foundation data. Bump on builder code changes that don't change
 * the persisted artifact shape (otherwise bump
 * `FOUNDATION_ARTIFACT_TYPE` instead).
 */
export const FOUNDATION_RUNNER_VERSION = "foundation-v1" as const;

// ---------------------------------------------------------------------------
// Warning codes
// ---------------------------------------------------------------------------

/**
 * Severe data-quality issues the builder discovers during
 * reconciliation. Each is surfaced both globally
 * (`FoundationArtifactPayload.integrityWarnings`) and per-row on
 * affected systems (`FoundationCanonicalSystem.integrityWarningCodes`)
 * so the Core System List tab can render badge + filter.
 */
export type FoundationWarningCode =
  /** One ABP Application_ID maps to two or more CSG IDs in `srDsAbpCsgSystemMapping`. */
  | "ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS"
  /** One CSG ID maps to two or more ABP Application_IDs. */
  | "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS"
  /** Active Solar Applications rows for one CSG ID imply multiple GATS IDs. */
  | "CSG_ID_HAS_MULTIPLE_GATS_IDS"
  /**
   * Two or more CSG IDs claim the same `tracking_system_ref_id` in
   * `srDsSolarApplications`. The builder keeps the first claim
   * (sorted by row order in the typed-column scan) so generation +
   * transferHistory rows for that trackingRef link to one
   * deterministic CSG; the losing CSGs are flagged here so they
   * can be reconciled upstream. Without the warning a losing CSG
   * would silently appear "not reporting" because its generation
   * data was attributed to the winner.
   */
  | "TRACKING_REF_COLLISION"
  /**
   * ABP row passes Part II + status filter but its Application_ID has
   * no CSG mapping. The system can't be counted, but the row exists.
   */
  | "UNMATCHED_PART2_ABP_ID"
  /**
   * `srDsAbpReport` has multiple rows for the same Application_ID. The
   * builder dedupes by ABP ID before counting (keeps the row with the
   * most recent Part II date, then `rawRow.Application_ID` lex
   * ascending), so this is a flag for upstream cleanup, not a counting
   * bug.
   */
  | "DUPLICATE_ABP_REPORT_ROW"
  /** Active Solar Applications row has no parseable `system_id` value. */
  | "SOLAR_APPLICATION_MISSING_CSG_ID";

/**
 * Discriminated union — each warning code carries its specific
 * supporting context for the integrity warning UI to render.
 */
export type FoundationIntegrityWarning =
  | { code: "ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS"; abpId: string; csgIds: string[] }
  | { code: "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS"; csgId: string; abpIds: string[] }
  | { code: "CSG_ID_HAS_MULTIPLE_GATS_IDS"; csgId: string; gatsIds: string[] }
  | {
      code: "TRACKING_REF_COLLISION";
      trackingRef: string;
      /** Sorted, deduped CSG IDs that all claim `trackingRef`. The first entry is the winner; the rest lose their generation linkage. */
      csgIds: string[];
    }
  | { code: "UNMATCHED_PART2_ABP_ID"; abpId: string }
  | { code: "DUPLICATE_ABP_REPORT_ROW"; abpId: string; rowCount: number }
  | { code: "SOLAR_APPLICATION_MISSING_CSG_ID"; rowKey: string };

// ---------------------------------------------------------------------------
// Per-system shape
// ---------------------------------------------------------------------------

/**
 * One CSG system as the foundation sees it. Wide on purpose — every
 * dashboard tab and the Core System List view read from this same
 * record. Adding a field here is the canonical extension point;
 * tabs that need it project a subset.
 *
 * Date fields are ISO strings (not Date objects) so the artifact
 * round-trips through the JSON-backed `solarRecComputedArtifacts`
 * cache without superjson. Tabs that need real Date objects parse
 * at the consumer.
 */
export type FoundationCanonicalSystem = {
  /** Canonical CSG ID from `srDsSolarApplications.system_id`. */
  csgId: string;
  /** ABP Application_IDs mapped to this CSG via `srDsAbpCsgSystemMapping`. Length 0 → no ABP mapping (still a system). */
  abpIds: string[];
  /** Locked def: portal/ABP status indicates terminated. Excluded from KPI denominators; visible in Core System List. */
  isTerminated: boolean;
  /** Locked def: mapped CSG + valid Part II date + ABP status not in (rejected/cancelled/withdrawn). */
  isPart2Verified: boolean;
  /** Locked def (v2): positive generation in [anchor − 2mo, anchor + 1mo) America/Chicago. */
  isReporting: boolean;
  /** Lifecycle bucket (v2). Tabs combine with `isReporting` for the legacy 6-state combined enum (`Terminated and Reporting`, etc.). Null only when contractType is unknown AND no transferHistory match AND no Zillow signal. */
  ownershipStatus:
    | "active"
    | "transferred"
    | "change-of-ownership"
    | "terminated"
    | null;
  /** Subset of warning codes that affect this system specifically. Empty → no per-row warning. */
  integrityWarningCodes: FoundationWarningCode[];
};

// ---------------------------------------------------------------------------
// Artifact payload (the wire shape)
// ---------------------------------------------------------------------------

/**
 * The full foundation artifact. Cached in
 * `solarRecComputedArtifacts.payload` as JSON-stringified by Phase 2.3,
 * read by every dashboard tab as of Phase 3.
 *
 * Size budget: ~21k systems × ~22 fields × ~50 chars = roughly 25 MB
 * decoded JSON in the worst case. That's larger than the
 * `getDashboardOverviewSummary`'s current 19.8 MB bloat — and
 * absolutely above CLAUDE.md's 1 MB wire rule. Phase 2.3 caches the
 * artifact server-side and exposes it ONLY via slim per-tab queries
 * (e.g. `getFoundationSummary` returning just `summaryCounts +
 * integrityWarnings`) and the paginated Core System List
 * (`getCoreSystemList`). The full payload is server-internal.
 */
export type FoundationArtifactPayload = {
  schemaVersion: 1;
  definitionVersion: typeof FOUNDATION_DEFINITION_VERSION;
  /** sha256(canonicalized inputs + definitionVersion) — cache key + `_checkpoint` value on responses. */
  foundationHash: string;
  /** ISO timestamp the builder wrote the artifact. */
  builtAt: string;
  /** Reporting anchor month for this scope (yyyy-mm-01) or null if no generation data exists yet. */
  reportingAnchorDateIso: string | null;
  /** Per-dataset active batch + row count snapshot used for the hash. Every `DatasetKey` MUST appear. */
  inputVersions: Record<
    DatasetKey,
    { batchId: string | null; rowCount: number }
  >;
  /** Map keyed by canonical CSG ID. */
  canonicalSystemsByCsgId: Record<string, FoundationCanonicalSystem>;
  /** Sorted, deduped CSG IDs of Part II Verified systems. `length === summaryCounts.part2Verified`. */
  part2EligibleCsgIds: string[];
  /** Sorted, deduped CSG IDs of reporting systems. `length === summaryCounts.reporting`. */
  reportingCsgIds: string[];
  summaryCounts: {
    /** Non-terminated CSG count. Excludes terminated. */
    totalSystems: number;
    terminated: number;
    /** `=== part2EligibleCsgIds.length`. Reads must funnel through this. */
    part2Verified: number;
    /** `=== reportingCsgIds.length`. */
    reporting: number;
    /** Intersection of part2-verified and reporting. */
    part2VerifiedAndReporting: number;
  };
  integrityWarnings: FoundationIntegrityWarning[];
  /** Active batch with `rowCount > 0` per `solarRecActiveDatasetVersions` ⋂ `COUNT(*) > 0` in the row table. */
  populatedDatasets: DatasetKey[];
};

// ---------------------------------------------------------------------------
// Empty / placeholder artifact (used by the Phase 2.1 builder skeleton)
// ---------------------------------------------------------------------------

/**
 * The artifact shape with everything zeroed out. Useful for:
 *   - The Phase 2.1 skeleton builder return value (real builder
 *     lands in Phase 2.2; until then anything that imports the
 *     foundation gets a typed empty object rather than a runtime
 *     throw).
 *   - `getFoundationSummary`'s "no abpReport batch yet" early-out.
 *   - Test fixtures wanting to start from a known-good zero state.
 *
 * Frozen so accidental mutation throws — every consumer must treat
 * the artifact as immutable.
 */
export const EMPTY_FOUNDATION_ARTIFACT: FoundationArtifactPayload =
  Object.freeze({
    schemaVersion: 1,
    definitionVersion: FOUNDATION_DEFINITION_VERSION,
    foundationHash: "",
    builtAt: new Date(0).toISOString(),
    reportingAnchorDateIso: null,
    inputVersions: Object.fromEntries(
      DATASET_KEYS.map((k) => [k, { batchId: null, rowCount: 0 }])
    ) as Record<DatasetKey, { batchId: string | null; rowCount: number }>,
    canonicalSystemsByCsgId: {},
    part2EligibleCsgIds: [],
    reportingCsgIds: [],
    summaryCounts: {
      totalSystems: 0,
      terminated: 0,
      part2Verified: 0,
      reporting: 0,
      part2VerifiedAndReporting: 0,
    },
    integrityWarnings: [],
    populatedDatasets: [],
  });

// ---------------------------------------------------------------------------
// Invariants — runtime assertions every builder must satisfy
// ---------------------------------------------------------------------------

/**
 * Server-side runtime checks. Throws on violation; the Phase 2.2
 * builder calls this before writing the artifact to the cache, so
 * a malformed payload is rejected at build time rather than
 * silently corrupting downstream tabs.
 *
 * Invariant order (deliberate — structural before count bounds, so
 * the most diagnostic error fires first):
 *
 *   1. `part2EligibleCsgIds` has no duplicates.
 *   2. `reportingCsgIds` has no duplicates.
 *   3. `summaryCounts.part2Verified === part2EligibleCsgIds.length`.
 *   4. `summaryCounts.reporting === reportingCsgIds.length`.
 *   5. `summaryCounts.totalSystems === non-terminated entries in
 *      canonicalSystemsByCsgId`. Terminated bucket is exclusive.
 *   6. `summaryCounts.terminated === terminated entries in
 *      canonicalSystemsByCsgId`.
 *   7. Every `populatedDatasets` entry is a valid `DatasetKey`.
 *   8. Every `DatasetKey` appears in `inputVersions`.
 *   9. Every CSG ID in `part2EligibleCsgIds` exists in
 *      `canonicalSystemsByCsgId` and has `isPart2Verified === true`.
 *  10. Every CSG ID in `reportingCsgIds` exists in
 *      `canonicalSystemsByCsgId` and has `isReporting === true`.
 *  11. `summaryCounts.part2Verified <= summaryCounts.totalSystems`
 *      (mapped <= total — defends against the 24,275/24,274 off-by-
 *      one shape; a backstop after the structural checks above).
 *  12. `summaryCounts.part2VerifiedAndReporting <=
 *      Math.min(part2Verified, reporting)`.
 *  13. `foundationHash` matches the foundation hash format (64-char
 *      lowercase hex sha256 or empty for `EMPTY_FOUNDATION_ARTIFACT`).
 */
export function assertFoundationInvariants(
  payload: FoundationArtifactPayload
): void {
  const systemsInMap = Object.values(payload.canonicalSystemsByCsgId);

  // 1. part2 dedup.
  const part2Set = new Set(payload.part2EligibleCsgIds);
  if (part2Set.size !== payload.part2EligibleCsgIds.length) {
    throw new Error(
      `[foundation] part2EligibleCsgIds has duplicates: ${payload.part2EligibleCsgIds.length} entries → ${part2Set.size} unique`
    );
  }

  // 2. reporting dedup.
  const reportingSet = new Set(payload.reportingCsgIds);
  if (reportingSet.size !== payload.reportingCsgIds.length) {
    throw new Error(
      `[foundation] reportingCsgIds has duplicates: ${payload.reportingCsgIds.length} entries → ${reportingSet.size} unique`
    );
  }

  // 3. part2 count matches its CSG list.
  if (payload.summaryCounts.part2Verified !== payload.part2EligibleCsgIds.length) {
    throw new Error(
      `[foundation] summaryCounts.part2Verified (${payload.summaryCounts.part2Verified}) !== part2EligibleCsgIds.length (${payload.part2EligibleCsgIds.length})`
    );
  }

  // 4. reporting count matches its CSG list.
  if (payload.summaryCounts.reporting !== payload.reportingCsgIds.length) {
    throw new Error(
      `[foundation] summaryCounts.reporting (${payload.summaryCounts.reporting}) !== reportingCsgIds.length (${payload.reportingCsgIds.length})`
    );
  }

  // 5 + 6. totalSystems and terminated bucket the canonical map.
  const expectedTotal = systemsInMap.filter((s) => !s.isTerminated).length;
  const expectedTerminated = systemsInMap.filter((s) => s.isTerminated).length;
  if (payload.summaryCounts.totalSystems !== expectedTotal) {
    throw new Error(
      `[foundation] summaryCounts.totalSystems (${payload.summaryCounts.totalSystems}) !== non-terminated count in map (${expectedTotal})`
    );
  }
  if (payload.summaryCounts.terminated !== expectedTerminated) {
    throw new Error(
      `[foundation] summaryCounts.terminated (${payload.summaryCounts.terminated}) !== terminated count in map (${expectedTerminated})`
    );
  }

  // 7. populatedDatasets are all valid keys.
  const validKeySet = new Set<string>(DATASET_KEYS);
  for (const key of payload.populatedDatasets) {
    if (!validKeySet.has(key)) {
      throw new Error(
        `[foundation] populatedDatasets contains invalid DatasetKey "${key}"`
      );
    }
  }

  // 8. inputVersions has every DatasetKey.
  for (const key of DATASET_KEYS) {
    if (!(key in payload.inputVersions)) {
      throw new Error(
        `[foundation] inputVersions missing DatasetKey "${key}"`
      );
    }
  }

  // 9. every part2 CSG exists in the map and is flagged. This MUST
  // run before invariant #11 (mapped <= total) so a bogus part2 entry
  // surfaces with a specific "missing CSG" message rather than a
  // generic "numerator > denominator" one.
  for (const csgId of payload.part2EligibleCsgIds) {
    const system = payload.canonicalSystemsByCsgId[csgId];
    if (!system) {
      throw new Error(
        `[foundation] part2EligibleCsgIds contains "${csgId}" but it's missing from canonicalSystemsByCsgId`
      );
    }
    if (!system.isPart2Verified) {
      throw new Error(
        `[foundation] part2EligibleCsgIds contains "${csgId}" but its system has isPart2Verified=false`
      );
    }
  }

  // 10. every reporting CSG exists in the map and is flagged.
  for (const csgId of payload.reportingCsgIds) {
    const system = payload.canonicalSystemsByCsgId[csgId];
    if (!system) {
      throw new Error(
        `[foundation] reportingCsgIds contains "${csgId}" but it's missing from canonicalSystemsByCsgId`
      );
    }
    if (!system.isReporting) {
      throw new Error(
        `[foundation] reportingCsgIds contains "${csgId}" but its system has isReporting=false`
      );
    }
  }

  // 11. mapped <= total. Backstop after structural checks.
  if (payload.summaryCounts.part2Verified > payload.summaryCounts.totalSystems) {
    throw new Error(
      `[foundation] part2Verified (${payload.summaryCounts.part2Verified}) > totalSystems (${payload.summaryCounts.totalSystems}) — mapping must dedupe by ABP ID before counting`
    );
  }

  // 12. intersection upper bound.
  const intersectionMax = Math.min(
    payload.summaryCounts.part2Verified,
    payload.summaryCounts.reporting
  );
  if (payload.summaryCounts.part2VerifiedAndReporting > intersectionMax) {
    throw new Error(
      `[foundation] part2VerifiedAndReporting (${payload.summaryCounts.part2VerifiedAndReporting}) > min(part2Verified, reporting) (${intersectionMax})`
    );
  }

  // 13. foundationHash format. Empty allowed for the placeholder
  // artifact; otherwise must be 64 lowercase hex chars (full sha256).
  if (
    payload.foundationHash !== "" &&
    !/^[0-9a-f]{64}$/.test(payload.foundationHash)
  ) {
    throw new Error(
      `[foundation] foundationHash format invalid: "${payload.foundationHash}" (expected 64-char lowercase hex or empty)`
    );
  }
}
