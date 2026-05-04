/**
 * PR #340 follow-up item 4 (2026-05-05) — source-level regression
 * rail for the post-mutation refresh contract in `FinancialsTab.tsx`.
 * Originally landed in PR #342 (saveOverride ordering); extended in
 * PR #342 follow-up (the shared `refreshFinancialsAfterMutation`
 * helper used by saveOverride, handleBatchRescan, and the inline
 * single-row rescan, plus a `throwOnError: true` rail on
 * `SolarRecDashboard.tsx` so a refetch rejection actually rejects —
 * TanStack Query's `refetch()` resolves even when the underlying
 * query errors unless `throwOnError` is set); and PR #344 follow-up
 * (extract the inline JSX rescan handler to a sibling
 * `handleSingleRowRescan` useCallback for ref stability + slicer
 * symmetry, and wrap the dashboard refetch wrappers in `useCallback`
 * so memo() on FinancialsTab and the helper's deps don't churn).
 *
 * The freshness contract for the slim KPI side cache requires:
 *   1. `financialsRefetch()` must complete BEFORE
 *      `invalidateFinancialKpiSummary()` runs. The heavy
 *      financials refetch is what writes the side-cache row on
 *      the server; invalidating the React-Query cache in parallel
 *      can land before the write and re-cache the stale value.
 *   2. `localOverrides[savedCsgId]` must be cleared ONLY after
 *      `financialsRefetch` succeeds. If the refetch fails, the
 *      authoritative DB rows haven't reloaded yet and the
 *      optimistic value is still the user's best view.
 *   3. All three financial mutation flows (saveOverride, batch
 *      rescan, inline single-row rescan) must share the same
 *      refresh implementation — the bug originally only affected
 *      saveOverride, but the same shape was open-coded in two
 *      other handlers and would regress independently.
 *
 * Pre-fix `saveOverride` violated (1) and (2): an unawaited
 * `Promise.all([scan, financials, invalidate]).then(clear)` ran
 * all three in parallel and only cleared the optimistic value on
 * the all-success branch. PR #342 fixed (1) and (2) inline, and
 * the PR #342 follow-up extracted the shared helper for (3) plus
 * the `throwOnError` rail. A behavioral test would require booting
 * a React + tRPC harness; this source-level rail catches the same
 * regression patterns (used elsewhere in this directory).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const FINANCIALS_TAB_FILE = resolve(
  __dirname,
  "..",
  "components",
  "FinancialsTab.tsx"
);

const DASHBOARD_FILE = resolve(
  __dirname,
  "..",
  "..",
  "features",
  "solar-rec",
  "SolarRecDashboard.tsx"
);

const SOURCE = readFileSync(FINANCIALS_TAB_FILE, "utf8");
const DASHBOARD_SOURCE = readFileSync(DASHBOARD_FILE, "utf8");

/** Strip block + line comments so prose docstrings don't confuse the regex. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Slice the body of a `const <name> = useCallback(async () => { … })`
 * declaration so the regex only inspects that handler. Walks
 * balanced braces from the first `{` after the arrow to find the
 * matching close. We anchor on `=>` rather than the first `{` after
 * the declaration so a type annotation like
 * `async (): Promise<{ … }> => { … }` doesn't fool the slicer into
 * returning the type's brace pair instead of the body.
 */
function sliceUseCallbackBody(
  source: string,
  name: string
): string | null {
  const decl = new RegExp(
    `const\\s+${name}\\s*=\\s*useCallback\\s*\\(\\s*async\\s*\\(`
  ).exec(source);
  if (!decl || decl.index === undefined) return null;
  const arrowIdx = source.indexOf("=>", decl.index);
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
        return source.slice(decl.index, i + 1);
      }
    }
  }
  return null;
}

const code = codeOnly(SOURCE);
const dashboardCode = codeOnly(DASHBOARD_SOURCE);

describe("FinancialsTab refreshFinancialsAfterMutation — shared helper invariants (PR #342 follow-up)", () => {
  const helperSlice = sliceUseCallbackBody(
    code,
    "refreshFinancialsAfterMutation"
  );

  it("declares the shared helper as a useCallback", () => {
    expect(helperSlice).not.toBeNull();
  });

  it("does NOT put financialsRefetch and invalidateFinancialKpiSummary in the same Promise.all/Promise.allSettled array", () => {
    // The pre-fix shape was:
    //   Promise.all([
    //     contractScanRefetch(),
    //     financialsRefetch(),
    //     invalidateFinancialKpiSummary(),
    //   ]).then(...);
    // We walk every `Promise.(all|allSettled)([…])` array literal in
    // the WHOLE file (helper, saveOverride, batch rescan, inline
    // rescan) and assert no SINGLE bracket pair contains BOTH
    // `financialsRefetch` AND `invalidateFinancialKpiSummary`. The
    // character class `[^\[\]]*?` excludes nested brackets so each
    // match captures exactly one array's contents — a naïve
    // `[\s\S]*?` would span across separate `Promise.allSettled`
    // calls and false-positive when one array has financialsRefetch
    // and the next has invalidateFinancialKpiSummary.
    const promiseArrayPattern =
      /Promise\.(?:all|allSettled)\s*\(\s*\[([^[\]]*)\]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = promiseArrayPattern.exec(code)) !== null) {
      const innerContents = match[1];
      const hasRefetch = /financialsRefetch/.test(innerContents);
      const hasInvalidate = /invalidateFinancialKpiSummary/.test(
        innerContents
      );
      expect(hasRefetch && hasInvalidate).toBe(false);
    }
  });

  it("does NOT wrap a single invalidate call in Promise.allSettled (PR #342 polish)", () => {
    // Pre-PR-342-followup the saveOverride handler had:
    //   invalidateOutcome = await Promise.allSettled([
    //     invalidateFinancialKpiSummary(),
    //   ]).then((results) => results[0]);
    // That one-element-array shape is a smell — use try/catch around
    // the bare call instead.
    const singleInvalidatePattern =
      /Promise\.allSettled\s*\(\s*\[\s*invalidateFinancialKpiSummary\s*\(/;
    expect(singleInvalidatePattern.test(code)).toBe(false);
  });

  it('removes the "skipped" invalidateOutcome state (PR #342 polish)', () => {
    // The transitional shape used:
    //   let invalidateOutcome:
    //     | PromiseSettledResult<unknown>
    //     | { status: "skipped" } = { status: "skipped" };
    // The shared helper supersedes this — there's no longer a need
    // for a tri-state because invalidate is gated on
    // financialsRefreshed via plain control flow.
    expect(code).not.toMatch(/status\s*:\s*["']skipped["']/);
    expect(code).not.toMatch(/invalidateOutcome/);
  });

  it("invalidateFinancialKpiSummary runs only after financialsRefetch succeeds", () => {
    // Ordering invariant: the helper must check financialsOutcome
    // (or financialsRefreshed) BEFORE awaiting invalidate.
    expect(helperSlice).not.toBeNull();
    const fulfilledIdx = helperSlice!.search(
      /financialsOutcome\.status\s*===\s*["']fulfilled["']|financialsRefreshed/
    );
    const invalidateIdx = helperSlice!.indexOf(
      "invalidateFinancialKpiSummary("
    );
    expect(fulfilledIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(fulfilledIdx);
  });

  it("uses Promise.allSettled (not Promise.all) so a refetch rejection is captured, not unhandled", () => {
    // Pre-fix the `Promise.all(...).then(...)` had no .catch — a
    // refetch rejection became an unhandled-promise warning.
    expect(helperSlice).not.toBeNull();
    expect(helperSlice!).toMatch(/Promise\.allSettled\s*\(/);
  });

  it("uses a normal try/catch (not a single-call Promise.allSettled) for the invalidate step", () => {
    expect(helperSlice).not.toBeNull();
    expect(helperSlice!).toMatch(
      /try\s*\{\s*await\s+invalidateFinancialKpiSummary\s*\(/
    );
  });

  it("captures rejection reasons via reasonText for all three steps", () => {
    expect(helperSlice).not.toBeNull();
    expect(helperSlice!).toMatch(
      /contractScanRefetch:\s*\$\{reasonText\(/
    );
    expect(helperSlice!).toMatch(
      /financialsRefetch:\s*\$\{reasonText\(/
    );
    expect(helperSlice!).toMatch(
      /invalidateFinancialKpiSummary:\s*\$\{reasonText\(/
    );
  });

  it("returns the financialsRefreshed flag so callers can decide whether to clear optimistic state", () => {
    expect(helperSlice).not.toBeNull();
    expect(helperSlice!).toMatch(/financialsRefreshed/);
    expect(helperSlice!).toMatch(/return\s*\{[^}]*financialsRefreshed/);
  });
});

describe("FinancialsTab saveOverride — uses shared refresh helper (PR #342 follow-up)", () => {
  const fnSlice = sliceUseCallbackBody(code, "saveOverride");

  it("source slice extracts cleanly", () => {
    expect(fnSlice).not.toBeNull();
  });

  it("calls refreshFinancialsAfterMutation instead of open-coding Promise.all", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(/refreshFinancialsAfterMutation\s*\(/);
    // Make sure the old shape didn't drift back in.
    expect(fnSlice!).not.toMatch(
      /Promise\.all\s*\(\s*\[\s*contractScanRefetch/
    );
  });

  it("clears localOverrides[savedCsgId] only when the helper reports financialsRefreshed=true", () => {
    expect(fnSlice).not.toBeNull();
    // The `next.delete(savedCsgId)` clear must live INSIDE the
    // `if (financialsRefreshed)` branch so a refetch failure
    // leaves the optimistic value in place.
    const fulfilledBranchPattern =
      /if\s*\(\s*financialsRefreshed\s*\)[\s\S]{0,400}next\.delete\(\s*savedCsgId\s*\)/;
    expect(fnSlice!).toMatch(fulfilledBranchPattern);
  });

  it("does NOT call next.delete(savedCsgId) outside an if (financialsRefreshed) branch", () => {
    // Walk every `next.delete(savedCsgId)` occurrence and confirm
    // the closest preceding control statement (within 300 chars)
    // is an `if (financialsRefreshed)` — not bare top-level code.
    expect(fnSlice).not.toBeNull();
    const deletePattern = /next\.delete\(\s*savedCsgId\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = deletePattern.exec(fnSlice!)) !== null) {
      const precedingText = fnSlice!.slice(
        Math.max(0, match.index - 400),
        match.index
      );
      expect(precedingText).toMatch(/if\s*\(\s*financialsRefreshed\s*\)/);
    }
  });

  it("logs failures with the searchable [financials:post-mutation-refresh] prefix and shows a user toast", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(
      /console\.warn\s*\(\s*[`'"][^`'"]*\[financials:post-mutation-refresh\]/
    );
    expect(fnSlice!).toMatch(
      /toast\.error\s*\(\s*[`'"][^`'"]*Override saved, but a background data refresh failed/
    );
  });
});

describe("FinancialsTab handleBatchRescan — uses shared refresh helper (PR #342 follow-up)", () => {
  const fnSlice = sliceUseCallbackBody(code, "handleBatchRescan");

  it("source slice extracts cleanly", () => {
    expect(fnSlice).not.toBeNull();
  });

  it("calls refreshFinancialsAfterMutation instead of open-coding Promise.all", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(/refreshFinancialsAfterMutation\s*\(/);
    expect(fnSlice!).not.toMatch(
      /Promise\.all\s*\(\s*\[\s*contractScanRefetch/
    );
  });

  it("logs failures with the [financials:post-mutation-refresh] prefix and toasts batch-rescan-specific copy", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(
      /console\.warn\s*\(\s*[`'"][^`'"]*\[financials:post-mutation-refresh\]/
    );
    expect(fnSlice!).toMatch(
      /toast\.error\s*\(\s*[`'"][^`'"]*Batch rescan/
    );
  });

  it("keeps the outer try/finally so setBatchRescanRunning(false) always runs", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(
      /\}\s*finally\s*\{\s*setBatchRescanRunning\(false\)/
    );
  });
});

describe("FinancialsTab handleSingleRowRescan — uses shared refresh helper (PR #344 follow-up)", () => {
  // PR #344 follow-up extracted the inline JSX onClick to a sibling
  // useCallback so it's testable through the same slicer as
  // saveOverride / handleBatchRescan. The Re-scan <Button> now reads
  //   onClick={() => handleSingleRowRescan(r.csgId)}
  // — so the test rail also asserts the JSX wiring.
  const fnSlice = sliceUseCallbackBody(code, "handleSingleRowRescan");

  it("source slice extracts cleanly", () => {
    expect(fnSlice).not.toBeNull();
  });

  it("calls refreshFinancialsAfterMutation instead of open-coding Promise.all", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(/refreshFinancialsAfterMutation\s*\(/);
    expect(fnSlice!).not.toMatch(
      /Promise\.all\s*\(\s*\[\s*contractScanRefetch/
    );
  });

  it("does NOT let a refresh failure trip the scan-failure toast", () => {
    // The mutation try/catch must not wrap the helper call. Verify
    // by source: the catch block ends with `return;` and the helper
    // call sits AFTER the catch closes.
    expect(fnSlice).not.toBeNull();
    const catchIdx = fnSlice!.indexOf('"Re-scan failed"');
    const helperIdx = fnSlice!.indexOf("refreshFinancialsAfterMutation(");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(catchIdx);
    // The catch block returns early so the helper only runs on the
    // success path. No mutable success-flag ladder.
    expect(fnSlice!).toMatch(
      /toast\.error\([^)]*"Re-scan failed"[^)]*\);[\s\S]{0,40}return\s*;/
    );
    expect(fnSlice!).not.toMatch(/scanSucceeded/);
  });

  it("logs failures with the [financials:post-mutation-refresh] prefix and toasts re-scan-specific copy", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(
      /console\.warn\s*\(\s*[`'"][^`'"]*\[financials:post-mutation-refresh\]/
    );
    expect(fnSlice!).toMatch(
      /toast\.error\s*\(\s*[`'"][^`'"]*Re-scan completed/
    );
  });

  it("the per-row Re-scan button wires onClick to handleSingleRowRescan(r.csgId)", () => {
    expect(code).toMatch(
      /onClick=\{\s*\(\s*\)\s*=>\s*handleSingleRowRescan\(\s*r\.csgId\s*\)\s*\}/
    );
    // And the old inline `onClick={async ...}` shape is gone.
    expect(code).not.toMatch(
      /onClick=\{\s*async\s*\(\s*\)\s*=>\s*\{[\s\S]{0,200}rescanSingleContract\.mutateAsync/
    );
  });
});

describe("SolarRecDashboard FinancialsTabLazy refetch wrappers — throwOnError + stability (PR #342 follow-up)", () => {
  it("declares stable useCallback wrappers around refetch({ throwOnError: true })", () => {
    // Inline arrow functions in JSX props create a fresh ref every
    // render, defeating memo() on FinancialsTab and churning the
    // refresh helper's useCallback deps. The wrapper must be a
    // useCallback at component scope.
    expect(dashboardCode).toMatch(
      /const\s+contractScanRefetchWithThrow\s*=\s*useCallback\s*\(\s*\(\s*\)\s*=>\s*contractScanResultsQuery\.refetch\(\s*\{\s*throwOnError\s*:\s*true\s*\}\s*\)/
    );
    expect(dashboardCode).toMatch(
      /const\s+financialsRefetchWithThrow\s*=\s*useCallback\s*\(\s*\(\s*\)\s*=>\s*financialsQuery\.refetch\(\s*\{\s*throwOnError\s*:\s*true\s*\}\s*\)/
    );
  });

  it("FinancialsTabLazy props reference the stable wrappers (not inline arrows)", () => {
    expect(dashboardCode).toMatch(
      /contractScanRefetch=\{\s*contractScanRefetchWithThrow\s*\}/
    );
    expect(dashboardCode).toMatch(
      /financialsRefetch=\{\s*financialsRefetchWithThrow\s*\}/
    );
  });

  it("does NOT pass raw query.refetch references (which swallow query errors)", () => {
    expect(dashboardCode).not.toMatch(
      /contractScanRefetch=\{\s*contractScanResultsQuery\.refetch\s*\}/
    );
    expect(dashboardCode).not.toMatch(
      /financialsRefetch=\{\s*financialsQuery\.refetch\s*\}/
    );
  });
});
