import { describe, expect, it } from "vitest";
import {
  buildFoundationOverlayMap,
  clean,
  extractSnapshotSystems,
  foundationCanonicalOverlay,
  getDeliveredForYear,
  isPart2VerifiedAbpRow,
  parseDate,
  parseNumber,
  parsePart2VerificationDate,
  toPercentValue,
} from "./aggregatorHelpers";
import {
  buildTransferDeliveryLookupFixture as lookupFor,
  makeFoundationSystem,
} from "./aggregatorTestFixtures";

// These helpers are the de-duplicated foundation of the Task 5.13
// aggregators. The tests guard against drift after the cleanup that
// pulled them out of three sibling files.

describe("clean", () => {
  it("returns empty string for null/undefined", () => {
    expect(clean(null)).toBe("");
    expect(clean(undefined)).toBe("");
  });

  it("trims surrounding whitespace", () => {
    expect(clean("  hello  ")).toBe("hello");
    expect(clean("\thi\n")).toBe("hi");
  });

  it("coerces numbers, booleans, objects via String()", () => {
    expect(clean(42)).toBe("42");
    expect(clean(true)).toBe("true");
    expect(clean({ toString: () => "obj" })).toBe("obj");
  });
});

describe("parseNumber", () => {
  it("parses plain numeric strings", () => {
    expect(parseNumber("42")).toBe(42);
    expect(parseNumber("3.14")).toBe(3.14);
    expect(parseNumber("-7")).toBe(-7);
  });

  it("strips $, %, commas, whitespace", () => {
    expect(parseNumber("$1,234.56")).toBe(1234.56);
    expect(parseNumber("99%")).toBe(99);
    expect(parseNumber("  5  ")).toBe(5);
  });

  it("returns null for empty/non-numeric/undefined", () => {
    expect(parseNumber(undefined)).toBeNull();
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("$")).toBeNull();
  });
});

describe("parseDate", () => {
  it("parses ISO YYYY-MM-DD", () => {
    const d = parseDate("2025-03-15");
    expect(d?.getFullYear()).toBe(2025);
    expect(d?.getMonth()).toBe(2);
    expect(d?.getDate()).toBe(15);
  });

  it("parses US M/D/YYYY (and 2-digit years)", () => {
    expect(parseDate("3/15/2025")?.getFullYear()).toBe(2025);
    expect(parseDate("3/15/25")?.getFullYear()).toBe(2025);
  });

  it("parses US M/D/YYYY HH:MM AM/PM", () => {
    const d = parseDate("3/15/2025 2:30 PM");
    expect(d?.getHours()).toBe(14);
    expect(d?.getMinutes()).toBe(30);
  });

  it("falls back to Date constructor for unrecognized formats", () => {
    const d = parseDate("Mar 15, 2025");
    expect(d).not.toBeNull();
    expect(d?.getFullYear()).toBe(2025);
  });

  it("returns null for empty/invalid strings", () => {
    expect(parseDate(undefined)).toBeNull();
    expect(parseDate("")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});

describe("parsePart2VerificationDate", () => {
  it("accepts Excel serial dates in [20000, 80000]", () => {
    // Excel serial 45000 ≈ 2023-03-15 (epoch 1899-12-30)
    const d = parsePart2VerificationDate("45000");
    expect(d?.getFullYear()).toBe(2023);
  });

  it("rejects Excel serials outside the plausible range", () => {
    expect(parsePart2VerificationDate("19999")).toBeNull();
    expect(parsePart2VerificationDate("80001")).toBeNull();
  });

  it("accepts calendar dates with year >= 2009", () => {
    expect(parsePart2VerificationDate("2025-03-15")).not.toBeNull();
    expect(parsePart2VerificationDate("3/15/2025")).not.toBeNull();
  });

  it("rejects calendar dates outside [2009, 2100]", () => {
    expect(parsePart2VerificationDate("2008-01-01")).toBeNull();
    expect(parsePart2VerificationDate("2101-01-01")).toBeNull();
  });

  it("returns null for empty / 'null' / non-date strings", () => {
    expect(parsePart2VerificationDate(undefined)).toBeNull();
    expect(parsePart2VerificationDate("")).toBeNull();
    expect(parsePart2VerificationDate("null")).toBeNull();
    expect(parsePart2VerificationDate("NULL")).toBeNull();
    expect(parsePart2VerificationDate("not a date")).toBeNull();
  });
});

describe("isPart2VerifiedAbpRow", () => {
  it("accepts either case of the verification-date column", () => {
    expect(
      isPart2VerifiedAbpRow({ Part_2_App_Verification_Date: "2025-03-15" })
    ).toBe(true);
    expect(
      isPart2VerifiedAbpRow({ part_2_app_verification_date: "2025-03-15" })
    ).toBe(true);
  });

  it("rejects rows without a parseable verification date", () => {
    expect(isPart2VerifiedAbpRow({})).toBe(false);
    expect(
      isPart2VerifiedAbpRow({ Part_2_App_Verification_Date: "" })
    ).toBe(false);
    expect(
      isPart2VerifiedAbpRow({ Part_2_App_Verification_Date: "null" })
    ).toBe(false);
  });
});

describe("toPercentValue", () => {
  it("returns numerator/denominator * 100 for valid inputs", () => {
    expect(toPercentValue(50, 100)).toBe(50);
    expect(toPercentValue(1, 4)).toBe(25);
  });

  it("returns null when denominator is zero or negative", () => {
    expect(toPercentValue(50, 0)).toBeNull();
    expect(toPercentValue(50, -1)).toBeNull();
  });

  it("returns null when either input is non-finite", () => {
    expect(toPercentValue(NaN, 10)).toBeNull();
    expect(toPercentValue(10, Infinity)).toBeNull();
  });
});

describe("getDeliveredForYear", () => {
  it("reads the (trackingId, energyYear) bucket from the lookup", () => {
    const lookup = lookupFor({
      // Server payload uses lowercase keys (built from
      // `unitId.toLowerCase()` in buildTransferDeliveryLookup.ts).
      // Test fixtures match prod shape.
      non100: { "2024": 50, "2025": 30 },
      non200: { "2024": 10 },
    });
    // Callers can pass either case — helper lowercases internally.
    expect(getDeliveredForYear(lookup, "non100", 2024)).toBe(50);
    expect(getDeliveredForYear(lookup, "non100", 2025)).toBe(30);
    expect(getDeliveredForYear(lookup, "non200", 2024)).toBe(10);
  });

  it("returns 0 for unknown tracking ID", () => {
    const lookup = lookupFor({ non100: { "2024": 50 } });
    expect(getDeliveredForYear(lookup, "non999", 2024)).toBe(0);
  });

  it("returns 0 for unknown energy year on a known tracking ID", () => {
    const lookup = lookupFor({ non100: { "2024": 50 } });
    expect(getDeliveredForYear(lookup, "non100", 2099)).toBe(0);
  });

  it("is case-insensitive on the trackingId", () => {
    // Server lookup keys are lowercase; row data
    // (`tracking_system_ref_id`) typically arrives mixed-case from
    // Schedule B PDF parses. Helper must normalize so both work
    // — this is the regression test for the pre-2026-04-29 bug
    // where Contract Vintage / Forecast / TrendDeliveryPace
    // silently returned 0 deliveries on every match in prod.
    const lookup = lookupFor({ non100: { "2024": 50 } });
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(50);
    expect(getDeliveredForYear(lookup, "Non100", 2024)).toBe(50);
    expect(getDeliveredForYear(lookup, "non100", 2024)).toBe(50);
    expect(getDeliveredForYear(lookup, "NoN100", 2024)).toBe(50);
  });
});

describe("extractSnapshotSystems", () => {
  it("extracts the 6-field SnapshotSystem subset", () => {
    const out = extractSnapshotSystems([
      {
        systemId: "id-1",
        stateApplicationRefId: "app-1",
        trackingSystemRefId: "trk-1",
        systemName: "Smith Residence",
        recPrice: 50,
        isReporting: true,
        // Extra fields the snapshot may include — ignored.
        irrelevant: "noise",
        anotherField: 42,
      },
    ]);
    expect(out).toEqual([
      {
        systemId: "id-1",
        stateApplicationRefId: "app-1",
        trackingSystemRefId: "trk-1",
        systemName: "Smith Residence",
        recPrice: 50,
        isReporting: true,
      },
    ]);
  });

  it("substitutes safe defaults when fields are missing or wrong-typed", () => {
    const out = extractSnapshotSystems([
      {
        // No systemId
        stateApplicationRefId: 12345, // wrong type
        trackingSystemRefId: "trk-1",
        systemName: 99, // wrong type (number instead of string)
        recPrice: "50", // wrong type (string instead of number)
        isReporting: "yes", // wrong type (string instead of boolean)
      },
    ]);
    expect(out).toEqual([
      {
        systemId: null,
        stateApplicationRefId: null,
        trackingSystemRefId: "trk-1",
        systemName: "",
        recPrice: null,
        isReporting: false,
      },
    ]);
  });

  it("skips non-object entries", () => {
    const out = extractSnapshotSystems([
      null,
      undefined,
      42,
      "string",
      { trackingSystemRefId: "trk-1" } as unknown,
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].trackingSystemRefId).toBe("trk-1");
  });

  it("returns empty for empty input", () => {
    expect(extractSnapshotSystems([])).toEqual([]);
  });
});

// ============================================================================
// Phase 3.1 — foundationCanonicalOverlay
// ============================================================================

describe("foundationCanonicalOverlay", () => {
  it("active + reporting → 'Not Transferred and Reporting'", () => {
    const out = foundationCanonicalOverlay(
      makeFoundationSystem({ ownershipStatus: "active", isReporting: true })
    );
    expect(out).toEqual({
      isReporting: true,
      isTransferred: false,
      isTerminated: false,
      ownershipStatus: "Not Transferred and Reporting",
    });
  });

  it("active + not reporting → 'Not Transferred and Not Reporting'", () => {
    const out = foundationCanonicalOverlay(
      makeFoundationSystem({ ownershipStatus: "active", isReporting: false })
    );
    expect(out.ownershipStatus).toBe("Not Transferred and Not Reporting");
  });

  it("transferred + reporting → 'Transferred and Reporting'", () => {
    const out = foundationCanonicalOverlay(
      makeFoundationSystem({
        ownershipStatus: "transferred",
        isReporting: true,
      })
    );
    expect(out.isTransferred).toBe(true);
    expect(out.ownershipStatus).toBe("Transferred and Reporting");
  });

  it("transferred + not reporting → 'Transferred and Not Reporting'", () => {
    const out = foundationCanonicalOverlay(
      makeFoundationSystem({
        ownershipStatus: "transferred",
        isReporting: false,
      })
    );
    expect(out.ownershipStatus).toBe("Transferred and Not Reporting");
  });

  it("terminated + reporting → 'Terminated and Reporting' (terminated wins over reporting)", () => {
    const out = foundationCanonicalOverlay(
      makeFoundationSystem({
        ownershipStatus: "terminated",
        isTerminated: true,
        isReporting: true,
      })
    );
    expect(out.isTerminated).toBe(true);
    expect(out.ownershipStatus).toBe("Terminated and Reporting");
  });

  it("change-of-ownership maps to 'Not Transferred' on the 6-state enum", () => {
    // The COO bucket only surfaces on the separate `changeOwnershipStatus`
    // field handled inside `buildChangeOwnershipAggregates.ts`.
    const out = foundationCanonicalOverlay(
      makeFoundationSystem({
        ownershipStatus: "change-of-ownership",
        isReporting: true,
      })
    );
    expect(out.isTransferred).toBe(false);
    expect(out.ownershipStatus).toBe("Not Transferred and Reporting");
  });
});

describe("buildFoundationOverlayMap", () => {
  it("builds a Map<csgId, overlay> for O(1) lookup", () => {
    const map = buildFoundationOverlayMap({
      "CSG-A": makeFoundationSystem({
        csgId: "CSG-A",
        ownershipStatus: "transferred",
        isReporting: true,
      }),
      "CSG-B": makeFoundationSystem({
        csgId: "CSG-B",
        ownershipStatus: "terminated",
        isTerminated: true,
        isReporting: false,
      }),
    });
    expect(map.size).toBe(2);
    expect(map.get("CSG-A")?.ownershipStatus).toBe("Transferred and Reporting");
    expect(map.get("CSG-B")?.ownershipStatus).toBe(
      "Terminated and Not Reporting"
    );
    expect(map.get("CSG-MISSING")).toBeUndefined();
  });

  it("returns an empty map for empty foundation systems", () => {
    expect(buildFoundationOverlayMap({}).size).toBe(0);
  });
});
