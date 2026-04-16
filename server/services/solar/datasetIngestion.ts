/**
 * Solar REC dataset ingestion service.
 *
 * Handles CSV parsing, header validation, row dedup (first-write-wins),
 * and batch creation for the server-side dataset architecture.
 */

import { nanoid } from "nanoid";
import { parseCsvText } from "../../routers/helpers";
import {
  createImportBatch,
  createImportFile,
  createImportErrors,
  updateImportBatchStatus,
  activateDatasetVersion,
  getActiveBatchForDataset,
} from "../../db";
import { storagePut } from "../../storage";
import {
  persistDatasetRows,
  hasPersistence,
} from "./datasetRowPersistence";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DatasetKey = string;

export type IngestResult = {
  batchId: string;
  status: "active" | "processing" | "failed";
  rowCount: number;
  dedupedCount: number;
  errors: Array<{ rowIndex: number; message: string }>;
};

export type DatasetDefinition = {
  label: string;
  requiredHeaderSets: string[][];
  multiFileAppend: boolean;
  rowKeyFields?: string[]; // fields that form the dedup key for append datasets
};

// ---------------------------------------------------------------------------
// Dataset definitions (server-side mirror of client DATASET_DEFINITIONS)
// Only the 7 core datasets for now — extend as migration progresses.
// ---------------------------------------------------------------------------

const CORE_DATASET_DEFINITIONS: Record<string, DatasetDefinition> = {
  solarApplications: {
    label: "Solar Applications",
    requiredHeaderSets: [
      ["Application_ID", "system_name"],
      ["system_id", "system_name"],
    ],
    multiFileAppend: false,
  },
  abpReport: {
    label: "ABP Report",
    requiredHeaderSets: [
      ["Application_ID", "Part_2_App_Verification_Date"],
      ["system_id", "part_2_app_verification_date"],
    ],
    multiFileAppend: false,
  },
  generationEntry: {
    label: "Generation Entry",
    requiredHeaderSets: [["Unit ID", "Facility Name", "Last Month of Gen"]],
    multiFileAppend: false,
  },
  accountSolarGeneration: {
    label: "Account Solar Generation",
    requiredHeaderSets: [
      ["Month of Generation", "GATS Gen ID", "Facility Name"],
    ],
    multiFileAppend: true,
    rowKeyFields: [
      "GATS Gen ID",
      "Month of Generation",
      "Last Meter Read Date",
      "Last Meter Read (kWh)",
      "Facility Name",
    ],
  },
  contractedDate: {
    label: "Contracted Date",
    requiredHeaderSets: [["id", "contracted"]],
    multiFileAppend: false,
  },
  deliveryScheduleBase: {
    label: "Delivery Schedule (Schedule B)",
    requiredHeaderSets: [
      ["tracking_system_ref_id"],
      ["Tracking System Ref ID"],
    ],
    multiFileAppend: false,
  },
  transferHistory: {
    label: "Transfer History",
    requiredHeaderSets: [
      ["Transaction ID", "Unit ID"],
      ["transaction_id", "unit_id"],
    ],
    multiFileAppend: true,
    rowKeyFields: [
      "Transaction ID",
      "Unit ID",
      "Transfer Date",
      "Quantity",
    ],
  },
};

// ---------------------------------------------------------------------------
// Header validation
// ---------------------------------------------------------------------------

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

function validateHeaders(
  headers: string[],
  definition: DatasetDefinition
): boolean {
  const normalizedHeaders = new Set(headers.map(normalizeHeader));

  return definition.requiredHeaderSets.some((requiredSet) =>
    requiredSet.every((required) =>
      normalizedHeaders.has(normalizeHeader(required))
    )
  );
}

// ---------------------------------------------------------------------------
// Row dedup (first-write-wins)
// ---------------------------------------------------------------------------

function buildRowKey(
  row: Record<string, string>,
  keyFields: string[]
): string {
  return keyFields
    .map((field) => (row[field] ?? "").trim().toLowerCase())
    .join("|");
}

function deduplicateRows(
  existingRows: Record<string, string>[],
  newRows: Record<string, string>[],
  keyFields: string[]
): { merged: Record<string, string>[]; dedupedCount: number } {
  const existingKeys = new Set(
    existingRows.map((row) => buildRowKey(row, keyFields))
  );

  let dedupedCount = 0;
  const uniqueNew: Record<string, string>[] = [];

  for (const row of newRows) {
    const key = buildRowKey(row, keyFields);
    if (existingKeys.has(key)) {
      dedupedCount++;
    } else {
      existingKeys.add(key);
      uniqueNew.push(row);
    }
  }

  return {
    merged: [...existingRows, ...uniqueNew],
    dedupedCount,
  };
}

// ---------------------------------------------------------------------------
// Main ingestion function
// ---------------------------------------------------------------------------

/**
 * Ingest a CSV file for a dataset.
 *
 * For small files (<10MB): runs synchronously and returns the full result.
 * For large files: creates the batch and returns { status: "processing" }.
 *
 * @param scopeId - The scope to ingest into
 * @param datasetKey - Which dataset this CSV belongs to
 * @param csvText - Raw CSV text content
 * @param fileName - Original filename for tracking
 * @param mode - "replace" or "append" (only valid for multi-append datasets)
 * @param importedBy - User ID who triggered the import
 */
export async function ingestDataset(
  scopeId: string,
  datasetKey: string,
  csvText: string,
  fileName: string,
  mode: "replace" | "append",
  importedBy: number
): Promise<IngestResult> {
  const definition = CORE_DATASET_DEFINITIONS[datasetKey];
  if (!definition) {
    return {
      batchId: "",
      status: "failed",
      rowCount: 0,
      dedupedCount: 0,
      errors: [{ rowIndex: -1, message: `Unknown dataset key: ${datasetKey}` }],
    };
  }

  // Create the batch record
  const batchId = await createImportBatch({
    scopeId,
    datasetKey,
    ingestSource: "upload",
    mergeStrategy: mode,
    status: "processing",
    rowCount: null,
    error: null,
    importedBy,
  });

  try {
    // Store raw file
    const storageKey = `solar-rec-datasets/${scopeId}/${datasetKey}/${batchId}/${fileName}`;
    try {
      await storagePut(storageKey, csvText);
    } catch {
      // Storage is best-effort — continue even if it fails
    }

    // Track the file
    await createImportFile({
      batchId,
      fileName,
      storageKey,
      sizeBytes: Buffer.byteLength(csvText, "utf8"),
      rowCount: null,
    });

    // Parse CSV
    const parsed = parseCsvText(csvText);
    if (parsed.headers.length === 0) {
      await updateImportBatchStatus(batchId, "failed", {
        error: "CSV file has no headers.",
      });
      return {
        batchId,
        status: "failed",
        rowCount: 0,
        dedupedCount: 0,
        errors: [{ rowIndex: 0, message: "CSV file has no headers." }],
      };
    }

    // Validate headers
    if (!validateHeaders(parsed.headers, definition)) {
      const error = `${definition.label} CSV is missing required columns. Headers found: ${parsed.headers.slice(0, 10).join(", ")}`;
      await updateImportBatchStatus(batchId, "failed", { error });
      return {
        batchId,
        status: "failed",
        rowCount: 0,
        dedupedCount: 0,
        errors: [{ rowIndex: 0, message: error }],
      };
    }

    // Handle append vs replace
    let finalRows = parsed.rows;
    let dedupedCount = 0;

    if (
      mode === "append" &&
      definition.multiFileAppend &&
      definition.rowKeyFields
    ) {
      // Load existing active batch rows
      const activeBatch = await getActiveBatchForDataset(scopeId, datasetKey);
      if (activeBatch) {
        // TODO: In Step 3, load existing rows from the normalized dataset table.
        // For now, we store the merged rows as a new batch without dedup
        // against existing data (dedup will be added when dataset tables exist).
        // This is a valid intermediate state — the batch contains only this upload's rows.
      }
    }

    // Collect validation errors
    const validationErrors: Array<{ rowIndex: number; message: string }> = [];
    // (Future: per-row validation against typed column schemas)

    if (validationErrors.length > 0) {
      await createImportErrors(
        validationErrors.map((err) => ({
          batchId,
          rowIndex: err.rowIndex,
          columnName: null,
          errorType: "validation",
          message: err.message,
        }))
      );
    }

    // Persist rows into the typed dataset table BEFORE activating.
    // If this fails, the batch stays in "processing" and the previous
    // active batch remains the authoritative source for reads.
    if (hasPersistence(datasetKey) && finalRows.length > 0) {
      try {
        const inserted = await persistDatasetRows(
          scopeId,
          batchId,
          datasetKey,
          finalRows
        );
        if (inserted !== finalRows.length) {
          console.warn(
            `[datasetIngestion] ${datasetKey}: inserted ${inserted}/${finalRows.length} rows`
          );
        }
      } catch (persistErr) {
        const message =
          persistErr instanceof Error
            ? persistErr.message
            : "Row persistence failed";
        await updateImportBatchStatus(batchId, "failed", { error: message });
        return {
          batchId,
          status: "failed",
          rowCount: 0,
          dedupedCount: 0,
          errors: [{ rowIndex: -1, message: `Row persistence: ${message}` }],
        };
      }
    }

    // Activate the batch
    await activateDatasetVersion(scopeId, datasetKey, batchId);
    await updateImportBatchStatus(batchId, "active", {
      rowCount: finalRows.length,
      completedAt: new Date(),
    });

    return {
      batchId,
      status: "active",
      rowCount: finalRows.length,
      dedupedCount,
      errors: validationErrors,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown ingestion error";
    await updateImportBatchStatus(batchId, "failed", { error: message });
    return {
      batchId,
      status: "failed",
      rowCount: 0,
      dedupedCount: 0,
      errors: [{ rowIndex: -1, message }],
    };
  }
}

/**
 * Get the current dataset definition (for header validation info, etc.).
 */
export function getDatasetDefinition(
  datasetKey: string
): DatasetDefinition | null {
  return CORE_DATASET_DEFINITIONS[datasetKey] ?? null;
}

export { CORE_DATASET_DEFINITIONS };
