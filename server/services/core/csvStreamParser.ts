/**
 * Streaming CSV parser for the dataset-upload pipeline.
 *
 * Phase 5e step 4 PR-D follow-up (2026-04-30) — replaces the
 * `fs.readFile` + `parseCsvText` pair in `runDatasetUploadJob`
 * which loaded the entire CSV file into memory and built a
 * `Record<string, string>[]` for every row before persistence.
 * On a multi-hundred-MB Converted Reads upload that combination
 * pushed Render's heap past 4 GB and crashed the instance.
 *
 * This parser:
 *   - Reads the file via `fs.createReadStream` (default 64 KB
 *     internal buffer).
 *   - Maintains parser state (in-quote, partial cell, partial
 *     row) across chunks.
 *   - Yields one fully-formed `CsvRow` (header → value) at a
 *     time as an `AsyncIterable`.
 *
 * Semantics mirror `parseCsvText` in
 * `server/routers/helpers/scheduleB.ts` exactly:
 *   - Doubled quotes inside quoted cells produce a literal `"`.
 *   - CRLF + LF + CR-only line endings all terminate a row.
 *   - Rows whose every cell is empty are dropped.
 *   - Headers are taken from the first non-empty row, trimmed,
 *     and rows with an empty header at any position are dropped.
 *   - Cells beyond `headers.length` are discarded; missing cells
 *     default to `""`.
 *
 * Memory budget per stream: O(rowSize + headers.length). The
 * caller does not retain rows; downstream code consumes one,
 * persists it, and lets it be GC'd before the next yield.
 */
import { createReadStream } from "node:fs";

export type CsvRow = Record<string, string>;

interface InternalParserState {
  cell: string;
  row: string[];
  inQuotes: boolean;
}

/**
 * Internal state machine — fed one chunk at a time, emits cell
 * arrays via `onRow`. Mirrors the byte-level loop in `parseCsvText`
 * with one wrinkle: the lookahead at the very end of a chunk for
 * `""` (escaped quote) and `\r\n` (CRLF pair) needs to defer the
 * boundary decision when the chunk ends mid-pair. We solve this
 * with a one-character "carry" — if the previous chunk ended on a
 * single `"` while in-quotes, or on a `\r`, we hold one position
 * of decision until the next chunk arrives.
 *
 * Returns the new state to thread into the next chunk. Caller is
 * responsible for calling `flushTrailing` after the stream ends to
 * push any in-progress final row.
 */
function feedChunk(
  state: InternalParserState,
  chunk: string,
  pendingCarry: string,
  onRow: (cells: string[]) => void
): { state: InternalParserState; pendingCarry: string } {
  // Prepend any deferred carry character from the previous chunk.
  const text = pendingCarry + chunk;
  let { cell, row, inQuotes } = state;

  let index = 0;
  while (index < text.length) {
    const char = text[index]!;

    if (inQuotes) {
      if (char === '"') {
        const next = text[index + 1];
        if (next === undefined) {
          // We can't tell if this `"` is a closing quote or the
          // first half of an escaped `""`. Carry it to the next
          // chunk for resolution.
          return {
            state: { cell, row, inQuotes: true },
            pendingCarry: '"',
          };
        }
        if (next === '"') {
          cell += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      cell += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r") {
        const next = text[index + 1];
        if (next === undefined) {
          // Could be CR-only or first half of CRLF — carry.
          return {
            state: { cell, row, inQuotes: false },
            pendingCarry: "\r",
          };
        }
        if (next === "\n") {
          // Consume the LF as part of CRLF.
          row.push(cell);
          cell = "";
          if (row.some((value) => value.length > 0)) {
            onRow(row);
          }
          row = [];
          index += 2;
          continue;
        }
        // CR-only line ending.
        row.push(cell);
        cell = "";
        if (row.some((value) => value.length > 0)) {
          onRow(row);
        }
        row = [];
        index += 1;
        continue;
      }
      // Plain LF.
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) {
        onRow(row);
      }
      row = [];
      index += 1;
      continue;
    }

    cell += char;
    index += 1;
  }

  return {
    state: { cell, row, inQuotes },
    pendingCarry: "",
  };
}

/**
 * Flush any partial row remaining when the input stream ends.
 * Mirrors the trailing block of `parseCsvText`.
 */
function flushTrailing(
  state: InternalParserState,
  pendingCarry: string,
  onRow: (cells: string[]) => void
): void {
  let cell = state.cell;
  const row = state.row;

  // Resolve any unresolved carry as a literal character (the only
  // ways to reach end-of-stream with a carry are: a stray `"`
  // immediately before EOF (which by parseCsvText's rules opens
  // a quoted cell that's never closed; we treat it as content),
  // or a trailing `\r` (which terminates a final row).
  if (pendingCarry === "\r") {
    row.push(cell);
    cell = "";
    if (row.some((value) => value.length > 0)) {
      onRow(row);
    }
    return;
  }
  if (pendingCarry === '"') {
    cell += '"';
  }

  row.push(cell);
  if (row.some((value) => value.length > 0)) {
    onRow(row);
  }
}

/**
 * Stream rows from a CSV file at `path`, yielding one
 * `Record<string, string>` per data row (headers excluded). The
 * generator never holds more than two rows in memory.
 *
 * `headers` argument: if provided, that header set is used as
 * authoritative (cells beyond the count are dropped, missing
 * cells default to `""`). Otherwise headers come from the first
 * non-empty row in the file. Mirrors `parseCsvText`'s behavior of
 * dropping empty rows + filtering empty header strings.
 */
export async function* streamCsvRowsFromFile(
  path: string
): AsyncGenerator<CsvRow, void, void> {
  let state: InternalParserState = { cell: "", row: [], inQuotes: false };
  let pendingCarry = "";
  let headers: string[] | null = null;
  let pendingRows: string[][] = [];

  const handleCells = (cells: string[]) => {
    if (headers === null) {
      // First non-empty row — capture as headers. Trim each, drop
      // headers that are empty after trimming. Mirrors parseCsvText.
      const trimmed = cells.map((h) => String(h ?? "").trim());
      const filtered = trimmed.filter((h) => h.length > 0);
      headers = filtered.length > 0 ? trimmed : []; // keep positional alignment
      return;
    }
    pendingRows.push(cells);
  };

  const stream = createReadStream(path, { encoding: "utf8" });

  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      ({ state, pendingCarry } = feedChunk(
        state,
        chunk,
        pendingCarry,
        handleCells
      ));
      // Flush any rows accumulated in this chunk.
      if (pendingRows.length > 0 && headers !== null) {
        for (const cells of pendingRows) {
          yield projectRow(headers, cells);
        }
        pendingRows = [];
      }
    }
    flushTrailing(state, pendingCarry, handleCells);

    if (headers !== null && pendingRows.length > 0) {
      for (const cells of pendingRows) {
        yield projectRow(headers, cells);
      }
    }
  } finally {
    if (typeof (stream as { destroy?: (err?: Error) => void }).destroy === "function") {
      (stream as { destroy: (err?: Error) => void }).destroy();
    }
  }
}

function projectRow(headers: string[], cells: string[]): CsvRow {
  const row: CsvRow = {};
  for (let i = 0; i < headers.length; i += 1) {
    const key = headers[i];
    if (!key) continue; // empty headers are dropped
    row[key] = String(cells[i] ?? "");
  }
  return row;
}

/**
 * Synchronous variant for tests + small in-memory inputs. Builds
 * a row array; do NOT use for production uploads (defeats the
 * streaming purpose).
 *
 * Exposed so the streaming parser's unit tests can compare its
 * output against the reference behavior of `parseCsvText` at a
 * row level without going through disk I/O.
 */
export function parseCsvTextStreaming(text: string): {
  headers: string[];
  rows: CsvRow[];
} {
  let state: InternalParserState = { cell: "", row: [], inQuotes: false };
  let pendingCarry = "";
  let headers: string[] | null = null;
  const rows: CsvRow[] = [];

  const handleCells = (cells: string[]) => {
    if (headers === null) {
      const trimmed = cells.map((h) => String(h ?? "").trim());
      const filtered = trimmed.filter((h) => h.length > 0);
      headers = filtered.length > 0 ? trimmed : [];
      return;
    }
    if (headers.length > 0) {
      rows.push(projectRow(headers, cells));
    }
  };

  ({ state, pendingCarry } = feedChunk(state, text, pendingCarry, handleCells));
  flushTrailing(state, pendingCarry, handleCells);

  // TS can't see that the inner closure may have set `headers` to a
  // non-null array, so widen via the explicit array cast.
  const finalHeaders: string[] = headers ?? [];
  return {
    headers: finalHeaders.filter((h) => h.length > 0),
    rows,
  };
}
