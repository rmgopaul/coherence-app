/**
 * CSV parsing, generation, and download helpers for the Solar REC dashboard.
 *
 * Extracted verbatim from client/src/pages/SolarRecDashboard.tsx during
 * Phase 1 session 1. No behavior changes — this is a mechanical lift so
 * the god component can shrink and so the pure functions become testable
 * and reusable from the upcoming useDashboardPersistence hook.
 */

import { clean } from "@/lib/helpers";
import type { CsvRow } from "../state/types";

/**
 * Parse RFC 4180-ish CSV text into headers + row records. Handles
 * quoted fields, escaped double-quotes, and CRLF/LF line endings.
 * Blank lines and empty trailing rows are dropped. The first non-empty
 * row is treated as the header row; subsequent rows become CsvRow
 * records keyed by header name.
 */
export function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const source = text.replace(/^\uFEFF/, "");
  const rows: CsvRow[] = [];
  let headers: string[] = [];
  let hasHeader = false;
  let rowValues: string[] = [];
  let cell = "";
  let inQuotes = false;

  const commitRow = () => {
    rowValues.push(cell);
    cell = "";

    if (!rowValues.some((entry) => clean(entry).length > 0)) {
      rowValues = [];
      return;
    }

    if (!hasHeader) {
      headers = rowValues.map((header, index) => clean(header) || `column_${index + 1}`);
      hasHeader = true;
      rowValues = [];
      return;
    }

    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = clean(rowValues[index]);
    });
    rows.push(record);
    rowValues = [];
  };

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    if (char === "\"") {
      const next = source[i + 1];
      if (inQuotes && next === "\"") {
        cell += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      rowValues.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      commitRow();
      continue;
    }

    cell += char;
  }

  commitRow();
  if (!hasHeader) return { headers: [], rows: [] };

  return { headers, rows };
}

/**
 * Escape a single cell value for CSV output. Wraps in double-quotes
 * and doubles embedded quotes only when the value contains a character
 * that would otherwise break the parse (quote, comma, or newline).
 */
export function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll("\"", "\"\"")}"`;
  }
  return normalized;
}

/**
 * Build a CSV string from a header list and a list of row objects.
 * Row values are looked up by header name and escaped via csvEscape.
 * Missing fields become empty strings.
 */
export function buildCsv(
  headers: string[],
  rows: Array<Record<string, string | number | null | undefined>>
): string {
  const headerLine = headers.map((header) => csvEscape(header)).join(",");
  const bodyLines = rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","));
  return [headerLine, ...bodyLines].join("\n");
}

/**
 * ISO-8601-flavored timestamp suitable for embedding in filenames
 * (YYYY-MM-DD-HH-mm-ss). Uses UTC time, not local time.
 */
export function timestampForCsvFileName(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/**
 * Convert an arbitrary label into a filename-safe kebab-case slug.
 * Returns "export" as a fallback if the normalized value is empty.
 */
export function toCsvFileSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return slug || "export";
}

/**
 * Trigger a browser download of a CSV string as a file. Creates a
 * temporary blob URL, synthesizes an anchor click, and revokes the
 * URL immediately.
 */
export function triggerCsvDownload(fileName: string, csvText: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Case-insensitive check whether every expected header is present in
 * the given header list (after `clean()` normalization).
 */
export function matchesExpectedHeaders(headers: string[], expected: string[]): boolean {
  const available = new Set(headers.map((header) => clean(header).toLowerCase()));
  return expected.every((header) => available.has(header.toLowerCase()));
}
