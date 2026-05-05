import { describe, expect, it } from "vitest";

import { shouldRunSolarRecStartupCleanup } from "./startupCleanupPolicy";

describe("shouldRunSolarRecStartupCleanup", () => {
  it("does not run Solar REC startup cleanup for local/dev by default", () => {
    expect(shouldRunSolarRecStartupCleanup({})).toBe(false);
  });

  it("runs Solar REC startup cleanup on Render", () => {
    expect(shouldRunSolarRecStartupCleanup({ RENDER: "true" })).toBe(true);
  });

  it("allows explicit local opt-in", () => {
    expect(
      shouldRunSolarRecStartupCleanup({
        SOLAR_REC_STARTUP_DB_CLEANUP: " yes ",
      })
    ).toBe(true);
  });

  it("does not treat arbitrary env text as opt-in", () => {
    expect(
      shouldRunSolarRecStartupCleanup({
        SOLAR_REC_STARTUP_DB_CLEANUP: "no",
      })
    ).toBe(false);
  });
});
