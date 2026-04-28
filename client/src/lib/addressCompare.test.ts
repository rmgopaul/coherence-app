/**
 * Task 9.5 PR-3 (2026-04-28) — tests for the address comparison
 * helpers used by the system detail page's Address section. Pure
 * functions; no mocks needed.
 */
import { describe, expect, it } from "vitest";
import {
  parseCityStateZip,
  normalizeZip,
  normalizeState,
  compareAddresses,
} from "./addressCompare";

describe("parseCityStateZip", () => {
  it("parses a canonical 'City, ST 12345' string", () => {
    expect(parseCityStateZip("Chicago, IL 60601")).toEqual({
      city: "Chicago",
      state: "IL",
      zip: "60601",
    });
  });

  it("handles 9-digit ZIPs by keeping only the 5-digit prefix", () => {
    expect(parseCityStateZip("Chicago, IL 60601-1234")).toEqual({
      city: "Chicago",
      state: "IL",
      zip: "60601",
    });
  });

  it("uppercases lowercase state codes", () => {
    expect(parseCityStateZip("Aurora, il 60506")).toEqual({
      city: "Aurora",
      state: "IL",
      zip: "60506",
    });
  });

  it("handles multi-word cities", () => {
    expect(parseCityStateZip("New York, NY 10001")).toEqual({
      city: "New York",
      state: "NY",
      zip: "10001",
    });
  });

  it("returns nulls for null/undefined/empty input", () => {
    expect(parseCityStateZip(null)).toEqual({
      city: null,
      state: null,
      zip: null,
    });
    expect(parseCityStateZip(undefined)).toEqual({
      city: null,
      state: null,
      zip: null,
    });
    expect(parseCityStateZip("")).toEqual({
      city: null,
      state: null,
      zip: null,
    });
    expect(parseCityStateZip("   ")).toEqual({
      city: null,
      state: null,
      zip: null,
    });
  });

  it("falls back to comma-split parsing for non-canonical strings", () => {
    // Comma-separated but missing the typical "ST 12345" tail.
    const result = parseCityStateZip("Springfield, IL");
    expect(result.state).toBe("IL");
    expect(result.city).toBe("Springfield");
    expect(result.zip).toBeNull();
  });

  it("returns nulls when no commas and no canonical tail", () => {
    expect(parseCityStateZip("just some text")).toEqual({
      city: null,
      state: null,
      zip: null,
    });
  });
});

describe("normalizeZip", () => {
  it("returns 5-digit ZIP for clean input", () => {
    expect(normalizeZip("60601")).toBe("60601");
  });

  it("strips 4-digit suffix on ZIP+4", () => {
    expect(normalizeZip("60601-1234")).toBe("60601");
  });

  it("ignores leading/trailing whitespace", () => {
    expect(normalizeZip("  60601  ")).toBe("60601");
  });

  it("returns null for non-numeric or short input", () => {
    expect(normalizeZip(null)).toBeNull();
    expect(normalizeZip("")).toBeNull();
    expect(normalizeZip("abc")).toBeNull();
    expect(normalizeZip("1234")).toBeNull(); // too short
  });
});

describe("normalizeState", () => {
  it("uppercases two-letter codes", () => {
    expect(normalizeState("il")).toBe("IL");
    expect(normalizeState("Il")).toBe("IL");
    expect(normalizeState("IL")).toBe("IL");
  });

  it("returns null for full state names (defensive)", () => {
    // The dashboard data is consistently 2-letter codes; full names
    // are flagged as "needs review" rather than silently coerced.
    expect(normalizeState("Illinois")).toBeNull();
  });

  it("returns null for null/empty/non-letter input", () => {
    expect(normalizeState(null)).toBeNull();
    expect(normalizeState("")).toBeNull();
    expect(normalizeState("12")).toBeNull();
    expect(normalizeState("I L")).toBeNull();
  });
});

describe("compareAddresses", () => {
  it("returns 'match' when both sources agree on ZIP and state", () => {
    const out = compareAddresses(
      {
        mailingAddress1: "123 Main St",
        mailingAddress2: null,
        cityStateZip: "Chicago, IL 60601",
        payeeName: "Smith",
      },
      { state: "IL", zipCode: "60601", county: "Cook" }
    );
    expect(out.zipMatch).toBe("match");
    expect(out.stateMatch).toBe("match");
    expect(out.overall).toBe("match");
  });

  it("flags mismatch when ZIPs disagree", () => {
    const out = compareAddresses(
      {
        mailingAddress1: "123 Main St",
        mailingAddress2: null,
        cityStateZip: "Chicago, IL 60601",
        payeeName: null,
      },
      { state: "IL", zipCode: "60602", county: null }
    );
    expect(out.zipMatch).toBe("mismatch");
    expect(out.stateMatch).toBe("match");
    expect(out.overall).toBe("mismatch");
  });

  it("flags mismatch when states disagree", () => {
    const out = compareAddresses(
      {
        mailingAddress1: null,
        mailingAddress2: null,
        cityStateZip: "Springfield, MO 65801",
        payeeName: null,
      },
      { state: "IL", zipCode: "65801", county: null }
    );
    expect(out.zipMatch).toBe("match");
    expect(out.stateMatch).toBe("mismatch");
    expect(out.overall).toBe("mismatch");
  });

  it("returns 'partial' when only one source has data", () => {
    const out = compareAddresses(
      {
        mailingAddress1: "123 Main St",
        mailingAddress2: null,
        cityStateZip: "Chicago, IL 60601",
        payeeName: null,
      },
      { state: null, zipCode: null, county: null }
    );
    expect(out.overall).toBe("partial");
    expect(out.zipMatch).toBe("missing-b");
    expect(out.stateMatch).toBe("missing-b");
  });

  it("returns 'none' when neither source has any address data", () => {
    const out = compareAddresses(
      {
        mailingAddress1: null,
        mailingAddress2: null,
        cityStateZip: null,
        payeeName: null,
      },
      { state: null, zipCode: null, county: null }
    );
    expect(out.overall).toBe("none");
  });

  it("handles null contractScan + populated registry", () => {
    const out = compareAddresses(null, {
      state: "IL",
      zipCode: "60601",
      county: "Cook",
    });
    expect(out.overall).toBe("partial");
    expect(out.zipMatch).toBe("missing-a");
    expect(out.stateMatch).toBe("missing-a");
  });

  it("handles populated contractScan + null registry", () => {
    const out = compareAddresses(
      {
        mailingAddress1: "123 Main",
        mailingAddress2: null,
        cityStateZip: "Chicago, IL 60601",
        payeeName: null,
      },
      null
    );
    expect(out.overall).toBe("partial");
  });

  it("treats unparseable cityStateZip as missing", () => {
    const out = compareAddresses(
      {
        mailingAddress1: "123 Main",
        mailingAddress2: null,
        cityStateZip: "garbage",
        payeeName: null,
      },
      { state: "IL", zipCode: "60601", county: null }
    );
    // mailingAddress1 is non-empty so contractScan side counts as
    // "has data", but the parsed zip/state are null. This reads as
    // missing-a on the comparison check. Overall is partial because
    // we can't compare the partial-vs-partial case.
    expect(out.zipMatch).toBe("missing-a");
    expect(out.stateMatch).toBe("missing-a");
  });

  it("preserves parsed contract pieces in the response", () => {
    const out = compareAddresses(
      {
        mailingAddress1: "123 Main",
        mailingAddress2: null,
        cityStateZip: "Chicago, IL 60601",
        payeeName: null,
      },
      null
    );
    expect(out.contractCity).toBe("Chicago");
    expect(out.contractState).toBe("IL");
    expect(out.contractZip).toBe("60601");
  });
});
