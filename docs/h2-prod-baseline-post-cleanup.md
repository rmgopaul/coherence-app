# Phase H-2 prod baseline — post-cleanup attribution

**Date**: 2026-05-09
**Status**: Captures direct DB observation on the canonical prod
scope (`scope-user-1`) AFTER the Phase H wrap-up + Phase 6/7/8
batch (PRs #492–#511) deployed. Companion doc to
[`h1-prod-baseline-attribution.md`](./h1-prod-baseline-attribution.md).

---

## Summary

The big-three accumulating-row candidates from H-1 are **trending
down on the storage layer** as the relevant TTL prunes deploy
across builds. State.json is 100% explainable. **One new
high-priority finding surfaced during the audit**: a stuck
`solarRecDashboardBuilds` row that reveals a real bug in the
opportunistic stale-claim sweeps. Fix shipped in PR #513 the same
day this doc was filed.

| Layer | H-1 finding (2026-05-08) | H-2 finding (2026-05-09) | Trend |
|---|---|---|---|
| `foundation-v1` cache rows | ≥20 × 5.7 MB = 114 MB | 29 × 5.6 MB = 164 MB | **Up** — last write 2026-05-08T07:31, BEFORE PR #500's prune deployed. Will self-clear on the next post-PR-500 build. |
| `system_snapshot` cache rows | n/a | 13 × ~3.6 MB = 47 MB | **Tracked.** Same TTL pattern (keep-newest-N per scope) — verify pruning on next build. |
| `state.json` blob | 42 KB legacy `datasetManifest` | 42,635 B (unchanged) | **Static.** PR #492 added the cleanup proc; the proc is admin-gated and has not been invoked manually yet. |
| `datasetUploadJobs` terminal rows | n/a | 90 done + 14 failed (oldest 5 days, within TTL) | **Healthy.** Within the 7-day retention window from PR #503 + #509. |
| `dashboardCsvExportJobs` | n/a | 0 stuck rows | **Healthy.** 30-min TTL works as designed. |
| `solarRecDashboardBuilds` | n/a | **1 stuck row** running for ~24 h | **🚨 Bug** — see "Stuck-build attribution" below. |

---

## Stuck-build attribution

### Observation

```
buildId                                      status   completedAt  startedAt              age
bld-312c41a266cf8b8fd9ab37ac9c8ade75          running  NULL         2026-05-08T05:47:42Z   ~24 h
```

`STALE_CLAIM_MS = 5 min`. The 5-minute threshold should have flipped
this row to `failed` long ago. It didn't.

### Root cause

`server/services/solar/dashboardBuildJobs.ts :: sweepStaleAndPrune`
fires only inside `getDashboardBuildStatus`. The status read is
how the parent dashboard polls the **active** buildId — but if the
worker died after claim AND the client moved on (page reload, new
build started, tab close), nobody polls the orphan, and the sweep
never runs against it. The doc comment said "periodic sweep" but
no boot-time timer was wired anywhere.

`server/services/solar/dashboardCsvExportJobs.ts :: sweepStaleAndPruned`
had the identical structure for the same reason. The reason no
stuck CSV export rows showed up in this audit is the much shorter
30-min TTL combined with much more frequent invocations — the
sweep effectively gets called often enough by accident that no
orphan persists for long. But the same bug is latent.

### Fix

PR #513 (filed 2026-05-09): add `startDashboardBuildStaleJobSweeper`
and `startDashboardCsvExportStaleJobSweeper` mirroring the
existing `startDatasetUploadStaleJobSweeper` shape. Boot tick +
recurring 5-min timer, env-tunable, `unref()`-ed,
re-entrancy-guarded, gated under `shouldMutateProdState()`.

After PR #513 deploys, the existing stuck row should flip to
`failed` within ~5 min via the periodic tick (the boot tick
catches it on first server restart).

---

## What still needs operator-loop attribution

The H-1 doc enumerated three candidates for the 1.68 GB residual
baseline:

1. **foundation-v1 cache bloat.** PR #500 (TTL prune via
   keep-newest-N) deployed during the batch. The 29-row count
   captured here was written *before* the prune deployed; future
   builds should reduce this to ≤3 rows per `(scope, artifactType)`
   tuple. Verify after the next cache-miss build.

2. **System snapshot held in heap across consumers.** No code
   change shipped in this batch. PR-C in the audit queue
   (`docs/system-snapshot-consumer-audit.md` TBDs) is what
   completes the picture. Still pending.

3. **Build runner static-input maps.** Phase 2 derived-fact
   tables (PR-G series) decouple the legacy `getOrBuild*` cache
   readers from the build runner; the maps still get materialized
   inside the build cycle but no longer leak across consumer hot
   paths. Verify the heap-after delta on the next H-1 operator
   session.

The H-1 diagnostic proc (`debugProcessMemorySnapshot`, PR #490)
remains the right capture surface. Live `process.memoryUsage()`
+ V8 `getHeapStatistics()` numbers from a cache-miss build cycle
are still the missing data point.

---

## Action items

1. ✅ **PR #513 — boot-time stale sweepers** (this doc captured the
   evidence; the fix shipped same day).
2. ⏳ **Manual `cleanupLegacyStatePayload` invocation** for the
   42 KB `state.json` legacy blob on `scope-user-1`. The proc is
   admin-tier and exists; needs an operator to call it.
3. ⏳ **Verify foundation-v1 pruning** after the next cache-miss
   build cycle. Expect row count to drop from 29 → ≤3 per
   `(scope, artifactType)` tuple.
4. ⏳ **H-1 operator-loop capture** during the next OOM
   recurrence (or a deliberate cache-miss build) — fills in the
   actual heap attribution that the storage-layer audit can only
   suggest.

---

## Cross-references

- **`docs/h1-prod-baseline-attribution.md`** — H-1 audit (2026-05-08)
- **`docs/post-merge-self-review-2026-05-09.md`** — PR #492-#507 review
- **PR #500** — foundation-v1 TTL prune
- **PR #503** + **PR #509** — datasetUploadJobs TTL prune + bulk-delete
- **PR #492** — `cleanupLegacyStatePayload` proc + `saveState` validator
- **PR #508** — cleanupLegacyStatePayload also overwrites S3
- **PR #513** — boot-time stale sweepers for build + CSV export jobs
