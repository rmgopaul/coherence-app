/**
 * Unit tests for `convertSpreadsheetFileToCsv` — the Phase 6 PR-A
 * helper that lets the v2 upload button accept Excel files for the
 * 2 tabular datasets (`abpIccReport2Rows`, `abpIccReport3Rows`).
 *
 * The helper is pure — given a `File`, it returns either the same
 * file (CSV passthrough) or a new `File` with synthesized CSV
 * bytes (Excel input). The server-side runner is unaware of the
 * conversion; from its perspective every v2 upload is a CSV.
 */
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  convertSpreadsheetFileToCsv,
  isExcelFile,
  parseCsvMatrix,
} from "./csvParsing";

function makeCsvFile(name: string, body: string): File {
  return new File([new TextEncoder().encode(body)], name, {
    type: "text/csv",
  });
}

function makeXlsxFile(name: string, rows: string[][]): File {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const buf: ArrayBuffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  });
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function readCsvText(file: File): Promise<string> {
  return file.text();
}

describe("isExcelFile", () => {
  it("recognises the four supported Excel extensions", () => {
    expect(isExcelFile(makeXlsxFile("a.xlsx", [["h"]]))).toBe(true);
    expect(isExcelFile(new File([], "report.xlsm"))).toBe(true);
    expect(isExcelFile(new File([], "report.xlsb"))).toBe(true);
    expect(isExcelFile(new File([], "legacy.xls"))).toBe(true);
  });

  it("returns false for CSVs and unrelated extensions", () => {
    expect(isExcelFile(makeCsvFile("data.csv", "a,b\n1,2\n"))).toBe(false);
    expect(isExcelFile(new File([], "notes.txt"))).toBe(false);
    expect(isExcelFile(new File([], "archive.zip"))).toBe(false);
  });

  it("is case-insensitive on the extension", () => {
    expect(isExcelFile(new File([], "REPORT.XLSX"))).toBe(true);
    expect(isExcelFile(new File([], "Report.Xls"))).toBe(true);
  });
});

describe("convertSpreadsheetFileToCsv — CSV passthrough", () => {
  it("returns the same File reference when the input is .csv", async () => {
    const file = makeCsvFile("data.csv", "h1,h2\nv1,v2\n");
    const out = await convertSpreadsheetFileToCsv(file);
    expect(out).toBe(file);
  });

  it("does not alter CSV bytes for the .csv passthrough path", async () => {
    const original = "h1,h2\nv1,v2\nv3,v4\n";
    const file = makeCsvFile("data.csv", original);
    const out = await convertSpreadsheetFileToCsv(file);
    await expect(readCsvText(out)).resolves.toBe(original);
  });
});

describe("convertSpreadsheetFileToCsv — Excel conversion", () => {
  it("converts a 2-column .xlsx to CSV preserving header order + values", async () => {
    const file = makeXlsxFile("report.xlsx", [
      ["application_id", "kw_dc"],
      ["app-001", "10.5"],
      ["app-002", "12.3"],
    ]);
    const out = await convertSpreadsheetFileToCsv(file);
    expect(out.name).toBe("report.csv");
    expect(out.type).toBe("text/csv");

    const csvText = await readCsvText(out);
    const matrix = parseCsvMatrix(csvText);
    expect(matrix[0]).toEqual(["application_id", "kw_dc"]);
    expect(matrix[1]).toEqual(["app-001", "10.5"]);
    expect(matrix[2]).toEqual(["app-002", "12.3"]);
  });

  it("escapes commas, quotes, and newlines from Excel cells", async () => {
    const file = makeXlsxFile("tricky.xlsx", [
      ["address", "notes"],
      ["123 Main St, Apt 4", 'has a "quote"'],
      ["456 Oak Ave", "line one\nline two"],
    ]);
    const out = await convertSpreadsheetFileToCsv(file);
    const csvText = await readCsvText(out);

    // Each tricky cell must round-trip through parseCsvMatrix
    // back to its exact original string.
    const matrix = parseCsvMatrix(csvText);
    expect(matrix[0]).toEqual(["address", "notes"]);
    expect(matrix[1]).toEqual(["123 Main St, Apt 4", 'has a "quote"']);
    expect(matrix[2]).toEqual(["456 Oak Ave", "line one\nline two"]);
  });

  it("derives the synthesized .csv name from the source extension", async () => {
    const variants = ["report.XLSX", "report.xlsm", "report.xlsb", "report.xls"];
    for (const name of variants) {
      const file = makeXlsxFile(name, [["a"], ["1"]]);
      const out = await convertSpreadsheetFileToCsv(file);
      expect(out.name.toLowerCase()).toBe("report.csv");
    }
  });
});

describe("convertSpreadsheetFileToCsv — error cases", () => {
  it("throws a clear message for unsupported extensions", async () => {
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    await expect(convertSpreadsheetFileToCsv(file)).rejects.toThrow(
      /Unsupported file type/i
    );
  });

  it("throws when an Excel workbook produces no headers and no rows", async () => {
    // An XLSX with one empty sheet — `XLSX.utils.aoa_to_sheet([])`
    // is the canonical way to build an empty worksheet.
    const sheet = XLSX.utils.aoa_to_sheet([]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
    const buf: ArrayBuffer = XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
    });
    const file = new File([buf], "empty.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    await expect(convertSpreadsheetFileToCsv(file)).rejects.toThrow(
      /any rows/i
    );
  });
});
