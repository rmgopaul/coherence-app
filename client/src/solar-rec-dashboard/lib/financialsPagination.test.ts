/**
 * Source-level regression rails proving the Financials tab is wired
 * to the paginated row reader (2026-05-13 — wire-shape pagination).
 *
 * Pre-PR, FinancialsTab consumed `financialProfitData.rows` at 16
 * sites — `.length` for counts, `.filter(r => r.needsReview).length`
 * for the flagged counter, `.map(r => ...)` for the CSV export, and
 * the table render itself. The full payload was ~10 MB on prod
 * (24K rows × ~420 bytes). Post-PR the parent's slim
 * `getDashboardFinancials` response no longer carries rows; the tab
 * fetches them via `getDashboardFinancialsPage` (paginated,
 * server-side sort + filter).
 *
 * The behavioral test would need to boot React + tRPC + mock query
 * client. This source-rail check is the cheap defensive layer that
 * catches a "drop the page query, re-add `.rows`" regression at PR
 * review time. Failure mode is a clear diff against the documented
 * contract.
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

const FINANCIALS_TAB_SOURCE = readFileSync(FINANCIALS_TAB_FILE, "utf8");
const DASHBOARD_SOURCE = readFileSync(DASHBOARD_FILE, "utf8");

/** Strip block + line comments so prose docstrings don't confuse the regex. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const FT_CODE = stripComments(FINANCIALS_TAB_SOURCE);
const DASH_CODE = stripComments(DASHBOARD_SOURCE);

describe("FinancialsTab — wire-shape pagination wiring", () => {
  it("imports useInfiniteQuery via the paginated page-reader hook", () => {
    // The hook is the tRPC-generated
    // `getDashboardFinancialsPage.useInfiniteQuery`. Regression rail
    // against a future PR that swaps it back to a heavy single-shot
    // `getDashboardFinancials.useQuery` call.
    expect(FT_CODE).toMatch(
      /trpc\.solarRecDashboard\.getDashboardFinancialsPage\.useInfiniteQuery/
    );
  });

  it("calls getDashboardFinancialsPage somewhere", () => {
    expect(FT_CODE).toMatch(/getDashboardFinancialsPage/);
  });

  it("does NOT contain the legacy `financialProfitData.rows.length === 0` empty-state check", () => {
    // Pre-PR the empty-state check was
    // `financialProfitData.rows.length === 0 && financialCsgIds.length === 0`.
    // Post-PR the source of truth is the server-shipped `totalCount`.
    // Allowing the old `.length === 0` would re-couple the empty
    // state to a now-always-empty array at the parent.
    expect(FT_CODE).not.toMatch(
      /financialProfitData\.rows\.length\s*===\s*0/
    );
  });

  it("does NOT contain the legacy `financialProfitData.rows.length > 0` table-render gate", () => {
    expect(FT_CODE).not.toMatch(
      /financialProfitData\.rows\.length\s*>\s*0/
    );
  });

  it("does NOT iterate over financialProfitData.rows", () => {
    // No more `.rows.map(...)`, `.rows.filter(...)`, or
    // `.rows.forEach(...)` on the parent-shipped slim data. Rows
    // live on the paginated page-reader pages now.
    expect(FT_CODE).not.toMatch(/financialProfitData\.rows\.(map|filter|forEach|reduce)/);
  });

  it("derives the flagged-count tile from the financialFlaggedCount prop", () => {
    // Pre-PR computed via `financialProfitData.rows.filter((r) =>
    // r.needsReview).length`. Post-PR the count is server-shipped on
    // the slim `getDashboardFinancials` response and threaded through
    // the parent as a prop.
    expect(FT_CODE).toMatch(/financialFlaggedCount/);
  });

  it("walks the cursor chain to assemble the CSV (option (b) — client-paginated)", () => {
    // CSV export pages through `getDashboardFinancialsPage` to
    // completion via the tRPC vanilla client (so it doesn't pollute
    // the React Query infinite-query cache). Regression rail against
    // a future PR that re-introduces `financialProfitData.rows.map`
    // for CSV.
    expect(FT_CODE).toMatch(
      /trpcUtils\.client\.solarRecDashboard\.getDashboardFinancialsPage\.query/
    );
  });

  it("maps local sort state to the server's sortKey/sortDir input", () => {
    // The page query needs sortKey/sortDir/filterNeedsReview/search
    // flowing in from local state — otherwise the server returns
    // unsorted rows and the tab's column-header arrows do nothing.
    const queryBlock = FT_CODE.match(
      /getDashboardFinancialsPage\.useInfiniteQuery\(\s*\{[\s\S]*?\}\s*,/
    );
    expect(queryBlock).not.toBeNull();
    expect(queryBlock![0]).toMatch(/sortKey:\s*financialSortBy/);
    expect(queryBlock![0]).toMatch(/sortDir:\s*financialSortDir/);
    expect(queryBlock![0]).toMatch(/filterNeedsReview/);
    expect(queryBlock![0]).toMatch(/search:/);
  });

  it("refreshFinancialsAfterMutation invalidates getDashboardFinancialsPage (PR #589 SF-1)", () => {
    // Pre-fix: the helper invalidated the slim `financialsQuery` +
    // `getDashboardFinancialKpiSummary` but NOT the new
    // `getDashboardFinancialsPage` infinite-query. After a save-
    // override / batch-rescan completes, the optimistic
    // `localOverrides` mask is cleared; without this invalidate the
    // page query keeps serving pre-mutation rows for the 60-sec
    // staleTime and the row snaps back to pre-edit values.
    //
    // Regression rail: the invalidate call MUST live inside the
    // `refreshFinancialsAfterMutation` useCallback body so every
    // mutation path that funnels through this helper picks it up.
    const fnIdx = FINANCIALS_TAB_SOURCE.indexOf(
      "refreshFinancialsAfterMutation = useCallback"
    );
    expect(fnIdx).toBeGreaterThan(-1);
    // Slice the function body + immediate surroundings (the body is
    // <800 chars today; 2000 gives headroom for future additions).
    const body = FINANCIALS_TAB_SOURCE.slice(fnIdx, fnIdx + 2000);
    expect(body).toMatch(
      /getDashboardFinancialsPage[\s\S]*?\.invalidate\s*\(/
    );
    // Defense against an "await invalidate" change that would re-
    // order the helper's promise resolution — keep it fire-and-
    // forget so the caller's `await refreshFinancialsAfterMutation`
    // semantics stay unchanged.
    expect(body).toMatch(
      /void\s+trpcUtils\.solarRecDashboard\.getDashboardFinancialsPage\.invalidate/
    );
  });
});

describe("SolarRecDashboard parent — slim financials wiring", () => {
  it("calls getDashboardFinancials.useQuery (the slim summary)", () => {
    // Keep the slim summary query in place — Overview KPI tiles
    // still read from it via `financialProfitData`.
    expect(DASH_CODE).toMatch(
      /solarRecTrpc\.solarRecDashboard\.getDashboardFinancials\.useQuery/
    );
  });

  it("financialProfitData no longer applies localOverrides over rows in the parent", () => {
    // Pre-PR the parent's useMemo applied localOverrides to the full
    // rows array and recomputed totals. Post-PR rows aren't carried
    // at this level — the page-reader path applies localOverrides
    // per-page in FinancialsTab itself. A regression that re-adds
    // the parent's `rows.map((row) => { const localOv = ... })` path
    // would mean the parent is materializing rows again somewhere.
    expect(DASH_CODE).not.toMatch(
      /financialsQuery\.data[\s\S]{0,80}rows\.map[\s\S]{0,80}localOverrides/
    );
  });

  it("threads financialFlaggedCount derived from the slim wire response", () => {
    // The slim response ships `flaggedCount` — the parent reads it
    // into a top-level binding for re-use across Overview tiles + as
    // a prop down to FinancialsTab.
    expect(DASH_CODE).toMatch(/financialsQuery\.data\?\.flaggedCount/);
  });
});
