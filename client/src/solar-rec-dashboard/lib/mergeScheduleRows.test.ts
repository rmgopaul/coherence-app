import { describe, expect, it } from "vitest";
import { mergeScheduleRows, type CsvRow } from "./mergeScheduleRows";

const row = (trackingId: string, extras: Record<string, string> = {}): CsvRow => ({
  tracking_system_ref_id: trackingId,
  ...extras,
});

describe("mergeScheduleRows", () => {
  it("returns secondary untouched when primary is empty", () => {
    const secondary = [row("NON100"), row("NON101")];
    const result = mergeScheduleRows([], secondary);
    expect(result.rows).toEqual(secondary);
    expect(result.conflicts).toEqual([]);
  });

  it("returns primary untouched when secondary is empty", () => {
    const primary = [row("NON100"), row("NON101")];
    const result = mergeScheduleRows(primary, []);
    expect(result.rows).toEqual(primary);
    expect(result.conflicts).toEqual([]);
  });

  it("unions non-overlapping tracking IDs, no conflicts", () => {
    const primary = [row("NON100", { year1_quantity_required: "5" })];
    const secondary = [row("NON999", { year1_quantity_required: "9" })];
    const result = mergeScheduleRows(primary, secondary);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].tracking_system_ref_id).toBe("NON100");
    expect(result.rows[1].tracking_system_ref_id).toBe("NON999");
    expect(result.conflicts).toEqual([]);
  });

  it("dedupes overlapping IDs with identical values, no conflicts", () => {
    const primary = [row("NON100", { year1_quantity_required: "5", utility_contract_number: "493" })];
    const secondary = [row("NON100", { year1_quantity_required: "5", utility_contract_number: "493" })];
    const result = mergeScheduleRows(primary, secondary);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].year1_quantity_required).toBe("5");
    expect(result.conflicts).toEqual([]);
  });

  it("records a conflict when overlapping IDs differ on a field (primary wins)", () => {
    const primary = [row("NON100", { year1_quantity_required: "5" })];
    const secondary = [row("NON100", { year1_quantity_required: "7" })];
    const result = mergeScheduleRows(primary, secondary);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].year1_quantity_required).toBe("5");
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].trackingSystemRefId).toBe("NON100");
    expect(result.conflicts[0].differingFields).toEqual(["year1_quantity_required"]);
  });

  it("fills in empty primary fields from secondary without creating a conflict", () => {
    const primary = [row("NON100", { year1_quantity_required: "5", utility_contract_number: "" })];
    const secondary = [row("NON100", { year1_quantity_required: "5", utility_contract_number: "493" })];
    const result = mergeScheduleRows(primary, secondary);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].utility_contract_number).toBe("493");
    expect(result.conflicts).toEqual([]);
  });

  it("passes through rows with no tracking_system_ref_id and never merges them", () => {
    const primary = [row(""), row("NON100", { year1_quantity_required: "5" })];
    const secondary = [row("", { year1_quantity_required: "9" })];
    const result = mergeScheduleRows(primary, secondary);
    // 3 rows: primary no-id, primary NON100, secondary no-id
    expect(result.rows).toHaveLength(3);
    expect(result.conflicts).toEqual([]);
  });

  it("treats uppercase and lowercase tracking IDs as the same key", () => {
    const primary = [row("non100", { year1_quantity_required: "5" })];
    const secondary = [row("NON100", { year1_quantity_required: "5" })];
    const result = mergeScheduleRows(primary, secondary);
    expect(result.rows).toHaveLength(1);
    expect(result.conflicts).toEqual([]);
  });

  it("6554 + 62 no-overlap scenario: total rows equals sum", () => {
    // Regression guard for the user's actual scenario.
    const primary: CsvRow[] = Array.from({ length: 6554 }, (_, i) =>
      row(`NON${i.toString().padStart(6, "0")}`, { year1_quantity_required: "10" })
    );
    const secondary: CsvRow[] = Array.from({ length: 62 }, (_, i) =>
      row(`SCH${i.toString().padStart(6, "0")}`, { year1_quantity_required: "20" })
    );
    const result = mergeScheduleRows(primary, secondary);
    expect(result.rows).toHaveLength(6616);
    expect(result.conflicts).toEqual([]);
  });
});
