/**
 * Source-level rail proving the server-boot path gates its
 * prod-mutating schedulers + orphan-batch cleanup on
 * `shouldMutateProdState()`.
 *
 * Concern #4 PR-2 (per
 * `docs/triage/local-dev-prod-mutation-findings.md`). The
 * findings doc enumerated 4 always-on entry points in
 * `server/_core/index.ts`:
 *
 *   A1: startNightlySnapshotScheduler()
 *   A2: startMonitoringScheduler()
 *   A3: startDatasetUploadStaleJobSweeper()
 *   A4: failOrphanedRunningBatches() (fire-and-forget block)
 *
 * Pre-fix all four were unconditional. Post-fix all four live
 * inside an `if (shouldMutateProdState()) { … }` branch. A
 * behavioral test would require mocking the scheduler module +
 * booting `startServer()`, which is heavy and side-effectful.
 * A source-grep rail is the cheap regression guard — if a future
 * PR moves any of the 4 starts back outside the gate (e.g. a
 * "drive-by fix" that splits the block in half), this test fails
 * immediately with a clear diff against the documented contract.
 *
 * The pattern mirrors `dashboardMountResilience.test.ts` — pure
 * source read + structural assertions, no React or DB.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const INDEX_FILE = resolve(__dirname, "index.ts");
const SOURCE = readFileSync(INDEX_FILE, "utf8");

/** Strip block + line comments so prose docstrings don't confuse the regex. */
function codeOnly(): string {
  return SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(
    /(^|[^:])\/\/[^\n]*/g,
    "$1"
  );
}

describe("server-boot scheduler gate (Concern #4 PR-2)", () => {
  const code = codeOnly();

  it("imports shouldMutateProdState from runtimeTarget", () => {
    expect(code).toMatch(
      /import\s*\{\s*shouldMutateProdState\s*\}\s*from\s*"\.\/runtimeTarget"/
    );
  });

  it("opens an `if (shouldMutateProdState())` block inside startServer", () => {
    // The guard is the single point of truth for the 4 always-on
    // prod-mutation entry points. Anything outside this block at
    // server-boot time is a regression candidate.
    expect(code).toMatch(/if\s*\(\s*shouldMutateProdState\s*\(\s*\)\s*\)\s*\{/);
  });

  it("places startNightlySnapshotScheduler() inside the gate", () => {
    const block = extractGateBlock(code);
    expect(block).not.toBeNull();
    expect(block!).toMatch(/startNightlySnapshotScheduler\s*\(\s*\)/);
  });

  it("places startMonitoringScheduler() inside the gate", () => {
    const block = extractGateBlock(code);
    expect(block).not.toBeNull();
    expect(block!).toMatch(/startMonitoringScheduler\s*\(\s*\)/);
  });

  it("places startDatasetUploadStaleJobSweeper() inside the gate", () => {
    const block = extractGateBlock(code);
    expect(block).not.toBeNull();
    expect(block!).toMatch(/startDatasetUploadStaleJobSweeper\s*\(\s*\)/);
  });

  it("places the failOrphanedRunningBatches dynamic import inside the gate", () => {
    const block = extractGateBlock(code);
    expect(block).not.toBeNull();
    // The block uses a dynamic import to keep the boot path lazy:
    //   const { failOrphanedRunningBatches } = await import("../db");
    expect(block!).toMatch(/failOrphanedRunningBatches/);
    expect(block!).toMatch(/await\s+import\s*\(\s*"\.\.\/db"\s*\)/);
  });

  it("does NOT call any of the 4 starts outside the gate block", () => {
    // The gate's only job is preventing accidental drift back to
    // unconditional starts. If any of these symbols appear outside
    // the gate block, the gate is bypassed.
    const block = extractGateBlock(code);
    expect(block).not.toBeNull();
    const outside = code.replace(block!, "");

    // The IMPORT statements naturally appear outside the gate
    // (they're at the top of the file). Strip them so we only
    // catch CALL sites.
    const importStripped = outside.replace(
      /import\s*\{[^}]*\}\s*from\s*"[^"]+";?/g,
      ""
    );

    expect(importStripped).not.toMatch(
      /\bstartNightlySnapshotScheduler\s*\(/
    );
    expect(importStripped).not.toMatch(
      /\bstartMonitoringScheduler\s*\(/
    );
    expect(importStripped).not.toMatch(
      /\bstartDatasetUploadStaleJobSweeper\s*\(/
    );
    expect(importStripped).not.toMatch(
      /\bfailOrphanedRunningBatches\s*\(/
    );
  });

  it("logs an explanatory warning on the else branch (operator visibility)", () => {
    // A silent skip is hostile to operators debugging "why aren't
    // my scheduled monitoring runs firing on this dev box?" — the
    // warn line tells them how to opt in.
    expect(code).toMatch(/console\.warn\s*\([\s\S]*?ALLOW_LOCAL_TO_PROD_WRITES/);
  });
});

/**
 * Walk balanced braces to extract the `if (shouldMutateProdState())
 * { … }` block body. Used instead of a greedy regex because the
 * block contains nested template literals + `${…}` interpolations
 * whose unescaped `}` would close a regex-based capture early.
 */
function extractGateBlock(code: string): string | null {
  const ifMatch = code.match(/if\s*\(\s*shouldMutateProdState\s*\(\s*\)\s*\)\s*\{/);
  if (!ifMatch || ifMatch.index === undefined) return null;
  const openBraceIdx = code.indexOf("{", ifMatch.index);
  if (openBraceIdx === -1) return null;
  let depth = 0;
  for (let i = openBraceIdx; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return code.slice(openBraceIdx + 1, i);
      }
    }
  }
  return null;
}
