/// <reference lib="webworker" />

type CsvRow = Record<string, string>;

type ParseCsvRequest = {
  id: number;
  text: string;
};

type ParseCsvSuccess = {
  id: number;
  ok: true;
  headers: string[];
  rows: CsvRow[];
};

type ParseCsvFailure = {
  id: number;
  ok: false;
  error: string;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function parseCsv(text: string): { headers: string[]; rows: CsvRow[] } {
  const source = text.replace(/^\uFEFF/, "");
  const matrix: string[][] = [];

  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

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
      row.push(cell);
      cell = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && source[i + 1] === "\n") i += 1;
      row.push(cell);
      cell = "";
      if (row.some((entry) => clean(entry).length > 0)) matrix.push(row);
      row = [];
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((entry) => clean(entry).length > 0)) matrix.push(row);

  if (matrix.length === 0) return { headers: [], rows: [] };

  const headers = matrix[0].map((header, index) => clean(header) || `column_${index + 1}`);
  const rows = matrix.slice(1).map((values) => {
    const record: CsvRow = {};
    headers.forEach((header, index) => {
      record[header] = clean(values[index]);
    });
    return record;
  });

  return { headers, rows };
}

self.onmessage = (event: MessageEvent<ParseCsvRequest>) => {
  const { id, text } = event.data;
  try {
    const parsed = parseCsv(text);
    const response: ParseCsvSuccess = {
      id,
      ok: true,
      headers: parsed.headers,
      rows: parsed.rows,
    };
    self.postMessage(response);
  } catch (error) {
    const response: ParseCsvFailure = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "Failed to parse CSV in worker.",
    };
    self.postMessage(response);
  }
};
