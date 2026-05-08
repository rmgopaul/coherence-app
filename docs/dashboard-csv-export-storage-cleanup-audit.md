# Dashboard CSV export — storage cleanup audit

**Date**: 2026-05-09
**Status**: Audit-only. Captures the current cleanup paths,
transitional debt, and observability gaps. No code changes
included; action items at the bottom.

Companion to:
- `CLAUDE.md` "Solar REC Dashboard data flow" → "Remaining
  background-job transitional debt"
- `docs/post-merge-self-review-2026-05-09.md` (the audit doc that
  filed PR-D in its deferred queue)

---

## Scope

Storage artifacts produced by the dashboard CSV export pipeline
in `server/services/solar/dashboardCsvExportJobs.ts`. Out of
scope:

- ABP settlement runs (`abpSettlement:run:*`) — see
  `docs/abp-settlement-run-retention-audit.md`
- System snapshot blobs (`snapshot:system:*`) — see
  `docs/system-snapshot-consumer-audit.md`
- Chunked-CSV dataset blobs (`dataset chunks` prefix) — see
  CLAUDE.md "Solar REC Dashboard data flow" for the storage
  layer overview

---

## Storage key shapes

Every CSV export uploads its artifact to a deterministic key
derived from the job row:

```
solar-rec-dashboard/<scopeId>/exports/<jobId>-<safeClaimId>.csv
```

`safeClaimId` is `encodeURIComponent(claimedBy)` where
`claimedBy = pid-${pid}-host-${hostname}-${suffix}` and `suffix`
is a 4-byte random hex (per the cross-process safety pattern in
hard rule #8). The claim-scoped suffix means a stale worker that
won and lost its claim cannot delete the artifact a *later*
successful retry just wrote.

**Legacy variant** (only for jobs with
`runnerVersion = "dashboard-csv-export-jobs-v3-heartbeat"`):
```
solar-rec-dashboard/<scopeId>/exports/<jobId>-<fileName>
```
This shape predates the claim-scoping fix and is reachable only
for rows already terminal at the time of the migration. New
exports never write this shape.

Source of truth: `storageKeyForJob` in
`server/services/solar/dashboardCsvExportJobs.ts:245`.

---

## Cleanup paths

Two distinct cleanup hooks fire `storageDelete`:

### 1. Mid-flight cleanup — `cleanupUploadedArtifact`

Triggered when the runner uploaded the artifact then hit a
post-upload error (lost claim, post-upload exception, runner
timeout during success completion). Wraps `storageDelete` in a
try/catch; logs `[dashboard:csv-export-jobs] cleanup
storageDelete failed for orphaned <reason> artifact …` on
failure.

Reasons that surface here:
- `lost-claim` — the success-completion UPDATE found
  `claimedBy ≠ ours` (stale-claim sweep took our claim).
- `post-upload-error` — exception thrown after `storagePut`
  succeeded.
- `runner-timeout` — `EXPORT_RUNNER_TIMEOUT_MS = 25 min`
  reached after the upload but before completion.

### 2. TTL prune sweep — `sweepStaleAndPruned`

Fired:
- Opportunistically on every `getDashboardCsvExportJobStatus`
  read.
- On a 5-minute periodic timer (PR #513,
  `startDashboardCsvExportStaleJobSweeper`).

For each terminal row past `JOB_TTL_MS = 30 min`:
1. `pruneTerminalDashboardCsvExportJobs` deletes the row.
2. The sweeper fires `storageDelete(key)` (fire-and-forget,
   `.catch` swallow).
3. On `storageDelete` failure, logs `[dashboard:csv-export-jobs]
   cleanup storageDelete failed for jobId=<id>: <message>`.

Order is intentional: row delete first, then artifact. If the
process crashes between the two, the artifact is orphaned with no
DB row pointing to it — recoverable only via the storage-bucket
lifecycle policy (see "Transitional debt" below).

---

## What's working

- **Local mode** (dev, tests): `storageDelete` removes files via
  `unlink`; missing files count as success. `solarRecDashboard
  CsvExportJobs.test.ts:1103` covers this path with a stub.
- **Proxy mode** (prod): the runner timeout, claim-scoped
  artifact key, and atomic `claimedBy` predicate together
  prevent the most common orphan source — a stale worker
  re-uploading or deleting an artifact a later retry just wrote.
- **Cross-process race safety** is verified by the contract
  tests in `dashboardCsvExportJobs.test.ts` ("late-put-timeout"
  and "late-complete-timeout" cases).
- **Storage cleanup never blocks the row sweep.** A failed
  proxy delete logs and returns `{ deleted: false, mode:
  "proxy" }`; the row delete is independent and has already
  succeeded by the time the storage call runs.

---

## Transitional debt

### A) Proxy `storageDelete` is best-effort with no retry

`storageDelete` in proxy mode (`server/storage.ts:339`) calls
`DELETE` on the Forge proxy with a 10 s timeout
(`STORAGE_PROXY_DELETE_TIMEOUT_MS`) and gives up on failure.
There is no retry, no backoff, no operator queue. The
deployed-but-unhealthy proxy that returns 502 for 30 minutes
during an incident permanently leaks every artifact whose row
TTL elapsed during the window.

**Mitigation today:** the storage bucket's own lifecycle policy
(if configured) reclaims old objects regardless of whether
`storageDelete` was called. CLAUDE.md cites this as the safety
net but **the policy is bucket-level configuration outside this
codebase** — auditing that it's actually configured + targeting
the `exports/*` prefix is an operator task, not a code task.

### B) Cleanup failures have no metric, only console.warn

Every `storageDelete` failure logs to stderr but emits no
structured metric. An operator wanting to answer "how many
orphan artifacts have we accumulated this week?" has to grep
logs across all instances of the deploy. There is no
`[dashboard:csv-export-jobs] cleanup-fail-rate` line, no count
exposed via `getDashboardCsvExportJobStatus` or any other proc.

Compare to the runner's terminal-state metric line, which IS
structured (`startDashboardJobMetric` envelope) and grep-able by
a single `outcome:"failed"` filter. Cleanup failures sit
outside that envelope.

### C) No orphan detector / reconciler

There is no programmatic way to list `solar-rec-dashboard/*/
exports/*` keys and check for matching `dashboardCsvExportJobs`
rows. `server/storage.ts` does not export a `storageList`
function. An orphan from any source (proxy delete failure, race
in a hypothetical bug, lifecycle-policy lag) is invisible until
the bucket fills.

This is the inverse of the H-1 audit story for `solarRecComputed
Artifacts`: there we knew the table grew because a direct DB
query showed 29 rows; here we have no equivalent surface for the
storage bucket.

### D) `getDashboardCsvExportJobStatus`'s opportunistic sweep
predates the boot-time periodic sweeper

PR #513 added `startDashboardCsvExportStaleJobSweeper` (5 min,
boot tick) so the failure mode of "no client polls the orphan"
no longer leaves stuck rows. The pre-PR-513 stuck-row scenario
on the build module turned up the gap; the CSV export module had
the same latent bug. With #513 deployed, opportunistic + periodic
sweeps both run, so storage cleanup fires on both code paths.

This entry is not a gap — it's confirmation that #513 closed it.
Listed here only so the storyline is complete.

---

## Observability gaps (concrete proposals)

Listed in priority order. None are blocking; they're the
candidates if PR-D becomes a code PR after this audit.

1. **Add a structured metric line for cleanup-failure events.**
   Fields: `jobId`, `key`, `mode` (`proxy`/`local`), `error`.
   Prefix `[dashboard:csv-export-jobs]` so it slots into the
   existing log-filter convention. A `cleanup-result` line per
   sweep-tick (with success / failure counts) gives the
   accumulated weekly view without per-failure log spam.

2. **Add a `getDashboardCsvExportCleanupHealth` admin proc.**
   Returns last-N-tick counts: prune attempts, prune successes,
   storageDelete attempts, storageDelete successes,
   storageDelete failures. Read-only, admin-tier, < 1 KB
   response. This is the operator equivalent of the structured
   metric — shows up in the Settings → Storage tab without
   needing log access.

3. **Add a `storageList(prefix)` helper.** Local mode reads the
   filesystem; proxy mode calls a hypothetical
   `GET /v1/storage/list?prefix=...`. If the proxy doesn't
   support it, document that and skip — a partial implementation
   in local mode still helps dev sanity-checks. Once it exists,
   an `auditOrphanArtifacts(prefix)` helper that joins against
   `dashboardCsvExportJobs` rows becomes trivial.

4. **Consider a retry path for transient proxy failures.**
   `storageDelete` is best-effort by contract; a retry queue
   would change the contract. Probably not worth it — the
   bucket lifecycle policy is the right home for "deal with
   orphans the proxy can't reach right now."

---

## Action items

| # | Item | Owner | Status |
|---|---|---|---|
| 1 | Confirm bucket lifecycle policy targets `solar-rec-dashboard/*/exports/*` keys with TTL ≥ JOB_TTL_MS + safety margin | Operator (Rhett / infra) | Pending |
| 2 | Grep stderr logs for `[dashboard:csv-export-jobs] cleanup storageDelete failed` to estimate current failure rate on prod | Operator | Pending |
| 3 | If failure rate > ~1% per week, ship observability gap #1 (structured metric line) | Future PR | Deferred |
| 4 | If a leak surfaces, ship observability gap #3 (`storageList` helper + orphan reconciler) | Future PR | Deferred |

The "do nothing" outcome is acceptable: the cleanup paths are
correct in steady state, the worst-case bound is "orphan
artifacts until lifecycle policy reclaims them," and the
post-PR-513 periodic sweep keeps the failure surface small.
This audit's job is to make sure that bound is **known** —
not to prematurely ship hardening for a problem that hasn't
demonstrated itself.

---

## Cross-references

- `server/services/solar/dashboardCsvExportJobs.ts` — runner +
  sweep + cleanup paths
- `server/storage.ts` — `storageDelete` contract
- `CLAUDE.md` "Remaining background-job transitional debt" — the
  citation that flagged this audit
- `docs/post-merge-self-review-2026-05-09.md` — PR-D origin in
  the deferred queue
- `docs/h2-prod-baseline-post-cleanup.md` — companion audit on
  DB-side cleanup
- **PR #513** — boot-time stale sweepers (closed gap D above)
- **PR #346**, **PR #347** — original CSV export background-job
  introduction (replaced direct CSV-through-tRPC procs)
- **PR #352** — `notFound is retryable` workaround (reverted in
  Phase 6 PR-B)
