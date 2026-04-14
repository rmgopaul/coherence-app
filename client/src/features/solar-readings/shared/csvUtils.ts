import { clean } from "@/lib/helpers";

type CsvRow = Record<string, string>;

export function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseCsv(text: string): {
  headers: string[];
  rows: CsvRow[];
} {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (char === '"') {
      const next = source[index + 1];
      if (inQuotes && next === '"') {
        cell += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cell);
      cell = "";
      if (row.some((entry) => clean(entry).length > 0))
        matrix.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((entry) => clean(entry).length > 0)) matrix.push(row);

  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map(
    (header, columnIndex) =>
      clean(header) || `column_${columnIndex + 1}`
  );
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, columnIndex) => {
      record[header] = clean(values[columnIndex]);
    });
    return record;
  });

  return { headers, rows };
}

export function csvEscape(
  value: string | number | boolean | null | undefined
): string {
  const normalized =
    value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

export function buildCsv(
  headers: string[],
  rows: Array<
    Record<string, string | number | boolean | null | undefined>
  >
): string {
  const headerLine = headers
    .map((header) => csvEscape(header))
    .join(",");
  const bodyLines = rows.map((row) =>
    headers.map((header) => csvEscape(row[header])).join(",")
  );
  return [headerLine, ...bodyLines].join("\n");
}

/**
 * Extract IDs from CSV text using a list of preferred header names.
 * This is the generic version of extractMeterNumbersFromCsv,
 * extractPlantIdsFromCsv, etc.
 */
export function extractIdsFromCsv(
  text: string,
  preferredHeaders: string[]
): string[] {
  const parsed = parseCsv(text);
  const normalizedHeaders = parsed.headers.map((header) =>
    clean(header).toLowerCase().replace(/\s+/g, "_")
  );

  const preferredIndex = normalizedHeaders.findIndex((header) =>
    preferredHeaders.includes(header)
  );

  if (parsed.headers.length === 1 && preferredIndex === -1) {
    const headerValue = clean(parsed.headers[0]);
    const columnValues = parsed.rows
      .map((row) => clean(row[parsed.headers[0]]))
      .filter(Boolean);
    const combined = headerValue
      ? [headerValue, ...columnValues]
      : columnValues;
    return Array.from(new Set(combined));
  }

  if (preferredIndex >= 0) {
    const matchedHeader = parsed.headers[preferredIndex];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[matchedHeader]))
          .filter((value) => value.length > 0)
      )
    );
  }

  if (parsed.headers.length > 0 && parsed.rows.length > 0) {
    const fallbackHeader = parsed.headers[0];
    return Array.from(
      new Set(
        parsed.rows
          .map((row) => clean(row[fallbackHeader]))
          .filter((value) => value.length > 0)
      )
    );
  }

  if (parsed.headers.length > 0 && parsed.rows.length === 0) {
    return Array.from(
      new Set(
        parsed.headers
          .map((value) => clean(value))
          .filter(Boolean)
      )
    );
  }

  return [];
}

export function toComparableNumber(
  value: number | null | undefined
): number {
  return value === null || value === undefined
    ? Number.NEGATIVE_INFINITY
    : value;
}

export function chunkArray<T>(
  values: T[],
  chunkSize: number
): T[][] {
  if (chunkSize <= 0) return [values];
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    output.push(values.slice(index, index + chunkSize));
  }
  return output;
}

export function waitForNextFrame(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}
