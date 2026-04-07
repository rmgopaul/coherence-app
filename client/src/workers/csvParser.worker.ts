/// <reference lib="webworker" />

type CsvRow = Record<string, string>;

type ParseCsvRequest =
  | {
      id: number;
      mode: "text";
      text: string;
    }
  | {
      id: number;
      mode: "file";
      file: File;
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

self.onmessage = (event: MessageEvent<ParseCsvRequest>) => {
  const request = event.data;
  void (async () => {
    const { id } = request;
    try {
      const text =
        request.mode === "file"
          ? await request.file.text()
          : request.mode === "text"
            ? request.text
            : "";
      if (!text) {
        throw new Error("CSV parser worker received an empty payload.");
      }
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
  })();
};
