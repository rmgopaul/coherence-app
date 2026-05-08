# Phase H-1 prod baseline attribution

**Date**: 2026-05-08
**Status**: Captures direct DB observation. The H-1 diagnostic
proc (`debugProcessMemorySnapshot`, PR #490) is live but requires
admin auth to call; pending an operator-in-the-loop session to
capture live `process.memoryUsage()`.

---

## What the storage layer reveals

A `solarRecComputedArtifacts` + `solarRecDashboardStorage` audit on
the canonical prod scope (`scope-user-1`) on 2026-05-08:

### `solarRecComputedArtifacts` — accumulating cache rows

The `foundation-v1` artifact type is the heaviest cache entry, at
**~5.7 MB per row** (32,627 systems × ~175 bytes/system serialized).
Each cache row is keyed by `inputVersionHash` — a fresh hash every
time the input dataset combo changes. **Old hashes are never pruned.**

Top 20 cache rows by size, all for `scope-user-1`:

```
artifactType   bytes      rowCount  updatedAt
foundation-v1  5,806,423  32,627    2026-05-05T20:52:51Z
foundation-v1  5,806,423  32,627    2026-05-05T20:45:37Z
foundation-v1  5,732,173  32,627    2026-05-06T07:44:55Z
foundation-v1  5,731,970  32,627    2026-05-06T01:03:53Z
foundation-v1  5,729,503  32,632    2026-05-08T06:41:09Z
... (15 more rows, all 5.6-5.8 MB)
```

**Total foundation-v1 storage on prod: 20+ rows × ~5.7 MB = ≥114 MB
just for one artifactType.**

### `solarRecDashboardStorage` — snapshot blobs

```
prefix                                     n_rows  total_bytes
dataset chunks                             37,586  9,496,150,225  (~9.5 GB — by-design heavy)
dataset top-level                             131  95,894,476     (~95 MB)
abpSettlement:run:Sj1VTWvADTp69SXhVmC4B        46  40,905,717     (one settlement run)
abpSettlement:run:Kf7oxIY8pdjl-GT14sSLj        45  40,085,481     (another)
abpSettlement:run:y0C2TvFAjqSebmzMF3nuU        45  40,071,781
abpSettlement:run:VU9MBgW53RGotN41KABSO        45  39,803,352
snapshot:system:190e54d26cf40df1               31  27,093,958     (one system snapshot, ~27 MB)
snapshot:system:492d092bce959dda               31  27,093,954     (another)
snapshot:system:6e8e996597558a8f               31  27,093,887
... (11 more, all ~27 MB each)
```

**`snapshot:system:*` shows at least 14 distinct system snapshots
persisted, each ~27 MB. 14 × 27 MB ≈ 378 MB of snapshot storage rows
on disk for one scope.**

---

## Why this matters for the OOM

DB storage size doesn't directly translate to heap pressure — these
rows don't load themselves into memory. But:

1. **Every cache miss reloads the snapshot** (~27 MB) into the
   calling aggregator's heap (see
   `docs/system-snapshot-consumer-audit.md` for the call sites).

2. **Drizzle's `select().from(table)` enumerates every column.** A
   query against `solarRecComputedArtifacts` that doesn't narrow
   columns returns every row's `payload` text (5+ MB each), even if
   only the metadata is used.

3. **Cache invalidation churns memory.** When `inputVersionHash`
   changes, the new artifact row is written and the OLD cache row
   stays. The next reader gets the new payload; the old payload sits
   in `solarRecComputedArtifacts` indefinitely. Over many input
   revisions, the table grows.

4. **The build runner's static-input maps** (per Phase H-0 and the
   step-4 hardening series) materialize ~26k systems × tokens +
   ~243k abp + ~273k solar-app entries during a build cycle. That's
   ~100 MB of in-process state PER build, sitting in heap until the
   build cycle completes.

Stack 2-3 of these together (a build cycle in progress + a tab read
that re-loads the snapshot via an aggregator + a slow CSV export
that holds rows) and the 1.68 GB residual baseline is plausible
without any single allocator being wrong.

---

## Three concrete attribution candidates

Ranked by likelihood of dominating the residual baseline:

1. **`foundation-v1` artifact bloat in
   `solarRecComputedArtifacts`.** ≥20 rows × 5.7 MB sit on disk;
   if any module-level cache holds two or three concurrently
   (e.g. background sync + foreground request), that's ~17 MB of
   resident heap *just* for foundation. Mitigation: TTL prune of
   old `inputVersionHash` rows (keep newest N per
   `(scopeId, artifactType)` tuple).

2. **System snapshot held in heap across consumers.** The 9 callers
   in `docs/system-snapshot-consumer-audit.md` all receive
   ~26-27 MB. With concurrent aggregator calls, V8 holds multiple
   copies simultaneously. Mitigation: build-cycle-bounded snapshot
   release (Option B from the consumer-audit doc).

3. **Build runner static-input maps.** Step 4 (perf-ratio) loads
   abpReport + solarApplications + accountSolarGen + generationEntry
   + generatorDetails + annualProductionEstimates — even with the
   per-page streaming (PR #482, #488), the resulting Maps sit in
   heap for the duration of step 4 (~10-15 min on prod-shape data).
   Mitigation: emit those maps to a side-cache fact table after
   build and read paginated rather than holding them.

---

## What we still need

Live `process.memoryUsage()` + V8 `getHeapStatistics()` from a
cache-miss build cycle is the missing data point. The H-1
diagnostic proc landed in PR #490 but needs an operator session
to invoke (admin-tier permission). Once captured, this doc gets
amended with:

- Heap floor between idle ticks
- Heap-after delta during a build cycle's step 0 → step 4
- Cache-hit vs cache-miss heap delta comparison
- `numberOfDetachedContexts` (closure-leak signal — non-zero is the
  smoking gun for a leaked Map/Set)

The right next PR after this audit is therefore:

- **Either** the foundation-v1 TTL prune (#1 attribution candidate
  is testable without operator access)
- **Or** the H-1 operator session captures, with this doc updated
  to lock in the actual attribution

Recommendation: ship the foundation-v1 TTL prune first — it's
unconditionally correct (we should never accumulate more than ~5
old cache rows per scope) and it removes the easiest-to-attribute
candidate. After it deploys, capture H-1 data on the next OOM
recurrence to attribute the remainder.

---

## Cross-reference

- Phase H wrap-up: PR #492
- Consumer audit: `docs/system-snapshot-consumer-audit.md`
- H-0 circuit-breakers: PR #489
- H-1 diagnostic proc: PR #490
