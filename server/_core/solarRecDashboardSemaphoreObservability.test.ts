/**
 * 2026-05-08 (Phase 6 observability) — pin the contract for the
 * periodic dashboard-load semaphore logger.
 *
 * Source-text tests so we don't need to spin up a fake setInterval
 * harness just to check the interval cadence + log fields. The
 * runtime behavior is exercised implicitly when the function is
 * called (via the setInterval wiring); a test that mocked timers
 * and asserted the log fired would only re-validate Node's timer
 * primitives. The contract here is the SHAPE of the log line + the
 * gate that suppresses idle-process logs.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTER_FILE = resolve(__dirname, "solarRecDashboardRouter.ts");
const source = readFileSync(ROUTER_FILE, "utf8");

describe("dashboardLoadSemaphore periodic logger", () => {
  it("uses a 30-second interval", () => {
    expect(source).toMatch(/SEMAPHORE_LOG_INTERVAL_MS\s*=\s*30_000/);
  });

  it("registers the timer with setInterval and unrefs it", () => {
    expect(source).toMatch(
      /setInterval\(\s*logSemaphoreState,\s*SEMAPHORE_LOG_INTERVAL_MS\s*\)/
    );
    // unref() ensures the timer doesn't keep Node alive in tests or
    // graceful-shutdown paths. Pin it so a future refactor doesn't
    // forget the call and leak the timer on every test run.
    expect(source).toMatch(/dashboardLoadSemaphoreLogTimer\.unref/);
  });

  it("suppresses logs when the semaphore + single-flight are both idle", () => {
    expect(source).toMatch(
      /stats\.active === 0 && stats\.waiting === 0 && inFlight === 0/
    );
    // The early-return path keeps the per-tick cost essentially zero
    // for an idle process — a successful production deploy shouldn't
    // emit a periodic "active=0 waiting=0" line every 30 s.
  });

  it("logs every required field for ops triage", () => {
    // The fields are the inputs an operator needs to attribute a
    // saturation incident: how many slots are taken, how many are
    // queued, what the cap is, how many distinct keys are mid-load,
    // and the heap floor. Pin all five so a future refactor doesn't
    // silently drop one.
    const fieldNames = [
      "active",
      "waiting",
      "limit",
      "inFlightSingleFlight",
      "heapUsedBytes",
    ];
    for (const field of fieldNames) {
      expect(source).toContain(field);
    }
    expect(source).toContain("[dashboard:load-semaphore]");
  });

  it("wraps the read in a try/catch so a logger throw can't crash the worker", () => {
    // A failed `process.memoryUsage()` (rare) or a future field that
    // throws in `JSON.stringify` (e.g. circular ref) must not propagate
    // up the timer callback. The catch-all is the load-bearing safety
    // belt that keeps observability from becoming a SPOF.
    const fnStart = source.indexOf("function logSemaphoreState()");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = source.slice(fnStart, fnStart + 1500);
    expect(fnSlice).toMatch(/try\s*{/);
    expect(fnSlice).toMatch(/catch/);
  });
});
