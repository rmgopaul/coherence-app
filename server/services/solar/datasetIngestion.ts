/**
 * Solar REC dataset ingestion service.
 *
 * Handles CSV parsing, header validation, row dedup (first-write-wins),
 * and batch creation for the server-side dataset architecture.
 */

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
  cloneDatasetBatchRows,
} from "./datasetRowPersistence";
import {
  buildSyncProgress,
  type CoreDatasetSyncProgress,
} from "./coreDatasetSyncProgress";

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

type IngestProgressReporter = (progress: CoreDatasetSyncProgress) => void;

// ---------------------------------------------------------------------------
// Dataset definitions (server-side mirror of client DATASET_DEFINITIONS)
// 7 + 7 datasets so far (Task 5.12 PRs 1–7 added generatorDetails,
// abpCsgSystemMapping, abpProjectApplicationRows, abpPortalInvoiceMapRows,
// abpCsgPortalDatabaseRows, abpQuickBooksRows, and
// abpUtilityInvoiceRows). Extend as the remaining 5 non-row-backed
// datasets migrate.
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
  generatorDetails: {
    label: "Generator Details",
    requiredHeaderSets: [
      ["GATS Unit ID", "Date Online"],
      ["gats_unit_id", "date_online"],
    ],
    multiFileAppend: false,
  },
  abpCsgSystemMapping: {
    label: "ABP CSG-System Mapping",
    requiredHeaderSets: [
      ["csgId", "systemId"],
      ["CSG ID", "System ID"],
    ],
    multiFileAppend: false,
  },
  abpProjectApplicationRows: {
    label: "ABP ProjectApplication Rows",
    requiredHeaderSets: [
      ["applicationId", "inverterSizeKwAcPart1"],
      ["Application_ID", "Inverter_Size_kW_AC_Part_1"],
    ],
    multiFileAppend: false,
  },
  abpPortalInvoiceMapRows: {
    label: "ABP Portal Invoice Map Rows",
    requiredHeaderSets: [
      ["csgId", "invoiceNumber"],
      ["CSG ID", "Invoice Number"],
    ],
    multiFileAppend: false,
  },
  abpCsgPortalDatabaseRows: {
    label: "ABP CSG Portal Database Rows",
    requiredHeaderSets: [
      ["systemId", "installerName"],
      ["System ID", "Installer"],
    ],
    multiFileAppend: false,
  },
  abpQuickBooksRows: {
    label: "ABP QuickBooks Rows",
    requiredHeaderSets: [
      ["invoiceNumber", "lineAmount", "description"],
      ["Date", "Num", "Customer", "Product/service description"],
    ],
    multiFileAppend: false,
  },
  abpUtilityInvoiceRows: {
    label: "ABP Utility Invoice Rows",
    requiredHeaderSets: [
      ["systemId", "paymentNumber", "recQuantity", "recPrice", "invoiceAmount"],
      [
        "System ID",
        "Payment Number",
        "Total RECS",
        "REC Price",
        "Invoice Amount ($)",
      ],
    ],
    multiFileAppend: false,
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
// Row dedup (first-write-wins) — key builder lives in
// datasetRowPersistence.ts alongside the bulk key-set loader so the
// upload-side key and the DB-side key stay defined in one place.
// ---------------------------------------------------------------------------

async function filterAppendRows(
  scopeId: string,
  batchId: string | null,
  datasetKey: string,
  newRows: Record<string, string>[],
  _keyFields: string[]
): Promise<{ rows: Record<string, string>[]; dedupedCount: number }> {
  // Load every existing dedupe key from the target batch in ONE
  // query, then do all comparisons in memory. Previous approach did
  // N serial SELECTs (one per upload row) which put the request
  // over Render's 100s proxy timeout on 500k+ row uploads.
  //
  // When batchId is null (no previous active batch to clone from
  // or first-time ingest), the existing set is empty and we only
  // dedupe within the upload itself.
  const { loadExistingRowKeys, partitionAppendRowsByKeySet } = await import(
    "./datasetRowPersistence"
  );
  const existingKeys = batchId
    ? await loadExistingRowKeys(scopeId, batchId, datasetKey)
    : new Set<string>();

  const { toInsert, dedupedCount } = partitionAppendRowsByKeySet(
    datasetKey,
    newRows,
    existingKeys
  );
  return { rows: toInsert, dedupedCount };
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
  importedBy: number,
  reportProgress?: IngestProgressReporter
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
    reportProgress?.(
      buildSyncProgress({
        phase: "parsing_csv",
        startPercent: 15,
        endPercent: 25,
        current: 0,
        total: 1,
        unitLabel: "steps",
        message: "Parsing CSV",
      })
    );
    const parsed = parseCsvText(csvText);
    reportProgress?.(
      buildSyncProgress({
        phase: "parsing_csv",
        startPercent: 15,
        endPercent: 25,
        current: 1,
        total: 1,
        unitLabel: "steps",
        message: "Parsing CSV",
      })
    );
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
    let rowsToPersist = parsed.rows;
    let dedupedCount = 0;
    let totalRowCount = parsed.rows.length;

    if (
      mode === "append" &&
      definition.multiFileAppend &&
      definition.rowKeyFields
    ) {
      reportProgress?.(
        buildSyncProgress({
          phase: "filtering_duplicates",
          startPercent: 25,
          endPercent: 40,
          current: 0,
          total: 1,
          unitLabel: "steps",
          message: "Filtering duplicate rows",
        })
      );
      const activeBatch = await getActiveBatchForDataset(scopeId, datasetKey);
      if (activeBatch) {
        const clonedRowCount = await cloneDatasetBatchRows(
          scopeId,
          activeBatch.id,
          batchId,
          datasetKey
        );
        const filtered = await filterAppendRows(
          scopeId,
          batchId,
          datasetKey,
          parsed.rows,
          definition.rowKeyFields
        );
        rowsToPersist = filtered.rows;
        dedupedCount = filtered.dedupedCount;
        totalRowCount = clonedRowCount + rowsToPersist.length;
      } else {
        const filtered = await filterAppendRows(
          scopeId,
          null,
          datasetKey,
          parsed.rows,
          definition.rowKeyFields
        );
        rowsToPersist = filtered.rows;
        dedupedCount = filtered.dedupedCount;
        totalRowCount = rowsToPersist.length;
      }
      reportProgress?.(
        buildSyncProgress({
          phase: "filtering_duplicates",
          startPercent: 25,
          endPercent: 40,
          current: 1,
          total: 1,
          unitLabel: "steps",
          message: "Filtering duplicate rows",
        })
      );
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
    if (hasPersistence(datasetKey) && rowsToPersist.length > 0) {
      try {
        reportProgress?.(
          buildSyncProgress({
            phase: "persisting_rows",
            startPercent: 40,
            endPercent: 92,
            current: 0,
            total: rowsToPersist.length,
            unitLabel: "rows",
            message: "Persisting rows to database",
          })
        );
        const inserted = await persistDatasetRows(
          scopeId,
          batchId,
          datasetKey,
          rowsToPersist,
          {
            onProgress: (insertedCount, totalCount) => {
              reportProgress?.(
                buildSyncProgress({
                  phase: "persisting_rows",
                  startPercent: 40,
                  endPercent: 92,
                  current: insertedCount,
                  total: totalCount,
                  unitLabel: "rows",
                  message: "Persisting rows to database",
                })
              );
            },
          }
        );
        if (inserted !== rowsToPersist.length) {
          console.warn(
            `[datasetIngestion] ${datasetKey}: inserted ${inserted}/${rowsToPersist.length} rows`
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

    // Atomically promote the new batch so the active pointer, row count,
    // and batch statuses never diverge across a mid-request crash.
    reportProgress?.(
      buildSyncProgress({
        phase: "activating_batch",
        startPercent: 92,
        endPercent: 99,
        current: 0,
        total: 1,
        unitLabel: "steps",
        message: "Activating new dataset batch",
      })
    );
    await activateDatasetVersion(scopeId, datasetKey, batchId, {
      rowCount: totalRowCount,
      completedAt: new Date(),
    });
    reportProgress?.(
      buildSyncProgress({
        phase: "activating_batch",
        startPercent: 92,
        endPercent: 99,
        current: 1,
        total: 1,
        unitLabel: "steps",
        message: "Activating new dataset batch",
      })
    );

    return {
      batchId,
      status: "active",
      rowCount: totalRowCount,
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
