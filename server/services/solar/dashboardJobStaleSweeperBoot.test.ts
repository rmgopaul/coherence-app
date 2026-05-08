/**
 * 2026-05-09 — post-merge audit follow-up.
 *
 * Pin the contract that BOTH dashboard-job modules expose a
 * `start*StaleJobSweeper()` boot fn AND that those fns are wired
 * into `_core/index.ts` under `shouldMutateProdState()`. Pre-fix,
 * the modules' sweeps fired ONLY opportunistically on status reads
 * — orphan `running` rows whose creating client moved on (page
 * reload, tab close) sat forever. Production evidence:
 * bld-312c41a266cf… stuck for ~24 h after a deploy.
 *
 * Source-text tests so we don't need to spin up a fake setInterval
 * harness just to verify wiring. The timer behavior is exercised
 * implicitly when the boot fn runs; the contract here is the SHAPE
 * of the boot fn + its presence in the boot path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const BUILD_FILE = resolve(__dirname, "dashboardBuildJobs.ts");
const CSV_FILE = resolve(__dirname, "dashboardCsvExportJobs.ts");
const INDEX_FILE = resolve(__dirname, "../../_core/index.ts");

const buildSource = readFileSync(BUILD_FILE, "utf8");
const csvSource = readFileSync(CSV_FILE, "utf8");
const indexSource = readFileSync(INDEX_FILE, "utf8");

describe("dashboardBuildJobs — boot-time stale sweeper", () => {
  it("exports startDashboardBuildStaleJobSweeper", () => {
    expect(buildSource).toMatch(
      /export function startDashboardBuildStaleJobSweeper\(\)/
    );
  });

  it("uses a 5-minute default interval (matches STALE_CLAIM_MS)", () => {
    expect(buildSource).toMatch(
      /DEFAULT_BUILD_SWEEP_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/
    );
  });

  it("is env-tunable via DASHBOARD_BUILD_SWEEP_INTERVAL_MS", () => {
    expect(buildSource).toContain("DASHBOARD_BUILD_SWEEP_INTERVAL_MS");
  });

  it("returns a stop callback (idempotent cleanup)", () => {
    // Mirror the startDatasetUploadStaleJobSweeper / start
    // DashboardLoadSemaphoreObservability shape.
    const startFnIdx = buildSource.indexOf(
      "export function startDashboardBuildStaleJobSweeper"
    );
    expect(startFnIdx).toBeGreaterThan(-1);
    const fnSlice = buildSource.slice(startFnIdx, startFnIdx + 2000);
    expect(fnSlice).toMatch(/return \(\) => \{[\s\S]*?clearInterval/);
  });

  it("calls unref() so the timer never holds Node alive", () => {
    expect(buildSource).toMatch(/buildSweepTimer\.unref/);
  });

  it("fires a boot tick before scheduling the timer", () => {
    // Pre-fix: fresh process inheriting stuck rows from the prior
    // instance had to wait the full interval before its first
    // sweep. The boot tick handles the deploy-cutover case.
    const startFnIdx = buildSource.indexOf(
      "export function startDashboardBuildStaleJobSweeper"
    );
    const fnSlice = buildSource.slice(startFnIdx, startFnIdx + 2000);
    const bootTickIdx = fnSlice.indexOf("void runBuildSweepTick()");
    const setIntervalIdx = fnSlice.indexOf("setInterval(");
    expect(bootTickIdx).toBeGreaterThan(-1);
    expect(setIntervalIdx).toBeGreaterThan(-1);
    expect(bootTickIdx).toBeLessThan(setIntervalIdx);
  });

  it("guards against re-entrancy via the buildSweeping flag", () => {
    // Slow DB shouldn't stack overlapping sweep ticks.
    const fnStart = buildSource.indexOf("async function runBuildSweepTick");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = buildSource.slice(fnStart, fnStart + 1500);
    expect(fnSlice).toMatch(/if \(buildSweeping\) return/);
    expect(fnSlice).toMatch(/buildSweeping = true/);
    expect(fnSlice).toMatch(/buildSweeping = false/);
  });
});

describe("dashboardCsvExportJobs — boot-time stale sweeper", () => {
  it("exports startDashboardCsvExportStaleJobSweeper", () => {
    expect(csvSource).toMatch(
      /export function startDashboardCsvExportStaleJobSweeper\(\)/
    );
  });

  it("uses a 5-minute default interval (matches STALE_CLAIM_MS)", () => {
    expect(csvSource).toMatch(
      /DEFAULT_CSV_EXPORT_SWEEP_INTERVAL_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/
    );
  });

  it("is env-tunable via DASHBOARD_CSV_EXPORT_SWEEP_INTERVAL_MS", () => {
    expect(csvSource).toContain("DASHBOARD_CSV_EXPORT_SWEEP_INTERVAL_MS");
  });

  it("returns a stop callback (idempotent cleanup)", () => {
    const startFnIdx = csvSource.indexOf(
      "export function startDashboardCsvExportStaleJobSweeper"
    );
    expect(startFnIdx).toBeGreaterThan(-1);
    const fnSlice = csvSource.slice(startFnIdx, startFnIdx + 2000);
    expect(fnSlice).toMatch(/return \(\) => \{[\s\S]*?clearInterval/);
  });

  it("calls unref() on the timer", () => {
    expect(csvSource).toMatch(/csvExportSweepTimer\.unref/);
  });

  it("fires a boot tick before scheduling the timer", () => {
    const startFnIdx = csvSource.indexOf(
      "export function startDashboardCsvExportStaleJobSweeper"
    );
    const fnSlice = csvSource.slice(startFnIdx, startFnIdx + 2000);
    const bootTickIdx = fnSlice.indexOf("void runCsvExportSweepTick()");
    const setIntervalIdx = fnSlice.indexOf("setInterval(");
    expect(bootTickIdx).toBeGreaterThan(-1);
    expect(setIntervalIdx).toBeGreaterThan(-1);
    expect(bootTickIdx).toBeLessThan(setIntervalIdx);
  });

  it("guards against re-entrancy via the csvExportSweeping flag", () => {
    const fnStart = csvSource.indexOf(
      "async function runCsvExportSweepTick"
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = csvSource.slice(fnStart, fnStart + 800);
    expect(fnSlice).toMatch(/if \(csvExportSweeping\) return/);
    expect(fnSlice).toMatch(/csvExportSweeping = true/);
    expect(fnSlice).toMatch(/csvExportSweeping = false/);
  });
});

describe("server boot path wiring", () => {
  it("imports both start fns from the right modules", () => {
    expect(indexSource).toMatch(
      /import \{ startDashboardBuildStaleJobSweeper \} from "[^"]*\/dashboardBuildJobs"/
    );
    expect(indexSource).toMatch(
      /import \{ startDashboardCsvExportStaleJobSweeper \} from "[^"]*\/dashboardCsvExportJobs"/
    );
  });

  it("calls both start fns under shouldMutateProdState()", () => {
    expect(indexSource).toContain("startDashboardBuildStaleJobSweeper(");
    expect(indexSource).toContain("startDashboardCsvExportStaleJobSweeper(");

    // Pin the gate ordering: both start calls must come AFTER the
    // shouldMutateProdState() check. A test import (NODE_ENV=test)
    // that fired the timer would defeat the whole pattern.
    const gateIdx = indexSource.indexOf("shouldMutateProdState()");
    const buildCallIdx = indexSource.indexOf(
      "startDashboardBuildStaleJobSweeper("
    );
    const csvCallIdx = indexSource.indexOf(
      "startDashboardCsvExportStaleJobSweeper("
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(buildCallIdx).toBeGreaterThan(gateIdx);
    expect(csvCallIdx).toBeGreaterThan(gateIdx);
  });

  it("does NOT call either start fn at module level", () => {
    // Source-text guard: the only call sites must live inside the
    // shouldMutateProdState() block. A module-level call would
    // mean importing _core/index.ts in a test starts a real timer.
    const gateIdx = indexSource.indexOf("shouldMutateProdState()");
    expect(gateIdx).toBeGreaterThan(-1);
    const beforeGate = indexSource.slice(0, gateIdx);
    expect(beforeGate).not.toMatch(
      /startDashboardBuildStaleJobSweeper\(/
    );
    expect(beforeGate).not.toMatch(
      /startDashboardCsvExportStaleJobSweeper\(/
    );
  });
});
