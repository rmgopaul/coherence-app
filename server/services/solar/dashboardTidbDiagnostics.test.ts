import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  withDbRetry: vi.fn(
    async (_operation: string, action: () => Promise<unknown>) => action()
  ),
}));

vi.mock("../../db/_core", async () => {
  const actual =
    await vi.importActual<typeof import("../../db/_core")>("../../db/_core");
  return {
    ...actual,
    getDb: mocks.getDb,
    withDbRetry: mocks.withDbRetry,
  };
});

import {
  DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_DEFAULT,
  DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_MAX,
  DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS_DEFAULT,
  DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS_DEFAULT,
  getDashboardTidbDiagnosticsEnabled,
  getDashboardTidbDiagnosticsLimit,
  getDashboardTidbDiagnosticsMinElapsedMs,
  getDashboardTidbDiagnosticsMinIntervalMs,
  maybeLogDashboardTidbDiagnostics,
  resetDashboardTidbDiagnosticsThrottleForTests,
  shouldRunDashboardTidbDiagnostics,
} from "./dashboardTidbDiagnostics";

const ENV_KEYS = [
  "DASHBOARD_TIDB_DIAGNOSTICS",
  "DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS",
  "DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS",
  "DASHBOARD_TIDB_DIAGNOSTICS_LIMIT",
] as const;

const originalEnv = new Map<string, string | undefined>();
let warnSpy: ReturnType<typeof vi.spyOn>;

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(overrides = {}) {
  return {
    path: "solarRecDashboard.getDashboardDeliveryTrackerAggregates",
    outcome: "success" as const,
    elapsedMs: 6_000,
    enforcement: "warn",
    allowlisted: false,
    heapBeforeBytes: 1_000,
    heapAfterBytes: 2_500,
    ...overrides,
  };
}

function parseDiagnosticLine(line: string): Record<string, unknown> {
  expect(line).toMatch(/^\[dashboard:tidb-diagnostics\] /);
  return JSON.parse(
    line.replace("[dashboard:tidb-diagnostics] ", "")
  ) as Record<string, unknown>;
}

describe("dashboard TiDB diagnostics env helpers", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetDashboardTidbDiagnosticsThrottleForTests();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("defaults to disabled with bounded safe thresholds", () => {
    expect(getDashboardTidbDiagnosticsEnabled()).toBe(false);
    expect(getDashboardTidbDiagnosticsMinElapsedMs()).toBe(
      DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS_DEFAULT
    );
    expect(getDashboardTidbDiagnosticsMinIntervalMs()).toBe(
      DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS_DEFAULT
    );
    expect(getDashboardTidbDiagnosticsLimit()).toBe(
      DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_DEFAULT
    );
  });

  it("accepts explicit enabled/threshold/interval/limit overrides", () => {
    process.env.DASHBOARD_TIDB_DIAGNOSTICS = "yes";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS = "0";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS = "0";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_LIMIT = "3";

    expect(getDashboardTidbDiagnosticsEnabled()).toBe(true);
    expect(getDashboardTidbDiagnosticsMinElapsedMs()).toBe(0);
    expect(getDashboardTidbDiagnosticsMinIntervalMs()).toBe(0);
    expect(getDashboardTidbDiagnosticsLimit()).toBe(3);
  });

  it("caps the statement-summary limit", () => {
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_LIMIT = "999";
    expect(getDashboardTidbDiagnosticsLimit()).toBe(
      DASHBOARD_TIDB_DIAGNOSTICS_LIMIT_MAX
    );
  });
});

describe("shouldRunDashboardTidbDiagnostics", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    resetDashboardTidbDiagnosticsThrottleForTests();
  });

  afterEach(() => {
    restoreEnv();
  });

  it("does not run when disabled", () => {
    expect(shouldRunDashboardTidbDiagnostics({ elapsedMs: 60_000 })).toBe(
      false
    );
  });

  it("does not run below the elapsed threshold", () => {
    process.env.DASHBOARD_TIDB_DIAGNOSTICS = "1";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS = "5000";

    expect(shouldRunDashboardTidbDiagnostics({ elapsedMs: 4_999 })).toBe(false);
  });

  it("runs at threshold but throttles repeated probes", () => {
    process.env.DASHBOARD_TIDB_DIAGNOSTICS = "1";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS = "5000";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS = "30000";

    expect(
      shouldRunDashboardTidbDiagnostics({ elapsedMs: 5_000 }, 100_000)
    ).toBe(true);
    expect(
      shouldRunDashboardTidbDiagnostics({ elapsedMs: 9_000 }, 110_000)
    ).toBe(false);
    expect(
      shouldRunDashboardTidbDiagnostics({ elapsedMs: 9_000 }, 131_000)
    ).toBe(true);
  });
});

describe("maybeLogDashboardTidbDiagnostics", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.DASHBOARD_TIDB_DIAGNOSTICS = "1";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS = "0";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_INTERVAL_MS = "0";
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_LIMIT = "2";
    resetDashboardTidbDiagnosticsThrottleForTests();
    mocks.getDb.mockReset();
    mocks.withDbRetry.mockReset();
    mocks.withDbRetry.mockImplementation(
      async (_operation: string, action: () => Promise<unknown>) => action()
    );
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    restoreEnv();
  });

  it("emits one bounded structured line with TiDB statement-summary rows", async () => {
    const execute = vi.fn(async () => [
      [
        {
          digest: "abc123",
          digestText: "SELECT * FROM srDsTransferHistory WHERE batchId = ?",
          sampleText: `SELECT ${"x".repeat(700)} FROM srDsTransferHistory`,
          tableNames: "srDsTransferHistory",
          execCount: "4",
          avgLatencyNs: "1000",
          maxLatencyNs: 2000,
          avgProcessedKeys: "10",
          maxProcessedKeys: "20",
          avgTotalKeys: "30",
          maxTotalKeys: "40",
          avgRequestUnitRead: "1.5",
          maxRequestUnitRead: "2.5",
          avgRequestUnitWrite: "0.25",
          maxRequestUnitWrite: "0.5",
          avgQueuedRcTimeNs: "3",
          maxQueuedRcTimeNs: "4",
        },
      ],
      [],
    ]);
    mocks.getDb.mockResolvedValue({ execute });

    await maybeLogDashboardTidbDiagnostics(request());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = parseDiagnosticLine(String(warnSpy.mock.calls[0][0]));
    expect(payload).toMatchObject({
      path: "solarRecDashboard.getDashboardDeliveryTrackerAggregates",
      outcome: "success",
      elapsedMs: 6000,
      enforcement: "warn",
      allowlisted: false,
      heapBeforeBytes: 1000,
      heapAfterBytes: 2500,
      heapDeltaBytes: 1500,
      available: true,
      limit: 2,
      source: "information_schema.statements_summary",
      requestScoped: false,
      statementCount: 1,
    });
    const statements = payload.statements as Array<Record<string, unknown>>;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({
      digest: "abc123",
      tableNames: "srDsTransferHistory",
      execCount: 4,
      avgRequestUnitRead: 1.5,
      maxRequestUnitWrite: 0.5,
    });
    expect(String(statements[0].sampleText).length).toBeLessThanOrEqual(500);
  });

  it("logs unavailable instead of throwing when TiDB diagnostics are unsupported", async () => {
    mocks.getDb.mockResolvedValue({
      execute: vi.fn(async () => {
        throw new Error("Unknown table 'statements_summary'");
      }),
    });

    await expect(
      maybeLogDashboardTidbDiagnostics(request({ outcome: "failed" }))
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = parseDiagnosticLine(String(warnSpy.mock.calls[0][0]));
    expect(payload).toMatchObject({
      available: false,
      outcome: "failed",
      error: "Unknown table 'statements_summary'",
    });
  });

  it("does not query TiDB when the elapsed gate is not met", async () => {
    process.env.DASHBOARD_TIDB_DIAGNOSTICS_MIN_ELAPSED_MS = "5000";

    await maybeLogDashboardTidbDiagnostics(request({ elapsedMs: 4_000 }));

    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
