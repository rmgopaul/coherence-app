/**
 * Read raw dataset rows out of IndexedDB (parity-verification support).
 *
 * Companion to `migrateToServer.ts` — shares the same storage format but
 * exposes a read-only interface that returns CsvRow[] per dataset key
 * without uploading or mutating anything.
 *
 * Used by the parity report to recompute the SystemRecord[] array
 * client-side and diff it against the server-computed snapshot.
 */

import {
  DASHBOARD_DB_NAME,
  DASHBOARD_DB_VERSION,
  DASHBOARD_DATASETS_STORE,
  DASHBOARD_DATASETS_MANIFEST_KEY,
} from "./constants";
import type { CsvRow, DatasetKey } from "../state/types";

type SerializedDataset = {
  _v?: number;
  fileName?: string;
  uploadedAt?: string;
  headers: string[];
  rows?: CsvRow[];
  columnData?: string[][];
  rowCount?: number;
};

type ManifestRecord = {
  keys?: string[];
};

// ---------------------------------------------------------------------------
// IDB plumbing — matches migrateToServer.ts
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
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open IndexedDB"));
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
// Public: read requested datasets from IDB as a keyed map
// ---------------------------------------------------------------------------

/**
 * Read the specified dataset keys from IndexedDB. Missing datasets
 * resolve to `null` so the caller can distinguish "not migrated yet"
 * from "migrated but empty".
 *
 * Returns `null` for the whole result if IndexedDB has no manifest
 * (i.e. no datasets were ever stored locally).
 */
export async function readIndexedDbDatasets(
  datasetKeys: readonly DatasetKey[]
): Promise<Record<string, CsvRow[]> | null> {
  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch {
    return null;
  }

  try {
    const manifest = await readRecord<ManifestRecord>(
      db,
      DASHBOARD_DATASETS_MANIFEST_KEY
    );
    if (!manifest?.keys?.length) return null;

    // The dashboard stores each dataset under a prefixed key —
    // see `dashboardDatasetStorageKey` in SolarRecDashboard.tsx.
    // The manifest stores short names, but the object store uses
    // the prefixed name. Without this, every read returns null.
    const result: Record<string, CsvRow[]> = {};
    for (const key of datasetKeys) {
      if (!manifest.keys.includes(key)) {
        result[key] = [];
        continue;
      }
      const storageKey = `dataset:${key}`;
      const serialized = await readRecord<SerializedDataset>(db, storageKey);
      result[key] = serialized ? deserializeRows(serialized) : [];
    }
    return result;
  } finally {
    db.close();
  }
}
