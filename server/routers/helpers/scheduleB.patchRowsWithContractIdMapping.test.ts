/**
 * Tests for `patchRowsWithContractIdMapping` — the pure helper that
 * applies a `tracking_system_ref_id → utility_contract_number`
 * mapping to canonical delivery-schedule rows.
 *
 * Used by:
 *   - `applyScheduleBContractIdMapping` (the user-clicked
 *     "Save & Apply mapping" button)
 *   - `applyScheduleBToDeliveryObligations` (the auto-apply path
 *     triggered after every Schedule B PDF import)
 *
 * The helper's job is to mirror the button's semantics inside the
 * import path, so the user no longer has to click "Save & Apply"
 * after every PDF upload — the saved mapping survives across all
 * Schedule B re-imports.
 */
import { describe, expect, it } from "vitest";
import {
  patchRowsWithContractIdMapping,
  parseContractIdMappingText,
} from "./scheduleB";

function row(values: Record<string, string>): Record<string, string> {
  return values;
}

describe("patchRowsWithContractIdMapping", () => {
  it("returns rows unchanged when the mapping is empty", () => {
    const rows = [
      row({ tracking_system_ref_id: "NON1234", utility_contract_number: "" }),
      row({ tracking_system_ref_id: "NON5678", utility_contract_number: "" }),
    ];
    const result = patchRowsWithContractIdMapping(rows, new Map());
    expect(result.patched).toBe(0);
    expect(result.unchanged).toBe(2);
    expect(result.rows).toEqual(rows);
  });

  it("returns an empty array when there are no rows", () => {
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping([], mapping);
    expect(result.patched).toBe(0);
    expect(result.unchanged).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it("patches a row whose contract_id is empty", () => {
    const rows = [
      row({ tracking_system_ref_id: "NON1234", utility_contract_number: "" }),
    ];
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.rows[0]?.utility_contract_number).toBe("153");
    // Source row must NOT be mutated.
    expect(rows[0]?.utility_contract_number).toBe("");
  });

  it("overwrites a row whose contract_id differs from the mapping", () => {
    // Mirrors the button's "mapping wins" semantic — the user
    // explicitly chose to apply this mapping, so any drift gets
    // corrected.
    const rows = [
      row({
        tracking_system_ref_id: "NON1234",
        utility_contract_number: "999", // wrong contract ID
      }),
    ];
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(result.rows[0]?.utility_contract_number).toBe("153");
  });

  it("counts a row whose contract_id matches the mapping as unchanged", () => {
    const rows = [
      row({
        tracking_system_ref_id: "NON1234",
        utility_contract_number: "153",
      }),
    ];
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(0);
    expect(result.unchanged).toBe(1);
    // Same row reference returned when nothing changes — saves a
    // shallow-copy allocation per unchanged row.
    expect(result.rows[0]).toBe(rows[0]);
  });

  it("normalizes tracking ID case when matching against the mapping", () => {
    // `parseContractIdMappingText` uppercases keys; row tracking IDs
    // come from the Schedule B scanner and may be mixed-case. The
    // helper must uppercase at lookup time.
    const rows = [
      row({
        tracking_system_ref_id: "non1234", // lowercase
        utility_contract_number: "",
      }),
    ];
    const mapping = new Map([["NON1234", "153"]]); // uppercase
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(1);
    expect(result.rows[0]?.utility_contract_number).toBe("153");
  });

  it("leaves rows without tracking IDs untouched", () => {
    const rows = [
      row({ tracking_system_ref_id: "", utility_contract_number: "153" }),
      row({ system_name: "Stray row with no tracking" } as Record<string, string>),
    ];
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(0);
    expect(result.unchanged).toBe(2);
    expect(result.rows).toEqual(rows);
  });

  it("leaves rows whose tracking ID is not in the mapping untouched", () => {
    const rows = [
      row({
        tracking_system_ref_id: "NON9999",
        utility_contract_number: "888",
      }),
    ];
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(result.rows[0]?.utility_contract_number).toBe("888");
  });

  it("does not mutate the input rows array", () => {
    const rows = [
      row({ tracking_system_ref_id: "NON1234", utility_contract_number: "" }),
    ];
    const mapping = new Map([["NON1234", "153"]]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    // Out array is a new array.
    expect(result.rows).not.toBe(rows);
    // Original row unmodified.
    expect(rows[0]?.utility_contract_number).toBe("");
  });

  it("handles a mixed batch (patched / unchanged / no-tracking / no-mapping)", () => {
    const rows = [
      // Will be patched (empty → mapped)
      row({ tracking_system_ref_id: "NON1234", utility_contract_number: "" }),
      // Already correct
      row({ tracking_system_ref_id: "NON5678", utility_contract_number: "200" }),
      // Wrong → patched
      row({ tracking_system_ref_id: "NON9999", utility_contract_number: "999" }),
      // No tracking ID → untouched
      row({ tracking_system_ref_id: "", utility_contract_number: "X" }),
      // Tracking ID not in mapping → untouched
      row({ tracking_system_ref_id: "NON0000", utility_contract_number: "Y" }),
    ];
    const mapping = new Map([
      ["NON1234", "153"],
      ["NON5678", "200"],
      ["NON9999", "315"],
    ]);
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(2);
    expect(result.unchanged).toBe(3);
    expect(result.rows[0]?.utility_contract_number).toBe("153");
    expect(result.rows[1]?.utility_contract_number).toBe("200");
    expect(result.rows[2]?.utility_contract_number).toBe("315");
    expect(result.rows[3]?.utility_contract_number).toBe("X");
    expect(result.rows[4]?.utility_contract_number).toBe("Y");
  });

  it("integrates with parseContractIdMappingText output (round-trip)", () => {
    // End-to-end: paste-style text → parser → helper. Pins the
    // contract that the parser's uppercased keys match the helper's
    // uppercased lookup.
    const text = "NON1234,153\nnon5678\t200\n  NON9999 ,  315  ";
    const mapping = parseContractIdMappingText(text);
    const rows = [
      row({ tracking_system_ref_id: "NON1234", utility_contract_number: "" }),
      row({ tracking_system_ref_id: "NON5678", utility_contract_number: "" }),
      row({ tracking_system_ref_id: "NON9999", utility_contract_number: "" }),
    ];
    const result = patchRowsWithContractIdMapping(rows, mapping);
    expect(result.patched).toBe(3);
    expect(result.rows.map((r) => r.utility_contract_number)).toEqual([
      "153",
      "200",
      "315",
    ]);
  });
});
