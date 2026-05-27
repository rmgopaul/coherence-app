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
  extractAbpReportStatusFields,
  extractDeliveryStartDate,
  extractSolarApplicationsRawFields,
} from "./buildSystemEnrichments";

describe("extractSolarApplicationsRawFields", () => {
  const EMPTY = {
    addressCity: null,
    utilityTerritory: null,
    projectStatus: null,
    internalStatus: null,
  };

  it("returns null fields for null / undefined rawRow", () => {
    expect(extractSolarApplicationsRawFields(null)).toEqual(EMPTY);
  });

  it("returns null fields for malformed JSON", () => {
    expect(extractSolarApplicationsRawFields("not json")).toEqual(EMPTY);
  });

  it("picks the first matching alias for each field", () => {
    const raw = JSON.stringify({
      City: "Chicago",
      "utility.name": "Ameren Illinois Company",
      "project.status": "4. Active",
      internal_status: "Step 4.2 - Initial Payment Has Been Sent to Customer",
      Application_ID: "APP-1",
    });
    expect(extractSolarApplicationsRawFields(raw)).toEqual({
      addressCity: "Chicago",
      utilityTerritory: "Ameren Illinois Company",
      projectStatus: "4. Active",
      internalStatus: "Step 4.2 - Initial Payment Has Been Sent to Customer",
    });
  });

  it("trims whitespace via pickField", () => {
    const raw = JSON.stringify({
      city: "  Springfield  ",
      utility: "Ameren",
      "project.status": "  Active  ",
    });
    const out = extractSolarApplicationsRawFields(raw);
    expect(out.addressCity).toBe("Springfield");
    expect(out.utilityTerritory).toBe("Ameren");
    expect(out.projectStatus).toBe("Active");
  });

  it("returns null for absent fields", () => {
    const raw = JSON.stringify({ unrelated: "value" });
    expect(extractSolarApplicationsRawFields(raw)).toEqual(EMPTY);
  });

  it("prefers utility.name (canonical) over Utility (fallback)", () => {
    // Aliases are probed in declaration order; `utility.name` first.
    const raw = JSON.stringify({
      "utility.name": "Ameren Illinois Company",
      Utility: "fallback",
    });
    expect(extractSolarApplicationsRawFields(raw).utilityTerritory).toBe(
      "Ameren Illinois Company"
    );
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

describe("extractAbpReportStatusFields", () => {
  const EMPTY = { part1Status: null, part2Status: null };

  it("returns null fields for null / malformed input", () => {
    expect(extractAbpReportStatusFields(null)).toEqual(EMPTY);
    expect(extractAbpReportStatusFields("not json")).toEqual(EMPTY);
  });

  it("extracts Part_1_Status + Part_2_Status from canonical CSV headers", () => {
    const raw = JSON.stringify({
      Part_1_Status: "Verified",
      Part_2_Status: "Verified",
      Batch_Status: "ICC_Approved",
    });
    expect(extractAbpReportStatusFields(raw)).toEqual({
      part1Status: "Verified",
      part2Status: "Verified",
    });
  });

  it("returns null when only one part status is present", () => {
    const raw = JSON.stringify({ Part_1_Status: "Verified" });
    expect(extractAbpReportStatusFields(raw)).toEqual({
      part1Status: "Verified",
      part2Status: null,
    });
  });
});
