# 2026-05-09 QA-walk follow-ups: deferred work plan

The 2026-05-09 prod QA-walk shipped 7 fix PRs (#530, #531, #532, #533,
#534, #535, #536). Several issues surfaced during meticulous post-merge
self-review were intentionally deferred — small NITs, cross-PR
correctness questions, and resilience layers that depended on a more
complete picture of the system. This doc enumerates those items and
groups them into focused follow-up PRs.

The packaging principle: **one PR per architectural concern, not one
PR per finding.** A handful of small NITs in the same module ship as
one cleanup PR; resilience-layer items that share a tRPC-link surface
ship together; Schedule B hardening items share a defensive concern
even though they're independent fixes.

---

## Items — by source

### From the original PR summary's "Known follow-ups (documented but
deferred)" section

1. **Slim vs heavy aggregator correctness drift.** Both PR-4 (#533)
   and PR-7 (#536) pin shared count fields to slim "for stability,"
   but the underlying ~$90K / ~25–60-per-tile divergence between
   slim and heavy is unresolved. Picking ONE source resolved the
   user-visible bug, but it left an open correctness question:
   which aggregator is "right" for these fields, and what's the
   structural cause of the drift?

2. **Snapshot log scale step-change at PR-4 cutover.** Log entries
   created post-PR-4 use slim values; existing localStorage entries
   use the row-walk values they were originally captured under. The
   trend chart blends them into one line with no visual marker, so
   a user reviewing snapshot history sees a $90K-ish discontinuity
   on the day PR-4 deployed.

3. **`Retry-After` header — server sends, client ignores.** PR-6
   (#535) wired the server to emit `Retry-After: 5` on heap-pressure
   rejections, but `dashboardTransientRetryDelay` doesn't read
   response headers (React Query's `retryDelay` callback doesn't
   surface them). Bridging that gap is in scope for a follow-up.

4. **Schedule B server-side semaphore — defense in depth.** PR-3
   (#532) fixed the client-side dep-array churn that caused the
   11-concurrent-mutation fan-out. The mutation handler itself has
   no server-side concurrency guard — a defective client OR a
   network race could still produce concurrent applies. Server-side
   semaphore would be belt-and-braces.

### From individual PR reviews (post-merge meticulous reviewer)

5. **PR-1 NITs.** (a) `processedCrossSourceKeys` Set heap cost
   grows linearly (~20–50 MB on 225k rows) — call this out in a
   comment. (b) Parser's `parsed.dedupedConvertedReads = 0` mutates
   the input — minor code smell. (c) The cross-source dedup key
   construction would benefit from extraction into a named helper
   for testability and code reuse.

6. **PR-3 stale closure on `successful.length`.** When the timer
   body is mid-await and new results arrive, the body completes
   with the OLD count, and the next effect re-fire sees
   `lastAppliedCount === successful.length` (because optimistic
   advance already happened), so it short-circuits via
   "no-new-results" — silently delaying the new batch up to 30s.
   Real UX cost during active scans.

7. **PR-4 totalGap basis mismatch.** `totalGap` is computed as
   `slim.totalContractedValue − rowWalk.totalDeliveredValue`. Slim's
   contracted is canonical Part-II foundation; rowWalk's delivered
   is page-walk facts. Different system sets → systemic bias in
   the gap (~$90K). Need to either (a) document the mix as
   acceptable or (b) compute totalGap from a consistent source.

8. **PR-4 OverviewTab row-walk fallback is dead code.** Pre-PR-4
   the fallback fired when `slimPart2Totals === null` and the
   page-walk had data. Post-PR-4 the slim summary always loads
   before any heavy tab activates, making the fallback unreachable
   in practice. Remove.

9. **PR-4 no OverviewTab regression test.** A future "let's
   prefer rowWalk again when length>0" diff to `OverviewTab.tsx`
   would re-introduce Bug #7 with no failing test. Add a test that
   asserts the slim-pin invariant.

10. **PR-5 toast UX misleading.** "click Log Snapshot again in a
    moment" gives no progress signal during the 20s walk. User can
    spam-click and just retoast.

11. **PR-5 naming inconsistency.** `snapshotPart2WalkRequested`
    (past participle) vs the existing `hasUserInteractedWithDashboard`
    (predicate verb). Mirror the existing pattern.

12. **PR-6 QueryClient global default.** `retry: 2` (the default
    in `solar-rec-main.tsx`) retries on 4xx-other (e.g. 401 after
    token expiry). PR-6's policy excludes those for the 3 modified
    tabs only; the rest of the dashboard inherits the unfiltered
    default. Apply the policy globally.

---

## PR packaging

### PR-FU-1: Slim vs heavy aggregator drift investigation
**Items:** #1
**Shape:** Diagnostic-first. Add a small comparison harness
(`server/services/solar/compareSlimVsHeavySummary.ts`) that takes
the two aggregators' outputs for a given scope and emits a
structured diff. Wire a diagnostic admin proc + a dev-time CLI
script. Document findings in
`docs/slim-vs-heavy-summary-drift.md` — likely a structural
explanation (first-CSG-by-row dedup vs. snapshot-pre-derived
field) with a recommendation: align the two paths OR keep the
current pin if alignment is too costly.

The harness becomes a reusable tool for any future "are these two
aggregators agreeing on prod data?" question.

### PR-FU-2: Resilience stack — Retry-After honoring + global policy
**Items:** #3, #12
**Shape:** Custom tRPC link captures `Retry-After` from failed
responses and stuffs it into `error.data.retryAfterMs`. The retry
policy reads that field as a floor and uses
`max(retryAfterMs, jitteredDelay)` so the server's hint is
honored when present. The QueryClient default in
`solar-rec-main.tsx` swaps `retry: 2` for
`shouldRetryDashboardTransient` so 4xx-other don't retry
globally, only on transient overload. Tests cover the
header-extraction link, the retry-floor logic, and the global
default behavior on 401.

### PR-FU-3: Schedule B hardening — semaphore + stale-closure fix
**Items:** #4, #6
**Shape:** Server: add an in-process per-`(scopeId, jobId)`
semaphore on `applyScheduleBToDeliveryObligations`. Concurrent
calls for the same job coalesce — the second waits for the first
to complete and returns the same result (or just rejects with a
clean status). Client: after a successful timer body, re-evaluate
the throttle decision against the current `scheduleBResults`; if
new results arrived during the await, schedule a follow-up timer
immediately (subject to the 30s window). Defense-in-depth: the
client throttle stops the fan-out at the source; the semaphore
catches anything that slips through.

### PR-FU-4: Snapshot/Summary cleanup — log scale marker + dead code
+ naming + UX
**Items:** #2, #7, #8, #9, #10, #11
**Shape:**
- **Scale marker:** add a `valueSource: "slim" | "row-walk" | null`
  field to `DashboardLogEntry`. New entries set `"slim"`; old
  entries (from localStorage / cloud) remain `null`. The trend
  chart renders a vertical reference line at the FIRST entry
  whose `valueSource === "slim"` so the user can see the cutover
  visually. Hover tooltip explains.
- **`totalGap` basis:** add an inline comment explaining that
  `totalGap = slim.contracted − rowWalk.delivered` mixes bases
  (an acceptable ~$90K bias on $478M total) until heavy can
  ship `totalDeliveredValuePart2` to slim. Add a test guard.
- **OverviewTab dead code:** remove the row-walk fallback in
  `overviewPart2Totals` — slim is always loaded by the time a
  heavy tab activates. Document why the fallback is gone in the
  PR description.
- **OverviewTab regression test:** add a behavioral test that
  asserts the slim-pin contract (heavy values for shared count
  fields are NOT preferred when slim is present).
- **PR-5 naming:** rename `snapshotPart2WalkRequested` →
  `hasRequestedSnapshotPart2Walk` to mirror
  `hasUserInteractedWithDashboard`. Refactor + update the
  regression rail.
- **PR-5 progress indicator:** show the current page count /
  total estimate in the Snapshot Log surface while the walk runs,
  so the user has visual feedback after clicking Log Snapshot.

### PR-FU-5: Performance Ratio matcher hygiene
**Items:** #5
**Shape:** Tiny cleanup PR colocated in
`buildPerformanceRatioAggregates.ts`:
- Extract dedup-key construction into a named helper
  `buildCrossSourceDedupKey({...})` for code reuse + testability.
  Add unit tests for the helper.
- Replace the parser mutation pattern in
  `parsePerformanceRatioSummaryPayload` with a non-mutating
  `{ ...parsed, dedupedConvertedReads: parsed.dedupedConvertedReads ?? 0 }`.
- Add an inline comment on `processedCrossSourceKeys` Set
  acknowledging the linear heap cost (~50 chars × N rows × ~2
  bytes per char ≈ 20–50 MB on 225k rows) and noting that this
  is acceptable given the streaming-drain pattern bounds total
  matcher heap to 1 page's worth of fact rows + the dedup set.
- Add a test asserting the "duplicate of unmatched/invalid is
  counted as deduped" semantic explicitly (review WARN: the
  comment didn't acknowledge the choice).

---

## After PR drafting

Each follow-up PR is reviewed against the meticulous-reviewer
prompt. Findings consolidate into a single remediation PR
(`fix/qa-walk-followups-remediation`) addressing all WARN/BLOCKER
items across the 5 PRs. Then all 6 PRs (5 follow-ups + 1
remediation) merge.

---

## Items NOT addressed in this batch

- **Direct streaming to proxy storage** for dashboard CSV exports
  (per CLAUDE.md "Remaining background-job transitional debt").
  Existing scope; tracked separately in Phase 6+ of the dashboard
  rebuild.
- **Phase 2 derived-fact-table builds** for delivered-value and
  similar heavy fields. Larger architectural shift — adding slim
  support for `totalDeliveredValuePart2` is the right scope for
  PR-FU-4 to wave at, not solve.
- **Eliminating the row-walk fallback path entirely.** PR-FU-4
  removes one specific row-walk fallback (OverviewTab); the
  parent's `snapshotPart2ValueSummary` row-walk is kept as
  defense for the cold-mount window before slim resolves.
