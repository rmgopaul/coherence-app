# ABP Settlement run-row retention audit

**Date**: 2026-05-08
**Status**: Audit only — no code changes shipped with this doc.
**Owner**: tracking item on the Phase 6/7 docket.

---

## Observed state on prod

The 2026-05-08 storage-table audit (see
`docs/h1-prod-baseline-attribution.md`) surfaced four
`abpSettlement:run:*` storage keys on scope-user-1, each ~40 MB:

```
prefix                                      n_rows  total_bytes
abpSettlement:run:Sj1VTWvADTp69SXhVmC4B          46  40,905,717  (~40 MB)
abpSettlement:run:Kf7oxIY8pdjl-GT14sSLj          45  40,085,481
abpSettlement:run:y0C2TvFAjqSebmzMF3nuU          45  40,071,781
abpSettlement:run:VU9MBgW53RGotN41KABSO          45  39,803,352
```

**Total: 4 runs × 40 MB ≈ 160 MB of storage** for one scope. Each
run carries its own ~45-46 chunked storage rows.

The runs live in `solarRecDashboardStorage` under
`storageKey = "abpSettlement:run:<runId>"` (see
`server/routers/helpers/jobRunnerState.ts ::
makeAbpSettlementRunStorageKey`). The runs index lives at
`storageKey = "abpSettlement:runs-index"`.

---

## How rows accumulate

Every `saveRun` mutation on `solarRecDashboard.abpSettlement` writes
a NEW chunked-CSV blob keyed by `runId`. The index gets updated to
point at the new row. **The previous row is never deleted.**

`saveRun`'s docstring on the proc (lines ~362-401) describes the
flow but doesn't mention retention. Looking through the helpers:

  - `saveAbpSettlementRun` writes the run + updates the index
  - `getAbpSettlementRun` reads a single run
  - `getAbpSettlementRunsIndex` lists run metadata
  - **No `deleteAbpSettlementRun` or `pruneOldAbpSettlementRuns` helper exists.**

So today, every settlement run accumulates indefinitely. A user
running once a month adds 40 MB/month forever; a user running
weekly adds 160 MB/month.

---

## Why this isn't an immediate OOM risk

These rows are persistent storage, NOT in-memory state. They only
load into heap when:

  1. The `getRun` proc is called for a specific `runId` (loads that
     one run's payload, ~40 MB)
  2. The `listRuns` proc is called (loads only the small index;
     ~10-20 KB total)

So the OOM blast radius is bounded to ~40 MB per concurrent
`getRun` reader. That's significant but not catastrophic on a
4 GB Render box — the H-0 circuit-breaker (PR #489) catches it
before the heap crosses the V8 ceiling.

The slow-burn risk is DB storage growth: 160 MB today × N months
× M users = unbounded. TiDB's storage cost is ~free in absolute
terms but the table-scan cost on
`solarRecDashboardStorage` grows linearly with row count.

---

## Three retention options

### Option A — TTL by age

Keep runs newer than N days (e.g. 90), delete older rows during
the existing dataset-upload sweeper tick.

**Pro**: simple to implement; mirrors the
`pruneOldTerminalDatasetUploadJobs` pattern shipped in PR #503.
**Con**: a user revisiting a 6-month-old settlement loses access.
Need product confirmation that 90 days is enough.

### Option B — Keep newest N per scope

Keep the newest 10 runs per scope, delete older ones.

**Pro**: bounded total regardless of velocity. No surprise loss
if the user runs settlement infrequently.
**Con**: a high-velocity user can lose 2-week-old runs;
threshold needs product input.

### Option C — User-driven delete with no auto-prune

Add a `deleteRun` proc + UI button. No automatic deletion;
audit trail is opt-in user action.

**Pro**: zero auto-deletion risk. Aligns with "audit log" semantics
(historical runs are intentionally preserved).
**Con**: the 160 MB doesn't reclaim itself; relies on user
discipline.

---

## Recommendation

**Defer until product input.** This isn't a Phase 6/7 critical-path
item — the blast radius is bounded by the H-0 circuit-breaker,
and 160 MB on a 4 GB box isn't actively harming anyone today.

The right next step is asking the product owner:

  - Has anyone ever revisited an older-than-90-day settlement run?
    (If yes → Option C; if no → Option A)
  - Should there be a hard cap on retained runs per scope?
    (Option B with N=10 is conservative)
  - Is "auto-delete after N days" acceptable for compliance/audit?
    (Some shops want indefinite retention)

The audit of consumer paths shows no programmatic dependency on
historical runs beyond the index — the only readers are the
`getRun` proc (one runId at a time) and the `listRuns` proc (which
returns metadata only). So any of A/B/C is technically safe.

---

## Cross-reference

- H-1 baseline attribution: `docs/h1-prod-baseline-attribution.md`
  (this audit's parent — the storage-size table that surfaced the
  4 × 40 MB observation)
- Dataset-upload TTL prune: PR #503 (the pattern Option A would
  mirror)
- ABP settlement run helpers:
  `server/routers/helpers/jobRunnerState.ts` (lines ~97-320)
- ABP settlement router: `server/_core/solarRecAbpSettlementRouter.ts`
  (procs `saveRun` / `getRun` / `listRuns`)
