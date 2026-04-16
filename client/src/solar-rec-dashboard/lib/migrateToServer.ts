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
// Columnar → CsvRow[] reconstruction
// ---------------------------------------------------------------------------

function rowsFromColumnar(
  headers: string[],
  columnData: string[][],
  rowCount: number
): CsvRow[] {
  const rows: CsvRow[] = new Array(rowCount);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    const row: CsvRow = {};
    for (let colIndex = 0; colIndex < headers.length; colIndex++) {
      row[headers[colIndex]] = columnData[colIndex]?.[rowIndex] ?? "";
    }
    rows[rowIndex] = row;
  }
  return rows;
}

function deserializeRows(dataset: SerializedDataset): CsvRow[] {
  if (dataset._v === 2 && dataset.columnData) {
    return rowsFromColumnar(
      dataset.headers,
      dataset.columnData,
      dataset.rowCount ?? dataset.columnData[0]?.length ?? 0
    );
  }
  return dataset.rows ?? [];
}

// ---------------------------------------------------------------------------
// CsvRow[] → CSV text
// ---------------------------------------------------------------------------

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowsToCsvText(headers: string[], rows: CsvRow[]): string {
  const headerLine = headers.map(csvEscape).join(",");
  const bodyLines = rows.map((row) =>
    headers.map((h) => csvEscape(row[h] ?? "")).join(",")
  );
  return [headerLine, ...bodyLines].join("\n");
}

// ---------------------------------------------------------------------------
// Upload to server
// ---------------------------------------------------------------------------

async function uploadDataset(
  scopeId: string,
  datasetKey: string,
  csvText: string,
  fileName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(
      `/solar-rec/api/datasets/upload?datasetKey=${encodeURIComponent(datasetKey)}&fileName=${encodeURIComponent(fileName)}&mode=replace`,
      {
        method: "POST",
        headers: { "Content-Type": "text/csv" },
        body: csvText,
        credentials: "include", // send auth cookies
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      return { success: false, error: `HTTP ${response.status}: ${errorBody}` };
    }

    const result = await response.json();
    if (result.status === "failed") {
      return { success: false, error: result.errors?.[0]?.message ?? "Upload failed" };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
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

        const rows = deserializeRows(serialized);
        if (rows.length === 0) {
          progress.completedDatasets++;
          continue;
        }

        const csvText = rowsToCsvText(serialized.headers, rows);
        const fileName = serialized.fileName || `${key}.csv`;

        const result = await uploadDataset(scopeId, key, csvText, fileName);
        if (!result.success) {
          progress.errors.push({
            datasetKey: key,
            error: result.error ?? "Unknown upload error",
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
