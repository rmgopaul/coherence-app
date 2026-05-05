/**
 * Tests for the canonical runtime-target detection module.
 *
 * Concern #4 fix-sequence PR-1 (per
 * `docs/triage/local-dev-prod-mutation-findings.md`). This module
 * is the gate every subsequent fix PR will build on, so the rails
 * here lock the contract: detection precedence, opt-in truthy
 * values, env-arg testability.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  allowsLocalProdWrites,
  detectRuntimeTarget,
  schedulerTickAllowed,
  shouldMutateProdState,
  __resetSchedulerSkipLoggedForTests,
} from "./runtimeTarget";

describe("detectRuntimeTarget", () => {
  it("returns 'test' when NODE_ENV is 'test' (highest precedence)", () => {
    expect(detectRuntimeTarget({ NODE_ENV: "test" })).toBe("test");
    // Test classification beats RENDER — vitest run on a Render
    // container in `NODE_ENV=test` is still a test, not prod.
    expect(detectRuntimeTarget({ NODE_ENV: "test", RENDER: "true" })).toBe(
      "test"
    );
  });

  it("returns 'hosted-prod' when RENDER is truthy", () => {
    expect(detectRuntimeTarget({ RENDER: "true" })).toBe("hosted-prod");
    expect(detectRuntimeTarget({ RENDER: "1" })).toBe("hosted-prod");
    expect(detectRuntimeTarget({ RENDER: "anything-truthy" })).toBe(
      "hosted-prod"
    );
  });

  it("returns 'local-dev' on a bare env", () => {
    expect(detectRuntimeTarget({})).toBe("local-dev");
  });

  it("returns 'local-dev' on NODE_ENV=development", () => {
    expect(detectRuntimeTarget({ NODE_ENV: "development" })).toBe("local-dev");
  });

  it("returns 'local-dev' on NODE_ENV=production but no RENDER (e.g. self-hosted)", () => {
    // Edge case: someone running with NODE_ENV=production locally
    // (e.g., reproducing a prod build) — without RENDER, we still
    // classify as local-dev so the prod-mutation guards don't
    // accidentally engage.
    expect(detectRuntimeTarget({ NODE_ENV: "production" })).toBe("local-dev");
  });

  it("ignores RENDER='' (empty string is falsy)", () => {
    expect(detectRuntimeTarget({ RENDER: "" })).toBe("local-dev");
  });
});

describe("allowsLocalProdWrites", () => {
  it("returns true on canonical truthy values (case-insensitive, trimmed)", () => {
    expect(allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "1" })).toBe(
      true
    );
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "true" })
    ).toBe(true);
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "yes" })
    ).toBe(true);
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: " YES " })
    ).toBe(true);
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "TRUE" })
    ).toBe(true);
  });

  it("returns false on falsy / unset / arbitrary text", () => {
    expect(allowsLocalProdWrites({})).toBe(false);
    expect(allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "" })).toBe(
      false
    );
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "no" })
    ).toBe(false);
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "false" })
    ).toBe(false);
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "0" })
    ).toBe(false);
    // Arbitrary text doesn't accidentally count as opt-in.
    expect(
      allowsLocalProdWrites({ ALLOW_LOCAL_TO_PROD_WRITES: "maybe" })
    ).toBe(false);
  });
});

describe("shouldMutateProdState", () => {
  it("returns true on hosted-prod (RENDER)", () => {
    expect(shouldMutateProdState({ RENDER: "true" })).toBe(true);
  });

  it("returns true on local-dev WITH explicit opt-in", () => {
    expect(
      shouldMutateProdState({ ALLOW_LOCAL_TO_PROD_WRITES: "true" })
    ).toBe(true);
  });

  it("returns false on local-dev without opt-in (the default safety case)", () => {
    expect(shouldMutateProdState({})).toBe(false);
    expect(shouldMutateProdState({ NODE_ENV: "development" })).toBe(false);
  });

  it("returns false in test runs even with opt-in (test isolation)", () => {
    // Test-run classification is the strongest negative — even
    // if the opt-in is set, vitest runs should never mutate prod.
    // (If a test genuinely needs to hit a real DB, it should
    // configure a separate `LOCAL_DEV_DATABASE_URL` and lift
    // NODE_ENV out of "test".)
    expect(
      shouldMutateProdState({
        NODE_ENV: "test",
        ALLOW_LOCAL_TO_PROD_WRITES: "true",
      })
    ).toBe(false);
  });

  it("returns true on hosted-prod even when NODE_ENV is unset (defensive)", () => {
    // Render injects RENDER but doesn't always set NODE_ENV.
    expect(shouldMutateProdState({ RENDER: "true" })).toBe(true);
  });
});

describe("schedulerTickAllowed (Concern #4 PR-3)", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetSchedulerSkipLoggedForTests();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns true on hosted-prod (tick proceeds)", () => {
    expect(schedulerTickAllowed("scheduler-x", { RENDER: "true" })).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns true on local-dev WITH explicit opt-in", () => {
    expect(
      schedulerTickAllowed("scheduler-x", {
        ALLOW_LOCAL_TO_PROD_WRITES: "true",
      })
    ).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns false on local-dev without opt-in (default safety case)", () => {
    expect(schedulerTickAllowed("scheduler-x", {})).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("scheduler-x")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("ALLOW_LOCAL_TO_PROD_WRITES")
    );
  });

  it("returns false during test runs (NODE_ENV=test wins over opt-in)", () => {
    // Mirrors the shouldMutateProdState test-isolation rule.
    expect(
      schedulerTickAllowed("scheduler-x", {
        NODE_ENV: "test",
        ALLOW_LOCAL_TO_PROD_WRITES: "true",
      })
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("logs at most once per scheduler-name per process", () => {
    expect(schedulerTickAllowed("chatty-sweeper", {})).toBe(false);
    expect(schedulerTickAllowed("chatty-sweeper", {})).toBe(false);
    expect(schedulerTickAllowed("chatty-sweeper", {})).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("logs once per distinct scheduler-name (different schedulers don't share quota)", () => {
    expect(schedulerTickAllowed("scheduler-a", {})).toBe(false);
    expect(schedulerTickAllowed("scheduler-b", {})).toBe(false);
    expect(schedulerTickAllowed("scheduler-a", {})).toBe(false);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });
});
