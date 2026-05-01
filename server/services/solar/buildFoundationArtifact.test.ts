/**
 * Phase 2.2 + 2.4 of the dashboard foundation repair (2026-04-30) —
 * tests for the foundation builder's pure surface and the new
 * Part II Verified helpers.
 *
 * The builder runs on `srDs*` row tables in production; these tests
 * exercise the pure `buildFoundationFromInputs` entry point with
 * fixture data, so we get fast deterministic coverage of every
 * locked definition without a DB.
 */

import { describe, expect, it } from "vitest";
import { DATASET_KEYS, type DatasetKey } from "../../../shared/datasetUpload.helpers";
import {
  FOUNDATION_DEFINITION_VERSION,
  type FoundationArtifactPayload,
} from "../../../shared/solarRecFoundation";
import {
  isPart2BlockingStatus,
  isPart2VerifiedSystem,
} from "./aggregatorHelpers";
import {
  buildFoundationFromInputs,
  type FoundationAbpCsgMappingInput,
  type FoundationAbpReportInput,
  type FoundationBuilderInputs,
  type FoundationSolarApplicationInput,
} from "./buildFoundationArtifact";

const FIXED_BUILT_AT = new Date("2026-04-30T00:00:00.000Z");

function makeInputVersions(
  populatedKeys: DatasetKey[] = ["solarApplications"]
): FoundationBuilderInputs["inputVersions"] {
  return Object.fromEntries(
    DATASET_KEYS.map((k) => [
      k,
      populatedKeys.includes(k)
        ? { batchId: `batch-${k}`, rowCount: 1 }
        : { batchId: null, rowCount: 0 },
    ])
  ) as FoundationBuilderInputs["inputVersions"];
}

function makeInputs(
  overrides: Partial<FoundationBuilderInputs> = {}
): FoundationBuilderInputs {
  return {
    scopeId: "scope-1",
    inputVersions: makeInputVersions(),
    solarApplications: [],
    abpReport: [],
    abpCsgSystemMapping: [],
    ...overrides,
  };
}

function makeSolar(
  csgId: string,
  overrides: Partial<FoundationSolarApplicationInput> = {}
): FoundationSolarApplicationInput {
  return {
    csgId,
    applicationId: null,
    systemName: `${csgId} system`,
    installedKwAc: 9.5,
    installedKwDc: 10,
    totalContractAmount: 1000,
    contractType: null,
    statusText: null,
    ...overrides,
  };
}

function makeAbpReport(
  applicationId: string,
  part2Date: string | null = "2024-06-01"
): FoundationAbpReportInput {
  return {
    applicationId,
    part2AppVerificationDate: part2Date,
    projectName: `${applicationId} project`,
  };
}

function makeMapping(
  csgId: string,
  abpId: string
): FoundationAbpCsgMappingInput {
  return { csgId, abpId };
}

// ============================================================================
// isPart2BlockingStatus
// ============================================================================

describe("isPart2BlockingStatus", () => {
  it("blocks rejected status", () => {
    expect(isPart2BlockingStatus("rejected")).toBe(true);
    expect(isPart2BlockingStatus("Rejected")).toBe(true);
    expect(isPart2BlockingStatus("REJECTED")).toBe(true);
    expect(isPart2BlockingStatus("Application Rejected by Reviewer")).toBe(true);
  });

  it("blocks cancelled status (both spellings)", () => {
    expect(isPart2BlockingStatus("cancelled")).toBe(true);
    expect(isPart2BlockingStatus("canceled")).toBe(true);
    expect(isPart2BlockingStatus("Project Cancelled")).toBe(true);
    expect(isPart2BlockingStatus("Project Canceled")).toBe(true);
  });

  it("blocks withdrawn status", () => {
    expect(isPart2BlockingStatus("withdrawn")).toBe(true);
    expect(isPart2BlockingStatus("Withdrawn by applicant")).toBe(true);
  });

  it("blocks composite status texts containing a blocking keyword", () => {
    // The legacy concatenation joins fields with " | "; one bad
    // field anywhere should still trip the filter.
    expect(
      isPart2BlockingStatus("Active | Rejected at Part 2 | In Review")
    ).toBe(true);
    expect(
      isPart2BlockingStatus("Approved | Active | Cancelled by user")
    ).toBe(true);
  });

  it("does NOT block valid statuses", () => {
    expect(isPart2BlockingStatus("active")).toBe(false);
    expect(isPart2BlockingStatus("approved")).toBe(false);
    expect(isPart2BlockingStatus("in review")).toBe(false);
    expect(isPart2BlockingStatus("Compliant | Active | In Block")).toBe(false);
  });

  it("does NOT block on substring false-positives", () => {
    // "withdrawnfromsale" is one word — without the boundary check
    // we'd false-positive on accidental substrings.
    expect(isPart2BlockingStatus("rejecteddiff")).toBe(false);
    expect(isPart2BlockingStatus("cancelledsubstr")).toBe(false);
  });

  it("returns false on empty / null / undefined", () => {
    expect(isPart2BlockingStatus(null)).toBe(false);
    expect(isPart2BlockingStatus(undefined)).toBe(false);
    expect(isPart2BlockingStatus("")).toBe(false);
    expect(isPart2BlockingStatus("   ")).toBe(false);
  });
});

// ============================================================================
// isPart2VerifiedSystem
// ============================================================================

describe("isPart2VerifiedSystem", () => {
  it("returns true when mapped + valid date + non-blocking status", () => {
    expect(
      isPart2VerifiedSystem({
        hasMappedAbpId: true,
        part2VerificationDateRaw: "2024-06-01",
        statusText: "Active",
      })
    ).toBe(true);
  });

  it("returns false when no ABP mapping exists", () => {
    expect(
      isPart2VerifiedSystem({
        hasMappedAbpId: false,
        part2VerificationDateRaw: "2024-06-01",
        statusText: null,
      })
    ).toBe(false);
  });

  it("returns false when Part II date is missing", () => {
    expect(
      isPart2VerifiedSystem({
        hasMappedAbpId: true,
        part2VerificationDateRaw: null,
        statusText: null,
      })
    ).toBe(false);
    expect(
      isPart2VerifiedSystem({
        hasMappedAbpId: true,
        part2VerificationDateRaw: "",
        statusText: null,
      })
    ).toBe(false);
  });

  it("returns false when Part II date is invalid", () => {
    expect(
      isPart2VerifiedSystem({
        hasMappedAbpId: true,
        part2VerificationDateRaw: "not a date",
        statusText: null,
      })
    ).toBe(false);
  });

  it("returns false when status is rejected/cancelled/withdrawn", () => {
    for (const status of ["rejected", "cancelled", "canceled", "withdrawn"]) {
      expect(
        isPart2VerifiedSystem({
          hasMappedAbpId: true,
          part2VerificationDateRaw: "2024-06-01",
          statusText: status,
        })
      ).toBe(false);
    }
  });

  it("accepts Excel-serial date format from the legacy parser", () => {
    // Excel serial 45444 = 2024-06-13. parsePart2VerificationDate
    // accepts 5-digit serials in [20000, 80000].
    expect(
      isPart2VerifiedSystem({
        hasMappedAbpId: true,
        part2VerificationDateRaw: "45444",
        statusText: null,
      })
    ).toBe(true);
  });
});

// ============================================================================
// buildFoundationFromInputs — happy path
// ============================================================================

describe("buildFoundationFromInputs — happy path", () => {
  it("returns a valid empty artifact when given empty inputs", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({ inputVersions: makeInputVersions([]) }),
      FIXED_BUILT_AT
    );
    expect(payload.canonicalSystemsByCsgId).toEqual({});
    expect(payload.part2EligibleCsgIds).toEqual([]);
    expect(payload.summaryCounts).toEqual({
      totalSystems: 0,
      terminated: 0,
      part2Verified: 0,
      reporting: 0,
      part2VerifiedAndReporting: 0,
    });
    expect(payload.integrityWarnings).toEqual([]);
    expect(payload.populatedDatasets).toEqual([]);
    expect(payload.foundationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.builtAt).toBe(FIXED_BUILT_AT.toISOString());
    expect(payload.definitionVersion).toBe(FOUNDATION_DEFINITION_VERSION);
  });

  it("builds canonical systems from solar applications", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1", { installedKwAc: 5, installedKwDc: 6 }),
          makeSolar("CSG-2", { installedKwAc: 12, installedKwDc: 14 }),
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(Object.keys(payload.canonicalSystemsByCsgId).sort()).toEqual([
      "CSG-1",
      "CSG-2",
    ]);
    expect(payload.canonicalSystemsByCsgId["CSG-1"].sizeKwAc).toBe(5);
    expect(payload.canonicalSystemsByCsgId["CSG-2"].sizeKwAc).toBe(12);
    expect(payload.summaryCounts.totalSystems).toBe(2);
    expect(payload.summaryCounts.terminated).toBe(0);
  });

  it("flags terminated systems via contract type", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1", { contractType: "IL ABP - Active" }),
          makeSolar("CSG-2", { contractType: "IL ABP - Terminated" }),
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.canonicalSystemsByCsgId["CSG-1"].isTerminated).toBe(false);
    expect(payload.canonicalSystemsByCsgId["CSG-2"].isTerminated).toBe(true);
    expect(payload.summaryCounts.totalSystems).toBe(1);
    expect(payload.summaryCounts.terminated).toBe(1);
  });

  it("populates abpIds from mapping table and marks Part II verified", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [makeSolar("CSG-1", { statusText: "Active" })],
        abpCsgSystemMapping: [makeMapping("CSG-1", "ABP-1")],
        abpReport: [makeAbpReport("ABP-1", "2024-06-01")],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.canonicalSystemsByCsgId["CSG-1"].abpIds).toEqual(["ABP-1"]);
    expect(payload.canonicalSystemsByCsgId["CSG-1"].isPart2Verified).toBe(true);
    expect(payload.part2EligibleCsgIds).toEqual(["CSG-1"]);
    expect(payload.summaryCounts.part2Verified).toBe(1);
  });

  it("excludes Part II from terminated systems", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1", {
            contractType: "IL ABP - Terminated",
            statusText: "Active",
          }),
        ],
        abpCsgSystemMapping: [makeMapping("CSG-1", "ABP-1")],
        abpReport: [makeAbpReport("ABP-1", "2024-06-01")],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.canonicalSystemsByCsgId["CSG-1"].isTerminated).toBe(true);
    expect(payload.canonicalSystemsByCsgId["CSG-1"].isPart2Verified).toBe(false);
    expect(payload.summaryCounts.part2Verified).toBe(0);
  });

  it("excludes Part II from blocked-status systems (rejected/cancelled/withdrawn)", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1", { statusText: "Rejected" }),
          makeSolar("CSG-2", { statusText: "Cancelled" }),
          makeSolar("CSG-3", { statusText: "Active" }),
        ],
        abpCsgSystemMapping: [
          makeMapping("CSG-1", "ABP-1"),
          makeMapping("CSG-2", "ABP-2"),
          makeMapping("CSG-3", "ABP-3"),
        ],
        abpReport: [
          makeAbpReport("ABP-1", "2024-06-01"),
          makeAbpReport("ABP-2", "2024-06-01"),
          makeAbpReport("ABP-3", "2024-06-01"),
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.canonicalSystemsByCsgId["CSG-1"].isPart2Verified).toBe(false);
    expect(payload.canonicalSystemsByCsgId["CSG-2"].isPart2Verified).toBe(false);
    expect(payload.canonicalSystemsByCsgId["CSG-3"].isPart2Verified).toBe(true);
    expect(payload.part2EligibleCsgIds).toEqual(["CSG-3"]);
    expect(payload.summaryCounts.part2Verified).toBe(1);
  });

  it("returns deterministic foundation hash for identical inputs", () => {
    const inputsA = makeInputs({
      solarApplications: [makeSolar("CSG-1")],
    });
    const inputsB = makeInputs({
      solarApplications: [makeSolar("CSG-1")],
    });
    const a = buildFoundationFromInputs(inputsA, FIXED_BUILT_AT);
    const b = buildFoundationFromInputs(inputsB, FIXED_BUILT_AT);
    expect(a.foundationHash).toBe(b.foundationHash);
  });

  it("produces a different foundation hash when input batch IDs change", () => {
    const inputsA = makeInputs({
      inputVersions: makeInputVersions(["solarApplications"]),
    });
    const inputsB = makeInputs({
      inputVersions: {
        ...makeInputVersions(["solarApplications"]),
        solarApplications: { batchId: "batch-different", rowCount: 1 },
      },
    });
    const a = buildFoundationFromInputs(inputsA, FIXED_BUILT_AT);
    const b = buildFoundationFromInputs(inputsB, FIXED_BUILT_AT);
    expect(a.foundationHash).not.toBe(b.foundationHash);
  });

  it("includes only datasets with active batches in populatedDatasets", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        inputVersions: makeInputVersions([
          "solarApplications",
          "abpReport",
          "abpCsgSystemMapping",
        ]),
      }),
      FIXED_BUILT_AT
    );
    expect(payload.populatedDatasets.sort()).toEqual([
      "abpCsgSystemMapping",
      "abpReport",
      "solarApplications",
    ]);
  });
});

// ============================================================================
// buildFoundationFromInputs — Phase 2.4 dedupe + integrity warnings
// ============================================================================

describe("buildFoundationFromInputs — ABP dedupe-by-ABP-ID (Phase 2.4)", () => {
  it("counts a duplicate ABP report row exactly once", () => {
    // Same ABP row appears twice in the report. The legacy code
    // counted both → numerator > denominator. The foundation
    // builder dedupes by applicationId before applying the
    // Part II filter.
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [makeSolar("CSG-1", { statusText: "Active" })],
        abpCsgSystemMapping: [makeMapping("CSG-1", "ABP-1")],
        abpReport: [
          makeAbpReport("ABP-1", "2024-06-01"),
          makeAbpReport("ABP-1", "2024-07-01"), // duplicate
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.summaryCounts.part2Verified).toBe(1);
    expect(payload.part2EligibleCsgIds).toEqual(["CSG-1"]);
    expect(
      payload.integrityWarnings.find(
        (w) => w.code === "DUPLICATE_ABP_REPORT_ROW"
      )
    ).toEqual({
      code: "DUPLICATE_ABP_REPORT_ROW",
      abpId: "ABP-1",
      rowCount: 2,
    });
  });

  it("dedup tie-breaks on newest Part II date first", () => {
    // Two ABP rows for ABP-1; only one has a valid Part II date.
    // The dedupe should keep the row with the newer date so the
    // system gets flagged Part II Verified.
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [makeSolar("CSG-1", { statusText: "Active" })],
        abpCsgSystemMapping: [makeMapping("CSG-1", "ABP-1")],
        abpReport: [
          makeAbpReport("ABP-1", null), // older / missing date
          makeAbpReport("ABP-1", "2024-06-01"),
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.summaryCounts.part2Verified).toBe(1);
    expect(payload.canonicalSystemsByCsgId["CSG-1"].part2VerificationDateIso).toBe(
      "2024-06-01"
    );
  });

  it("never produces numerator > denominator (24,275/24,274 backstop)", () => {
    // Synthesize a multi-CSG scope where some ABP rows are
    // duplicated. The foundation must satisfy
    // `summaryCounts.part2Verified <= summaryCounts.totalSystems`
    // — this is the locked invariant the v3 plan calls out as
    // the most critical correctness check.
    const solar: FoundationSolarApplicationInput[] = [];
    const mapping: FoundationAbpCsgMappingInput[] = [];
    const abp: FoundationAbpReportInput[] = [];
    for (let i = 0; i < 100; i++) {
      const csg = `CSG-${i}`;
      const abpId = `ABP-${i}`;
      solar.push(makeSolar(csg, { statusText: "Active" }));
      mapping.push(makeMapping(csg, abpId));
      abp.push(makeAbpReport(abpId, "2024-06-01"));
      // Every 5th ABP row is duplicated.
      if (i % 5 === 0) {
        abp.push(makeAbpReport(abpId, "2024-07-01"));
      }
    }
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: solar,
        abpCsgSystemMapping: mapping,
        abpReport: abp,
      }),
      FIXED_BUILT_AT
    );
    expect(payload.summaryCounts.part2Verified).toBeLessThanOrEqual(
      payload.summaryCounts.totalSystems
    );
    expect(payload.summaryCounts.part2Verified).toBe(100);
    expect(payload.summaryCounts.totalSystems).toBe(100);
    expect(
      payload.integrityWarnings.filter(
        (w) => w.code === "DUPLICATE_ABP_REPORT_ROW"
      ).length
    ).toBe(20);
  });

  it("emits ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS when one ABP maps to two CSGs", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1", { statusText: "Active" }),
          makeSolar("CSG-2", { statusText: "Active" }),
        ],
        abpCsgSystemMapping: [
          makeMapping("CSG-1", "ABP-1"),
          makeMapping("CSG-2", "ABP-1"), // same ABP, different CSG
        ],
        abpReport: [makeAbpReport("ABP-1", "2024-06-01")],
      }),
      FIXED_BUILT_AT
    );
    const dupe = payload.integrityWarnings.find(
      (w) => w.code === "ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS"
    );
    expect(dupe).toBeDefined();
    expect(dupe).toEqual({
      code: "ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS",
      abpId: "ABP-1",
      csgIds: ["CSG-1", "CSG-2"],
    });
    // Both CSGs carry the warning code in their per-row badge.
    expect(
      payload.canonicalSystemsByCsgId["CSG-1"].integrityWarningCodes
    ).toContain("ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS");
    expect(
      payload.canonicalSystemsByCsgId["CSG-2"].integrityWarningCodes
    ).toContain("ABP_ID_MAPS_TO_MULTIPLE_CSG_IDS");
  });

  it("emits CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS when one CSG maps to two ABPs", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [makeSolar("CSG-1", { statusText: "Active" })],
        abpCsgSystemMapping: [
          makeMapping("CSG-1", "ABP-1"),
          makeMapping("CSG-1", "ABP-2"),
        ],
        abpReport: [
          makeAbpReport("ABP-1", "2024-06-01"),
          makeAbpReport("ABP-2", "2024-06-01"),
        ],
      }),
      FIXED_BUILT_AT
    );
    const dupe = payload.integrityWarnings.find(
      (w) => w.code === "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS"
    );
    expect(dupe).toEqual({
      code: "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS",
      csgId: "CSG-1",
      abpIds: ["ABP-1", "ABP-2"],
    });
    expect(payload.canonicalSystemsByCsgId["CSG-1"].abpIds).toEqual([
      "ABP-1",
      "ABP-2",
    ]);
  });

  it("emits UNMATCHED_PART2_ABP_ID when a verified ABP has no CSG mapping", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [],
        abpCsgSystemMapping: [],
        abpReport: [makeAbpReport("ABP-ORPHAN", "2024-06-01")],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.integrityWarnings).toEqual([
      { code: "UNMATCHED_PART2_ABP_ID", abpId: "ABP-ORPHAN" },
    ]);
    expect(payload.summaryCounts.part2Verified).toBe(0);
  });

  it("does NOT emit UNMATCHED_PART2_ABP_ID when the date is invalid", () => {
    // Don't flood the warning list with every empty-date ABP row.
    const payload = buildFoundationFromInputs(
      makeInputs({
        abpReport: [
          makeAbpReport("ABP-1", null),
          makeAbpReport("ABP-2", "not a date"),
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.integrityWarnings).toEqual([]);
  });

  it("emits SOLAR_APPLICATION_MISSING_CSG_ID when solar row has no CSG ID", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1"),
          { ...makeSolar("DUMMY"), csgId: null, applicationId: "ABP-NO-CSG" },
        ],
      }),
      FIXED_BUILT_AT
    );
    expect(
      payload.integrityWarnings.find(
        (w) => w.code === "SOLAR_APPLICATION_MISSING_CSG_ID"
      )
    ).toEqual({
      code: "SOLAR_APPLICATION_MISSING_CSG_ID",
      rowKey: "ABP-NO-CSG",
    });
    // Only CSG-1 lands in the canonical map; the missing-CSG row
    // stays as a warning only.
    expect(Object.keys(payload.canonicalSystemsByCsgId)).toEqual(["CSG-1"]);
  });
});

// ============================================================================
// buildFoundationFromInputs — invariants always pass
// ============================================================================

describe("buildFoundationFromInputs — invariants pass on all generated payloads", () => {
  it("happy-path payload validates against assertFoundationInvariants", () => {
    // The builder calls `assertFoundationInvariants` itself. If
    // any of these constructions tripped an invariant the call
    // would have thrown — reaching the expect is the proof.
    const payload: FoundationArtifactPayload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-1", { statusText: "Active" }),
          makeSolar("CSG-2", { contractType: "IL ABP - Terminated" }),
        ],
        abpCsgSystemMapping: [makeMapping("CSG-1", "ABP-1")],
        abpReport: [makeAbpReport("ABP-1", "2024-06-01")],
      }),
      FIXED_BUILT_AT
    );
    expect(payload.summaryCounts.part2Verified).toBe(1);
    expect(payload.summaryCounts.totalSystems).toBe(1); // CSG-2 is terminated
    expect(payload.summaryCounts.terminated).toBe(1);
  });

  it("complex multi-warning fixture validates", () => {
    const payload = buildFoundationFromInputs(
      makeInputs({
        solarApplications: [
          makeSolar("CSG-A", { statusText: "Active" }),
          makeSolar("CSG-B", { statusText: "Rejected" }),
          makeSolar("CSG-C", { statusText: "Active" }),
        ],
        abpCsgSystemMapping: [
          makeMapping("CSG-A", "ABP-1"),
          makeMapping("CSG-B", "ABP-2"),
          makeMapping("CSG-C", "ABP-3"),
          makeMapping("CSG-C", "ABP-4"), // CSG-C maps to two ABPs
        ],
        abpReport: [
          makeAbpReport("ABP-1", "2024-06-01"),
          makeAbpReport("ABP-2", "2024-06-01"),
          makeAbpReport("ABP-3", "2024-06-01"),
          makeAbpReport("ABP-3", "2024-07-01"), // duplicate
          makeAbpReport("ABP-4", "2024-06-01"),
          makeAbpReport("ABP-ORPHAN", "2024-06-01"), // unmatched
        ],
      }),
      FIXED_BUILT_AT
    );
    // Part II Verified: CSG-A (ok) + CSG-C (ok) — CSG-B is blocked.
    expect(payload.summaryCounts.part2Verified).toBe(2);
    expect(payload.part2EligibleCsgIds).toEqual(["CSG-A", "CSG-C"]);
    // Warnings present: duplicate ABP, multi-ABP CSG, unmatched.
    const codes = payload.integrityWarnings.map((w) => w.code).sort();
    expect(codes).toEqual([
      "CSG_ID_MAPS_TO_MULTIPLE_ABP_IDS",
      "DUPLICATE_ABP_REPORT_ROW",
      "UNMATCHED_PART2_ABP_ID",
    ]);
  });
});
