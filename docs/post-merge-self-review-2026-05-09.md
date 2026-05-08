# Post-merge self-review — Phase H wrap-up + Phase 6/7/8 batch (PRs #492–#507)

**Date:** 2026-05-09
**Reviewer:** Claude (post-merge audit per `feedback_post_merge_self_review.md`)
**Scope:** 16 PRs shipped in the 2026-05-08 / 2026-05-09 batch.

---

## Summary

Reviewed all 16 PRs as a meticulous code reviewer. Found **3
high-priority issues** worth follow-up PRs (all shipped), **3
medium-priority** observations (deferred or doc-only), and **3
low-priority nits** (left as future cleanup). Audit also caught
**3 merge conflicts** during sequential merge; all resolved
cleanly.

## High-priority follow-ups (shipped)

### A) `cleanupLegacyStatePayload` didn't update S3 — **PR #508**

PR #492 added the cleanup proc but only wrote the heartbeat to the
DB row. `loadDashboardPayload` reads DB first, falls back to S3 on
null/throw — so a future DB-row prune (TTL, manual delete, schema
migration) would resurrect the legacy 42 KB datasetManifest blob
via the storage path. The `saveState.superRefine` validator only
runs on the WRITE path; it can't catch a stale READ.

**Fix:** mirror saveState's two-tier write (DB + S3) inside the
cleanup proc. S3 write wrapped in try/catch so an outage doesn't
fail the cleanup. New `storageSynced` field in audit log + return
shape.

### B) `pruneOldTerminalDatasetUploadJobs` did N+1 deletes — **PR #509**

PR #503 used `deleteDatasetUploadJob` per row inside the prune
loop. Total round-trips per sweep tick: 1 SELECT + (1 SELECT + 2
DELETEs) per row = **2N+1**. On a scope with 1,000 stale terminal
rows, that's **2,001 round-trips per 5-minute sweep** — measurable
load.

**Fix:** two bulk DELETEs (children-by-subquery, then
parents-by-predicate). Always 2 round-trips regardless of N. The
single-row `deleteDatasetUploadJob` is preserved for non-prune
callers.

### C) `setInterval` in #496 was module-level — **PR #510**

PR #496 called `setInterval(logSemaphoreState, 30_000)` at module
load. Every test that imported `solarRecDashboardRouter.ts` started
a real timer; `unref()` kept Node from hanging but produced stray
log lines and risked future-test reliability.

**Fix:** wrap in `startDashboardLoadSemaphoreObservability()`
called from `_core/index.ts` at server boot under the
`shouldMutateProdState()` gate. Mirrors the
`startDatasetUploadStaleJobSweeper` pattern. New regression test
asserts NO module-level `setInterval` in the file.

---

## Medium-priority observations

### D) `pruneOldComputedArtifacts` runs on every upsert (#500) — **deferred**

Every `upsertComputedArtifact` triggers a fire-and-forget prune
pass: 1 SELECT (covered by the
`sr_computed_artifacts_scope_type_updated_idx` index) + 1
conditional DELETE. Worst-case ~5-15 ms per upsert under healthy
load.

For now this is acceptable: build runs fire 5 upserts (one per fact
artifact), so 5 prune passes per build. Total overhead < 100 ms,
amortized against a 5-15 minute build cycle.

**Mitigation if it becomes a problem:** lazy debounce via
per-`(scopeId, type)` timer, or threshold gate (`COUNT(*) > 10`).
Defer until p99 latency on `upsertComputedArtifact` shows it's
needed.

### E) `buildDashboardSystemFacts.ts` carries an extra `part2EligibleCount` field

The other 4 builders converted in #505 don't have this field. The
metric API supports caller-supplied extras intentionally, so the
inconsistency is by design. **Doc-only mitigation:** when CLAUDE.md
lists the per-builder metric shapes, note the per-builder extras
explicitly. Not blocking.

### F) System snapshot consumer audit (#498) has TBDs

6 of 9 caller field-reads marked TBD. The doc shipped as a
planning artifact, but consumer-by-consumer field reads need to be
filled in before scoping the next Phase 8 retirement step.
**Follow-up:** complete the table when the next consumer-retirement
PR series begins.

---

## Low-priority nits (left)

### G) 30s semaphore interval (#496) isn't env-tunable

Hardcoded `SEMAPHORE_LOG_INTERVAL_MS = 30_000`. Other env
thresholds (`DASHBOARD_HEAP_PRESSURE_REJECT_BYTES`, etc.) ARE
tunable. Consistent ops surface would tune-able all of them. Not
worth a PR until ops actually wants to change it.

### H) `pruneOldComputedArtifacts` keep=0 test doesn't pin the clamp directly

The test for `keep: 0` asserts the helper proceeds (returns
`deleteAffected` count from the stub) but doesn't directly
verify the SELECT ran with `LIMIT 1` (the clamped value). Not a
correctness issue — the existing test still passes because the
helper IS clamping internally. Tightening the test would mean
inspecting the stub's `limitCalled` count, which the existing stub
doesn't expose. Skip.

### I) CLAUDE.md "1.68 GB residual not yet attributed" wording (#495)

PR #500 (foundation-v1 TTL prune) + PR #500's docs partly resolved
this. The wording in PR #495's CLAUDE.md addition was already
updated during the #507 conflict resolution to reflect the
attribution, so this is now closed.

---

## Conflicts resolved during sequential merge

Three PRs had merge conflicts after PRs ahead of them landed:

1. **#502** (setImmediate yield placement) conflicted with #494
   (heap-log placement). Both touched the same per-page block in
   the perf-ratio runner. Resolved by ordering: yield → heap log
   (with `drainSize=` field from #494) → early-return.

2. **#506** (perf-ratio metric API) conflicted with #502 + #505
   (which converted the OTHER 4 builders). Resolved by re-applying
   the metric-API conversion fresh on top of post-#505 main.

3. **#507** (CLAUDE.md hard rule #9) conflicted with #495
   (CLAUDE.md state.json subsection). Resolved by keeping both —
   #9 in the numbered hard-rules list, state.json subsection
   following.

All three conflicts came from the same root cause: PRs touching
the same file in different ways without strict ordering. Future
batches with high inter-PR file overlap should either land
sequentially or re-rebase before push.

---

## What this review confirmed about the batch

Most of the batch was clean. The 3 high-priority issues were:
- #492's missing S3 write (subtle — not visible in the unit
  tests, only in the read-fallback semantics)
- #503's N+1 query pattern (visible from a careful read; not
  caught at code-review time)
- #496's module-level setInterval (caught by reading the import
  flow + thinking about test impact)

The post-merge self-review pattern (per
`feedback_post_merge_self_review.md`) is doing exactly what the
memory rule was put in place to do: catch real bugs that code
review missed. Memory rule remains worth following.

---

## Cross-references

- **PR #508**: cleanupLegacyStatePayload also writes S3 (fix A)
- **PR #509**: bulk-delete in pruneOldTerminalDatasetUploadJobs
  (fix B)
- **PR #510**: testable startDashboardLoadSemaphoreObservability
  (fix C)
- **`docs/h1-prod-baseline-attribution.md`** (PR #499): the H-1
  audit that surfaced the accumulation patterns
- **`feedback_post_merge_self_review.md`**: the memory rule that
  drove this audit
