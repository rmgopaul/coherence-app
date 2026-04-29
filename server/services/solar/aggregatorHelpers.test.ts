import { describe, expect, it } from "vitest";
import {
  clean,
  extractSnapshotSystems,
  getDeliveredForYear,
  isPart2VerifiedAbpRow,
  parseDate,
  parseNumber,
  parsePart2VerificationDate,
  toPercentValue,
} from "./aggregatorHelpers";
import { buildTransferDeliveryLookupFixture as lookupFor } from "./aggregatorTestFixtures";

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
      NON100: { "2024": 50, "2025": 30 },
      NON200: { "2024": 10 },
    });
    expect(getDeliveredForYear(lookup, "NON100", 2024)).toBe(50);
    expect(getDeliveredForYear(lookup, "NON100", 2025)).toBe(30);
    expect(getDeliveredForYear(lookup, "NON200", 2024)).toBe(10);
  });

  it("returns 0 for unknown tracking ID", () => {
    const lookup = lookupFor({ NON100: { "2024": 50 } });
    expect(getDeliveredForYear(lookup, "NON999", 2024)).toBe(0);
  });

  it("returns 0 for unknown energy year on a known tracking ID", () => {
    const lookup = lookupFor({ NON100: { "2024": 50 } });
    expect(getDeliveredForYear(lookup, "NON100", 2099)).toBe(0);
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
