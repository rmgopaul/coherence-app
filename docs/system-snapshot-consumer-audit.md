# `getOrBuildSystemSnapshot` consumer audit (Phase 8 retirement scoping)

**Date**: 2026-05-08
**Status**: Audit only — no code changes shipped with this doc.
**Owner**: tracking item on the Phase 8 docket per CLAUDE.md.

---

## Why this matters

`getOrBuildSystemSnapshot(scopeId)` returns the full `SystemRecord[]`
payload (~26 MB on prod) into the Node heap. The Phase 2 retirement
already removed every tRPC consumer (`getSystemSnapshot` is no longer
on `solarRecDashboardRouter`); the remaining callers are in-process
fact builders + aggregators. Each cache-miss call to
`getOrBuildSystemSnapshot` allocates ~26 MB of `SystemRecord[]` into
heap, plus another ~10–30 MB of derived per-call structures.

The 1.68 GB residual baseline that started the 2026-05-08 OOM cascade
is consistent with two or three of these allocations stacked
end-to-end during a build runner cycle — they don't all GC between
build steps, especially under heap pressure.

This document inventories every remaining call site so a
follow-up PR series can replace the calls with paginated fact-table
reads (`getDashboardSystemsPage`-style) one consumer at a time.

---

## Live consumers

There are **9 production consumers** across the build runner +
aggregator surface. All are server-only; none are tRPC procedures
(those were retired in Phase 2 PR-F-4-h).

| Consumer | Call site | Purpose | Snapshot fields actually read |
|---|---|---|---|
| `buildDashboardSystemFacts.ts` | line ~240 | The `systemFacts` build runner step (Phase 2 PR-F-2) — populates `solarRecDashboardSystemFacts` from the snapshot | All system fields (1:1 reshape into the fact table). This is the canonical reshape pass; everything else either reads from this fact table or from the snapshot directly. |
| `loadPerformanceRatioInput.ts` | line ~601 | Phase 1 of the perf-ratio static input load — feeds `tokenizeSystemForPerfRatio` which extracts only `key, trackingSystemRefId, systemId, stateApplicationRefId, systemName, installerName, monitoringPlatform, installedKwAc, totalContractAmount, contractedValue, part2HasVerification` | Only the ~11 fields above out of ~30 on `SystemRecord`. |
| `buildPerformanceSourceRows.ts` | line 272 (inside `Promise.all`) | Reshapes systems for REC-Performance-Eval; builds the `systemsByTrackingId` map | Canonical `SnapshotSystem` (6 fields): `systemId`, `stateApplicationRefId`, `trackingSystemRefId`, `systemName`, `recPrice`, `isReporting` |
| `buildOverviewSummaryAggregates.ts` | inside its `withArtifactCache` recompute | Overview tile counts + ownership tile + financial KPI rollups | Custom `SnapshotSystemForSummary` (18 fields): `key`, `systemId`, `stateApplicationRefId`, `trackingSystemRefId`, `systemName`, `sizeBucket`, `isReporting`, `isTransferred`, `isTerminated`, `ownershipStatus`, `contractType`, `contractStatusText`, `latestReportingDate`, `contractedDate`, `zillowStatus`, `zillowSoldDate`, `totalContractAmount`, `contractedValue`, `deliveredValue` |
| `buildForecastAggregates.ts` | line 457 inside the `withArtifactCache` recompute | Forecast tab — joins systems with annualProductionEstimates | Canonical `SnapshotSystem` (declared 6 fields), but only **2 actually read**: `trackingSystemRefId`, `isReporting` |
| `buildContractVintageAggregates.ts` | line 429 inside the `withArtifactCache` recompute | Contracts + AnnualReview tabs | Canonical `SnapshotSystem`, **5 fields read**: `systemId`, `stateApplicationRefId`, `trackingSystemRefId`, `recPrice`, `isReporting` |
| `buildChangeOwnershipAggregates.ts` | inside `withArtifactCache` recompute | Change-ownership computations + ChangeOwnership fact-table builder | Custom `SnapshotSystemForChangeOwnership` (20 fields): `key`, `systemId`, `stateApplicationRefId`, `trackingSystemRefId`, `systemName`, `installedKwAc`, `isReporting`, `isTransferred`, `isTerminated`, `ownershipStatus`, `contractType`, `contractStatusText`, `contractedDate`, `zillowStatus`, `zillowSoldDate`, `latestReportingDate`, `hasChangedOwnership`, `changeOwnershipStatus`, `totalContractAmount`, `contractedValue` |
| `buildAppPipelineMonthly.ts` | line 318 inside `withArtifactCache` recompute | Application pipeline | Canonical `SnapshotSystem`, **1 field via type** (`trackingSystemRefId`) **+ 1 via runtime cast bypass** (`installedKwAc`, read via `(system as Record<string, unknown>).installedKwAc` at line 177 — see "Validator-bypass note" below) |
| `buildSystemSnapshot.ts` | self — the snapshot builder itself | n/a (the underlying compute) | n/a |

### Field-union summary

The cumulative set of `SystemRecord` fields any in-process consumer
reads (excluding `buildDashboardSystemFacts`, which is the 1:1
reshape pass):

| Field | Used by |
|---|---|
| `key` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `systemId` | `buildPerformanceSourceRows`, `buildOverviewSummaryAggregates`, `buildContractVintageAggregates`, `buildChangeOwnershipAggregates`, `loadPerformanceRatioInput` |
| `stateApplicationRefId` | `buildPerformanceSourceRows`, `buildOverviewSummaryAggregates`, `buildContractVintageAggregates`, `buildChangeOwnershipAggregates`, `loadPerformanceRatioInput` |
| `trackingSystemRefId` | All 7 consumers |
| `systemName` | `buildPerformanceSourceRows`, `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates`, `loadPerformanceRatioInput` |
| `recPrice` | `buildPerformanceSourceRows`, `buildContractVintageAggregates` |
| `isReporting` | `buildPerformanceSourceRows`, `buildOverviewSummaryAggregates`, `buildForecastAggregates`, `buildContractVintageAggregates`, `buildChangeOwnershipAggregates` |
| `isTransferred` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `isTerminated` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `sizeBucket` | `buildOverviewSummaryAggregates` |
| `installedKwAc` | `buildChangeOwnershipAggregates`, `buildAppPipelineMonthly` (via cast), `loadPerformanceRatioInput` |
| `installerName` | `loadPerformanceRatioInput` |
| `monitoringPlatform` | `loadPerformanceRatioInput` |
| `ownershipStatus` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `contractType` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `contractStatusText` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `contractedDate` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `latestReportingDate` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `zillowStatus` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `zillowSoldDate` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates` |
| `totalContractAmount` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates`, `loadPerformanceRatioInput` |
| `contractedValue` | `buildOverviewSummaryAggregates`, `buildChangeOwnershipAggregates`, `loadPerformanceRatioInput` |
| `deliveredValue` | `buildOverviewSummaryAggregates` |
| `hasChangedOwnership` | `buildChangeOwnershipAggregates` |
| `changeOwnershipStatus` | `buildChangeOwnershipAggregates` |
| `part2HasVerification` | `loadPerformanceRatioInput` |

**~26 fields total.** The full `SystemRecord` shape (client-side
TypeScript) has ~30+ fields; the field-union above is a strict
subset, suggesting the snapshot retains a few fields no live
consumer reads. Pruning those would shrink the in-heap snapshot;
auditing them requires diffing the client `SystemRecord` type
against this list.

### Validator-bypass note

`buildAppPipelineMonthly.ts` uses the canonical `SnapshotSystem`
TYPE for static type-checking but reads `installedKwAc` via a raw
`(system as Record<string, unknown>).installedKwAc` cast at line
177. The cast bypasses the runtime validator the type was created
to enforce. The comment at line 174-176 acknowledges this
intentionally. **Whichever Phase 8 retirement option ships, this
cast must either:**
- Become a real field on the canonical `SnapshotSystem` type +
  `extractSnapshotSystems` validator (Option A direction), OR
- Become a paginated read against `solarRecDashboardSystemFacts`
  with `installedKwAc` added as a column there (also Option A).

Don't ship the retirement leaving this cast as-is — it's a silent
field-shape regression risk.

### Build runner — special

`buildDashboardSystemFacts.ts` is the SHIM that populates
`solarRecDashboardSystemFacts`. Every other consumer above
COULD theoretically read from that fact table instead of the
snapshot, which would remove their direct dependency.
**Pre-condition:** all fields in the field-union table above
must be present as columns on `solarRecDashboardSystemFacts`.
Today only the system-tile shape is there; the change-ownership
+ overview-summary fields (e.g. `zillowStatus`, `contractedDate`,
`totalContractAmount`) are NOT yet on the fact table.

---

## Why retirement is non-trivial

A naive "replace with `getDashboardSystemsPage` paginated reads" fails
for three reasons:

1. **In-process aggregators cannot paginate.** They need the full
   system set in-memory for joins (e.g. matching annualProduction
   rows to systems by trackingSystemRefId). A paginated read would
   trade one large allocation for many small ones — same total
   memory, more CPU.

2. **The fact table doesn't carry every snapshot field.**
   `solarRecDashboardSystemFacts` (the existing fact table from
   Phase 2 PR-F) holds the system-tile shape, not the full
   `SystemRecord`. Several aggregators read fields that aren't in
   the fact table.

3. **The snapshot itself is the cache.** `getOrBuildSystemSnapshot`
   is a `withArtifactCache` wrapper — repeated calls within a build
   cycle hit the cache. Replacing with paginated DB reads would lose
   that cache layer.

The right retirement strategy is therefore:

**Option A — extend the system-facts table to be a full snapshot
replacement.**
- Audit which fields each aggregator reads.
- Add the missing columns to `solarRecDashboardSystemFacts`.
- Migrate aggregators to read from the fact table (paginated when
  the join shape allows; full-load when it doesn't, but at least the
  column set is canonical).

**Option B — accept the snapshot but bound its lifetime.**
- Add a per-build-cycle snapshot release: clear the
  `withArtifactCache` row at the end of each build runner cycle so
  the next cycle starts cold.
- Slim the `SystemRecord` shape to only the fields actually read
  across all consumers (drop dead fields the snapshot retains for
  legacy reasons).

Option A is the structural fix; Option B is the pragmatic
heap-pressure relief.

---

## Recommended next step

The TBD rows above are now filled in (PR-C from the
`docs/post-merge-self-review-2026-05-09.md` deferred queue,
2026-05-09). Concrete observations from the completed audit:

1. **The fact-table-as-canonical-replacement strategy (Option A)
   needs ~22 new columns on `solarRecDashboardSystemFacts`** to
   cover every field the other 7 in-process consumers read. The
   union table above lists them. Today only the system-tile
   shape is there; the change-ownership + overview-summary
   fields (`zillowStatus`, `contractedDate`, `totalContractAmount`,
   etc.) are missing.

2. **`buildForecastAggregates.ts` reads only 2 fields**
   (`trackingSystemRefId`, `isReporting`). It's the cheapest
   consumer to migrate first — 2 columns either already exist on
   the fact table (`trackingSystemRefId` ✓) or need adding
   (`isReporting`).

3. **`buildAppPipelineMonthly.ts` has a validator bypass** for
   `installedKwAc` (raw cast). Whichever option ships, the cast
   needs replacing.

4. **`loadPerformanceRatioInput.ts` is the heaviest custom
   subset** (11 fields, 5 not reachable from the canonical
   `SnapshotSystem` type). Likely the last consumer to migrate
   in any phased retirement.

Sequencing recommendation for a Phase 8 retirement PR series:

- **PR-1**: extend `solarRecDashboardSystemFacts` with the
  missing 22 columns + their fact-builder reshape.
- **PR-2**: migrate `buildForecastAggregates` first (smallest
  surface).
- **PR-3**: migrate `buildContractVintageAggregates` (5 fields,
  small).
- **PR-4**: migrate `buildAppPipelineMonthly` + remove the
  `installedKwAc` cast.
- **PR-5**: migrate `buildOverviewSummaryAggregates`
  (18 fields, large but mechanical).
- **PR-6**: migrate `buildChangeOwnershipAggregates` (20 fields,
  largest).
- **PR-7**: migrate `buildPerformanceSourceRows`.
- **PR-8**: migrate `loadPerformanceRatioInput` (the perf-ratio
  static-input load is also one of H-1's three residual-baseline
  candidates — landing this last + capturing H-1 numbers
  before/after closes the attribution loop).
- **PR-9**: retire `getOrBuildSystemSnapshot` (in-process) and
  the underlying `buildSystemSnapshot.ts`.

Prerequisite for any of these: H-1 operator-loop diagnostic
capture (still pending per `docs/h2-prod-baseline-post-cleanup.md`).
The H-1 numbers determine whether the snapshot is THE residual
contributor that drives this work, or whether build-runner
static-input maps dominate and this retirement is a smaller
dividend than expected.

---

## Appendix: shared aggregator with cache

`getOrBuildSystemSnapshot` lives in
`server/services/solar/buildSystemSnapshot.ts`. The cache layer is
`withArtifactCache` in
`server/services/solar/withArtifactCache.ts`. Both are imported by
the consumers above; both stay in-process for the duration of a
Node worker's lifetime unless explicitly cleared.

The only public mutation surface for the snapshot today is the
build runner cycle (the build creates a fresh snapshot, every
fact builder reads it, builds complete). No tRPC procedure
exposes the raw snapshot anymore — the retirement we're scoping
is the in-process consumer set, not the wire surface.
