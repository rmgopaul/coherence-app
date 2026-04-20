import { describe, it, expect } from "vitest";
import {
  buildColumnarFromRows,
  buildLazyCsvDataset,
  getDatasetColumnarSource,
  rowsFromColumnar,
} from "./lazyDataset";
import type { CsvDataset } from "../state/types";

describe("rowsFromColumnar", () => {
  it("rebuilds rows from columnar data", () => {
    const rows = rowsFromColumnar(
      ["a", "b"],
      [
        ["1", "3"],
        ["2", "4"],
      ],
      2,
    );
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("defaults missing cells to empty string", () => {
    const rows = rowsFromColumnar(["a", "b"], [["1"], []], 2);
    // Row 1 has no column data past index 0 in either column.
    expect(rows).toEqual([
      { a: "1", b: "" },
      { a: "", b: "" },
    ]);
  });

  it("returns empty array for rowCount 0", () => {
    expect(rowsFromColumnar(["a"], [[]], 0)).toEqual([]);
  });
});

describe("buildColumnarFromRows", () => {
  it("round-trips with rowsFromColumnar", () => {
    const originalRows = [
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ];
    const columnar = buildColumnarFromRows(["a", "b"], originalRows);
    expect(columnar).toEqual([
      ["1", "3"],
      ["2", "4"],
    ]);
    expect(rowsFromColumnar(["a", "b"], columnar, 2)).toEqual(originalRows);
  });

  it("defaults missing fields to empty string", () => {
    const columnar = buildColumnarFromRows(["a", "b"], [{ a: "1" }]);
    expect(columnar).toEqual([["1"], [""]]);
  });
});

describe("buildLazyCsvDataset", () => {
  const baseInput = {
    fileName: "test.csv",
    uploadedAt: new Date("2026-01-01"),
    headers: ["a", "b"],
    columnData: [
      ["1", "3"],
      ["2", "4"],
    ],
    rowCount: 2,
    sources: undefined,
  };

  it("exposes rows that materialize on first access", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    expect(dataset.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("caches materialized rows (identity stable across reads)", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    const first = dataset.rows;
    const second = dataset.rows;
    expect(first).toBe(second);
  });

  it("freezes headers so callers can't desync from columnar source", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    expect(Object.isFrozen(dataset.headers)).toBe(true);
    expect(() => {
      (dataset.headers as string[]).push("c");
    }).toThrow();
  });

  it("exposes the columnar source via getDatasetColumnarSource", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    const source = getDatasetColumnarSource(dataset);
    expect(source).not.toBeNull();
    expect(source?.rowCount).toBe(2);
    expect(source?.columnData).toHaveLength(2);
  });

  it("keeps the columnar source consistent with visible headers", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    const source = getDatasetColumnarSource(dataset)!;
    expect(source.headers).toBe(dataset.headers);
  });

  it("returns null columnar source for plain datasets", () => {
    const plain: CsvDataset = {
      fileName: "plain.csv",
      uploadedAt: new Date(),
      headers: ["x"],
      rows: [{ x: "1" }],
    };
    expect(getDatasetColumnarSource(plain)).toBeNull();
  });

  it("setter coerces non-array assignment to empty array", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    // Exercise the setter — even though the type says CsvRow[], we
    // want to defend against `dataset.rows = undefined` etc.
    (dataset as unknown as { rows: unknown }).rows = null;
    expect(dataset.rows).toEqual([]);
  });

  it("setter accepts explicit array assignment", () => {
    const dataset = buildLazyCsvDataset(baseInput);
    const replacement = [{ a: "99", b: "88" }];
    dataset.rows = replacement;
    expect(dataset.rows).toBe(replacement);
  });
});
