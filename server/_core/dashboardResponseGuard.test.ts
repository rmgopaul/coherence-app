import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initTRPC } from "@trpc/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES_DEFAULT,
  DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES_DEFAULT,
  DASHBOARD_OVERSIZE_ALLOWLIST,
  DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT,
  checkDashboardResponseSize,
  getDashboardRequestHeapAfterWarnBytes,
  getDashboardRequestHeapDeltaWarnBytes,
  getDashboardRequestHeapLogAll,
  getDashboardResponseEnforcement,
  getDashboardResponseLimitBytes,
} from "./dashboardResponseGuard";

const ENV_KEYS = [
  "DASHBOARD_RESPONSE_LIMIT_BYTES",
  "DASHBOARD_RESPONSE_ENFORCEMENT",
  "DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES",
  "DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES",
  "DASHBOARD_REQUEST_HEAP_LOG_ALL",
  "DASHBOARD_TIDB_DIAGNOSTICS",
  "DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS",
  "DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS",
  "DASHBOARD_TIDB_DIAGNOSTICS_LIMIT",
  "NODE_ENV",
] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(
    ENV_KEYS.map((k) => [k, process.env[k]])
  ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
}

function restoreEnv(snapshot: ReturnType<typeof snapshotEnv>): void {
  for (const k of ENV_KEYS) {
    const value = snapshot[k];
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
}

describe("getDashboardResponseLimitBytes", () => {
  let snapshot: ReturnType<typeof snapshotEnv>;
  beforeEach(() => {
    snapshot = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("defaults to 1 MB when env unset", () => {
    delete process.env.DASHBOARD_RESPONSE_LIMIT_BYTES;
    expect(getDashboardResponseLimitBytes()).toBe(
      DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
    );
    expect(DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT).toBe(1024 * 1024);
  });

  it("respects a positive integer override", () => {
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "262144";
    expect(getDashboardResponseLimitBytes()).toBe(262144);
  });

  it("falls back to the default for non-numeric / non-positive / whitespace values", () => {
    for (const raw of ["not-a-number", "0", "-1024", "   "]) {
      process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = raw;
      expect(getDashboardResponseLimitBytes()).toBe(
        DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
      );
    }
  });

  it("floors a fractional positive value", () => {
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "131072.9";
    expect(getDashboardResponseLimitBytes()).toBe(131072);
  });
});

describe("getDashboardResponseEnforcement", () => {
  let snapshot: ReturnType<typeof snapshotEnv>;
  beforeEach(() => {
    snapshot = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("returns 'warn' in production by default", () => {
    delete process.env.DASHBOARD_RESPONSE_ENFORCEMENT;
    process.env.NODE_ENV = "production";
    expect(getDashboardResponseEnforcement()).toBe("warn");
  });

  it("returns 'throw' in dev/test by default", () => {
    delete process.env.DASHBOARD_RESPONSE_ENFORCEMENT;
    for (const env of ["development", "test"]) {
      process.env.NODE_ENV = env;
      expect(getDashboardResponseEnforcement()).toBe("throw");
    }
  });

  it.each(["warn", "throw", "off"] as const)(
    "respects an explicit '%s' override",
    (value) => {
      process.env.DASHBOARD_RESPONSE_ENFORCEMENT = value;
      process.env.NODE_ENV = "production";
      expect(getDashboardResponseEnforcement()).toBe(value);
    }
  );

  it("normalizes case and whitespace", () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "  THROW  ";
    process.env.NODE_ENV = "production";
    expect(getDashboardResponseEnforcement()).toBe("throw");
  });

  it("falls back to NODE_ENV-driven default for invalid values", () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "loud";
    process.env.NODE_ENV = "production";
    expect(getDashboardResponseEnforcement()).toBe("warn");
    process.env.NODE_ENV = "development";
    expect(getDashboardResponseEnforcement()).toBe("throw");
  });
});

describe("dashboard request heap env helpers", () => {
  let snapshot: ReturnType<typeof snapshotEnv>;
  beforeEach(() => {
    snapshot = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("uses the documented default heap thresholds", () => {
    delete process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES;
    delete process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES;
    expect(getDashboardRequestHeapDeltaWarnBytes()).toBe(
      DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES_DEFAULT
    );
    expect(getDashboardRequestHeapAfterWarnBytes()).toBe(
      DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES_DEFAULT
    );
    expect(DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES_DEFAULT).toBe(
      64 * 1024 * 1024
    );
    expect(DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES_DEFAULT).toBe(
      700 * 1024 * 1024
    );
  });

  it("respects positive threshold overrides and ignores invalid ones", () => {
    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "1024.9";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "2048";
    expect(getDashboardRequestHeapDeltaWarnBytes()).toBe(1024);
    expect(getDashboardRequestHeapAfterWarnBytes()).toBe(2048);

    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "0";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "nope";
    expect(getDashboardRequestHeapDeltaWarnBytes()).toBe(
      DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES_DEFAULT
    );
    expect(getDashboardRequestHeapAfterWarnBytes()).toBe(
      DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES_DEFAULT
    );
  });

  it("supports explicit log-all truthy values only", () => {
    for (const raw of ["1", "true", "yes", "on", " TRUE "]) {
      process.env.DASHBOARD_REQUEST_HEAP_LOG_ALL = raw;
      expect(getDashboardRequestHeapLogAll()).toBe(true);
    }
    for (const raw of ["", "0", "false", "off", "no", "anything-else"]) {
      process.env.DASHBOARD_REQUEST_HEAP_LOG_ALL = raw;
      expect(getDashboardRequestHeapLogAll()).toBe(false);
    }
  });
});

describe("DASHBOARD_OVERSIZE_ALLOWLIST", () => {
  it("is empty after Phase 2 — every known oversized response has been retired", () => {
    // Retirement history (most recent first):
    //   - `getDashboardOfflineMonitoring` — Phase 2 OfflineMonitoring
    //     residual cleanup (2026-05-07): stripped 3 dead Part-2 ID
    //     arrays + dropped the dead parent `part2VerifiedSystemIds`
    //     useMemo. Remaining wire shape (eligiblePart2TrackingIds +
    //     2 scalars) fits under 1 MB.
    //   - `getSystemSnapshot` — Phase 2 PR-F-4-h (2026-05-07): every
    //     client consumer migrated to paginated/aggregator-backed
    //     reads. `useSystemSnapshot` hook + parent `systems` useMemo
    //     deleted. Server-side proc still exists; no client callers.
    //   - `getDashboardOverviewSummary` — Phase 2 PR-E-4-supplement
    //     (2026-05-06): stripped `ownershipRows` (~5–15 MB) at the
    //     wire boundary.
    //   - `getDashboardChangeOwnership` — Phase 2 PR-D-4 (2026-05-06):
    //     stripped `rows` (~19 MB) at the wire boundary; consumers
    //     moved to paginated `getDashboardChangeOwnershipPage`.
    //
    // The allowlist mechanism stays in the source for future
    // pressure-relief use; if a new regression genuinely needs an
    // entry, add it here with an inline replacement plan.
    expect([...DASHBOARD_OVERSIZE_ALLOWLIST]).toEqual([]);
  });

  it("uses fully-qualified router-prefixed paths (no bare procedure names)", () => {
    for (const entry of DASHBOARD_OVERSIZE_ALLOWLIST) {
      expect(entry).toMatch(/^solarRecDashboard\.[A-Za-z]+$/);
    }
  });

  it("does NOT include the retired CSV-export procs (replaced by the background-job flow)", () => {
    // The `startDashboardCsvExport` + `getDashboardCsvExportJobStatus`
    // pair shipped under the response budget — both responses are
    // bounded. The old `exportOwnershipTileCsv` /
    // `exportChangeOwnershipTileCsv` synchronous procs are gone.
    expect(DASHBOARD_OVERSIZE_ALLOWLIST.has(
      "solarRecDashboard.exportOwnershipTileCsv"
    )).toBe(false);
    expect(DASHBOARD_OVERSIZE_ALLOWLIST.has(
      "solarRecDashboard.exportChangeOwnershipTileCsv"
    )).toBe(false);
    expect(DASHBOARD_OVERSIZE_ALLOWLIST.has(
      "solarRecDashboard.getDatasetCsv"
    )).toBe(false);
  });
});

describe("checkDashboardResponseSize", () => {
  it("returns ok with measured bytes for a small response", () => {
    const verdict = checkDashboardResponseSize(
      { hello: "world" },
      "solarRecDashboard.someProc",
      { limitBytes: 1024 }
    );
    if (!verdict.ok) {
      throw new Error(`expected ok verdict, got bytes=${verdict.bytes}`);
    }
    expect(verdict.limit).toBe(1024);
    expect(verdict.bytes).toBeGreaterThan(0);
    expect(verdict.bytes).toBeLessThanOrEqual(1024);
  });

  it("flags oversize and reports allowlisted=true only for fully-qualified entries", () => {
    // The default `DASHBOARD_OVERSIZE_ALLOWLIST` is empty after
    // Phase 2; pass a synthetic allowlist via `options.allowlist`
    // to exercise the path-matching branch. The match must be on
    // the FULLY-QUALIFIED `<router>.<proc>` path — bare procedure
    // names + same-name-different-router both miss.
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const synthetic = new Set(["solarRecDashboard.heavyTestProc"]);
    const allowlisted = checkDashboardResponseSize(
      big,
      "solarRecDashboard.heavyTestProc",
      { limitBytes: 1024, allowlist: synthetic }
    );
    const bare = checkDashboardResponseSize(
      big,
      "heavyTestProc",
      {
        limitBytes: 1024,
        allowlist: synthetic,
      }
    );
    const otherRouter = checkDashboardResponseSize(
      big,
      "otherRouter.heavyTestProc",
      { limitBytes: 1024, allowlist: synthetic }
    );
    if (allowlisted.ok || bare.ok || otherRouter.ok) {
      throw new Error("expected oversize verdicts");
    }
    expect(allowlisted.allowlisted).toBe(true);
    expect(bare.allowlisted).toBe(false);
    expect(otherRouter.allowlisted).toBe(false);
  });

  it("respects a custom allowlist via options", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "myRouter.someExperimentalProc",
      {
        limitBytes: 1024,
        allowlist: new Set(["myRouter.someExperimentalProc"]),
      }
    );
    if (verdict.ok) throw new Error("expected oversize verdict");
    expect(verdict.allowlisted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-router middleware integration: confirm tRPC reports the
// fully-qualified path to middleware after sub-router composition.
// The allowlist relies on this format.
// ---------------------------------------------------------------------------

describe("tRPC middleware path format", () => {
  it("reports the full dotted path inside a composed sub-router", async () => {
    const tT = initTRPC.create();
    const observed: string[] = [];

    const captureMiddleware = tT.middleware(async ({ path, next }) => {
      observed.push(path);
      return next();
    });

    const subRouter = tT.router({
      myProc: tT.procedure
        .use(captureMiddleware)
        .query(() => ({ ok: true })),
    });
    const appRouter = tT.router({ solarRecDashboard: subRouter });

    const caller = appRouter.createCaller({});
    await caller.solarRecDashboard.myProc();

    expect(observed).toEqual(["solarRecDashboard.myProc"]);
  });
});

// ---------------------------------------------------------------------------
// Allowlist serialization-skip behavior. The whole point of the warn-
// mode short-circuit is to avoid `JSON.stringify`-ing 20–60 MB
// allowlisted responses. The "sentinel" object below has a `toJSON`
// that throws — if the middleware tries to serialize it, the test
// fails. Tests are at the procedure-handler level so we exercise the
// real middleware (not just `checkDashboardResponseSize`).
// ---------------------------------------------------------------------------

describe("dashboardResponseGuardMiddleware allowlist short-circuit", () => {
  let envSnapshot: ReturnType<typeof snapshotEnv>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    delete process.env.DASHBOARD_TIDB_DIAGNOSTICS;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock("./solarRecBase");
  });

  /**
   * Builds a tiny tRPC dispatcher that uses the real
   * `dashboardResponseGuardMiddleware`. Returns a caller against a
   * router shaped like `solarRecDashboard.<procName>` so the path the
   * middleware sees matches the production-format allowlist entries.
   *
   * `requirePermission` is mocked to a passthrough so we do not need
   * a real DB or solar-rec context just to drive the guard.
   */
  async function buildHarness(
    procedureName: string,
    payload: unknown,
    resolver?: () => unknown
  ) {
    vi.resetModules();
    vi.doMock("./solarRecBase", async () => {
      const trpc = await import("@trpc/server");
      const localT = trpc.initTRPC.create();
      const passthrough = localT.middleware(async ({ next }) => next());
      return {
        t: localT,
        requirePermission: () => localT.procedure.use(passthrough),
      };
    });

    const { dashboardProcedure } = await import("./dashboardResponseGuard");
    // Reuse the same `t` we just gave to dashboardResponseGuard via the
    // mock so middleware composition shares one tRPC instance.
    const { t: localT } = (await import("./solarRecBase")) as unknown as {
      t: ReturnType<typeof initTRPC.create>;
    };
    const subRouter = localT.router({
      [procedureName]: dashboardProcedure(
        "solar-rec-dashboard",
        "read"
      ).query(() => (resolver ? resolver() : payload)),
    });
    const appRouter = localT.router({ solarRecDashboard: subRouter });
    return appRouter.createCaller({});
  }

  /**
   * A response whose JSON serialization would throw. If the middleware
   * tries to stringify it, the throw surfaces during the call.
   */
  function sentinel() {
    return {
      toJSON: () => {
        throw new Error(
          "[test] sentinel response was serialized by the guard"
        );
      },
    };
  }

  function memoryUsageWithHeap(
    heapUsed: number
  ): ReturnType<typeof process.memoryUsage> {
    return {
      rss: heapUsed,
      heapTotal: heapUsed,
      heapUsed,
      external: 0,
      arrayBuffers: 0,
    };
  }

  function mockHeapSequence(...heapValues: number[]) {
    let index = 0;
    return vi.spyOn(process, "memoryUsage").mockImplementation(() => {
      const value = heapValues[Math.min(index, heapValues.length - 1)] ?? 0;
      index += 1;
      return memoryUsageWithHeap(value);
    });
  }

  function parseHeapLog(callIndex = 0): Record<string, unknown> {
    const message = String(warnSpy.mock.calls[callIndex]?.[0] ?? "");
    expect(message).toContain("[dashboard:request-heap]");
    return JSON.parse(
      message.replace("[dashboard:request-heap] ", "")
    ) as Record<string, unknown>;
  }

  function parseWarnLogByPrefix(prefix: string): Record<string, unknown> {
    const message = String(
      warnSpy.mock.calls.find((call) =>
        String(call[0]).startsWith(prefix)
      )?.[0] ?? ""
    );
    expect(message).toContain(prefix);
    return JSON.parse(
      message.replace(`${prefix} `, "")
    ) as Record<string, unknown>;
  }

  // Phase 2 OfflineMonitoring residual cleanup (2026-05-07): the
  // 3 harness-driven "allowlisted X" tests previously exercised
  // middleware code paths that activate only when a response's
  // tRPC path is in `DASHBOARD_OVERSIZE_ALLOWLIST`. After the
  // last entry retired, the allowlist is empty and those tests
  // had no live exemplar — wiring them up against a mocked Set
  // would test-only-overhead the middleware without behavioral
  // coverage. The middleware code paths still exist (search
  // `dashboardResponseGuard.ts` for `allowlisted`); if a future
  // regression genuinely needs an allowlist entry, revive the
  // tests then. Removed:
  //   - warn mode + allowlisted: does NOT serialize the response
  //   - heap log-all + allowlisted: logs heap without serializing
  //   - throw mode + allowlisted: serializes (to log) but does
  //     not throw
  // Path-matching coverage stays in the unit-level test above
  // ("flags oversize and reports allowlisted=true only for
  // fully-qualified entries") via a synthetic allowlist Set.

  it("does not log heap metrics below thresholds by default", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "warn";
    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "1000";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "10000";
    mockHeapSequence(1_000, 1_100);
    const caller = await buildHarness("someExperimentalProc", { ok: true });

    await (caller.solarRecDashboard as {
      someExperimentalProc: () => Promise<unknown>;
    }).someExperimentalProc();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs one structured heap line when the heap delta threshold is exceeded", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "off";
    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "100";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "10000";
    mockHeapSequence(1_000, 1_250);
    const caller = await buildHarness("someExperimentalProc", { ok: true });

    await (caller.solarRecDashboard as {
      someExperimentalProc: () => Promise<unknown>;
    }).someExperimentalProc();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = parseHeapLog();
    expect(payload).toMatchObject({
      path: "solarRecDashboard.someExperimentalProc",
      outcome: "success",
      enforcement: "off",
      allowlisted: false,
      heapBeforeBytes: 1000,
      heapAfterBytes: 1250,
      heapDeltaBytes: 250,
      heapDeltaWarnBytes: 100,
      heapAfterWarnBytes: 10000,
      reasons: ["heap-delta"],
    });
    expect(typeof payload.elapsedMs).toBe("number");
  });

  it("logs below-threshold heap metrics when log-all is enabled", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "off";
    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "1000";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "10000";
    process.env.DASHBOARD_REQUEST_HEAP_LOG_ALL = "true";
    mockHeapSequence(1_000, 1_001);
    const caller = await buildHarness("someExperimentalProc", { ok: true });

    await (caller.solarRecDashboard as {
      someExperimentalProc: () => Promise<unknown>;
    }).someExperimentalProc();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = parseHeapLog();
    expect(payload.enforcement).toBe("off");
    expect(payload.reasons).toEqual(["log-all"]);
  });

  it("logs failed procedures when the heap threshold is exceeded", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "warn";
    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "100";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "10000";
    mockHeapSequence(1_000, 1_250);
    const caller = await buildHarness("someExperimentalProc", null, () => {
      throw new Error("boom");
    });

    await expect(
      (caller.solarRecDashboard as {
        someExperimentalProc: () => Promise<unknown>;
      }).someExperimentalProc()
    ).rejects.toThrow("boom");

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = parseHeapLog();
    expect(payload).toMatchObject({
      path: "solarRecDashboard.someExperimentalProc",
      outcome: "failed",
      error: "boom",
      heapDeltaBytes: 250,
      reasons: ["heap-delta"],
    });
  });

  it("warn mode + non-allowlisted: serializes (to log) but does not throw", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "warn";
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "32"; // tiny budget
    const caller = await buildHarness("someExperimentalProc", {
      rows: Array.from({ length: 100 }, (_, i) => ({ i })),
    });
    const result = await (caller.solarRecDashboard as {
      someExperimentalProc: () => Promise<unknown>;
    }).someExperimentalProc();
    expect(result).toBeTruthy();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain(
      "[dashboard:oversize-response]"
    );
  });

  it("warn mode + non-allowlisted + heap pressure: skips size measurement without serializing", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "warn";
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "32";
    process.env.DASHBOARD_REQUEST_HEAP_DELTA_WARN_BYTES = "100";
    process.env.DASHBOARD_REQUEST_HEAP_AFTER_WARN_BYTES = "10000";
    mockHeapSequence(1_000, 1_250);
    const caller = await buildHarness("someExperimentalProc", sentinel());

    await expect(
      (caller.solarRecDashboard as {
        someExperimentalProc: () => Promise<unknown>;
      }).someExperimentalProc()
    ).resolves.toBeTruthy();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    const heapPayload = parseWarnLogByPrefix("[dashboard:request-heap]");
    expect(heapPayload).toMatchObject({
      path: "solarRecDashboard.someExperimentalProc",
      outcome: "success",
      reasons: ["heap-delta"],
    });
    const skipPayload = parseWarnLogByPrefix("[dashboard:response-size-skip]");
    expect(skipPayload).toMatchObject({
      path: "solarRecDashboard.someExperimentalProc",
      enforcement: "warn",
      allowlisted: false,
      heapBeforeBytes: 1000,
      heapAfterBytes: 1250,
      heapDeltaBytes: 250,
      heapDeltaWarnBytes: 100,
      heapAfterWarnBytes: 10000,
      reasons: ["heap-delta"],
    });
  });

  // The `throw mode + allowlisted: serializes (to log) but does
  // not throw` test was removed alongside the warn-mode +
  // heap-log-all allowlisted tests above (see the multi-line note
  // around the removed block). All three exercised behavior that
  // requires a live allowlist entry; with the allowlist now empty
  // there's no live exemplar to test against.

  it("throw mode + non-allowlisted: serializes and throws TRPCError", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "throw";
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "32";
    const caller = await buildHarness("someExperimentalProc", {
      rows: Array.from({ length: 100 }, (_, i) => ({ i })),
    });
    await expect(
      (caller.solarRecDashboard as {
        someExperimentalProc: () => Promise<unknown>;
      }).someExperimentalProc()
    ).rejects.toThrow(/exceeded 32 bytes/);
  });

  it("off mode: bypasses the guard entirely (no measurement, no log)", async () => {
    process.env.DASHBOARD_RESPONSE_ENFORCEMENT = "off";
    const caller = await buildHarness("someExperimentalProc", sentinel());
    await expect(
      (caller.solarRecDashboard as {
        someExperimentalProc: () => Promise<unknown>;
      }).someExperimentalProc()
    ).resolves.toBeTruthy();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regression rail: every dashboard procedure must go through
// dashboardProcedure(), not raw requirePermission(). A future PR that
// adds a procedure with the wrong builder loses the size guard
// silently; this asserts the contract on the source file.
// ---------------------------------------------------------------------------

describe("solarRecDashboardRouter wiring", () => {
  it("uses dashboardProcedure exclusively (no raw requirePermission)", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    expect(source).not.toMatch(/\brequirePermission\s*\(/);
    const matches = source.match(/\bdashboardProcedure\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(40);
  });

  it("registers getDashboardSummary as a dashboardProcedure", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    expect(source).toMatch(
      /getDashboardSummary\s*:\s*dashboardProcedure\s*\(/
    );
  });

  it("keeps getDatasetSummariesAll on metadata-only row counts", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    const procBlock =
      /getDatasetSummariesAll\s*:\s*dashboardProcedure[\s\S]*?\n  \/\*\*\n   \* Cursor-paginated row reader/.exec(
        source
      )?.[0];
    expect(procBlock).toBeDefined();
    // This query runs on default Overview mount. It must not fan out
    // into live COUNT(*) scans over all active srDs* tables; the upload
    // and migration paths already persist the active batch rowCount.
    expect(procBlock!).not.toMatch(/COUNT\s*\(\s*\*\s*\)/);
    expect(procBlock!).not.toMatch(/actualRowCounts/);
    expect(procBlock!).toMatch(/activeBatch\?\.rowCount/);
  });

  it("registers startDashboardCsvExport + getDashboardCsvExportJobStatus as dashboardProcedure", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    // The background-job flow replaces the synchronous
    // `exportOwnershipTileCsv` / `exportChangeOwnershipTileCsv`
    // procs. Both new procs are bounded responses (start: < 200 B
    // jobId; status: < 1 KB snapshot), so neither needs allowlist
    // exemption — pin the registration so a future PR can't
    // accidentally regress to inline CSV downloads.
    expect(source).toMatch(
      /startDashboardCsvExport\s*:\s*dashboardProcedure\s*\(/
    );
    expect(source).toMatch(
      /getDashboardCsvExportJobStatus\s*:\s*dashboardProcedure\s*\(/
    );
    expect(source).toMatch(/exportType:\s*z\.literal\("datasetCsv"\)/);
    expect(source).toMatch(
      /exportType:\s*z\.literal\("deliveryTrackerDetailCsv"\)/
    );
    expect(source).toMatch(
      /exportType:\s*z\.literal\("deliveryTrackerUnmatchedTransfersCsv"\)/
    );
    expect(source).toMatch(/datasetKey:\s*z\.enum\(/);
  });

  it("strips dead Offline Monitoring fields at the wire boundary", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    const procBlock =
      /getDashboardOfflineMonitoring\s*:\s*dashboardProcedure[\s\S]*?\n  \/\*\*\n   \* Phase 2 PR-C-3-a/.exec(
        source
      )?.[0];
    expect(procBlock).toBeDefined();
    // PR-C-3-b strips: per-system maps (covered separately by
    // mountResilience rails).
    // Application-id-keyed maps stripped via destructure-out
    // alongside the per-system maps.
    expect(procBlock!).toMatch(
      /abpAcSizeKwByApplicationId:\s*_abpAcSizeKwByApplicationId/
    );
    expect(procBlock!).toMatch(
      /abpPart2VerificationDateByApplicationId:\s*\n\s*_abpPart2VerificationDateByApplicationId/
    );
    // Phase 2 OfflineMonitoring residual cleanup (2026-05-07)
    // additionally strips the 3 dead Part-2 ID arrays. The
    // aggregator still computes them internally for server-side
    // fact-builder consumption; they're discarded at the wire
    // boundary because no client path reads them after the F-4
    // sequence retired the parent-level Sets they fed.
    expect(procBlock!).toMatch(
      /eligiblePart2ApplicationIds:\s*_eligiblePart2ApplicationIds/
    );
    expect(procBlock!).toMatch(
      /eligiblePart2PortalSystemIds:\s*_eligiblePart2PortalSystemIds/
    );
    expect(procBlock!).toMatch(
      /part2VerifiedSystemIds:\s*_part2VerifiedSystemIds/
    );
  });

  it("registers getSnapshotLogs as a dashboardProcedure (read-only recovery surface)", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    expect(source).toMatch(
      /getSnapshotLogs\s*:\s*dashboardProcedure\s*\(/
    );
    // Read-only contract: the proc body must be `.query(...)`,
    // never `.mutation(...)`. Catches a future PR that
    // accidentally adds a write-back/restore on the same name.
    const procBlock =
      /getSnapshotLogs\s*:\s*dashboardProcedure\s*\([\s\S]{0,300}?\.input\s*\([\s\S]{0,400}?\)\s*\.\s*(query|mutation)\s*\(/.exec(
        source
      );
    expect(procBlock).not.toBeNull();
    expect(procBlock![1]).toBe("query");
  });

  it("does NOT re-register retired synchronous CSV export procs", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");
    // The old query-shape procs returned MB-scale CSV strings
    // through tRPC and were on the oversize allowlist. The
    // background-job flow supersedes them; a future PR must NOT
    // reintroduce a synchronous shape under either name.
    expect(source).not.toMatch(
      /exportOwnershipTileCsv\s*:\s*dashboardProcedure\s*\(/
    );
    expect(source).not.toMatch(
      /exportChangeOwnershipTileCsv\s*:\s*dashboardProcedure\s*\(/
    );
    expect(source).not.toMatch(/getDatasetCsv\s*:\s*dashboardProcedure\s*\(/);
  });

  it("listSolarRecDashboardStorageByPrefix uses ESCAPE '!' (sql_mode-independent)", () => {
    // Codex P3 fix on PR #354. Pre-fix the helper used
    // `ESCAPE '\\'` (one backslash at the SQL wire). Under the
    // default MySQL/TiDB sql_mode (no NO_BACKSLASH_ESCAPES) the
    // parser sees `\` as the string-literal escape character, so
    // `'\'` (one backslash) reads as an unterminated string —
    // syntax error. The fix uses `!` which has no special meaning
    // in any SQL mode.
    const filePath = resolve(__dirname, "..", "db", "preferences.ts");
    const source = readFileSync(filePath, "utf8");
    // Helper exists.
    expect(source).toMatch(
      /export\s+async\s+function\s+listSolarRecDashboardStorageByPrefix/
    );
    // Every ESCAPE clause emitted via a `sql\`...\`` template
    // must use `'!'`. We scan only inside template literals
    // (not JSDoc text) so the historical-context comments above
    // the helper don't false-positive.
    const sqlTemplateMatches =
      source.match(/sql`[^`]*ESCAPE\s+'[^']*'[^`]*`/g) ?? [];
    expect(sqlTemplateMatches.length).toBeGreaterThan(0);
    for (const m of sqlTemplateMatches) {
      expect(m).toMatch(/ESCAPE\s+'!'/);
    }
    // Escapes the bang character in the user-supplied prefix
    // (`!` → `!!`). Without this, a prefix containing a literal
    // `!` would be interpreted as the escape character.
    expect(source).toMatch(/\.replace\(\s*\/!\/g\s*,\s*['"]!!['"]/);
    // Escapes `%` and `_` via `!`.
    expect(source).toMatch(/\.replace\(\s*\/%\/g\s*,\s*['"]!%['"]/);
    expect(source).toMatch(/\.replace\(\s*\/_\/g\s*,\s*['"]!_['"]/);
  });
});

// ---------------------------------------------------------------------------
// CLAUDE.md drift rails. The repo's CLAUDE.md is loaded into every
// model context, so claims that disagree with the code mislead every
// future PR. Pin the allowlist count + retired-proc disclaimers so a
// future PR that retires another entry remembers to update the prose.
// ---------------------------------------------------------------------------

describe("CLAUDE.md drift", () => {
  const claudeMdPath = resolve(__dirname, "..", "..", "CLAUDE.md");
  const claudeMd = readFileSync(claudeMdPath, "utf8");

  it("documents the current allowlist count, not a stale one", () => {
    // The prose just above the allowlisted-procedure table claims
    // an exact procedure count. Keep it in sync with the Set.
    // Special case: when the allowlist is empty, the prose reads
    // "Transitional reality: the allowlist is empty." (no count).
    const claimedCount = DASHBOARD_OVERSIZE_ALLOWLIST.size;
    if (claimedCount === 0) {
      expect(claudeMd).toMatch(
        /Transitional reality:\s+the allowlist is empty/i
      );
      return;
    }
    const numberToWord: Record<number, string> = {
      1: "One",
      2: "Two",
      3: "Three",
      4: "Four",
      5: "Five",
      6: "Six",
      7: "Seven",
      8: "Eight",
    };
    const expectedWord = numberToWord[claimedCount];
    expect(expectedWord).toBeDefined();
    const sentence = new RegExp(
      `Transitional reality:\\s*(?:${expectedWord}|${claimedCount})\\s+procedure(?:s)? still ship(?:s)? an? oversized`,
      "i"
    );
    expect(claudeMd).toMatch(sentence);
  });

  it("documents the same live allowlist entries in hard rule 5", () => {
    const hardRule = claudeMd.match(
      /5\. \*\*Default Overview mount must not enable any allowlisted heavy[\s\S]*?(?=\n6\. \*\*)/
    )?.[0];
    expect(hardRule).toBeDefined();

    // Special case: when the allowlist is empty, Hard Rule 5
    // states that the allowlist is empty. No "currently
    // allowlisted procs are X" sentence is required.
    if (DASHBOARD_OVERSIZE_ALLOWLIST.size === 0) {
      expect(hardRule).toMatch(/the allowlist is empty/i);
      // None of the previously-retired procs should be listed as
      // live; they may appear in the rule's prose only as
      // historically-retired entries.
      expect(hardRule).not.toMatch(
        /currently allowlisted proc(?:s)? (?:is|are)\s+`/
      );
      return;
    }

    const currentSentence = hardRule!.match(
      /The\s+(?:only\s+)?(?:\d+|[A-Z][a-z]+)?\s*currently allowlisted proc(?:s)? (?:is|are)([\s\S]*?)\./
    )?.[1];
    expect(currentSentence).toBeDefined();

    const liveProcNames = [...DASHBOARD_OVERSIZE_ALLOWLIST].map(
      (path) => path.split(".").at(-1)!
    );
    for (const procName of liveProcNames) {
      expect(currentSentence).toContain(`\`${procName}\``);
    }
    expect(currentSentence).not.toContain("getDashboardOverviewSummary");
    expect(currentSentence).not.toContain("getDashboardChangeOwnership");
  });

  it("does NOT reference the retired CSV export procs as live", () => {
    // A future PR adding a NEW table row that names these procs as
    // current would re-confuse readers. The prose may mention them
    // historically (in the "Retired CSV-export procs" section) but
    // must not list them as live entries in the allowlist table.
    // Source signal: no markdown table cell of the form
    // `\| `solarRecDashboard.exportOwnershipTileCsv` \|`.
    expect(claudeMd).not.toMatch(
      /\|\s*`solarRecDashboard\.exportOwnershipTileCsv`\s*\|/
    );
    expect(claudeMd).not.toMatch(
      /\|\s*`solarRecDashboard\.exportChangeOwnershipTileCsv`\s*\|/
    );
    expect(claudeMd).not.toMatch(
      /\|\s*`solarRecDashboard\.getDatasetCsv`\s*\|/
    );
  });

  it("documents the new background-job procs as the replacement", () => {
    expect(claudeMd).toMatch(/startDashboardCsvExport/);
    expect(claudeMd).toMatch(/getDashboardCsvExportJobStatus/);
  });

  it("does not tell future tab work to expand getSystemSnapshot", () => {
    expect(claudeMd).not.toMatch(
      /Aggregates\s+→\s+extend\s+`getSystemSnapshot`/
    );
    expect(claudeMd).toMatch(/Do \*\*not\*\* extend\s+`getSystemSnapshot`/);
  });

  it("does not list `getDashboardOfflineMonitoring` as a live allowlisted entry (retired 2026-05-07)", () => {
    // Phase 2 OfflineMonitoring residual cleanup retired the
    // entry from the allowlist. The prose may mention it only in
    // the historical retirement-notes section, never as a live
    // table row. Source signal: no markdown table cell of the
    // form `\| `solarRecDashboard.getDashboardOfflineMonitoring` \|`.
    expect(claudeMd).not.toMatch(
      /\|\s*`solarRecDashboard\.getDashboardOfflineMonitoring`\s*\|/
    );
  });
});

// ---------------------------------------------------------------------------
// CI drift rails. These tests cover the OOM guardrails that have repeatedly
// caught Solar REC dashboard regressions; keep them visible as a named CI job
// instead of burying them in the full Vitest run only.
// ---------------------------------------------------------------------------

describe("Solar REC dashboard guardrail CI", () => {
  const repoRoot = resolve(__dirname, "..", "..");
  const packageJson = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };
  const ciWorkflow = readFileSync(
    resolve(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8"
  );

  it("runs dashboard OOM and mount guardrails as a dedicated CI job", () => {
    const script = packageJson.scripts?.["test:solar-rec-dashboard-guardrails"];

    expect(script).toBeDefined();
    expect(script).toContain("server/_core/dashboardResponseGuard.test.ts");
    expect(script).toContain(
      "client/src/solar-rec-dashboard/lib/dashboardMountResilience.test.ts"
    );
    expect(script).toContain(
      "server/services/solar/dashboardJobMetrics.test.ts"
    );
    expect(script).toContain(
      "server/services/solar/dashboardTidbDiagnostics.test.ts"
    );
    expect(ciWorkflow).toMatch(/solar-rec-dashboard-guardrails:/);
    expect(ciWorkflow).toContain("pnpm run test:solar-rec-dashboard-guardrails");
  });
});
