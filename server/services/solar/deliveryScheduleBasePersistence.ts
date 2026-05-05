import { buildCsvText } from "../../routers/helpers";
import {
  saveSolarRecDashboardPayload,
  upsertSolarRecDatasetSyncState,
} from "../../db";
import { storagePut } from "../../storage";
import { ingestDataset, type IngestResult } from "./datasetIngestion";

export const DELIVERY_SCHEDULE_BASE_CANONICAL_RUNNER_VERSION =
  "deliveryScheduleBase-row-canonical@1" as const;

const DELIVERY_SCHEDULE_BASE_DATASET_KEY = "deliveryScheduleBase";
const DELIVERY_SCHEDULE_BASE_STORAGE_KEY = "dataset:deliveryScheduleBase";
const REQUIRED_TRACKING_HEADER = "tracking_system_ref_id";

export type DeliveryScheduleBaseRow = Record<string, string>;

export type PersistDeliveryScheduleBaseCanonicalInput = {
  scopeId: string;
  userId: number;
  storagePath: string;
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rows: DeliveryScheduleBaseRow[];
};

export type PersistDeliveryScheduleBaseCanonicalResult = {
  finalPayload: string;
  csvText: string;
  batchId: string;
  rowCount: number;
  dedupedCount: number;
  rowTableStatus: "active";
  rowTableErrors: IngestResult["errors"];
  persistedToDatabase: boolean;
  storageSynced: boolean;
  persistError: string | null;
  storageError: string | null;
  syncStateUpdated: boolean;
  syncStateError: string | null;
  _runnerVersion: typeof DELIVERY_SCHEDULE_BASE_CANONICAL_RUNNER_VERSION;
};

export type PersistDeliveryScheduleBaseCanonicalDeps = {
  buildCsvText: typeof buildCsvText;
  ingestDataset: typeof ingestDataset;
  saveSolarRecDashboardPayload: typeof saveSolarRecDashboardPayload;
  storagePut: typeof storagePut;
  upsertSolarRecDatasetSyncState: typeof upsertSolarRecDatasetSyncState;
};

const defaultDeps: PersistDeliveryScheduleBaseCanonicalDeps = {
  buildCsvText,
  ingestDataset,
  saveSolarRecDashboardPayload,
  storagePut,
  upsertSolarRecDatasetSyncState,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeFileName(fileName: string): string {
  const normalized = fileName
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .slice(0, 255);
  return normalized || "deliveryScheduleBase.csv";
}

export function normalizeDeliveryScheduleBaseHeaders(
  headers: readonly string[],
  rows: readonly DeliveryScheduleBaseRow[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (header: unknown) => {
    const value = String(header ?? "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  push(REQUIRED_TRACKING_HEADER);
  headers.forEach(push);
  rows.forEach((row) => Object.keys(row).forEach(push));
  return out;
}

/**
 * Canonical Schedule B persistence.
 *
 * The typed srDs delivery schedule table is the source of truth for
 * dashboard tabs. The legacy cloud JSON is still written as a derived
 * compatibility artifact so older readers and diagnostics keep working.
 */
export async function persistDeliveryScheduleBaseCanonical(
  input: PersistDeliveryScheduleBaseCanonicalInput,
  deps: PersistDeliveryScheduleBaseCanonicalDeps = defaultDeps
): Promise<PersistDeliveryScheduleBaseCanonicalResult> {
  const headers = normalizeDeliveryScheduleBaseHeaders(input.headers, input.rows);
  const csvText = deps.buildCsvText(headers, input.rows);
  const fileName = normalizeFileName(input.fileName);

  const ingestResult = await deps.ingestDataset(
    input.scopeId,
    DELIVERY_SCHEDULE_BASE_DATASET_KEY,
    csvText,
    fileName,
    "replace",
    input.userId
  );
  if (ingestResult.status !== "active") {
    const reason =
      ingestResult.errors.map((error) => error.message).join("; ") ||
      "unknown row-table ingest failure";
    throw new Error(
      `deliveryScheduleBase row-table ingest failed for batch ${ingestResult.batchId || "(none)"}: ${reason}`
    );
  }

  const finalPayload = JSON.stringify({
    fileName,
    uploadedAt: input.uploadedAt,
    headers,
    csvText,
  });

  let persistedToDatabase = false;
  let persistError: string | null = null;
  try {
    persistedToDatabase = await deps.saveSolarRecDashboardPayload(
      input.userId,
      DELIVERY_SCHEDULE_BASE_STORAGE_KEY,
      finalPayload
    );
  } catch (error) {
    persistError = errorMessage(error);
  }

  let storageSynced = false;
  let storageError: string | null = null;
  try {
    await deps.storagePut(input.storagePath, finalPayload, "application/json");
    storageSynced = true;
  } catch (error) {
    storageError = errorMessage(error);
  }

  let syncStateUpdated = false;
  let syncStateError: string | null = null;
  try {
    syncStateUpdated = await deps.upsertSolarRecDatasetSyncState({
      userId: input.userId,
      storageKey: DELIVERY_SCHEDULE_BASE_STORAGE_KEY,
      payload: finalPayload,
      dbPersisted: persistedToDatabase,
      storageSynced,
    });
  } catch (error) {
    syncStateError = errorMessage(error);
  }

  return {
    finalPayload,
    csvText,
    batchId: ingestResult.batchId,
    rowCount: ingestResult.rowCount,
    dedupedCount: ingestResult.dedupedCount,
    rowTableStatus: "active",
    rowTableErrors: ingestResult.errors,
    persistedToDatabase,
    storageSynced,
    persistError,
    storageError,
    syncStateUpdated,
    syncStateError,
    _runnerVersion: DELIVERY_SCHEDULE_BASE_CANONICAL_RUNNER_VERSION,
  };
}
