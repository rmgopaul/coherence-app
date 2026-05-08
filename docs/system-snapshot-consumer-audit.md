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
| `buildDashboardSystemFacts.ts` | line ~231 | The `systemFacts` build runner step (Phase 2 PR-F-2) — populates `solarRecDashboardSystemFacts` from the snapshot | All system fields (1:1 reshape into the fact table). This is the canonical reshape pass; everything else either reads from this fact table or from the snapshot directly. |
| `loadPerformanceRatioInput.ts` | line ~601 | Phase 1 of the perf-ratio static input load — feeds `tokenizeSystemForPerfRatio` which extracts only `key, trackingSystemRefId, systemId, stateApplicationRefId, systemName, installerName, monitoringPlatform, installedKwAc, totalContractAmount, contractedValue, part2HasVerification` | Only the ~11 fields above out of ~30 on `SystemRecord`. |
| `buildPerformanceSourceRows.ts` | one call inside Promise.all | Reshapes systems for the REC-Performance-Eval client tab | TBD (read source for full list) |
| `buildOverviewSummaryAggregates.ts` | one call inside Promise.all | Overview tile counts | TBD |
| `buildForecastAggregates.ts` | one call before annualProduction load | Forecast tab — joins systems with annualProductionEstimates | TBD |
| `buildContractVintageAggregates.ts` | one call inside Promise.all | Contracts + AnnualReview tabs | TBD |
| `buildChangeOwnershipAggregates.ts` | one call inside Promise.all | Change-ownership computations | TBD |
| `buildAppPipelineMonthly.ts` | one call inside Promise.all | Application pipeline | TBD |
| `buildSystemSnapshot.ts` | self — the snapshot builder itself | n/a (the underlying compute) | n/a |

`buildDashboardSystemFacts.ts` is special — it's the SHIM that
populates `solarRecDashboardSystemFacts`. Every other consumer above
COULD theoretically read from that fact table instead of the snapshot,
which would remove their direct dependency.

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

Before either option ships, **audit which fields each aggregator
reads from the snapshot**. The "TBD" rows above need to be filled in.
That's the H-1 follow-up's data informing this work — once we know
which fields are actually consumed, the fact-table extension scope
becomes concrete.

Prerequisite: H-1 diagnostic (`debugProcessMemorySnapshot`) shipped in
PR #490 and is live on prod. The next operational task is to capture
heap snapshots before/during/after a build cycle to attribute the
1.68 GB residual to the snapshot vs. other candidates
(`inFlightDashboardPayloadLoads`, build-runner static input maps).
That data points at whether snapshot retirement is the highest-leverage
Phase 8 follow-up or whether something else dominates.

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
