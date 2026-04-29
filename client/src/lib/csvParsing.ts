import * as XLSX from "xlsx";
import { clean } from "./helpers";

export type CsvRow = Record<string, string>;

export type ParsedTabularData = {
  headers: string[];
  rows: CsvRow[];
  matrix: string[][];
};

export type ParseTabularFileOptions = {
  // For Excel workbooks: parse only the first sheet (default) or merge all sheets.
  excelSheetMode?: "first" | "all";
};

export function normalizeHeader(value: string): string {
  return clean(value)
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

export function parseNumber(value: unknown): number | null {
  const normalized = clean(value).replace(/,/g, "").replace(/[$%]/g, "");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDate(value: unknown): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const result = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    return Number.isNaN(result.getTime()) ? null : result;
  }

  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (us) {
    const year = Number(us[3]) < 100 ? Number(us[3]) + 2000 : Number(us[3]);
    const result = new Date(Date.UTC(year, Number(us[1]) - 1, Number(us[2])));
    return Number.isNaN(result.getTime()) ? null : result;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseCsvMatrix(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];

    if (character === '"') {
      const next = source[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && character === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((entry) => clean(entry).length > 0)) {
        matrix.push(row);
      }
      row = [];
      continue;
    }

    cell += character;
  }

  row.push(cell);
  if (row.some((entry) => clean(entry).length > 0)) {
    matrix.push(row);
  }

  return matrix;
}

export function matrixToParsedTabularData(matrix: string[][]): ParsedTabularData {
  if (!matrix.length) {
    return { headers: [], rows: [], matrix: [] };
  }

  const headers = matrix[0].map((header, index) => clean(header) || `column_${index + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = clean(values[index]);
    });
    return record;
  });

  return {
    headers,
    rows,
    matrix,
  };
}

export function sheetToMatrix(sheet: XLSX.WorkSheet): string[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: "",
    blankrows: false,
  }).map((row) => row.map((entry) => clean(entry)));
}

function mergeParsedTabularData(parts: ParsedTabularData[]): ParsedTabularData {
  if (parts.length === 0) {
    return { headers: [], rows: [], matrix: [] };
  }

  const headers: string[] = [];
  const seenHeaders = new Set<string>();
  parts.forEach((part) => {
    part.headers.forEach((header) => {
      const normalized = clean(header);
      if (!normalized || seenHeaders.has(normalized)) return;
      seenHeaders.add(normalized);
      headers.push(normalized);
    });
  });

  if (headers.length === 0) {
    return { headers: [], rows: [], matrix: [] };
  }

  const rows = parts.flatMap((part) =>
    part.rows.map((row) => {
      const mergedRow: CsvRow = {};
      headers.forEach((header) => {
        mergedRow[header] = clean(row[header]);
      });
      return mergedRow;
    })
  );

  const matrix = [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ""))];
  return { headers, rows, matrix };
}

export async function parseTabularFile(
  file: File,
  options: ParseTabularFileOptions = {}
): Promise<ParsedTabularData> {
  const lowerName = file.name.toLowerCase();

  if (lowerName.endsWith(".csv")) {
    const text = await file.text();
    const matrix = parseCsvMatrix(text);
    return matrixToParsedTabularData(matrix);
  }

  if (/(\.xlsx|\.xlsm|\.xlsb|\.xls)$/i.test(lowerName)) {
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", raw: false, cellDates: false });
    const excelSheetMode = options.excelSheetMode ?? "first";

    if (excelSheetMode === "all") {
      const parsedSheets = workbook.SheetNames
        .map((sheetName) => workbook.Sheets[sheetName])
        .filter((sheet): sheet is XLSX.WorkSheet => Boolean(sheet))
        .map((sheet) => matrixToParsedTabularData(sheetToMatrix(sheet)))
        .filter((parsed) => parsed.headers.length > 0 || parsed.rows.length > 0);

      if (parsedSheets.length === 0) {
        return { headers: [], rows: [], matrix: [] };
      }

      return mergeParsedTabularData(parsedSheets);
    }

    const firstSheetName = workbook.SheetNames[0];
    const firstSheet = workbook.Sheets[firstSheetName];
    if (!firstSheet) {
      throw new Error(`Could not read worksheet from ${file.name}.`);
    }
    const matrix = sheetToMatrix(firstSheet);
    if (!matrix.length) return { headers: [], rows: [], matrix: [] };

    return matrixToParsedTabularData(matrix);
  }

  throw new Error(`Unsupported file type for ${file.name}. Please upload CSV or Excel.`);
}

export function findHeaderRowIndex(matrix: string[][], requiredHeaders: string[]): number {
  const normalizedRequired = requiredHeaders.map((header) => normalizeHeader(header));
  for (let rowIndex = 0; rowIndex < matrix.length; rowIndex += 1) {
    const normalizedRow = new Set(matrix[rowIndex].map((entry) => normalizeHeader(entry)));
    const foundAll = normalizedRequired.every((required) => normalizedRow.has(required));
    if (foundAll) return rowIndex;
  }
  return -1;
}

export function readByNormalizedHeader(
  row: string[],
  headerRow: string[],
  candidates: string[]
): string {
  const headerLookup = new Map<string, number>();
  headerRow.forEach((header, index) => {
    headerLookup.set(normalizeHeader(header), index);
  });

  for (const candidate of candidates) {
    const index = headerLookup.get(normalizeHeader(candidate));
    if (index === undefined) continue;
    const value = clean(row[index]);
    if (value) return value;
  }

  return "";
}

export function findHeaderByKeywords(headers: string[], requiredKeywords: string[]): string | null {
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const matchesAll = requiredKeywords.every((keyword) => normalized.includes(normalizeHeader(keyword)));
    if (matchesAll) return header;
  }
  return null;
}

export function findHeaderByKeywordsExcluding(
  headers: string[],
  requiredKeywords: string[],
  excludedKeywords: string[]
): string | null {
  const normalizedExcluded = excludedKeywords.map((keyword) => normalizeHeader(keyword));
  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const matchesAll = requiredKeywords.every((keyword) => normalized.includes(normalizeHeader(keyword)));
    if (!matchesAll) continue;
    const hasExcluded = normalizedExcluded.some((keyword) => normalized.includes(keyword));
    if (hasExcluded) continue;
    return header;
  }
  return null;
}

export function findHeaderByAliases(headers: string[], aliases: string[]): string | null {
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const exact = headers.find((header) => normalizeHeader(header) === normalizedAlias);
    if (exact) return exact;
  }

  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const fuzzy = headers.find((header) => normalizeHeader(header).includes(normalizedAlias));
    if (fuzzy) return fuzzy;
  }

  return null;
}

/** Excel extensions the dashboard recognises (case-insensitive). */
const EXCEL_EXTENSION_RE = /\.(xlsx|xlsm|xlsb|xls)$/i;

/** True when `file` looks like one of our supported Excel formats. */
export function isExcelFile(file: File): boolean {
  return EXCEL_EXTENSION_RE.test(file.name);
}

/**
 * Render headers + row records as a CSV string. Mirrors
 * `client/src/solar-rec-dashboard/lib/csvIo.ts#buildCsv`, but lives
 * here so `convertSpreadsheetFileToCsv` doesn't have to reach into a
 * dashboard-feature module.
 *
 * Escaping rules: any cell containing `"`, `,`, `\n`, or `\r` is
 * wrapped in double quotes and embedded `"` is doubled. Empty /
 * nullish values render as the empty string.
 */
function csvEscapeCell(value: string): string {
  if (/["\r\n,]/.test(value)) {
    return `"${value.replaceAll('"', '""')}"`;
  }
  return value;
}

function buildCsvText(headers: string[], rows: CsvRow[]): string {
  const headerLine = headers.map((header) => csvEscapeCell(header)).join(",");
  const bodyLines = rows.map((row) =>
    headers.map((header) => csvEscapeCell(row[header] ?? "")).join(",")
  );
  return [headerLine, ...bodyLines].join("\n");
}

/**
 * Phase 6 PR-A — convert an Excel file to a synthesized CSV `File`
 * suitable for the v2 upload pipeline. Pure passthrough for `.csv`.
 *
 * The v2 upload runner only knows how to parse CSV bytes. The
 * legacy v1 path supported Excel by parsing in the browser via
 * `parseTabularFile` and then operating on the parsed rows
 * client-side. To keep the v2 server runner simple and identical
 * for every dataset, we run the same browser-side parse here and
 * then synthesize a CSV file with the same `{headers, rows}`. The
 * server then sees a normal CSV.
 *
 * Throws when:
 *   - `file` is neither CSV nor a recognised Excel extension
 *     (caller should have filtered via the input's `accept`, but
 *     guard anyway so a manual drop produces a clean message).
 *   - The Excel parse returns zero headers AND zero rows — almost
 *     always means the workbook is empty or password-protected.
 */
export async function convertSpreadsheetFileToCsv(
  file: File,
  options: ParseTabularFileOptions = {}
): Promise<File> {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".csv")) {
    return file;
  }
  if (!EXCEL_EXTENSION_RE.test(lowerName)) {
    throw new Error(
      `Unsupported file type for ${file.name}. Upload CSV or Excel (.xlsx, .xlsm, .xlsb, .xls).`
    );
  }
  const parsed = await parseTabularFile(file, options);
  if (parsed.headers.length === 0 && parsed.rows.length === 0) {
    throw new Error(
      `Could not extract any rows from ${file.name}. The workbook may be empty or password-protected.`
    );
  }
  const csvText = buildCsvText(parsed.headers, parsed.rows);
  const csvBytes = new TextEncoder().encode(csvText);
  const csvName = file.name.replace(EXCEL_EXTENSION_RE, ".csv");
  return new File([csvBytes], csvName, {
    type: "text/csv",
    lastModified: file.lastModified,
  });
}
