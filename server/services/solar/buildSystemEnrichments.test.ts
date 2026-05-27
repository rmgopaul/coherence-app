/**
 * Pure-helper tests for buildSystemEnrichments.
 *
 * The orchestrator (`buildSystemEnrichments`) touches the DB and is
 * exercised end-to-end via the system-facts runner step test. These
 * tests cover the 3 exported pure helpers in isolation:
 *   - `extractSolarApplicationsRawFields`
 *   - `extractDeliveryStartDate`
 *   - `dedupLatestCollateralByCsg`
 */
import { describe, expect, it } from "vitest";
import {
  dedupLatestCollateralByCsg,
  extractDeliveryStartDate,
  extractSolarApplicationsRawFields,
} from "./buildSystemEnrichments";

describe("extractSolarApplicationsRawFields", () => {
  it("returns null fields for null / undefined rawRow", () => {
    expect(extractSolarApplicationsRawFields(null)).toEqual({
      addressCity: null,
      utilityTerritory: null,
    });
  });

  it("returns null fields for malformed JSON", () => {
    expect(extractSolarApplicationsRawFields("not json")).toEqual({
      addressCity: null,
      utilityTerritory: null,
    });
  });

  it("picks the first matching alias for each field", () => {
    const raw = JSON.stringify({
      City: "Chicago",
      Utility: "ComEd",
      Application_ID: "APP-1",
    });
    expect(extractSolarApplicationsRawFields(raw)).toEqual({
      addressCity: "Chicago",
      utilityTerritory: "ComEd",
    });
  });

  it("trims whitespace via pickField", () => {
    const raw = JSON.stringify({ city: "  Springfield  ", utility: "Ameren" });
    const out = extractSolarApplicationsRawFields(raw);
    expect(out.addressCity).toBe("Springfield");
    expect(out.utilityTerritory).toBe("Ameren");
  });

  it("returns null for absent fields", () => {
    const raw = JSON.stringify({ unrelated: "value" });
    expect(extractSolarApplicationsRawFields(raw)).toEqual({
      addressCity: null,
      utilityTerritory: null,
    });
  });
});

describe("extractDeliveryStartDate", () => {
  it("returns null for null / malformed input", () => {
    expect(extractDeliveryStartDate(null)).toBeNull();
    expect(extractDeliveryStartDate("not json")).toBeNull();
  });

  it("parses ISO-format year1_start_date", () => {
    const raw = JSON.stringify({ year1_start_date: "2024-06-01" });
    const parsed = extractDeliveryStartDate(raw);
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed?.getFullYear()).toBe(2024);
    expect(parsed?.getMonth()).toBe(5); // June (0-indexed)
    expect(parsed?.getDate()).toBe(1);
  });

  it("parses US-format year1_start_date", () => {
    const raw = JSON.stringify({ year1_start_date: "6/1/2025" });
    const parsed = extractDeliveryStartDate(raw);
    expect(parsed?.getFullYear()).toBe(2025);
    expect(parsed?.getMonth()).toBe(5);
  });

  it("returns null when the cell is missing or empty", () => {
    expect(extractDeliveryStartDate(JSON.stringify({}))).toBeNull();
    expect(
      extractDeliveryStartDate(JSON.stringify({ year1_start_date: "" }))
    ).toBeNull();
  });
});

describe("dedupLatestCollateralByCsg", () => {
  it("returns empty map for empty input", () => {
    expect(dedupLatestCollateralByCsg([])).toEqual(new Map());
  });

  it("first occurrence per csgId wins (caller pre-orders DESC)", () => {
    const out = dedupLatestCollateralByCsg([
      { csgId: "CSG-1", additionalCollateralPercent: 5.0 }, // newest
      { csgId: "CSG-1", additionalCollateralPercent: 4.0 }, // older
      { csgId: "CSG-2", additionalCollateralPercent: 6.5 },
    ]);
    expect(out.get("CSG-1")).toBe(5.0);
    expect(out.get("CSG-2")).toBe(6.5);
  });

  it("skips rows where additionalCollateralPercent is null", () => {
    const out = dedupLatestCollateralByCsg([
      { csgId: "CSG-1", additionalCollateralPercent: null }, // newest, null
      { csgId: "CSG-1", additionalCollateralPercent: 4.0 }, // older, has value
    ]);
    // Newest scan didn't capture a value — the older one is NOT a
    // fallback (a null in the newest scan is a real signal that the
    // contract was scanned but no collateral was specified). So the
    // dedup intentionally drops this csgId.
    expect(out.has("CSG-1")).toBe(false);
  });
});
