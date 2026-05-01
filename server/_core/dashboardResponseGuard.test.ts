import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DASHBOARD_OVERSIZE_ALLOWLIST,
  DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT,
  checkDashboardResponseSize,
  getDashboardResponseEnforcement,
  getDashboardResponseLimitBytes,
} from "./dashboardResponseGuard";

const ENV_KEYS = [
  "DASHBOARD_RESPONSE_LIMIT_BYTES",
  "DASHBOARD_RESPONSE_ENFORCEMENT",
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

  it("floors a fractional positive value", () => {
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "131072.9";
    expect(getDashboardResponseLimitBytes()).toBe(131072);
  });

  it("falls back to the default for non-numeric values", () => {
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "not-a-number";
    expect(getDashboardResponseLimitBytes()).toBe(
      DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
    );
  });

  it("falls back to the default for non-positive values", () => {
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "0";
    expect(getDashboardResponseLimitBytes()).toBe(
      DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
    );
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "-1024";
    expect(getDashboardResponseLimitBytes()).toBe(
      DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
    );
  });

  it("falls back to the default for whitespace-only values", () => {
    process.env.DASHBOARD_RESPONSE_LIMIT_BYTES = "   ";
    expect(getDashboardResponseLimitBytes()).toBe(
      DASHBOARD_RESPONSE_LIMIT_BYTES_DEFAULT
    );
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

  it("returns 'throw' in development by default", () => {
    delete process.env.DASHBOARD_RESPONSE_ENFORCEMENT;
    process.env.NODE_ENV = "development";
    expect(getDashboardResponseEnforcement()).toBe("throw");
  });

  it("returns 'throw' in test by default", () => {
    delete process.env.DASHBOARD_RESPONSE_ENFORCEMENT;
    process.env.NODE_ENV = "test";
    expect(getDashboardResponseEnforcement()).toBe("throw");
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

describe("DASHBOARD_OVERSIZE_ALLOWLIST", () => {
  it("contains exactly the documented set of known-oversized procedures", () => {
    // Every entry here is a known regression scheduled for the data-plane
    // rebuild. Adding or removing an entry should be a deliberate diff
    // tied to the migration that justifies it; this snapshot test makes
    // accidental drift impossible.
    expect([...DASHBOARD_OVERSIZE_ALLOWLIST].sort()).toEqual(
      [
        "getDashboardChangeOwnership",
        "getDashboardOfflineMonitoring",
        "getDashboardOverviewSummary",
        "getDatasetCsv",
        "getSystemSnapshot",
      ].sort()
    );
  });
});

describe("checkDashboardResponseSize", () => {
  it("returns ok for a small response well under the limit and reports measured bytes", () => {
    const verdict = checkDashboardResponseSize(
      { hello: "world" },
      "solarRecDashboard.someProc",
      { limitBytes: 1024, enforcement: "throw" }
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.limit).toBe(1024);
      expect(verdict.bytes).toBeGreaterThan(0);
      expect(verdict.bytes).toBeLessThanOrEqual(1024);
    }
  });

  it("measures bytes via superjson + JSON.stringify of the result", () => {
    // A 16-char string serializes to roughly its quoted form. Exact byte
    // counts depend on superjson's wrapping; we don't pin them, just
    // assert "non-zero and below limit".
    const verdict = checkDashboardResponseSize(
      "hello-world-1234",
      "solarRecDashboard.someProc",
      { limitBytes: 1024, enforcement: "warn" }
    );
    expect(verdict.ok).toBe(true);
  });

  it("counts Date | null fields toward the byte total via superjson", () => {
    // Regression rail for the OwnershipOverviewExportRow shape that
    // pushed getDashboardOverviewSummary over budget. superjson has to
    // emit a parallel `meta` tree to round-trip Date values, which costs
    // ~50 bytes per Date cell on top of the ISO string. A row with three
    // Date fields × 21k rows is the structure the rebuild plan retires.
    const withDates = checkDashboardResponseSize(
      {
        rows: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          a: new Date("2026-01-01T00:00:00Z"),
          b: new Date("2026-02-01T00:00:00Z"),
          c: null,
        })),
      },
      "solarRecDashboard.someProc",
      { limitBytes: Number.MAX_SAFE_INTEGER, enforcement: "warn" }
    );
    const withoutDates = checkDashboardResponseSize(
      {
        rows: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          a: "2026-01-01T00:00:00.000Z",
          b: "2026-02-01T00:00:00.000Z",
          c: null,
        })),
      },
      "solarRecDashboard.someProc",
      { limitBytes: Number.MAX_SAFE_INTEGER, enforcement: "warn" }
    );
    if (!withDates.ok || !withoutDates.ok) {
      throw new Error("expected both checks to land under the limit");
    }
    // The Date payload should be strictly larger than the equivalent
    // string payload because superjson adds a meta tree.
    expect(withDates.bytes).toBeGreaterThan(withoutDates.bytes);
  });

  it("flags an oversized response and recommends a throw under throw enforcement", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "solarRecDashboard.someProc",
      { limitBytes: 1024, enforcement: "throw" }
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.bytes).toBeGreaterThan(verdict.limit);
    expect(verdict.allowlisted).toBe(false);
    expect(verdict.shouldThrow).toBe(true);
    expect(verdict.procedureName).toBe("someProc");
  });

  it("does not recommend a throw when the procedure is allowlisted", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "solarRecDashboard.getSystemSnapshot",
      { limitBytes: 1024, enforcement: "throw" }
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.allowlisted).toBe(true);
    expect(verdict.shouldThrow).toBe(false);
  });

  it("does not recommend a throw under warn enforcement, allowlist or not", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const allowlisted = checkDashboardResponseSize(
      big,
      "solarRecDashboard.getDashboardOverviewSummary",
      { limitBytes: 1024, enforcement: "warn" }
    );
    const notAllowlisted = checkDashboardResponseSize(
      big,
      "solarRecDashboard.someProc",
      { limitBytes: 1024, enforcement: "warn" }
    );
    expect(allowlisted.ok).toBe(false);
    expect(notAllowlisted.ok).toBe(false);
    if (allowlisted.ok || notAllowlisted.ok) return;
    expect(allowlisted.shouldThrow).toBe(false);
    expect(notAllowlisted.shouldThrow).toBe(false);
  });

  it("bypasses the check entirely when enforcement=off", () => {
    // 'off' is a kill switch for incident response; it must not call
    // through to superjson at all.
    const verdict = checkDashboardResponseSize(
      { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) },
      "solarRecDashboard.someProc",
      { limitBytes: 1, enforcement: "off" }
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.bytes).toBe(0);
  });

  it("matches the allowlist on the trailing procedure name regardless of router prefix", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const flat = checkDashboardResponseSize(big, "getSystemSnapshot", {
      limitBytes: 1024,
      enforcement: "throw",
    });
    const nested = checkDashboardResponseSize(
      big,
      "solarRecDashboard.getSystemSnapshot",
      { limitBytes: 1024, enforcement: "throw" }
    );
    const doubleNested = checkDashboardResponseSize(
      big,
      "solar.rec.dashboard.getSystemSnapshot",
      { limitBytes: 1024, enforcement: "throw" }
    );
    for (const verdict of [flat, nested, doubleNested]) {
      expect(verdict.ok).toBe(false);
      if (verdict.ok) continue;
      expect(verdict.allowlisted).toBe(true);
      expect(verdict.shouldThrow).toBe(false);
      expect(verdict.procedureName).toBe("getSystemSnapshot");
    }
  });

  it("respects a custom allowlist passed via options", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "solarRecDashboard.someExperimentalProc",
      {
        limitBytes: 1024,
        enforcement: "throw",
        allowlist: new Set(["someExperimentalProc"]),
      }
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.allowlisted).toBe(true);
    expect(verdict.shouldThrow).toBe(false);
  });
});
