import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initTRPC } from "@trpc/server";
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
    // tied to the migration that justifies it.
    expect([...DASHBOARD_OVERSIZE_ALLOWLIST].sort()).toEqual(
      [
        "solarRecDashboard.getDashboardChangeOwnership",
        "solarRecDashboard.getDashboardOfflineMonitoring",
        "solarRecDashboard.getDashboardOverviewSummary",
        "solarRecDashboard.getDatasetCsv",
        "solarRecDashboard.getSystemSnapshot",
      ].sort()
    );
  });

  it("uses fully-qualified router-prefixed paths (no bare procedure names)", () => {
    // A bare entry like `"getSystemSnapshot"` would silently allowlist a
    // same-named procedure on a different router. Every entry must carry
    // its router prefix.
    for (const entry of DASHBOARD_OVERSIZE_ALLOWLIST) {
      expect(entry).toMatch(/^solarRecDashboard\.[A-Za-z]+$/);
    }
  });
});

describe("checkDashboardResponseSize", () => {
  it("returns ok with measured bytes for a small response under the limit", () => {
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

  it("flags an oversized non-allowlisted response", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "solarRecDashboard.someProc",
      { limitBytes: 1024 }
    );
    if (verdict.ok) {
      throw new Error("expected oversized verdict");
    }
    expect(verdict.bytes).toBeGreaterThan(verdict.limit);
    expect(verdict.allowlisted).toBe(false);
  });

  it("flags an oversized allowlisted response with allowlisted=true", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "solarRecDashboard.getSystemSnapshot",
      { limitBytes: 1024 }
    );
    if (verdict.ok) {
      throw new Error("expected oversized verdict");
    }
    expect(verdict.allowlisted).toBe(true);
  });

  it("requires the full router-prefixed path to match the allowlist", () => {
    // Bare procedure name must NOT match — we removed the trailing-suffix
    // matcher that allowed `getSystemSnapshot` on any router to slip through.
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const bare = checkDashboardResponseSize(big, "getSystemSnapshot", {
      limitBytes: 1024,
    });
    if (bare.ok) throw new Error("expected oversized verdict");
    expect(bare.allowlisted).toBe(false);

    // Same procedure name on a different router must NOT match.
    const otherRouter = checkDashboardResponseSize(
      big,
      "otherRouter.getSystemSnapshot",
      { limitBytes: 1024 }
    );
    if (otherRouter.ok) throw new Error("expected oversized verdict");
    expect(otherRouter.allowlisted).toBe(false);

    // The full-path entry matches.
    const fq = checkDashboardResponseSize(
      big,
      "solarRecDashboard.getSystemSnapshot",
      { limitBytes: 1024 }
    );
    if (fq.ok) throw new Error("expected oversized verdict");
    expect(fq.allowlisted).toBe(true);
  });

  it("respects a custom allowlist passed via options", () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i })) };
    const verdict = checkDashboardResponseSize(
      big,
      "myRouter.someExperimentalProc",
      {
        limitBytes: 1024,
        allowlist: new Set(["myRouter.someExperimentalProc"]),
      }
    );
    if (verdict.ok) throw new Error("expected oversized verdict");
    expect(verdict.allowlisted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real-router middleware integration: confirm that tRPC reports the
// fully-qualified path to middleware after sub-router composition. The
// allowlist relies on this format.
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
// Regression rail: every dashboard procedure must go through
// dashboardProcedure(), not raw requirePermission(). A future PR that
// adds a procedure with the wrong builder loses the size guard silently;
// this asserts the contract on the source file.
// ---------------------------------------------------------------------------

describe("solarRecDashboardRouter wiring", () => {
  it("uses dashboardProcedure exclusively (no raw requirePermission)", () => {
    const filePath = resolve(__dirname, "solarRecDashboardRouter.ts");
    const source = readFileSync(filePath, "utf8");

    // No raw requirePermission( call sites in the dashboard router.
    expect(source).not.toMatch(/\brequirePermission\s*\(/);

    // dashboardProcedure( should still be the gating idiom; if every
    // procedure has been removed something else has gone very wrong.
    const matches = source.match(/\bdashboardProcedure\s*\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(40);
  });
});
