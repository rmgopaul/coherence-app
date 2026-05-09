# Slim vs heavy dashboard summary drift

> **Status:** structural explanation + diagnostic harness (PR-FU-1).
> No fix shipped — operator action required when drift is observed.
>
> **Last updated:** 2026-05-09

---

## What the drift looks like

The Solar REC dashboard's Overview tile counts (`<=10 kW AC`,
`>10 kW AC`, `Reporting`, `Not Reporting`, `Terminated`) are computed
by two different aggregators on the server, and they don't always
agree.

The two aggregators:

- **Slim** — `getDashboardSummary` proc, backed by
  `buildSlimDashboardSummary.ts`. Fires on every cold mount of the
  dashboard. Cheap (~5 KB response, ~100 ms compute). Source of
  truth for cold-mount tile values.
- **Heavy** — `getDashboardOverviewSummary` proc, backed by
  `buildOverviewSummaryAggregates.ts`. Gated on
  `isOverviewTabActive && hasUserInteractedWithDashboard`, so it
  doesn't fire on cold mount. Expensive (loads system snapshot
  + ABP rollups). Was the source of truth for tile values BEFORE
  the user interacted; PR-7 (#536) pinned the shared count fields
  to slim regardless of which aggregator is loaded.

The 2026-05-09 prod QA-walk observed the following deltas on the
shared count fields after activating Performance Ratio:

| Field | Slim | Heavy | Delta |
|---|---|---|---|
| `totalSystems` | 24,291 | 24,351 | **+60** |
| `reportingSystems` | 20,518 | 20,543 | **+25** |
| `<=10 kW AC` | 17,645 | 17,705 | +60 |
| `>10 kW AC` | 6,646 | 6,656 | +10 |
| `Terminated` | 68 | 62 | -6 |

PR-7 pinned the user-visible tile values to slim "for stability." The
question this doc answers: **what STRUCTURAL difference between the
two aggregators causes the drift, and which value is closer to the
ground truth?**

---

## The two structural causes (and how to tell them apart)

### Cause 1: Unmatched Part-II ABP rows

**Heavy counts every unique Part-II ABP project as 1 system in
`totalSystems`, even when no canonical system matches.**

The heavy aggregator's main loop at
`buildOverviewSummaryAggregates.ts:379–429` walks
`part2VerifiedAbpRows`, deduplicates by project identity, then tries
to match each project against the `systems` snapshot via 4 lookup
indexes (portalSystemId / applicationId / trackingId / projectName).
**If no system matches, the row still increments `uniquePart2Projects`
and `notTransferredNotReporting`.** It just doesn't contribute to the
size-bucket counts (those are scoped by Part-II eligibility on the
snapshot side, which excludes unmatched rows).

The slim aggregator never sees these rows. Its `totalSystems` comes
from `foundation.summaryCounts.part2Verified`, which counts canonical
systems only — unmatched ABP rows are not part of the foundation's
canonical set.

**Net effect:** for N unmatched Part-II ABP rows in a batch, heavy
is +N on `totalSystems` and +X on `notTransferredNotReporting` (where
X≤N) compared to slim.

The 2026-05-09 prod walk's `+60 totalSystems` delta is consistent
with ~60 unmatched Part-II ABP rows in the active batch. Whether
this is a bug depends on what ground truth the user wants:

- **If "totalSystems" means "Part-II projects we should care about
  monitoring,"** unmatched rows ARE valid — heavy is right. Slim
  under-counts because the foundation can't classify a project it
  never matched.
- **If "totalSystems" means "Part-II canonical systems with full
  metadata,"** unmatched rows AREN'T valid — slim is right. Heavy
  over-counts because the projects can't be acted on (no system
  to drill into).

There's no universally correct answer — it depends on what the
Overview tile is communicating. **Operator action:** review the
unmatched rows in the active ABP batch. They typically indicate
ingestion misalignment — an ABP row whose `application_id` /
`tracking_id` doesn't match any `srDsSolarApplications` row. Fix
the misalignment and the drift disappears.

### Cause 2: Stale system snapshot

**Heavy reads `system.sizeBucket` pre-derived from the snapshot.
Slim reads `installedKwAc` live from `srDsSolarApplications`.**

The system snapshot is a cached artifact built by
`buildSystemSnapshot`. It carries pre-derived fields including
`sizeBucket` (`<=10 kW AC` / `>10 kW AC` / `Unknown`). The
snapshot is rebuilt on demand but caches across requests.

If `installedKwAc` was updated after the snapshot was built (e.g.,
a monitoring sync rewrote a system's nameplate from 9.5 → 10.5
kW AC), the snapshot's `sizeBucket` is stale until the next
rebuild. Heavy uses the stale bucket; slim uses the live row.

**Net effect:** for N systems with stale buckets, heavy and slim
disagree on the bucket distribution by some delta — typically
±N each in two of the three buckets (`<=10 kW AC` ↔ `>10 kW AC`
flip).

This mechanism is more visible on `<=10 kW AC` / `>10 kW AC` /
`Unknown` than on `totalSystems` (it never changes the total —
it just reshuffles between buckets).

**Operator action:** rebuild the system snapshot via
`getOrBuildSystemSnapshot(scopeId, { force: true })`. The
diagnostic verdict will say
`primary:stale-snapshot-buckets` when this is the dominant cause.

### Cause 3: Reporting flag mismatches

**Foundation's `isReporting` may disagree with the snapshot's
`isReporting`.**

Heavy overlays foundation-derived flags onto the snapshot
(`buildOverviewSummaryAggregates.ts:648–656`), but the overlay
doesn't always succeed — if a system ID doesn't match the overlay
map (off-by-one, case sensitivity, whitespace), the snapshot's
stale flag is used.

This mechanism is rare (the overlay is well-tested) and small —
typically a handful of systems at most. Confined to
`reportingSystems`.

**Operator action:** rebuild the snapshot OR force a foundation
refresh, whichever was last built earlier.

---

## Diagnostic harness

The pure helper `compareSlimVsHeavySummary` in
`server/services/solar/compareSlimVsHeavySummary.ts` takes:

- The slim summary's shared count fields
- The heavy summary's shared count fields
- The count of unmatched Part-II ABP projects in the batch
- The count of size-bucket mismatches between snapshot + live solar
- The count of reporting flag mismatches between foundation +
  snapshot

…and returns a structured `DriftDiagnosticReport` with:

- Per-field delta breakdown
- Evidence summary (how much drift each tracked mechanism explains)
- Verdict (`no-drift` / `primary:<mechanism>` / `compound` /
  `unexplained`) + an operator-readable note

The harness is unit-tested with synthetic data. The actual
production call site (a tRPC admin proc that wires the harness to
real aggregator outputs) is intentionally a follow-up — the harness
itself is the value PR-FU-1 ships.

### Verdict thresholds

A mechanism is the `primary` verdict only if it explains a STRICT
majority of the drift (>50%). With multiple mechanisms each
contributing partially, the verdict is `compound`. With none of
the tracked mechanisms accounting for the drift, the verdict is
`unexplained` — a signal that a NEW mechanism may need to be added
to the diagnostic.

---

## Recommended workflow

1. Notice the dashboard tile values disagreeing with an external
   ground truth (a manual count, a CSV export, etc.).
2. Run the slim and heavy aggregators against the affected scope.
3. Compute the 3 mechanism counts:
   - `unmatchedPart2AbpProjectCount` — walk
     `part2VerifiedAbpRows`, count rows whose 4-key match against
     the snapshot finds nothing.
   - `sizeBucketMismatchCount` — for each Part-II eligible CSG, compare
     the snapshot's `system.sizeBucket` against the bucket
     classification of the live `srDsSolarApplications.installedKwAc`.
   - `reportingFlagMismatchCount` — for each Part-II eligible CSG,
     compare `foundation.canonicalSystemsByCsgId.isReporting`
     against `snapshot.system.isReporting`.
4. Pass to `compareSlimVsHeavySummary` and read the verdict.
5. Apply the suggested remediation (rebuild snapshot, refresh
   foundation, fix ingestion misalignment).
6. Re-run to confirm.

---

## Open questions for a future PR

- **Should heavy stop counting unmatched Part-II ABP rows in
  `totalSystems`?** If yes, slim and heavy converge on
  `totalSystems` and the operator's "ingestion misalignment" detection
  shifts to a separate diagnostic. If no, slim should arguably ALSO
  count them (which means foundation needs to expose unmatched-row
  totals — not currently part of the foundation contract).

- **Should the snapshot's `sizeBucket` be replaced with on-demand
  derivation from the live solar batch?** Saves bucket-staleness
  but adds compute on every heavy read.

These are architectural decisions out of scope for this drift
diagnostic. The right home for them is a follow-up to this doc once
the operator has used the diagnostic in production for a few weeks
and we have data on which mechanism dominates.
