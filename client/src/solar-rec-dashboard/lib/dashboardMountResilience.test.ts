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

  it("ownership CSV download flows through the server-side export proc, not client-side row hydration", () => {
    // Both download handlers must call the server-side export
    // procs. Client-side filtering of the heavy aggregator's rows is
    // the bug this PR retires — it required the user to click twice
    // and held megabytes of detail rows in browser heap.
    expect(code).toMatch(
      /downloadOwnershipCountTileCsv[\s\S]*?solarRecTrpcUtils\.solarRecDashboard\.exportOwnershipTileCsv\.fetch/
    );
    expect(code).toMatch(
      /downloadChangeOwnershipCountTileCsv[\s\S]*?solarRecTrpcUtils\.solarRecDashboard\.exportChangeOwnershipTileCsv\.fetch/
    );
    // No window.alert in the export path — toasts only.
    expect(code).not.toMatch(/downloadOwnershipCountTileCsv[\s\S]{0,2000}window\.alert/);
    expect(code).not.toMatch(
      /downloadChangeOwnershipCountTileCsv[\s\S]{0,2000}window\.alert/
    );
    // No empty-result fallback to a 0-row CSV — the handler explicitly
    // surfaces "no rows" via toast.error instead of triggering a
    // download.
    expect(code).toMatch(
      /downloadOwnershipCountTileCsv[\s\S]{0,2000}rowCount\s*===\s*0[\s\S]{0,200}toast\.error/
    );
  });

  it("CSV export click does NOT flip hasUserInteractedWithDashboard (heavy queries stay disabled)", () => {
    // PR #332 follow-up item 7 (2026-05-02). Flipping the
    // interaction flag inside the CSV handlers silently enables the
    // mount-tier heavy queries (overview-summary / offlineMonitoring
    // / change-ownership) on the next render, dragging multi-MB JSON
    // into the browser as a side-effect of an export click. The
    // handler bodies must NOT call setHasUserInteractedWithDashboard(true).
    const ownershipCsvHandler = sliceFn(code, "downloadOwnershipCountTileCsv");
    expect(ownershipCsvHandler).not.toBeNull();
    expect(ownershipCsvHandler!).not.toMatch(
      /setHasUserInteractedWithDashboard\s*\(\s*true\s*\)/
    );
    const changeOwnershipCsvHandler = sliceFn(
      code,
      "downloadChangeOwnershipCountTileCsv"
    );
    expect(changeOwnershipCsvHandler).not.toBeNull();
    expect(changeOwnershipCsvHandler!).not.toMatch(
      /setHasUserInteractedWithDashboard\s*\(\s*true\s*\)/
    );
  });
});

/**
 * Pull a function/arrow-function body out of the source as a string,
 * so a regex assertion only inspects that handler's body — not the
 * whole 6000-line file. Matches `const NAME = ... =>` then walks
 * matching braces.
 */
function sliceFn(source: string, name: string): string | null {
  const declRegex = new RegExp(
    `const\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*=\\s*async`
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
