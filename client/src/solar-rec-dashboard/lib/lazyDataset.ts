/**
 * Lazy-materialization infrastructure for large CsvDatasets.
 *
 * The dashboard hydrates every uploaded dataset into React state on
 * mount (across 14+ datasets totaling ~1.5M rows). Eagerly
 * materializing each dataset's `rows` array — a Record<string,string>
 * per row, headers × rowCount string references — pushed the Chrome
 * renderer process into code-5 OOM crashes. But tabs that never
 * mount never read `.rows`, and tabs that do mount read it once.
 *
 * So: keep each dataset's column-major representation in memory, and
 * only walk it into row objects the first time a consumer reads
 * `dataset.rows`. Cache thereafter.
 *
 * Consumer contract is unchanged: `dataset.rows` is a CsvRow[].
 * Everything that iterates rows, reads `.length`, maps, filters, etc.
 * works identically. The first access inside a component's render
 * pays ~500ms for a ~94MB dataset; subsequent renders are instant.
 *
 * Headers are frozen on attachment so a caller mutating
 * `dataset.headers` after construction cannot desync the hidden
 * columnar source from the visible headers. If a caller wants to
 * rename headers they must construct a new dataset.
 */

import type { CsvDataset, CsvRow } from "../state/types";

const DATASET_COLUMNAR_SOURCE = Symbol.for("solarRec.datasetColumnarSource");

export type ColumnarSource = {
  readonly headers: readonly string[];
  readonly columnData: readonly (readonly string[])[];
  readonly rowCount: number;
};

/**
 * Rebuild the row-major view of a columnar dataset. Walks each column
 * array once and emits one CsvRow per index. Missing cells default to
 * empty strings. Used both by buildLazyCsvDataset (on first .rows
 * read) and by any consumer that needs to re-materialize after
 * discarding the cached row array.
 */
export function rowsFromColumnar(
  headers: readonly string[],
  columnData: readonly (readonly string[])[],
  rowCount: number,
): CsvRow[] {
  const rows: CsvRow[] = new Array(rowCount);
  const safeHeaders = Array.isArray(headers) ? headers : [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const row: CsvRow = {};
    for (let columnIndex = 0; columnIndex < safeHeaders.length; columnIndex += 1) {
      const header = safeHeaders[columnIndex]!;
      const column = columnData[columnIndex];
      row[header] = column?.[rowIndex] ?? "";
    }
    rows[rowIndex] = row;
  }
  return rows;
}

/**
 * Flip a row-oriented dataset into columnar form. One inner array per
 * header, aligned by row index. Missing cells default to empty
 * strings so column lengths stay uniform.
 */
export function buildColumnarFromRows(
  headers: readonly string[],
  rows: readonly CsvRow[],
): string[][] {
  const columnData: string[][] = new Array(headers.length);
  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    const header = headers[columnIndex]!;
    const column = new Array<string>(rows.length);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      column[rowIndex] = rows[rowIndex]?.[header] ?? "";
    }
    columnData[columnIndex] = column;
  }
  return columnData;
}

/**
 * Read the hidden columnar source from a dataset, if any. Datasets
 * built by buildLazyCsvDataset carry their source arrays on a
 * non-enumerable symbol slot. Datasets constructed directly (fresh
 * uploads, legacy payloads) return null and callers must fall back to
 * buildColumnarFromRows.
 */
export function getDatasetColumnarSource(
  dataset: CsvDataset | null | undefined,
): ColumnarSource | null {
  if (!dataset) return null;
  const raw = (dataset as unknown as Record<symbol, unknown>)[
    DATASET_COLUMNAR_SOURCE
  ];
  if (!raw || typeof raw !== "object") return null;
  const candidate = raw as Partial<ColumnarSource>;
  if (!Array.isArray(candidate.headers)) return null;
  if (!Array.isArray(candidate.columnData)) return null;
  if (typeof candidate.rowCount !== "number") return null;
  return candidate as ColumnarSource;
}

/**
 * Build a CsvDataset whose `rows` array materializes on first access
 * and caches thereafter. For datasets whose tabs never mount, the
 * expensive row-object construction never happens at all.
 *
 * A tab that DOES read rows pays exactly the same cost as before —
 * one materialization, cached for subsequent reads. No per-access
 * Proxy overhead on the hot path.
 *
 * The columnar arrays stay reachable via the hidden symbol slot so
 * serialization (saveDatasetsToStorage) can write them back to IDB
 * without walking the rows.
 */
export function buildLazyCsvDataset(input: {
  fileName: string;
  uploadedAt: Date;
  headers: string[];
  columnData: string[][];
  rowCount: number;
  sources: CsvDataset["sources"];
}): CsvDataset {
  const { fileName, uploadedAt, headers, columnData, rowCount, sources } = input;

  // Freeze so a caller cannot mutate headers after construction and
  // desync the visible `dataset.headers` from the hidden
  // columnarSource.headers. If a caller needs different headers they
  // must build a new dataset via the eager path.
  const frozenHeaders = Object.freeze([...headers]) as readonly string[] as string[];

  const dataset: CsvDataset = {
    fileName,
    uploadedAt,
    headers: frozenHeaders,
    rows: [] as CsvRow[], // overwritten by the getter below
    // Task 5.14 PR-1: scalar row count. Lets `dataset.rowCount`
    // consumers (Step 1 upload UI, dashboard staleness/loaded
    // checks) read the count without triggering the lazy `.rows`
    // getter — which would walk the columnar source into a full
    // CsvRow[] just to call `.length` on it.
    rowCount,
    sources,
  };
  let cachedRows: CsvRow[] | null = null;
  Object.defineProperty(dataset, "rows", {
    configurable: true,
    enumerable: true,
    get() {
      if (cachedRows === null) {
        cachedRows = rowsFromColumnar(frozenHeaders, columnData, rowCount);
      }
      return cachedRows;
    },
    set(value: CsvRow[]) {
      cachedRows = Array.isArray(value) ? value : [];
    },
  });
  Object.defineProperty(dataset, DATASET_COLUMNAR_SOURCE, {
    configurable: true,
    enumerable: false,
    writable: false,
    value: {
      headers: frozenHeaders,
      columnData,
      rowCount,
    } satisfies ColumnarSource,
  });
  return dataset;
}
