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

  it("exposes startDashboardLoadSemaphoreObservability and registers the timer there (NOT module-level)", () => {
    // 2026-05-09 — post-merge review of #496 caught that the
    // original setInterval was module-level, firing on every test
    // import. Pin the start-function shape so a future refactor
    // doesn't accidentally re-introduce a module-level timer.
    expect(source).toMatch(
      /export function startDashboardLoadSemaphoreObservability\(\)/
    );
    expect(source).toMatch(
      /setInterval\(\s*logSemaphoreState,\s*SEMAPHORE_LOG_INTERVAL_MS\s*\)/
    );
    // The function must return a stop callback (idempotent cleanup)
    // matching the pattern of `startDatasetUploadStaleJobSweeper`.
    expect(source).toMatch(/return \(\) => \{[\s\S]*?clearInterval/);
    // unref() ensures the timer doesn't keep Node alive in tests or
    // graceful-shutdown paths. Pin it so a future refactor doesn't
    // forget the call and leak the timer on every test run.
    expect(source).toMatch(/dashboardLoadSemaphoreLogTimer\.unref/);
  });

  it("does NOT call setInterval at module level", () => {
    // Source-text guard: the only `setInterval(logSemaphoreState,
    // ...)` call must live INSIDE the start function. A
    // module-level call would mean importing the router file in a
    // test starts a real timer (the original #496 bug); enforcing
    // it here keeps the regression locked out.
    const startFnIdx = source.indexOf(
      "export function startDashboardLoadSemaphoreObservability"
    );
    expect(startFnIdx).toBeGreaterThan(-1);
    const beforeStartFn = source.slice(0, startFnIdx);
    expect(beforeStartFn).not.toMatch(/setInterval\(\s*logSemaphoreState/);
  });

  it("is wired into the server boot path (production-only, gated by shouldMutateProdState)", () => {
    // The start function must actually be CALLED somewhere or it's
    // dead code. _core/index.ts is the canonical boot file; the
    // call site must live inside the prod-state gate so test runs
    // (NODE_ENV=test) skip it.
    const indexFile = readFileSync(
      resolve(__dirname, "index.ts"),
      "utf8"
    );
    expect(indexFile).toContain("startDashboardLoadSemaphoreObservability");
    expect(indexFile).toContain("shouldMutateProdState()");
    // Pin call-ordering: shouldMutateProdState() must precede the
    // start call — otherwise a test import would fire the timer.
    const gateIdx = indexFile.indexOf("shouldMutateProdState()");
    const callIdx = indexFile.indexOf(
      "startDashboardLoadSemaphoreObservability("
    );
    expect(gateIdx).toBeGreaterThan(-1);
    expect(callIdx).toBeGreaterThan(gateIdx);
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
