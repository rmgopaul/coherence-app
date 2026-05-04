/**
 * PR #340 follow-up item 4 (2026-05-05) — source-level regression
 * rail for `saveOverride` in `FinancialsTab.tsx`.
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
 *
 * Pre-fix `saveOverride` violated both: an unawaited
 * `Promise.all([scan, financials, invalidate]).then(clear)` ran
 * all three in parallel and only cleared the optimistic value on
 * the all-success branch. A behavioral test would require booting
 * a React + tRPC harness; this source-level rail catches the same
 * regression pattern (used elsewhere in this directory).
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

const SOURCE = readFileSync(FINANCIALS_TAB_FILE, "utf8");

/** Strip block + line comments so prose docstrings don't confuse the regex. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Slice the body of `saveOverride` so the regex only inspects
 * that handler. The function is declared with
 * `const saveOverride = useCallback(async () => { ... }, [deps]);`
 * — walk balanced braces from the first `{` after the arrow to
 * find the matching close.
 */
function sliceSaveOverrideBody(source: string): string | null {
  const decl = /const\s+saveOverride\s*=\s*useCallback\s*\(\s*async\s*\(\s*\)\s*=>\s*\{/.exec(source);
  if (!decl || decl.index === undefined) return null;
  const openBrace = source.indexOf("{", decl.index);
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

describe("FinancialsTab saveOverride — background refresh ordering (PR #340 follow-up item 1)", () => {
  const code = codeOnly(SOURCE);
  const fnSlice = sliceSaveOverrideBody(code);

  it("source slice extracts cleanly", () => {
    expect(fnSlice).not.toBeNull();
  });

  it("does NOT call invalidateFinancialKpiSummary in the same Promise.all/allSettled array as financialsRefetch", () => {
    // The pre-fix shape was:
    //   Promise.all([
    //     contractScanRefetch(),
    //     financialsRefetch(),
    //     invalidateFinancialKpiSummary(),
    //   ]).then(...);
    // We walk every `Promise.(all|allSettled)([…])` array literal
    // and assert no SINGLE bracket pair contains BOTH
    // `financialsRefetch` AND `invalidateFinancialKpiSummary`.
    // The character class `[^\[\]]*?` excludes nested brackets so
    // each match captures exactly one array's contents — a naïve
    // `[\s\S]*?` would span across separate `Promise.allSettled`
    // calls and false-positive when one array has financialsRefetch
    // and the next has invalidateFinancialKpiSummary.
    expect(fnSlice).not.toBeNull();
    const promiseArrayPattern =
      /Promise\.(?:all|allSettled)\s*\(\s*\[([^[\]]*)\]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = promiseArrayPattern.exec(fnSlice!)) !== null) {
      const innerContents = match[1];
      const hasRefetch = /financialsRefetch/.test(innerContents);
      const hasInvalidate = /invalidateFinancialKpiSummary/.test(innerContents);
      expect(hasRefetch && hasInvalidate).toBe(false);
    }
  });

  it("uses Promise.allSettled (not Promise.all) so a refetch failure is captured, not unhandled", () => {
    // Pre-fix the `Promise.all(...).then(...)` had no .catch — a
    // refetch rejection became an unhandled-promise warning.
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(/Promise\.allSettled\s*\(/);
  });

  it("financialsRefetch outcome must be checked before invalidateFinancialKpiSummary runs", () => {
    // Ordering invariant: invalidate runs only on the
    // financials-fulfilled branch. Source-level signal: the
    // `financialsOutcome.status === "fulfilled"` literal must
    // appear BEFORE the call to invalidateFinancialKpiSummary in
    // the function body.
    expect(fnSlice).not.toBeNull();
    const fulfilledIdx = fnSlice!.indexOf(
      'financialsOutcome.status === "fulfilled"'
    );
    const invalidateIdx = fnSlice!.indexOf("invalidateFinancialKpiSummary(");
    expect(fulfilledIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(-1);
    expect(invalidateIdx).toBeGreaterThan(fulfilledIdx);
  });

  it("clears localOverrides[savedCsgId] only after financialsRefetch fulfills (not unconditionally)", () => {
    // The `next.delete(savedCsgId)` clear must live INSIDE the
    // `financialsOutcome.status === "fulfilled"` branch so a
    // refetch failure leaves the optimistic value in place.
    expect(fnSlice).not.toBeNull();
    const fulfilledBranchPattern =
      /financialsOutcome\.status === ["']fulfilled["'][\s\S]{0,800}next\.delete\(\s*savedCsgId\s*\)/;
    expect(fnSlice!).toMatch(fulfilledBranchPattern);
  });

  it("logs failures with the searchable [financials:save-override] prefix and shows a user toast", () => {
    expect(fnSlice).not.toBeNull();
    expect(fnSlice!).toMatch(
      /console\.warn\s*\(\s*[`'"][^`'"]*\[financials:save-override\]/
    );
    expect(fnSlice!).toMatch(
      /toast\.error\s*\(\s*[`'"][^`'"]*Override saved/
    );
  });
});
