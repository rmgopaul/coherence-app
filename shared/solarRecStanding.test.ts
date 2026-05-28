/**
 * Pure-function tests for `deriveStanding` — the 9-value Standing
 * taxonomy. One test per branch in the decision tree + edge cases
 * for null/whitespace contractType and case-insensitive contract-type
 * matching (load-bearing because `normalizeContractType` lowercases).
 */
import { describe, expect, it } from "vitest";
import { deriveStanding } from "./solarRecStanding";

describe("deriveStanding", () => {
  // -----------------------------------------------------------------
  // Closed states — terminal regardless of transferSeen / isReporting.
  // -----------------------------------------------------------------

  it("returns 'Closed — RECs Repaid (Good Standing)' for IL ABP - Terminated", () => {
    expect(deriveStanding("IL ABP - Terminated", false, false)).toBe(
      "Closed — RECs Repaid (Good Standing)"
    );
    // transferSeen / isReporting don't move the needle on this branch.
    expect(deriveStanding("IL ABP - Terminated", true, true)).toBe(
      "Closed — RECs Repaid (Good Standing)"
    );
  });

  it("returns 'Closed — Default' for IL ABP - Defaulted", () => {
    expect(deriveStanding("IL ABP - Defaulted", false, false)).toBe(
      "Closed — Default"
    );
    expect(deriveStanding("IL ABP - Defaulted", true, true)).toBe(
      "Closed — Default"
    );
  });

  // -----------------------------------------------------------------
  // Assigned branch — contractType === "IL ABP - Transferred".
  // -----------------------------------------------------------------

  it("returns 'Active — Good Standing (Assigned)' for transferred + reporting", () => {
    expect(deriveStanding("IL ABP - Transferred", true, true)).toBe(
      "Active — Good Standing (Assigned)"
    );
    // transferSeen flag is redundant under explicit Assigned — Assigned
    // wins even without an observed GATS transfer (paperwork may have
    // landed before the first transfer row).
    expect(deriveStanding("IL ABP - Transferred", false, true)).toBe(
      "Active — Good Standing (Assigned)"
    );
  });

  it("returns 'At Risk — Reporting Lapse (Assigned)' for transferred + not reporting", () => {
    expect(deriveStanding("IL ABP - Transferred", true, false)).toBe(
      "At Risk — Reporting Lapse (Assigned)"
    );
  });

  // -----------------------------------------------------------------
  // Orphaned branch — non-transferred contractType + transferSeen.
  // -----------------------------------------------------------------

  it("returns 'At Risk — Unassigned Transfer' for orphaned + reporting", () => {
    expect(deriveStanding("IL ABP", true, true)).toBe(
      "At Risk — Unassigned Transfer"
    );
    // Same for non-IL-ABP contract types (PSA, Full Upfront,
    // Pay-as-you-go) when a transfer is observed without assignment.
    expect(deriveStanding("PSA Full Upfront", true, true)).toBe(
      "At Risk — Unassigned Transfer"
    );
  });

  it("returns 'Jeopardy / Default-Track' for orphaned + not reporting", () => {
    expect(deriveStanding("IL ABP", true, false)).toBe(
      "Jeopardy / Default-Track"
    );
  });

  // -----------------------------------------------------------------
  // Intact branch — non-transferred contractType + no transferSeen.
  // -----------------------------------------------------------------

  it("returns 'Active — Good Standing' for intact + reporting", () => {
    expect(deriveStanding("IL ABP", false, true)).toBe(
      "Active — Good Standing"
    );
    expect(deriveStanding("Full Upfront", false, true)).toBe(
      "Active — Good Standing"
    );
  });

  it("returns 'At Risk — Reporting Lapse' for intact + not reporting", () => {
    expect(deriveStanding("IL ABP", false, false)).toBe(
      "At Risk — Reporting Lapse"
    );
  });

  // -----------------------------------------------------------------
  // Unknown branch — null / undefined / empty / whitespace.
  // -----------------------------------------------------------------

  it("returns 'Unknown' for null / undefined / empty / whitespace", () => {
    expect(deriveStanding(null, false, true)).toBe("Unknown");
    expect(deriveStanding(undefined, true, false)).toBe("Unknown");
    expect(deriveStanding("", true, true)).toBe("Unknown");
    expect(deriveStanding("   ", false, false)).toBe("Unknown");
  });

  // -----------------------------------------------------------------
  // Contract-type matching is case-insensitive + whitespace-normalized
  // (mirrors `normalizeContractType`).
  // -----------------------------------------------------------------

  it("matches contract types case-insensitively", () => {
    expect(deriveStanding("il abp - transferred", false, true)).toBe(
      "Active — Good Standing (Assigned)"
    );
    expect(deriveStanding("IL ABP - TERMINATED", false, false)).toBe(
      "Closed — RECs Repaid (Good Standing)"
    );
    expect(deriveStanding("Il Abp - Defaulted", true, true)).toBe(
      "Closed — Default"
    );
  });

  it("collapses internal whitespace in contract types", () => {
    expect(deriveStanding("IL  ABP -  Transferred", false, true)).toBe(
      "Active — Good Standing (Assigned)"
    );
  });
});
