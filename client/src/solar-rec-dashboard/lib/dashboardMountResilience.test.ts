/**
 * Source-level regression rails proving the Solar REC dashboard
 * default-Overview mount path does NOT enable the four legacy
 * oversized procedures or the legacy SystemRecord[] snapshot.
 *
 * Strategy: read the dashboard parent's source verbatim and assert
 * the textual gating predicates for each heavy query. This is a
 * cheap structural guard — a behavioral test would require booting
 * React + tRPC + a mock server, and would still need source-level
 * enforcement to prevent a future PR from regressing the gate.
 *
 * Failure mode: if a future PR removes a gate (e.g. drops the
 * `&& hasUserInteractedWithDashboard` clause), this test fails
 * immediately with a clear diff against the documented contract.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_FILE = resolve(
  __dirname,
  "..",
  "..",
  "features",
  "solar-rec",
  "SolarRecDashboard.tsx"
);

const SOURCE = readFileSync(DASHBOARD_FILE, "utf8");

/** Strip block + line comments so prose docstrings don't confuse the regex. */
function codeOnly(): string {
  return SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /(^|[^:])\/\/[^\n]*/g,
    "$1"
  );
}

describe("Solar REC dashboard mount: heavy-query gates", () => {
  const code = codeOnly();

  it("declares the hasUserInteractedWithDashboard interaction state", () => {
    expect(code).toMatch(
      /\[\s*hasUserInteractedWithDashboard\s*,\s*setHasUserInteractedWithDashboard\s*\][^;]*useState/
    );
  });

  it("getDashboardOverviewSummary is gated on isOverviewTabActive AND hasUserInteractedWithDashboard", () => {
    // Find the overview-summary useQuery call site.
    const block = extractUseQueryBlock(
      code,
      "getDashboardOverviewSummary.useQuery"
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(/enabled\s*:\s*[^,}]*isOverviewTabActive/);
    expect(block!).toMatch(/hasUserInteractedWithDashboard/);
  });

  it("getDashboardOfflineMonitoring is gated on a tab-active predicate AND hasUserInteractedWithDashboard", () => {
    const block = extractUseQueryBlock(
      code,
      "getDashboardOfflineMonitoring.useQuery"
    );
    expect(block).not.toBeNull();
    // Tab predicate is computed in a helper variable —
    // `isOfflineMonitoringHeavyNeeded` — that the gate references.
    expect(block!).toMatch(/isOfflineMonitoringHeavyNeeded/);
    expect(block!).toMatch(/hasUserInteractedWithDashboard/);
  });

  it("getDashboardChangeOwnership is gated on isChangeOwnershipTabActive AND hasUserInteractedWithDashboard", () => {
    const block = extractUseQueryBlock(
      code,
      "getDashboardChangeOwnership.useQuery"
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(/isChangeOwnershipTabActive/);
    expect(block!).toMatch(/hasUserInteractedWithDashboard/);
  });

  it("useSystemSnapshot is invoked with a narrow tab-specific predicate, not generic interaction", () => {
    // Generic-interaction gates re-enable the legacy 26 MB
    // SystemRecord[] payload as soon as the user clicks anything.
    // The predicate must be tab-specific.
    expect(code).toMatch(
      /useSystemSnapshot\s*\(\s*\{\s*[\s\S]*?enabled\s*:\s*isSystemSnapshotNeeded/
    );
    expect(code).toMatch(
      /const\s+isSystemSnapshotNeeded\s*=[\s\S]*?isAlertsTabActive[\s\S]*?isComparisonsTabActive[\s\S]*?isFinancialsTabActive[\s\S]*?isForecastTabActive[\s\S]*?selectedSystemKey/
    );
    // Generic interaction gating is NOT used for the snapshot.
    expect(code).not.toMatch(
      /useSystemSnapshot\s*\(\s*\{\s*[\s\S]{0,200}enabled\s*:\s*hasUserInteractedWithDashboard/
    );
  });

  it("URL-driven tab change flips hasUserInteractedWithDashboard", () => {
    // The URL useEffect calls setHasUserInteractedWithDashboard(true)
    // alongside setActiveTab so deep links don't permanently freeze
    // the gate at false.
    expect(code).toMatch(
      /getTabFromSearch\s*\([\s\S]*?setHasUserInteractedWithDashboard\s*\(\s*true\s*\)/
    );
  });

  it("getDashboardSummary (slim) fires unconditionally on mount — no enabled gate", () => {
    const block = extractUseQueryBlock(
      code,
      "getDashboardSummary.useQuery"
    );
    expect(block).not.toBeNull();
    expect(block!).not.toMatch(/enabled\s*:/);
  });

  it("CSV export uses the background-job flow (start + poll), not an inline tRPC CSV fetch", () => {
    // Both handlers must drive the background-job flow:
    //   startDashboardCsvExport (mutation) → poll
    //   getDashboardCsvExportJobStatus → triggerUrlDownload(url).
    // Inline `.fetch` of the old synchronous CSV procs is the bug
    // this PR retires — it returned MB-scale CSV strings through
    // tRPC and held the whole CSV in browser heap during the
    // response.
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(/startDashboardCsvExport\.mutateAsync/);
    expect(sharedHelper!).toMatch(
      /getDashboardCsvExportJobStatus\.fetch/
    );
    expect(sharedHelper!).toMatch(/triggerUrlDownload\s*\(/);

    // Both per-tile click handlers must dispatch through the shared
    // helper rather than open-coding the start/poll loop.
    const ownershipHandler = sliceFn(code, "downloadOwnershipCountTileCsv");
    expect(ownershipHandler).not.toBeNull();
    expect(ownershipHandler!).toMatch(/runDashboardCsvExport\s*\(/);
    const changeOwnershipHandler = sliceFn(
      code,
      "downloadChangeOwnershipCountTileCsv"
    );
    expect(changeOwnershipHandler).not.toBeNull();
    expect(changeOwnershipHandler!).toMatch(/runDashboardCsvExport\s*\(/);

    // The retired inline-CSV fetch shape must NOT reappear on either
    // handler.
    expect(code).not.toMatch(
      /exportOwnershipTileCsv\.fetch/
    );
    expect(code).not.toMatch(
      /exportChangeOwnershipTileCsv\.fetch/
    );

    // No window.alert in the export path — toasts only.
    expect(code).not.toMatch(/downloadOwnershipCountTileCsv[\s\S]{0,2000}window\.alert/);
    expect(code).not.toMatch(
      /downloadChangeOwnershipCountTileCsv[\s\S]{0,2000}window\.alert/
    );

    // Empty-result path: the shared helper surfaces "no rows" via
    // toast.error rather than triggering a 0-row download.
    expect(sharedHelper!).toMatch(
      /rowCount[\s\S]{0,200}toast\.error/
    );
  });

  it("CSV export handlers are wrapped in useCallback so memo()-ed OverviewTab doesn't churn every parent render", () => {
    // Inline arrow functions in props create a fresh ref every
    // render, defeating memo() on the consumer (`OverviewTab` here).
    // The shared helper + per-tile handlers must all be useCallback
    // so the prop refs stay stable.
    expect(code).toMatch(
      /const\s+runDashboardCsvExport\s*=\s*useCallback\s*\(/
    );
    expect(code).toMatch(
      /const\s+downloadOwnershipCountTileCsv\s*=\s*useCallback\s*\(/
    );
    expect(code).toMatch(
      /const\s+downloadChangeOwnershipCountTileCsv\s*=\s*useCallback\s*\(/
    );
  });

  it("CSV export `notFound` is retryable until TTL, not immediate failure (in-memory registry isn't durable across restarts)", () => {
    // Pre-fix the client treated `notFound` as terminal because
    // the comment claimed "the server only prunes terminal records
    // (per the running-prune skip rule), so this branch means the
    // artifact actually expired." That's only true under stable
    // process state. The in-memory `Map` registry in
    // `dashboardCsvExportJobs.ts` is wiped by any process restart
    // (deploy, OOM, future multi-instance routing) — those
    // clients then see notFound for a perfectly valid job that
    // simply got orphaned. Until Phase 6 (DB-backed registry), the
    // ONLY terminal client outcomes are: server `succeeded`,
    // server `failed`, start-mutation throw, or TTL exhaustion.
    // notFound joins the "transient retry" path with the same
    // "interrupted" toast UX as a poll error.
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    // Walk balanced braces to extract the notFound branch body
    // (a regex would match `}` inside template literals like
    // `${params.consoleTag}` and capture nothing).
    const notFoundIfIdx = sharedHelper!.search(
      /if\s*\(\s*status\.status\s*===\s*["']notFound["']\s*\)\s*\{/
    );
    expect(notFoundIfIdx).toBeGreaterThan(-1);
    const openBraceIdx = sharedHelper!.indexOf("{", notFoundIfIdx);
    let depth = 0;
    let closeBraceIdx = -1;
    for (let i = openBraceIdx; i < sharedHelper!.length; i++) {
      const ch = sharedHelper![i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          closeBraceIdx = i;
          break;
        }
      }
    }
    expect(closeBraceIdx).toBeGreaterThan(openBraceIdx);
    const branchBody = sharedHelper!.slice(openBraceIdx + 1, closeBraceIdx);

    // No early return out of the helper.
    expect(branchBody).not.toMatch(/\breturn\s*;/);
    // No toast.error (would be the user-visible "failed" surface).
    expect(branchBody).not.toMatch(/toast\.error/);
    // Must surface the interrupted UX so the user knows we're still
    // trying.
    expect(branchBody).toMatch(/setToastPhase\s*\(\s*["']interrupted["']/);
    // Must `continue` the polling loop.
    expect(branchBody).toMatch(/\bcontinue\s*;/);
  });

  it("CSV export status-poll errors are NOT terminal — the loop keeps polling until server terminal status or TTL", () => {
    // Pre-fix a transient `getDashboardCsvExportJobStatus.fetch(...)`
    // rejection (network blip, 5xx, rate limit) escaped the unguarded
    // `await` into the outer catch and surfaced "Failed to export"
    // while the server job was still running and might still write
    // the artifact. Same false-failure class as the original 120s
    // ceiling. The fix wraps the per-poll fetch in its own try/catch
    // and `continue`s the loop on transient errors.
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    // The status-poll fetch must live inside its own try/catch.
    expect(sharedHelper!).toMatch(
      /try\s*\{[\s\S]{0,400}getDashboardCsvExportJobStatus\.fetch[\s\S]{0,400}\}\s*catch\s*\(\s*pollError/
    );
    // The per-poll catch handler must `continue` (keep polling),
    // never `return` (stop polling).
    expect(sharedHelper!).toMatch(
      /catch\s*\(\s*pollError[\s\S]{0,400}continue\s*;/
    );
    // The "interrupted" UX must surface so the user knows we're
    // still trying.
    expect(sharedHelper!).toMatch(/setToastPhase\s*\(\s*["']interrupted["']\s*\)/);
    // The start mutation IS terminal — no jobId, nothing to poll.
    // Make sure the start mutation has its own try/catch separate
    // from the polling loop.
    expect(sharedHelper!).toMatch(
      /startDashboardCsvExport\.mutateAsync[\s\S]{0,400}catch\s*\(\s*error[\s\S]{0,300}return\s*;/
    );
  });

  it("CSV export poll horizon matches the server's 30-min job TTL (no false-failures at 120s)", () => {
    // Pre-fix the client gave up at 120s while the server's TTL is
    // 30 min, surfacing a "Failed" toast while the worker was still
    // running and leaving an orphaned artifact the user couldn't
    // download. The poll horizon must match the server's
    // dashboardCsvExportJobs.JOB_TTL_MS (30 min).
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(
      /CSV_EXPORT_POLL_MAX_MS\s*=\s*30\s*\*\s*60\s*\*\s*1000/
    );
    // The retired 120_000 ceiling must not reappear.
    expect(sharedHelper!).not.toMatch(/120_000|120000\b/);
  });

  it("CSV export poll backs off so a 30-min poll horizon doesn't hammer the server", () => {
    // The flat 1.5s loop would be 1200 polls over 30 min. The
    // backoff helper must transition fast → medium → slow.
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(/function\s+nextPollDelayMs/);
    // Sanity-check the three steps without pinning specific values
    // beyond the documented ladder.
    expect(sharedHelper!).toMatch(/return\s+1500\b/);
    expect(sharedHelper!).toMatch(/return\s+5000\b/);
    expect(sharedHelper!).toMatch(/return\s+15_000\b/);
  });

  it("CSV export updates the toast text after the hint threshold so a long-running export doesn't look stalled", () => {
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(
      /CSV_EXPORT_TOAST_HINT_AT_MS\s*=\s*30_000/
    );
    expect(sharedHelper!).toMatch(
      /toast\.loading\s*\(\s*params\.preparingMessage/
    );
    // Per-tile handlers must pass the hint message in.
    const ownershipHandler = sliceFn(code, "downloadOwnershipCountTileCsv");
    expect(ownershipHandler).not.toBeNull();
    expect(ownershipHandler!).toMatch(/preparingMessage\s*:/);
    const changeOwnershipHandler = sliceFn(
      code,
      "downloadChangeOwnershipCountTileCsv"
    );
    expect(changeOwnershipHandler).not.toBeNull();
    expect(changeOwnershipHandler!).toMatch(/preparingMessage\s*:/);
  });

  it("CSV export helper accepts initialMessage and per-tile callers pass it", () => {
    // PR #350 added the initialMessage prop so the helper can own
    // the initial loading toast (which it needs to be able to
    // revert to "initial" text on connection recovery before the
    // 30s hint threshold). Pin both the signature and the per-tile
    // wiring so a future refactor can't silently drop it.
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(/initialMessage\s*:\s*string/);
    const ownershipHandler = sliceFn(code, "downloadOwnershipCountTileCsv");
    expect(ownershipHandler).not.toBeNull();
    expect(ownershipHandler!).toMatch(/initialMessage\s*:/);
    const changeOwnershipHandler = sliceFn(
      code,
      "downloadChangeOwnershipCountTileCsv"
    );
    expect(changeOwnershipHandler).not.toBeNull();
    expect(changeOwnershipHandler!).toMatch(/initialMessage\s*:/);
  });

  it("CSV export helper OWNS the initial toast.loading call (per-tile handlers do not create toastId)", () => {
    // Pre-fix the per-tile handlers called `toast.loading(...)`
    // outside the helper and passed the resulting toastId in. The
    // helper had no way to revert to the initial text on
    // recovery — a poll error at 10s + recovery at 20s left the
    // user staring at "interrupted" until the 30s hint flipped it.
    // The fix moved toast.loading INTO the helper. Lock that:
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(
      /const\s+toastId\s*=\s*toast\.loading\s*\(\s*params\.initialMessage/
    );
    // Per-tile handlers must NOT call toast.loading directly
    // anymore (they used to pre-create the toastId).
    const ownershipHandler = sliceFn(code, "downloadOwnershipCountTileCsv");
    expect(ownershipHandler).not.toBeNull();
    expect(ownershipHandler!).not.toMatch(/toast\.loading\s*\(/);
    const changeOwnershipHandler = sliceFn(
      code,
      "downloadChangeOwnershipCountTileCsv"
    );
    expect(changeOwnershipHandler).not.toBeNull();
    expect(changeOwnershipHandler!).not.toMatch(/toast\.loading\s*\(/);
  });

  it("CSV export recovery from interrupted re-anchors to initial when elapsed < 30s", () => {
    // PR #350 added the recovery branch that lets the toast revert
    // from "interrupted" to the original "Preparing X…" text after
    // a poll succeeds before the hint threshold. The fix is the
    // `setToastPhase("initial")` arm at the bottom of the loop.
    // Lock that the helper has both arms.
    const sharedHelper = sliceFn(code, "runDashboardCsvExport");
    expect(sharedHelper).not.toBeNull();
    expect(sharedHelper!).toMatch(
      /setToastPhase\s*\([\s\S]{0,120}["']stillPreparing["'][\s\S]{0,120}["']initial["']/
    );
  });

  it("Snapshot Log tab hydrates from server (getSnapshotLogs) — local-only history is no longer canonical", () => {
    // Production scenario: localStorage holds 1 entry; cloud
    // (`solarRecDashboardStorage` rows) holds the historical 22-
    // entry log split between the main key and orphaned chunk
    // rows. Without server hydration the user sees 1 entry; with
    // the merge below they see all 22.
    expect(code).toMatch(
      /solarRecTrpc\.solarRecDashboard\.getSnapshotLogs\.useQuery/
    );
    // Query is gated on the Snapshot Log tab being active so it
    // doesn't fire on Overview mount (would push the heavy
    // recovery scan onto every dashboard load).
    expect(code).toMatch(
      /getSnapshotLogs\.useQuery\([\s\S]{0,400}enabled\s*:\s*isSnapshotLogTabActive/
    );
    // Merge helper exists.
    expect(code).toMatch(/function\s+mergeSnapshotLogEntriesForDisplay/);
  });

  it("Snapshot Log hydration is READ-ONLY — server entries do NOT enter logEntries (no accidental cloud write-back)", () => {
    // PR #354 follow-up — Codex P1 fix. Pre-fix the hydration
    // useEffect called
    //   setLogEntries((prev) => merge(prev, server))
    // which silently triggered the cloud-sync useEffect (which
    // watches `logEntries` and writes any signature change back
    // to REMOTE_SNAPSHOT_LOGS_KEY). Opening the Snapshot Log tab
    // therefore mutated production storage — the exact write-back
    // PR #353 explicitly deferred.
    //
    // The fix keeps server-recovered entries in a SEPARATE state
    // (`recoveredSnapshotLogEntries`) that the cloud-sync effect
    // does NOT depend on. This rail enforces the contract.
    expect(code).toMatch(
      /\[\s*recoveredSnapshotLogEntries\s*,\s*setRecoveredSnapshotLogEntries\s*\][^;]*useState/
    );
    // Hydration effect must call setRecoveredSnapshotLogEntries,
    // NEVER setLogEntries inside the snapshotLogsServerQuery effect.
    expect(code).toMatch(
      /snapshotLogsServerQuery\.data[\s\S]{0,1200}setRecoveredSnapshotLogEntries\s*\(/
    );
    // The retired write-back shape must NOT reappear: no
    // `setLogEntries((prev) => merge...)` anywhere referencing
    // server-recovered entries.
    expect(code).not.toMatch(
      /setLogEntries\s*\(\s*\(\s*prev\s*\)\s*=>\s*mergeServerSnapshotLogsIntoLocal/
    );
    expect(code).not.toMatch(
      /setLogEntries\s*\(\s*\(\s*prev\s*\)\s*=>\s*mergeSnapshotLogEntriesForDisplay/
    );
  });

  it("Snapshot Log tab receives the display-merged list, NOT the raw persisted logEntries", () => {
    // Display-only union: visibleSnapshotLogEntries = merge(
    //   logEntries,                  // local persisted state
    //   recoveredSnapshotLogEntries  // server-recovered (read-only)
    // )
    expect(code).toMatch(
      /const\s+visibleSnapshotLogEntries\s*=\s*useMemo\s*\([\s\S]{0,400}mergeSnapshotLogEntriesForDisplay\s*\(\s*logEntries\s*,\s*recoveredSnapshotLogEntries/
    );
    // SnapshotLogTabLazy JSX must receive the display-merged list,
    // NOT raw `logEntries`. Search for `<SnapshotLogTabLazy` (JSX
    // open tag) so the import declaration `const SnapshotLogTabLazy
    // = lazy(...)` doesn't false-positive. We slice only up to
    // the JSX close (`/>` for self-closing or
    // `</SnapshotLogTabLazy>`) so a downstream consumer that
    // legitimately passes `logEntries={logEntries}` (e.g. the
    // RecPerformanceEvaluation tab) doesn't false-positive.
    const tabIdx = code.indexOf("<SnapshotLogTabLazy");
    expect(tabIdx).toBeGreaterThan(-1);
    // Find the JSX close — first `/>` that isn't preceded by
    // another `<` open. For our component this is unambiguous.
    const closeIdx = code.indexOf("/>", tabIdx);
    expect(closeIdx).toBeGreaterThan(tabIdx);
    const propsRegion = code.slice(tabIdx, closeIdx);
    expect(propsRegion).toMatch(
      /logEntries=\{\s*visibleSnapshotLogEntries\s*\}/
    );
    // Belt-and-braces: NOT the raw logEntries (only inside the
    // SnapshotLogTabLazy props).
    expect(propsRegion).not.toMatch(/logEntries=\{\s*logEntries\s*\}/);
  });

  it("deserializeDashboardLogs is per-item safe — one malformed entry can't poison the whole batch (Codex P2)", () => {
    // Pre-fix the per-entry processing was inside the OUTER
    // try/catch, so any throw from the per-entry .map (e.g.
    // `entry.datasets.map(...)` against a non-array slipping past
    // the nullish-coalescing guard) returned [] for the whole
    // batch. The fix wraps each entry's body in its own try/catch
    // and falls back to null (filtered out) for that one entry.
    const decl = code.indexOf("function deserializeDashboardLogs");
    expect(decl).toBeGreaterThan(-1);
    // Slice the whole function body via balanced braces.
    const openBraceIdx = code.indexOf("{", decl);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openBraceIdx; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    expect(closeIdx).toBeGreaterThan(openBraceIdx);
    const body = code.slice(openBraceIdx, closeIdx + 1);
    // A `.map` callback inside the body must wrap its work in its
    // own try/catch returning null on failure.
    expect(body).toMatch(
      /\.map\s*\(\s*\([^)]*\)\s*(?::\s*[^=]+\s*)?=>\s*\{[\s\S]{0,200}try\s*\{[\s\S]{0,4000}catch\s*\{[\s\S]{0,200}return\s+null/
    );
    // Defensive Array.isArray guards on the optional sub-arrays so
    // a non-array slipping in (e.g. server payload bug) doesn't
    // hit `.map` on a string and throw.
    expect(body).toMatch(/Array\.isArray\(\s*entry\.datasets\s*\)/);
    expect(body).toMatch(/Array\.isArray\(\s*entry\.cooStatuses\s*\)/);
    expect(body).toMatch(
      /Array\.isArray\(\s*entry\.recPerformanceContracts2025\s*\)/
    );
  });

  it("Snapshot Log display merge: dedupes by id and sorts newest-first", () => {
    // Source rail proving the helper has the right shape. The pure
    // recovery primitives in
    // `server/services/solar/snapshotLogRecovery.test.ts` cover the
    // same invariants on the server side.
    const decl = code.indexOf("function mergeSnapshotLogEntriesForDisplay");
    expect(decl).toBeGreaterThan(-1);
    // Walk parens from the first `(` after the name to find the
    // matching `)` of the parameter list, ignoring inline `{ ... }`
    // type braces inside.
    const openParenIdx = code.indexOf("(", decl);
    let parenDepth = 0;
    let closeParenIdx = -1;
    for (let i = openParenIdx; i < code.length; i++) {
      const ch = code[i];
      if (ch === "(") parenDepth++;
      else if (ch === ")") {
        parenDepth--;
        if (parenDepth === 0) {
          closeParenIdx = i;
          break;
        }
      }
    }
    expect(closeParenIdx).toBeGreaterThan(openParenIdx);
    const bodyOpenIdx = code.indexOf("{", closeParenIdx);
    let braceDepth = 0;
    let bodyCloseIdx = -1;
    for (let i = bodyOpenIdx; i < code.length; i++) {
      const ch = code[i];
      if (ch === "{") braceDepth++;
      else if (ch === "}") {
        braceDepth--;
        if (braceDepth === 0) {
          bodyCloseIdx = i;
          break;
        }
      }
    }
    expect(bodyCloseIdx).toBeGreaterThan(bodyOpenIdx);
    const body = code.slice(bodyOpenIdx, bodyCloseIdx + 1);

    // Dedupe semantics: keyed by id via Map.
    expect(body).toMatch(/new\s+Map\b/);
    expect(body).toMatch(/byId\.set\s*\(\s*[a-zA-Z]+\.id/);
    // Sort newest-first by createdAt.
    expect(body).toMatch(/\.sort\s*\([\s\S]{0,200}createdAt/);
  });

  it("CSV export click does NOT flip hasUserInteractedWithDashboard (heavy queries stay disabled)", () => {
    // PR #332 follow-up item 7 (2026-05-02). Flipping the
    // interaction flag inside the CSV handlers silently enables the
    // mount-tier heavy queries (overview-summary / offlineMonitoring
    // / change-ownership) on the next render, dragging multi-MB JSON
    // into the browser as a side-effect of an export click. The
    // handler bodies (and the shared poll helper they call) must
    // NOT call setHasUserInteractedWithDashboard(true).
    for (const name of [
      "downloadOwnershipCountTileCsv",
      "downloadChangeOwnershipCountTileCsv",
      "runDashboardCsvExport",
    ]) {
      const handler = sliceFn(code, name);
      expect(handler).not.toBeNull();
      expect(handler!).not.toMatch(
        /setHasUserInteractedWithDashboard\s*\(\s*true\s*\)/
      );
    }
  });
});

/**
 * Pull a function/arrow-function body out of the source as a string,
 * so a regex assertion only inspects that handler's body — not the
 * whole 6000-line file. Matches both `const NAME = async (...) => {`
 * and `const NAME = useCallback(\n  async (...) => {` shapes by
 * anchoring on the declaration name and walking forward to the
 * first `=>` arrow.
 */
function sliceFn(source: string, name: string): string | null {
  const declRegex = new RegExp(
    `const\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=\\s*(?:async|useCallback\\s*\\()`
  );
  const declMatch = declRegex.exec(source);
  if (!declMatch) return null;
  const arrowIdx = source.indexOf("=>", declMatch.index);
  if (arrowIdx === -1) return null;
  const openBrace = source.indexOf("{", arrowIdx);
  if (openBrace === -1) return null;
  let depth = 0;
  for (let i = openBrace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(declMatch.index, i + 1);
      }
    }
  }
  return null;
}

/**
 * Pull a useQuery call site out of the source as a string so we can
 * grep for `enabled:` predicates inside its options-object only,
 * not the whole file (which has many `enabled:` strings).
 *
 * Returns the substring from the procedure name through the closing
 * brace of the options literal, or null if the call site is missing.
 */
function extractUseQueryBlock(source: string, procedureFragment: string): string | null {
  const idx = source.indexOf(procedureFragment);
  if (idx === -1) return null;
  // Find the start of the procedure call's argument list.
  const openParen = source.indexOf("(", idx);
  if (openParen === -1) return null;
  // Walk forward, balancing braces/parens, until the matching ).
  let depth = 0;
  let end = -1;
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && ch === ")") {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;
  return source.slice(idx, end + 1);
}

describe("Solar REC dashboard mount: high-cardinality fields stay off mount path", () => {
  const code = codeOnly();

  it("does not derive part2EligibleSystemsForSizeReporting unconditionally outside the gated query path", () => {
    // The derived list reads `offlineMonitoringQuery.data` which
    // returns undefined when the query is disabled. The derivation
    // returns [] in that case — the test pins the early-out.
    expect(code).toMatch(
      /part2EligibleSystemsForSizeReporting[\s\S]{0,200}offlineMonitoringQuery\.data/
    );
  });

  it("reads abpEligibleTotalSystems from slimSummary first, offlineMonitoring second", () => {
    expect(code).toMatch(
      /abpEligibleTotalSystems\s*=\s*[\s\S]*?slimSummary\?\.[A-Za-z]+\s*\?\?\s*offlineMonitoringQuery/
    );
  });

  it("cumulativeKwAcPart2 / cumulativeKwDcPart2 flow into OverviewTab from the slim summary", () => {
    expect(code).toMatch(/cumulativeKwAcPart2:\s*\n?\s*slimSummary\.cumulativeKwAcPart2/);
    expect(code).toMatch(/cumulativeKwDcPart2:\s*\n?\s*slimSummary\.cumulativeKwDcPart2/);
  });
});

describe("Solar REC dashboard mount: financials gating (PR #332 follow-up item 8)", () => {
  const code = codeOnly();

  it("getDashboardFinancials is NOT enabled for Overview mount — only Financials/Pipeline tabs", () => {
    // The row-materializing aggregator is reserved for the tabs
    // that actually render rows. Overview reads only the slim KPI
    // summary endpoint below. Letting Overview enable the heavy
    // proc was the bug item 8 retires — the heavy proc loads
    // mapping/icc/abp rows BEFORE its cache check, paying the
    // full hydration cost on every cold mount.
    const block = extractUseQueryBlock(
      code,
      "getDashboardFinancials.useQuery"
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(/enabled\s*:[^,}]*isFinancialsTabActive/);
    expect(block!).toMatch(/isPipelineTabActive/);
    expect(block!).not.toMatch(/isOverviewTabActive/);
  });

  it("contractScanResultsQuery is NOT enabled for Overview mount", () => {
    // Same row-materializing concern as `getDashboardFinancials` —
    // the contract-scan join shouldn't fire on Overview mount.
    const block = extractUseQueryBlock(
      code,
      "contractScan.getContractScanResultsByCsgIds.useQuery"
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(/isFinancialsTabActive/);
    expect(block!).toMatch(/isPipelineTabActive/);
    expect(block!).not.toMatch(/isOverviewTabActive/);
  });

  it("Overview mount uses the slim getDashboardFinancialKpiSummary proc", () => {
    // The replacement endpoint MUST exist and be gated specifically
    // on Overview activity so first-paint KPI tiles render without
    // pulling the heavy aggregator.
    const block = extractUseQueryBlock(
      code,
      "getDashboardFinancialKpiSummary.useQuery"
    );
    expect(block).not.toBeNull();
    expect(block!).toMatch(/enabled\s*:[^,}]*isOverviewTabActive/);
  });

  it("financialProfitData carries kpiDataAvailable so OverviewTab can render N/A on slim cold cache", () => {
    // Heavy success path sets kpiDataAvailable: true. Slim path
    // either inherits true from the KPI summary cache hit, or stays
    // at FINANCIAL_PROFIT_EMPTY's false default. UI consumers branch
    // on it so the 4 tile values are explicit about availability.
    expect(code).toMatch(/kpiDataAvailable\s*:\s*true/);
    expect(code).toMatch(/kpiDataAvailable\s*:\s*false/);
  });

  it("invalidates the slim KPI query whenever heavy financials data updates (PR #334 follow-up item 2)", () => {
    // The 60s staleTime on `getDashboardFinancialKpiSummary` will
    // otherwise keep returning a stale snapshot across a single
    // Overview ↔ Financials navigation cycle. The fix: a useEffect
    // gated on `financialsQuery.dataUpdatedAt` that calls the
    // utils' `.invalidate()` for the slim KPI proc. Pinning the
    // textual presence here so a future refactor doesn't quietly
    // drop the invalidation.
    expect(code).toMatch(
      /invalidateFinancialKpiSummary\s*=\s*useCallback/
    );
    expect(code).toMatch(
      /getDashboardFinancialKpiSummary\.invalidate\s*\(/
    );
    expect(code).toMatch(/financialsQuery\.dataUpdatedAt/);
  });
});

describe("Solar REC dashboard mount: slim summary discriminator (PR #332 follow-up item 4)", () => {
  const code = codeOnly();

  it("`summary` is a discriminated union — heavy-only fields cannot be read as silent zeros on the slim path", () => {
    // The projection literal flips on the data source: heavy data
    // returns kind: "heavy", slim data returns kind: "slim". TS
    // narrows on `summary.kind === "heavy"` for any consumer that
    // wants to read totalDeliveredValue/totalGap/ownershipRows.
    expect(code).toMatch(/kind\s*:\s*["']heavy["']/);
    expect(code).toMatch(/kind\s*:\s*["']slim["']/);
    // No `as { _runnerVersion?: string }` cast — the inferred tRPC
    // type already carries the field.
    expect(code).not.toMatch(/as\s*\{\s*_runnerVersion\?:\s*string\s*\}/);
  });

  it("dead `ownershipCountTileRows` memo (which read summary.ownershipRows) is gone", () => {
    // The memo was the only client reader of `summary.ownershipRows`,
    // and it had no consumers. CSV exports go through the server-side
    // `exportOwnershipTileCsv` proc instead.
    expect(code).not.toMatch(/const\s+ownershipCountTileRows\s*=/);
    expect(code).not.toMatch(/summary\.ownershipRows\.filter/);
  });
});

describe("Solar REC dashboard: snapshot-readiness gate (PR #337 follow-up item 1)", () => {
  const code = codeOnly();

  it("createLogEntry refuses to persist when heavy data is missing — no silent-zero log entries", () => {
    // The function must early-return on the !ready path and call
    // `toast.error(<reason>)` so the user understands why the
    // snapshot didn't take.
    const fnSlice = sliceCreateLogEntryBody();
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(/snapshotReadiness/);
    expect(fnSlice!).toMatch(/!\s*snapshotReadiness\.ready/);
    expect(fnSlice!).toMatch(/toast\.error\s*\(/);
    expect(fnSlice!).toMatch(/return\s*;/);
  });

  it("snapshotReadiness gates on ALL FIVE heavy inputs (PR #338 follow-up item 2)", () => {
    // Each heavy input feeds a required field of the log entry.
    // Pre-fix #337: button always live → silent 0s.
    // Pre-fix #338: gate covered four — `recPerformanceContracts2025`
    // was still persisted as `[]` when `performanceSourceRowsQuery`
    // hadn't run.
    expect(code).toMatch(/snapshotReadiness/);
    expect(code).toMatch(/summary\?\.kind\s*!==\s*["']heavy["']/);
    expect(code).toMatch(/changeOwnershipQuery\.status\s*!==\s*["']success["']/);
    expect(code).toMatch(/offlineMonitoringQuery\.status\s*!==\s*["']success["']/);
    expect(code).toMatch(/!serverSnapshot\.systems/);
    expect(code).toMatch(/performanceSourceRowsQuery\.status\s*!==\s*["']success["']/);
  });

  it("snapshotReadiness type CARRIES the narrowed values it gates on (PR #338 follow-up item 3)", () => {
    // `createLogEntry` reads from `snapshotReadiness.*` instead of
    // outer variables. A future PR that disables a query without
    // updating `snapshotReadiness` cannot accidentally
    // re-introduce silent zeros.
    expect(code).toMatch(/type\s+SnapshotReadyState\s*=\s*\{/);
    expect(code).toMatch(
      /SnapshotReadyState[\s\S]{0,400}summary:\s*HeavyOverviewSummary/
    );
    expect(code).toMatch(
      /SnapshotReadyState[\s\S]{0,500}recPerformanceContracts/
    );
    // The belt-and-braces second `summary?.kind !== "heavy"` check
    // inside createLogEntry is gone — the discriminator narrows.
    const fnSlice = sliceCreateLogEntryBody();
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).not.toMatch(/Belt-and-braces/);
  });

  it("Log Snapshot button is disabled and tooltipped while readiness is false", () => {
    expect(code).toMatch(
      /disabled\s*=\s*\{\s*!snapshotReadiness\.ready\s*\}[\s\S]{0,400}Log Snapshot/
    );
    expect(code).toMatch(
      /title\s*=\s*\{[\s\S]{0,200}snapshotReadiness\.ready[\s\S]{0,200}snapshotReadiness\.reason[\s\S]{0,400}Log Snapshot/
    );
  });
});

/**
 * Pull the body of `createLogEntry` out of the source so a regex can
 * inspect just that function. The function uses `=> {` so we walk
 * matching braces from the first `{` after the arrow.
 */
function sliceCreateLogEntryBody(): string | null {
  const decl = SOURCE.match(/const\s+createLogEntry\s*=\s*\(\s*\)\s*=>\s*\{/);
  if (!decl || decl.index === undefined) return null;
  const start = SOURCE.indexOf("{", decl.index);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < SOURCE.length; i++) {
    const ch = SOURCE[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return SOURCE.slice(decl.index, i + 1);
    }
  }
  return null;
}
