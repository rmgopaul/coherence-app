/**
 * One-time migration utility: IndexedDB → server-side normalized storage.
 *
 * Reads all datasets from IndexedDB, reconstructs CSV text from the
 * columnar storage format, and uploads each to the server's dataset
 * ingestion endpoint.
 *
 * This runs client-side and is triggered by a migration UI button.
 * After successful migration, the user can switch to server-side reads.
 */

import {
  DASHBOARD_DB_NAME,
  DASHBOARD_DB_VERSION,
  DASHBOARD_DATASETS_STORE,
  DASHBOARD_DATASETS_MANIFEST_KEY,
} from "./constants";
import type { CsvRow, DatasetKey } from "../state/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SerializedDataset = {
  _v?: number;
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rows?: CsvRow[];
  columnData?: string[][];
  rowCount?: number;
  sources?: Array<{
    fileName: string;
    uploadedAt: string;
    rowCount: number;
  }>;
};

type ManifestRecord = {
  keys?: string[];
};

export type MigrationProgress = {
  status: "idle" | "reading" | "uploading" | "done" | "error";
  totalDatasets: number;
  completedDatasets: number;
  currentDataset: string | null;
  errors: Array<{ datasetKey: string; error: string }>;
};

// ---------------------------------------------------------------------------
// IndexedDB reading
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const request = window.indexedDB.open(DASHBOARD_DB_NAME, DASHBOARD_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DASHBOARD_DATASETS_STORE)) {
        db.createObjectStore(DASHBOARD_DATASETS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

function readRecord<T>(db: IDBDatabase, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DASHBOARD_DATASETS_STORE, "readonly");
    const store = tx.objectStore(DASHBOARD_DATASETS_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve((request.result as T) ?? null);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// CSV building helpers (chunked)
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Yield to the browser so the tab stays responsive during big builds. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Upload to server — chunked
// ---------------------------------------------------------------------------

/**
 * Rows per chunk. 10k rows × ~300 cols = ~15-30MB of CSV text per
 * chunk, safely under the 50MB express limit and small enough that
 * Render's request timeout won't kill the parse+insert cycle.
 */
const ROWS_PER_CHUNK = 10_000;

type ChunkIngestResult = {
  batchId: string;
  status: "processing" | "active" | "failed";
  chunkRowCount: number;
  totalRowCountSoFar: number | null;
  errors: Array<{ rowIndex: number; message: string }>;
};

async function uploadOneChunk(
  datasetKey: string,
  csvText: string,
  fileName: string,
  batchId: string | null,
  finalize: boolean
): Promise<{ success: boolean; batchId?: string; error?: string }> {
  const params = new URLSearchParams({
    datasetKey,
    fileName,
    finalize: String(finalize),
  });
  if (batchId) params.set("batchId", batchId);

  try {
    const response = await fetch(
      `/solar-rec/api/datasets/upload-chunk?${params.toString()}`,
      {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csvText,
        credentials: "include",
      }
    );
    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        error: `HTTP ${response.status}: ${errorBody.slice(0, 200)}`,
      };
    }
    const result: ChunkIngestResult = await response.json();
    if (result.status === "failed") {
      return {
        success: false,
        batchId: result.batchId,
        error: result.errors?.[0]?.message ?? "Chunk upload failed",
      };
    }
    return { success: true, batchId: result.batchId };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Stream a columnar dataset to the server in 10k-row chunks. Never
 * materializes more than one chunk's worth of CSV text at a time
 * in client memory.
 */
async function uploadColumnarDataset(
  datasetKey: string,
  headers: string[],
  columnData: string[][],
  rowCount: number,
  fileName: string,
  onChunkComplete: (chunkIndex: number, totalChunks: number) => void
): Promise<{ success: boolean; error?: string }> {
  const totalChunks = Math.max(1, Math.ceil(rowCount / ROWS_PER_CHUNK));
  let batchId: string | null = null;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const startRow = chunkIndex * ROWS_PER_CHUNK;
    const endRow = Math.min(startRow + ROWS_PER_CHUNK, rowCount);
    const isLast = chunkIndex === totalChunks - 1;

    // Build only this chunk's CSV text.
    const parts: string[] = [headers.map(csvEscape).join(",")];
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex++) {
      const cells: string[] = new Array(headers.length);
      for (let colIndex = 0; colIndex < headers.length; colIndex++) {
        cells[colIndex] = csvEscape(columnData[colIndex]?.[rowIndex] ?? "");
      }
      parts.push(cells.join(","));
      if ((rowIndex - startRow + 1) % 2000 === 0) {
        await yieldToBrowser();
      }
    }
    const csvText = parts.join("\n");

    const result = await uploadOneChunk(
      datasetKey,
      csvText,
      fileName,
      batchId,
      isLast
    );
    if (!result.success) {
      return {
        success: false,
        error: `chunk ${chunkIndex + 1}/${totalChunks}: ${result.error}`,
      };
    }
    if (result.batchId) batchId = result.batchId;
    onChunkComplete(chunkIndex + 1, totalChunks);
  }
  return { success: true };
}

/**
 * Same as uploadColumnarDataset but for v1 CsvRow[] format.
 */
async function uploadRowsDataset(
  datasetKey: string,
  headers: string[],
  rows: CsvRow[],
  fileName: string,
  onChunkComplete: (chunkIndex: number, totalChunks: number) => void
): Promise<{ success: boolean; error?: string }> {
  const totalChunks = Math.max(1, Math.ceil(rows.length / ROWS_PER_CHUNK));
  let batchId: string | null = null;

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    const startRow = chunkIndex * ROWS_PER_CHUNK;
    const endRow = Math.min(startRow + ROWS_PER_CHUNK, rows.length);
    const isLast = chunkIndex === totalChunks - 1;

    const parts: string[] = [headers.map(csvEscape).join(",")];
    for (let rowIndex = startRow; rowIndex < endRow; rowIndex++) {
      const row = rows[rowIndex];
      parts.push(headers.map((h) => csvEscape(row[h] ?? "")).join(","));
      if ((rowIndex - startRow + 1) % 2000 === 0) {
        await yieldToBrowser();
      }
    }
    const csvText = parts.join("\n");

    const result = await uploadOneChunk(
      datasetKey,
      csvText,
      fileName,
      batchId,
      isLast
    );
    if (!result.success) {
      return {
        success: false,
        error: `chunk ${chunkIndex + 1}/${totalChunks}: ${result.error}`,
      };
    }
    if (result.batchId) batchId = result.batchId;
    onChunkComplete(chunkIndex + 1, totalChunks);
  }
  return { success: true };
}

// ---------------------------------------------------------------------------
// Main migration function
// ---------------------------------------------------------------------------

/**
 * Migrate all datasets from IndexedDB to the server.
 *
 * @param scopeId - The scope to migrate into
 * @param onProgress - Callback for progress updates
 */
export async function migrateIndexedDbToServer(
  scopeId: string,
  onProgress: (progress: MigrationProgress) => void
): Promise<MigrationProgress> {
  const progress: MigrationProgress = {
    status: "reading",
    totalDatasets: 0,
    completedDatasets: 0,
    currentDataset: null,
    errors: [],
  };
  onProgress({ ...progress });

  try {
    // 1. Open IndexedDB and read manifest
    const db = await openDb();
    const manifest = await readRecord<ManifestRecord>(
      db,
      DASHBOARD_DATASETS_MANIFEST_KEY
    );

    const datasetKeys = manifest?.keys ?? [];
    if (datasetKeys.length === 0) {
      progress.status = "done";
      onProgress({ ...progress });
      return progress;
    }

    progress.totalDatasets = datasetKeys.length;
    onProgress({ ...progress });

    // 2. For each dataset, read from IndexedDB and upload.
    // NOTE: The object store uses prefixed keys (`dataset:${key}`),
    // but the manifest stores short names. Without the prefix every
    // readRecord returns null and the migration silently completes
    // with zero uploads.
    progress.status = "uploading";
    for (const key of datasetKeys) {
      progress.currentDataset = key;
      onProgress({ ...progress });

      try {
        const storageKey = `dataset:${key}`;
        const serialized = await readRecord<SerializedDataset>(db, storageKey);
        if (!serialized || !serialized.headers?.length) {
          progress.completedDatasets++;
          continue; // Skip empty datasets
        }

        const fileName = serialized.fileName || `${key}.csv`;

        // Surface per-chunk progress in the currentDataset label so
        // the UI shows something like "solarApplications (chunk 2/4)".
        const reportChunk = (chunkIndex: number, totalChunks: number) => {
          progress.currentDataset = `${key} (chunk ${chunkIndex}/${totalChunks})`;
          onProgress({ ...progress });
        };

        let uploadResult: { success: boolean; error?: string };
        if (serialized._v === 2 && serialized.columnData) {
          const rowCount =
            serialized.rowCount ?? serialized.columnData[0]?.length ?? 0;
          if (rowCount === 0) {
            progress.completedDatasets++;
            continue;
          }
          uploadResult = await uploadColumnarDataset(
            key,
            serialized.headers,
            serialized.columnData,
            rowCount,
            fileName,
            reportChunk
          );
        } else {
          const rows = serialized.rows ?? [];
          if (rows.length === 0) {
            progress.completedDatasets++;
            continue;
          }
          uploadResult = await uploadRowsDataset(
            key,
            serialized.headers,
            rows,
            fileName,
            reportChunk
          );
        }

        if (!uploadResult.success) {
          progress.errors.push({
            datasetKey: key,
            error: uploadResult.error ?? "Unknown upload error",
          });
        }
      } catch (err) {
        progress.errors.push({
          datasetKey: key,
          error: err instanceof Error ? err.message : "Read error",
        });
      }

      progress.completedDatasets++;
      onProgress({ ...progress });
    }

    progress.status = progress.errors.length > 0 ? "error" : "done";
    progress.currentDataset = null;
    onProgress({ ...progress });

    db.close();
    return progress;
  } catch (err) {
    progress.status = "error";
    progress.errors.push({
      datasetKey: "system",
      error: err instanceof Error ? err.message : "Migration failed",
    });
    onProgress({ ...progress });
    return progress;
  }
}

/**
 * Check if IndexedDB has any datasets that could be migrated.
 */
export async function hasIndexedDbDatasets(): Promise<boolean> {
  try {
    const db = await openDb();
    const manifest = await readRecord<ManifestRecord>(
      db,
      DASHBOARD_DATASETS_MANIFEST_KEY
    );
    db.close();
    return (manifest?.keys?.length ?? 0) > 0;
  } catch {
    return false;
  }
}
