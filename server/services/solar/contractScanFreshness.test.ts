/**
 * PR #338 follow-up item 1 (2026-05-04) — source-level regression
 * rails proving the contract-scan freshness signal (the row read by
 * `getScopeContractScanVersion`, used by `computeFinancialsHash`)
 * is bumped on every real production mutation:
 *
 *   - `updateContractOverride` after the override write succeeds.
 *   - `rescanSingleContract` after the new result row is inserted.
 *   - `runContractScanJob` after the job reaches `completed`.
 *
 * Without those bumps the slim KPI side cache + the public
 * `getFinancialsHash` proc keep returning stale values until
 * something else mutates the scope's dataset versions — which
 * defeats the canonical-hash freshness contract from PR #337
 * follow-up.
 *
 * A behavioral test would have to boot a tRPC + DB harness with a
 * seeded scope and the contract-scan job runner. Source-level rails
 * are the cheap guard against future PRs silently dropping the
 * bumps; the brittleness trade-off matches the dashboardMount-
 * Resilience.test.ts strategy.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTER = readFileSync(
  resolve(__dirname, "..", "..", "_core", "solarRecContractScanRouter.ts"),
  "utf8"
);
const RUNNER = readFileSync(
  resolve(__dirname, "..", "core", "contractScanJobRunner.ts"),
  "utf8"
);

/** Strip block + line comments so prose docstrings don't confuse the regex. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Slice a router proc out of the source by name so regex
 * assertions only inspect the relevant proc body, not the whole
 * file. The router uses `procName: requirePermission(...)` records
 * separated by `}),` lines. We slice from the proc's declaration
 * to the next sibling proc declaration (or end of router object).
 */
function sliceProc(source: string, procName: string): string | null {
  const decl = new RegExp(`\\b${procName}\\s*:\\s*requirePermission\\s*\\(`);
  const start = decl.exec(source)?.index;
  if (start === undefined) return null;
  // Find the start of the NEXT proc record by scanning for the
  // `<identifier>: requirePermission(` pattern past the current one.
  const after = source.slice(start + procName.length);
  const next = /\n\s+[A-Za-z][A-Za-z0-9_]*\s*:\s*requirePermission\s*\(/.exec(
    after
  );
  const end = next ? start + procName.length + next.index : source.length;
  return source.slice(start, end);
}

describe("contract-scan freshness bumps — router (PR #338 follow-up item 1)", () => {
  const code = codeOnly(ROUTER);

  it("updateContractOverride bumps override-version after a successful write using ctx.scopeId + result.overriddenAt", () => {
    const slice = sliceProc(code, "updateContractOverride");
    expect(slice).not.toBeNull();
    // The bump uses the same scopeId the override was written under
    // and the timestamp the DB helper returned.
    expect(slice!).toMatch(/bumpScopeContractScanOverrideVersion/);
    expect(slice!).toMatch(
      /bumpScopeContractScanOverrideVersion\s*\(\s*ctx\.scopeId\s*,\s*result\.overriddenAt\s*\)/
    );
    // Must be AFTER the result null-check so we never bump on a NOT_FOUND.
    const nullCheckIdx = slice!.indexOf("if (!result)");
    const bumpIdx = slice!.indexOf("bumpScopeContractScanOverrideVersion(\n");
    expect(nullCheckIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(nullCheckIdx);
  });

  it("rescanSingleContract bumps after the insertContractScanResult write succeeds", () => {
    const slice = sliceProc(code, "rescanSingleContract");
    expect(slice).not.toBeNull();
    // Single-row rescan changed the latest scan-result row — bump
    // override-version with a fresh `new Date()` so the canonical
    // financials hash advances. Re-using `latestJob.id` for a
    // job-version bump WOULD NOT change the financials hash
    // because `computeFinancialsHash` reads `latestCompletedJobId`,
    // not any per-row updatedAt column; the stored job-id value
    // already equals `latestJob.id`.
    expect(slice!).toMatch(/bumpScopeContractScanOverrideVersion/);
    // Order: the bump must come AFTER `insertContractScanResult` so
    // a thrown insert never triggers a freshness advance.
    const insertIdx = slice!.indexOf("insertContractScanResult");
    const bumpIdx = slice!.indexOf("bumpScopeContractScanOverrideVersion");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(bumpIdx).toBeGreaterThan(insertIdx);
  });

  it("the bumps are best-effort (.catch with a console.warn) — do not throw out of the proc", () => {
    // A bump failure must not roll back the user-visible state
    // change. Every router-side bump is wrapped in `.catch(...)`.
    const slice = code;
    const bumpPattern =
      /bumpScopeContractScan(?:Override|Job)Version\s*\([\s\S]{0,200}\)\s*\.catch/g;
    const matches = slice.match(bumpPattern);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

describe("contract-scan freshness bumps — job runner (PR #338 follow-up item 1)", () => {
  const code = codeOnly(RUNNER);

  it("imports bumpScopeContractScanJobVersion from solarRecDatasets", () => {
    expect(code).toMatch(/bumpScopeContractScanJobVersion/);
    // Runner uses dynamic `await import("../../db/solarRecDatasets")`
    // so the bump symbol is destructured from that import.
    expect(code).toMatch(
      /bumpScopeContractScanJobVersion[\s\S]{0,200}import\s*\(\s*["']\.\.\/\.\.\/db\/solarRecDatasets["']/
    );
  });

  it("bumps after status: 'completed' is written — both the early no-pending-IDs branch AND the post-loop final branch", () => {
    // Two completion paths in the runner; both must bump.
    const completedWriteCount = (
      code.match(/status:\s*["']completed["']/g) || []
    ).length;
    expect(completedWriteCount).toBe(2);

    const bumpAfterCompletedCount = (
      code.match(
        /status:\s*["']completed["'][\s\S]{0,400}bumpScopeContractScanJobVersion/g
      ) || []
    ).length;
    expect(bumpAfterCompletedCount).toBe(2);
  });

  it("does NOT bump after ANY `stopped` write (cancelled job) — partial results are not a stable freshness anchor", () => {
    // PR #339 follow-up item 4 — pre-fix the test only checked
    // the FIRST `status: "stopped"` occurrence; a future PR
    // adding a bump after a second stopped-write would slip past.
    assertNoBumpAfterEachStatus(code, "stopped", 300);
  });

  it("does NOT bump after ANY `failed` write — failures didn't update the result set", () => {
    // The runner has multiple `failed` writes (missing
    // credentials, DB unavailable, error catch branch). All of
    // them must remain bump-free.
    assertNoBumpAfterEachStatus(code, "failed", 400);
  });

  it("the bump call is best-effort (.catch with a console.warn) — runner does not throw out of completion", () => {
    const matches = code.match(
      /bumpScopeContractScanJobVersion\s*\([\s\S]{0,200}\)\s*\.catch/g
    );
    expect(matches).not.toBeNull();
    // Both completion paths wrap their bump in .catch.
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * PR #339 follow-up item 4 (2026-05-05). Walk every occurrence of
 * `status: "<status>"` in the runner source and assert no
 * `bumpScopeContractScanJobVersion` appears within `windowChars`
 * after each. Iterating every occurrence catches a future PR that
 * adds a bump after a second/third terminal-status write — the
 * previous single-`indexOf` pattern only checked the first.
 */
function assertNoBumpAfterEachStatus(
  source: string,
  status: "failed" | "stopped",
  windowChars: number
): void {
  const needle = `status: "${status}"`;
  let from = 0;
  let occurrences = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx === -1) break;
    occurrences++;
    const window = source.slice(idx, idx + windowChars);
    expect(window).not.toMatch(/bumpScopeContractScanJobVersion/);
    from = idx + needle.length;
  }
  // Sanity: the runner must contain at least one write of this
  // status — otherwise the assertion above is vacuously true and
  // would silently pass under a refactor that renamed the literal.
  expect(occurrences).toBeGreaterThan(0);
}
