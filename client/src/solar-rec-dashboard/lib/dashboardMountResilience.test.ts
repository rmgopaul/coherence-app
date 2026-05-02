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
});

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
