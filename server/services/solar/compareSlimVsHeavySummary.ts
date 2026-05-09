/**
 * Slim vs heavy dashboard summary drift diagnostic.
 *
 * 2026-05-09 — Follow-up to PR-7 (#536) and PR-4 (#533) which pinned
 * the Overview tile counts to slim values "for stability." Both PRs
 * acknowledged that slim and heavy diverge by 25–60 per shared count
 * field on prod data, and that picking ONE source resolved the
 * user-visible bug while leaving the underlying correctness question
 * open.
 *
 * This module ships a **pure diagnostic harness** that takes already-
 * computed slim + heavy summary outputs (plus the Part-II foundation
 * and the unmatched-Part-II-ABP-row count) and produces a structured
 * drift report explaining WHICH structural mechanism is responsible
 * for each diverging field. Operators can call this against a prod
 * scope to pinpoint whether a stale snapshot, unmatched ABP rows, or
 * something else explains a given discrepancy.
 *
 * Scope-bound caller (a tRPC admin proc) belongs in a follow-up — the
 * harness here is just the pure logic so it can be unit-tested with
 * synthetic data.
 *
 * **Two leading hypotheses** (see
 * `docs/slim-vs-heavy-summary-drift.md` for the full structural
 * write-up):
 *
 * 1. **Unmatched Part-II ABP rows.** Heavy counts every unique
 *    Part-II ABP project as 1 system in `totalSystems`, even when
 *    no canonical system matches the ABP row. Slim never sees them
 *    because they're not in `foundation.part2EligibleCsgIds`. If
 *    there are N unmatched Part-II ABP rows in a batch, heavy is
 *    +N on `totalSystems` and 0 of those count as reporting. The
 *    2026-05-09 prod walk's deltas (+60 total / +25 reporting) are
 *    consistent with ~60 unmatched rows of which ~25 happen to
 *    have other reasons that affect the reporting count
 *    indirectly.
 *
 * 2. **Stale system snapshot.** Heavy reads `system.sizeBucket`
 *    pre-derived from the snapshot at snapshot-build time. Slim
 *    reads the live `installedKwAc` value from
 *    `srDsSolarApplications`. If `installedKwAc` was updated after
 *    the snapshot was built (e.g., a monitoring sync rewrote a
 *    boundary system from 9.5 → 10.5 kW AC), heavy's bucket
 *    classification is stale.
 *
 * The harness reports both mechanisms' contributions and surfaces a
 * verdict that ranks them by evidence strength.
 */

export type SharedCountField =
  | "totalSystems"
  | "reportingSystems"
  | "smallSystems"
  | "largeSystems"
  | "unknownSizeSystems";

export type SharedCountSnapshot = {
  totalSystems: number;
  reportingSystems: number;
  smallSystems: number;
  largeSystems: number;
  unknownSizeSystems: number;
};

export type DriftDiagnosticInput = {
  slim: SharedCountSnapshot;
  heavy: SharedCountSnapshot;
  /**
   * Number of Part-II ABP rows whose 4-key match (portalSystemId /
   * applicationId / trackingId / projectName) found NO canonical
   * system. These contribute +1 each to heavy's `totalSystems`,
   * `notTransferredNotReporting`, and `notReportingOwnershipTotal`,
   * but slim does not see them at all.
   */
  unmatchedPart2AbpProjectCount: number;
  /**
   * Number of canonical systems whose snapshot-derived `sizeBucket`
   * disagrees with the live `srDsSolarApplications` row's
   * `installedKwAc <= 10` classification (after foundation's
   * Part-II eligibility filter). Each mismatch represents one
   * count drifting between buckets in slim vs heavy.
   */
  sizeBucketMismatchCount: number;
  /**
   * Number of canonical systems whose foundation-derived
   * `isReporting` disagrees with the snapshot-derived
   * `system.isReporting`. Each mismatch may flip a system between
   * `reporting` and `notReporting` columns.
   */
  reportingFlagMismatchCount: number;
};

export type DriftFieldDiff = {
  field: SharedCountField;
  slim: number;
  heavy: number;
  delta: number;
};

export type DriftMechanismVerdict =
  | "no-drift"
  | "primary:unmatched-abp-rows"
  | "primary:stale-snapshot-buckets"
  | "primary:reporting-flag-mismatch"
  | "compound:multiple-mechanisms"
  | "unexplained";

export type DriftDiagnosticReport = {
  fieldDiffs: DriftFieldDiff[];
  totalAbsoluteDrift: number;
  /**
   * Aggregated evidence — how much of the drift each hypothesized
   * mechanism explains, summed across fields.
   */
  evidence: {
    unmatchedAbpRowsExplains: number;
    staleSnapshotBucketsExplains: number;
    reportingFlagMismatchesExplains: number;
  };
  verdict: DriftMechanismVerdict;
  /**
   * Operator-readable explanation of the verdict + suggested
   * remediation. One short paragraph; no chunked bullet list.
   */
  verdictNote: string;
};

const SHARED_FIELDS: readonly SharedCountField[] = [
  "totalSystems",
  "reportingSystems",
  "smallSystems",
  "largeSystems",
  "unknownSizeSystems",
] as const;

/**
 * **Verdict thresholds.**
 *
 * `PRIMARY_VERDICT_THRESHOLD` — when a single mechanism explains a
 * STRICT majority of the drift (>50%), it's the primary verdict.
 * With multiple mechanisms each contributing partially the verdict
 * is `compound:multiple-mechanisms`. With no mechanism accounting
 * for the drift the verdict is `unexplained` (signal: a new
 * mechanism may need to be added to this diagnostic).
 *
 * Drift of 0 across all fields short-circuits to `no-drift` BEFORE
 * any mechanism math runs.
 */
const PRIMARY_VERDICT_THRESHOLD = 0.5;

export function compareSlimVsHeavySummary(
  input: DriftDiagnosticInput
): DriftDiagnosticReport {
  const fieldDiffs: DriftFieldDiff[] = SHARED_FIELDS.map((field) => ({
    field,
    slim: input.slim[field],
    heavy: input.heavy[field],
    delta: input.heavy[field] - input.slim[field],
  }));

  // 2026-05-09 follow-up review remediation — switch from
  // positional `fieldDiffs[N]!` to a name-keyed lookup. A future
  // reorder of `SHARED_FIELDS` would silently break attribution
  // (the tests use the same constant, so they wouldn't catch it).
  // Keying on the field name makes the math reorder-safe AND
  // self-documenting at the call site.
  const deltaByField = Object.fromEntries(
    fieldDiffs.map((diff) => [diff.field, diff.delta])
  ) as Record<SharedCountField, number>;

  const totalAbsoluteDrift = fieldDiffs.reduce(
    (sum, diff) => sum + Math.abs(diff.delta),
    0
  );

  if (totalAbsoluteDrift === 0) {
    return {
      fieldDiffs,
      totalAbsoluteDrift: 0,
      evidence: {
        unmatchedAbpRowsExplains: 0,
        staleSnapshotBucketsExplains: 0,
        reportingFlagMismatchesExplains: 0,
      },
      verdict: "no-drift",
      verdictNote:
        "Slim and heavy summaries report identical counts on every shared field. No drift to investigate.",
    };
  }

  // **Unmatched ABP rows** — each contributes +1 to
  // heavy.totalSystems (slim does not count them; foundation's
  // canonical Part-II set excludes unmatched rows). They contribute
  // 0 directly to heavy.reportingSystems (the heavy aggregator
  // routes unmatched rows to `notTransferredNotReporting`, which is
  // SUMMED INTO `notReportingOwnershipTotal` but NOT into
  // `reportingSystems` — see `buildOverviewSummaryAggregates.ts`'s
  // `reportingSystems = notTransferredReporting + transferredReporting
  // + terminatedReporting` formula). They contribute 0 to size
  // buckets (the snapshot's bucket projection filters by Part-II
  // eligibility, excluding unmatched rows).
  //
  // 2026-05-09 follow-up review remediation: pre-fix the formula
  // was `min(N, |totalSystems delta|) + min(N, |reportingSystems
  // delta|)`, double-counting the reportingSystems delta against
  // BOTH this mechanism and the reporting-flag-mismatch mechanism
  // below. AND the second term incorrectly credited unmatched
  // rows for a +25 reportingSystems delta when unmatched can ONLY
  // push the delta toward 0 or negative (heavy reportingSystems
  // grows only via matched-system reporting, not via unmatched).
  // Corrected: unmatched explains the totalSystems delta only,
  // capped by the positive (heavy > slim) direction.
  const totalSystemsDelta = deltaByField.totalSystems;
  const unmatchedAbpRowsExplains = Math.min(
    input.unmatchedPart2AbpProjectCount,
    Math.max(0, totalSystemsDelta)
  );

  // **Stale snapshot buckets** — each mismatch flips a system from
  // one bucket to another. The drift it explains equals the count
  // of mismatches × 2 (each mismatch contributes -1 in the OLD
  // bucket and +1 in the NEW bucket = 2 absolute drift), capped by
  // the sum of absolute deltas across the 3 size-bucket fields.
  const sizeBucketAbsoluteDrift =
    Math.abs(deltaByField.smallSystems) +
    Math.abs(deltaByField.largeSystems) +
    Math.abs(deltaByField.unknownSizeSystems);
  const staleSnapshotBucketsExplains = Math.min(
    input.sizeBucketMismatchCount * 2,
    sizeBucketAbsoluteDrift
  );

  // **Reporting flag mismatches** — each mismatch flips a system
  // from reporting to not-reporting (or vice versa) without
  // changing `totalSystems`. Confined to the `reportingSystems`
  // delta. Now the SOLE attributor for that delta — pre-remediation
  // unmatched-ABP also claimed it, leading to over-attribution
  // when both counts were non-zero.
  const reportingFlagMismatchesExplains = Math.min(
    input.reportingFlagMismatchCount,
    Math.abs(deltaByField.reportingSystems)
  );

  const evidence = {
    unmatchedAbpRowsExplains,
    staleSnapshotBucketsExplains,
    reportingFlagMismatchesExplains,
  };

  const explainedTotal =
    unmatchedAbpRowsExplains +
    staleSnapshotBucketsExplains +
    reportingFlagMismatchesExplains;

  const ratios = {
    unmatched: unmatchedAbpRowsExplains / totalAbsoluteDrift,
    snapshot: staleSnapshotBucketsExplains / totalAbsoluteDrift,
    reportingFlag: reportingFlagMismatchesExplains / totalAbsoluteDrift,
  };

  let verdict: DriftMechanismVerdict;
  let verdictNote: string;

  if (explainedTotal === 0) {
    verdict = "unexplained";
    const perFieldDeltaText = fieldDiffs
      .filter((d) => d.delta !== 0)
      .map((d) => `${d.field}=${d.delta > 0 ? "+" : ""}${d.delta}`)
      .join(", ");
    verdictNote = `Drift of ${totalAbsoluteDrift} units across the shared count fields, but none of the 3 tracked mechanisms (unmatched ABP rows, stale snapshot buckets, reporting flag mismatches) account for it. Per-field deltas: ${perFieldDeltaText}. Investigate field-level drift directly: a new mechanism may need to be added to this diagnostic.`;
  } else if (ratios.unmatched > PRIMARY_VERDICT_THRESHOLD) {
    verdict = "primary:unmatched-abp-rows";
    verdictNote = `Heavy aggregator counts ${input.unmatchedPart2AbpProjectCount} Part-II ABP rows that have no canonical system match; slim does not see them. This single mechanism explains ${unmatchedAbpRowsExplains} of the ${totalAbsoluteDrift} units of drift. Remediation: review the unmatched rows in the active ABP batch; they likely indicate ingestion misalignment between abpReport and solarApplications.`;
  } else if (ratios.snapshot > PRIMARY_VERDICT_THRESHOLD) {
    verdict = "primary:stale-snapshot-buckets";
    verdictNote = `${input.sizeBucketMismatchCount} systems have a snapshot-derived sizeBucket that disagrees with the live srDsSolarApplications installedKwAc. This mechanism explains ${staleSnapshotBucketsExplains} of the ${totalAbsoluteDrift} units of drift. Remediation: rebuild the system snapshot via getOrBuildSystemSnapshot(forceRebuild=true) so the bucket field reflects the live solar batch.`;
  } else if (ratios.reportingFlag > PRIMARY_VERDICT_THRESHOLD) {
    verdict = "primary:reporting-flag-mismatch";
    verdictNote = `${input.reportingFlagMismatchCount} systems have foundation-derived isReporting that disagrees with the snapshot-derived isReporting. This mechanism explains ${reportingFlagMismatchesExplains} of the ${totalAbsoluteDrift} units of drift. Remediation: rebuild the system snapshot OR force a foundation refresh — whichever was last built earlier.`;
  } else if (explainedTotal >= totalAbsoluteDrift * PRIMARY_VERDICT_THRESHOLD) {
    verdict = "compound:multiple-mechanisms";
    verdictNote = `Drift of ${totalAbsoluteDrift} units across shared fields. Multiple tracked mechanisms each contribute partially (unmatched-abp=${unmatchedAbpRowsExplains}, stale-snapshot=${staleSnapshotBucketsExplains}, reporting-flag-mismatch=${reportingFlagMismatchesExplains}). Remediation: rebuild the system snapshot to address the snapshot-side mechanisms, then re-diagnose to see if unmatched-abp drift remains.`;
  } else {
    verdict = "unexplained";
    verdictNote = `Drift of ${totalAbsoluteDrift} units across shared fields; tracked mechanisms only account for ${explainedTotal} units (${Math.round((explainedTotal / totalAbsoluteDrift) * 100)}%). A new mechanism may need to be added to this diagnostic. Per-field deltas: ${fieldDiffs
      .filter((d) => d.delta !== 0)
      .map((d) => `${d.field}=${d.delta > 0 ? "+" : ""}${d.delta}`)
      .join(", ")}.`;
  }

  return {
    fieldDiffs,
    totalAbsoluteDrift,
    evidence,
    verdict,
    verdictNote,
  };
}
