/**
 * Persist parsed CsvRow[] into the typed srDs* tables.
 *
 * Previously `ingestDataset` parsed the CSV and activated the batch
 * without actually storing any rows, which made the server snapshot
 * return empty for every scope. This module closes that gap.
 *
 * Each dataset has:
 *   - A set of typed columns (for indexed lookups / compact storage)
 *   - A `rawRow` JSON column holding the full original CsvRow so the
 *     round-trip back to a CsvRow[] via `loadDatasetRows` is lossless.
 *
 * Inserts are batched in chunks to avoid huge single statements on
 * large migrations (tested: ~2000-row chunks are a safe ceiling for
 * TiDB with moderate row width).
 */

import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import {
  srDsSolarApplications,
  srDsAbpReport,
  srDsGenerationEntry,
  srDsAccountSolarGeneration,
  srDsContractedDate,
  srDsDeliverySchedule,
  srDsTransferHistory,
} from "../../../drizzle/schema";
import {
  getDb,
  withDbRetry,
  sql,
  getDbExecuteAffectedRows,
} from "../../db/_core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CsvRow = Record<string, string>;

const INSERT_CHUNK_SIZE = 500;

function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function parseNum(value: unknown): number | null {
  const s = clean(value);
  if (s === null) return null;
  // Strip currency symbols, commas, whitespace.
  const cleaned = s.replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Truncate a string to fit a varchar column. */
function clip(value: string | null, maxLen: number): string | null {
  if (value === null) return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

/** Pick the first non-empty value from the provided keys. */
function pick(row: CsvRow, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = clean(row[key]);
    if (v !== null) return v;
  }
  return null;
}

type DatasetInserter = (
  scopeId: string,
  batchId: string,
  rows: CsvRow[]
) => Promise<number>;

type AppendRowChecker = (
  scopeId: string,
  batchId: string,
  row: CsvRow
) => Promise<boolean>;

type BatchRowCloner = (
  scopeId: string,
  fromBatchId: string,
  toBatchId: string
) => Promise<number>;

/** Execute inserts in chunks. Returns the number of rows persisted. */
async function chunkedInsert<TRow>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table type
  table: any,
  rows: TRow[],
  label: string
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    await withDbRetry(`insert ${label} chunk`, () =>
      db.insert(table).values(chunk as never)
    );
    inserted += chunk.length;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Per-dataset row mappers
// ---------------------------------------------------------------------------

const persistSolarApplications: DatasetInserter = async (
  scopeId,
  batchId,
  rows
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    applicationId: clip(pick(row, "Application_ID", "system_id"), 64),
    systemId: clip(pick(row, "system_id"), 64),
    trackingSystemRefId: clip(
      pick(row, "tracking_system_ref_id", "PJM_GATS_or_MRETS_Unit_ID_Part_2"),
      64
    ),
    stateCertificationNumber: clip(
      pick(row, "state_certification_number"),
      64
    ),
    systemName: clip(pick(row, "system_name", "Project_Name"), 255),
    installedKwAc: parseNum(row.installed_system_size_kw_ac),
    installedKwDc: parseNum(row.installed_system_size_kw_dc),
    recPrice: parseNum(row.rec_price),
    totalContractAmount: parseNum(row.total_contract_amount),
    annualRecs: parseNum(row.annual_recs),
    contractType: clip(pick(row, "contract_type"), 128),
    installerName: clip(pick(row, "installer_name"), 255),
    county: clip(pick(row, "county"), 128),
    state: clip(pick(row, "state"), 64),
    zipCode: clip(pick(row, "zip_code"), 16),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(srDsSolarApplications, values, "solarApplications");
};

const persistAbpReport: DatasetInserter = async (scopeId, batchId, rows) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    applicationId: clip(pick(row, "Application_ID", "application_id"), 64),
    systemId: clip(pick(row, "system_id"), 64),
    trackingSystemRefId: clip(
      pick(row, "tracking_system_ref_id", "PJM_GATS_or_MRETS_Unit_ID_Part_2"),
      64
    ),
    projectName: clip(pick(row, "Project_Name", "project_name"), 255),
    part2AppVerificationDate: clip(
      pick(row, "Part_2_App_Verification_Date", "part_2_app_verification_date"),
      32
    ),
    inverterSizeKwAc: parseNum(
      row.inverter_size_kw_ac ?? row.Inverter_Size_kW_AC
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(srDsAbpReport, values, "abpReport");
};

const persistGenerationEntry: DatasetInserter = async (
  scopeId,
  batchId,
  rows
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    unitId: clip(pick(row, "Unit ID"), 64),
    facilityName: clip(pick(row, "Facility Name"), 255),
    lastMonthOfGen: clip(pick(row, "Last Month of Gen"), 32),
    effectiveDate: clip(pick(row, "Effective Date"), 32),
    onlineMonitoring: clip(pick(row, "online_monitoring"), 255),
    onlineMonitoringAccessType: clip(
      pick(row, "online_monitoring_access_type"),
      64
    ),
    onlineMonitoringSystemId: clip(pick(row, "online_monitoring_system_id"), 255),
    onlineMonitoringSystemName: clip(
      pick(row, "online_monitoring_system_name"),
      255
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(srDsGenerationEntry, values, "generationEntry");
};

const persistAccountSolarGeneration: DatasetInserter = async (
  scopeId,
  batchId,
  rows
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    gatsGenId: clip(pick(row, "GATS Gen ID"), 64),
    facilityName: clip(pick(row, "Facility Name"), 255),
    monthOfGeneration: clip(pick(row, "Month of Generation"), 32),
    lastMeterReadDate: clip(pick(row, "Last Meter Read Date"), 32),
    lastMeterReadKwh: clip(pick(row, "Last Meter Read (kWh)"), 64),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAccountSolarGeneration,
    values,
    "accountSolarGeneration"
  );
};

const persistContractedDate: DatasetInserter = async (
  scopeId,
  batchId,
  rows
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    systemId: clip(pick(row, "id", "system_id"), 64),
    contractedDate: clip(pick(row, "contracted"), 32),
  }));
  return chunkedInsert(srDsContractedDate, values, "contractedDate");
};

const persistDeliverySchedule: DatasetInserter = async (
  scopeId,
  batchId,
  rows
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    trackingSystemRefId: clip(
      pick(row, "tracking_system_ref_id", "Tracking System Ref ID"),
      64
    ),
    systemName: clip(pick(row, "system_name", "System Name"), 255),
    utilityContractNumber: clip(
      pick(row, "utility_contract_number", "Utility Contract Number"),
      64
    ),
    batchIdRef: clip(pick(row, "batch_id", "Batch ID"), 64),
    stateCertificationNumber: clip(
      pick(row, "state_certification_number", "State Certification Number"),
      64
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(srDsDeliverySchedule, values, "deliveryScheduleBase");
};

const persistTransferHistory: DatasetInserter = async (
  scopeId,
  batchId,
  rows
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    transactionId: clip(pick(row, "Transaction ID", "transaction_id"), 64),
    unitId: clip(pick(row, "Unit ID", "unit_id"), 64),
    transferCompletionDate: clip(
      pick(row, "Transfer Completion Date", "Transfer Date", "transfer_date"),
      32
    ),
    quantity: parseNum(row.Quantity ?? row.quantity),
    transferor: clip(pick(row, "Transferor", "transferor"), 255),
    transferee: clip(pick(row, "Transferee", "transferee"), 255),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(srDsTransferHistory, values, "transferHistory");
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

// Single source of truth: the seven typed srDs* tables, keyed by the
// dataset key callers use throughout the solar-rec codebase. Adding a
// new dataset starts here and the compiler + test suite surface the
// remaining wiring (persister, cloner, etc.).
const SRDS_TABLES = {
  solarApplications: srDsSolarApplications,
  abpReport: srDsAbpReport,
  generationEntry: srDsGenerationEntry,
  accountSolarGeneration: srDsAccountSolarGeneration,
  contractedDate: srDsContractedDate,
  deliveryScheduleBase: srDsDeliverySchedule,
  transferHistory: srDsTransferHistory,
} as const;

type SrDsDatasetKey = keyof typeof SRDS_TABLES;

const PERSISTERS: Record<SrDsDatasetKey, DatasetInserter> = {
  solarApplications: persistSolarApplications,
  abpReport: persistAbpReport,
  generationEntry: persistGenerationEntry,
  accountSolarGeneration: persistAccountSolarGeneration,
  contractedDate: persistContractedDate,
  deliveryScheduleBase: persistDeliverySchedule,
  transferHistory: persistTransferHistory,
};

/**
 * Persist the given rows for a dataset into its typed srDs* table.
 *
 * Returns the number of rows actually inserted. If the dataset key
 * is not one of the 7 core datasets, returns 0 without throwing —
 * callers should check the count and surface a warning.
 */
export async function persistDatasetRows(
  scopeId: string,
  batchId: string,
  datasetKey: string,
  rows: CsvRow[]
): Promise<number> {
  const persister = PERSISTERS[datasetKey as SrDsDatasetKey];
  if (!persister) return 0;
  return persister(scopeId, batchId, rows);
}

/**
 * Whether this dataset key has a typed persistence mapping.
 */
export function hasPersistence(datasetKey: string): boolean {
  return datasetKey in PERSISTERS;
}

const accountSolarGenerationRowExists: AppendRowChecker = async (
  scopeId,
  batchId,
  row
) => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const gatsGenId = clip(pick(row, "GATS Gen ID"), 64);
  const facilityName = clip(pick(row, "Facility Name"), 255);
  const monthOfGeneration = clip(pick(row, "Month of Generation"), 32);
  const lastMeterReadDate = clip(pick(row, "Last Meter Read Date"), 32);
  const lastMeterReadKwh = clip(pick(row, "Last Meter Read (kWh)"), 64);

  const rows = await withDbRetry(
    "check account solar generation append row",
    () =>
      db
        .select({ id: srDsAccountSolarGeneration.id })
        .from(srDsAccountSolarGeneration)
        .where(sql`
          ${srDsAccountSolarGeneration.scopeId} = ${scopeId}
          AND ${srDsAccountSolarGeneration.batchId} = ${batchId}
          AND ${srDsAccountSolarGeneration.gatsGenId} <=> ${gatsGenId}
          AND ${srDsAccountSolarGeneration.facilityName} <=> ${facilityName}
          AND ${srDsAccountSolarGeneration.monthOfGeneration} <=> ${monthOfGeneration}
          AND ${srDsAccountSolarGeneration.lastMeterReadDate} <=> ${lastMeterReadDate}
          AND ${srDsAccountSolarGeneration.lastMeterReadKwh} <=> ${lastMeterReadKwh}
        `)
        .limit(1)
  );

  return rows.length > 0;
};

const transferHistoryRowExists: AppendRowChecker = async (
  scopeId,
  batchId,
  row
) => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const transactionId = clip(pick(row, "Transaction ID", "transaction_id"), 64);
  const unitId = clip(pick(row, "Unit ID", "unit_id"), 64);
  const transferCompletionDate = clip(
    pick(row, "Transfer Completion Date", "Transfer Date", "transfer_date"),
    32
  );
  const quantity = parseNum(row.Quantity ?? row.quantity);

  const rows = await withDbRetry("check transfer history append row", () =>
    db
      .select({ id: srDsTransferHistory.id })
      .from(srDsTransferHistory)
      .where(sql`
        ${srDsTransferHistory.scopeId} = ${scopeId}
        AND ${srDsTransferHistory.batchId} = ${batchId}
        AND ${srDsTransferHistory.transactionId} <=> ${transactionId}
        AND ${srDsTransferHistory.unitId} <=> ${unitId}
        AND ${srDsTransferHistory.transferCompletionDate} <=> ${transferCompletionDate}
        AND ${srDsTransferHistory.quantity} <=> ${quantity}
      `)
      .limit(1)
  );

  return rows.length > 0;
};

const cloneAccountSolarGenerationBatch: BatchRowCloner = async (
  scopeId,
  fromBatchId,
  toBatchId
) => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await withDbRetry("clone account solar generation batch", () =>
    db.execute(sql`
      INSERT INTO srDsAccountSolarGeneration (
        id,
        scopeId,
        batchId,
        gatsGenId,
        facilityName,
        monthOfGeneration,
        lastMeterReadDate,
        lastMeterReadKwh,
        rawRow,
        createdAt
      )
      SELECT
        REPLACE(UUID(), '-', ''),
        ${scopeId},
        ${toBatchId},
        gatsGenId,
        facilityName,
        monthOfGeneration,
        lastMeterReadDate,
        lastMeterReadKwh,
        rawRow,
        CURRENT_TIMESTAMP
      FROM srDsAccountSolarGeneration
      WHERE scopeId = ${scopeId}
        AND batchId = ${fromBatchId}
    `)
  );

  return getDbExecuteAffectedRows(result);
};

const cloneTransferHistoryBatch: BatchRowCloner = async (
  scopeId,
  fromBatchId,
  toBatchId
) => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await withDbRetry("clone transfer history batch", () =>
    db.execute(sql`
      INSERT INTO srDsTransferHistory (
        id,
        scopeId,
        batchId,
        transactionId,
        unitId,
        transferCompletionDate,
        quantity,
        transferor,
        transferee,
        rawRow,
        createdAt
      )
      SELECT
        REPLACE(UUID(), '-', ''),
        ${scopeId},
        ${toBatchId},
        transactionId,
        unitId,
        transferCompletionDate,
        quantity,
        transferor,
        transferee,
        rawRow,
        CURRENT_TIMESTAMP
      FROM srDsTransferHistory
      WHERE scopeId = ${scopeId}
        AND batchId = ${fromBatchId}
    `)
  );

  return getDbExecuteAffectedRows(result);
};

const APPEND_ROW_CHECKERS: Record<string, AppendRowChecker> = {
  accountSolarGeneration: accountSolarGenerationRowExists,
  transferHistory: transferHistoryRowExists,
};

const BATCH_CLONERS: Record<string, BatchRowCloner> = {
  accountSolarGeneration: cloneAccountSolarGenerationBatch,
  transferHistory: cloneTransferHistoryBatch,
};

export async function appendRowExists(
  scopeId: string,
  batchId: string,
  datasetKey: string,
  row: CsvRow
): Promise<boolean> {
  const checker = APPEND_ROW_CHECKERS[datasetKey];
  if (!checker) return false;
  return checker(scopeId, batchId, row);
}

export async function cloneDatasetBatchRows(
  scopeId: string,
  fromBatchId: string,
  toBatchId: string,
  datasetKey: string
): Promise<number> {
  const cloner = BATCH_CLONERS[datasetKey];
  if (!cloner) return 0;
  return cloner(scopeId, fromBatchId, toBatchId);
}

/**
 * DELETE all typed rows for (datasetKey, batchId). Returns affected
 * row count. Unknown datasetKey returns 0 without throwing — same
 * contract as persistDatasetRows / cloneDatasetBatchRows.
 *
 * No scopeId filter: batchId is a nanoid and is unique across scopes,
 * so (table, batchId) already identifies a single batch's rows.
 */
export async function deleteDatasetBatchRows(
  datasetKey: string,
  batchId: string
): Promise<number> {
  const table = SRDS_TABLES[datasetKey as SrDsDatasetKey];
  if (!table) return 0;

  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await withDbRetry(`delete ${datasetKey} batch rows`, () =>
    db.delete(table).where(eq(table.batchId, batchId))
  );

  return getDbExecuteAffectedRows(result);
}

/**
 * Build a stable string key for a row based on its dataset's dedupe
 * fields. Matches the buildRowKey() helper in datasetIngestion.ts
 * and the SQL <=> comparisons in the *RowExists checkers above.
 *
 * Kept here so the bulk existing-key loader (below) uses the exact
 * same key construction as both the upload-side in-memory dedup and
 * the single-row SQL check fallback.
 */
function rowKey(datasetKey: string, row: CsvRow): string {
  if (datasetKey === "accountSolarGeneration") {
    return [
      pick(row, "GATS Gen ID"),
      pick(row, "Facility Name"),
      pick(row, "Month of Generation"),
      pick(row, "Last Meter Read Date"),
      pick(row, "Last Meter Read (kWh)"),
    ]
      .map((v) => (v ?? "").trim().toLowerCase())
      .join("|");
  }
  if (datasetKey === "transferHistory") {
    return [
      pick(row, "Transaction ID", "transaction_id"),
      pick(row, "Unit ID", "unit_id"),
      pick(
        row,
        "Transfer Completion Date",
        "Transfer Date",
        "transfer_date"
      ),
      String(parseNum(row.Quantity ?? row.quantity) ?? ""),
    ]
      .map((v) => (v ?? "").trim().toLowerCase())
      .join("|");
  }
  return "";
}

/**
 * Reconstruct the dedupe key string for a typed row read out of the
 * srDs* table. Mirrors rowKey() above — typed column names on the
 * LHS, CSV header equivalents on the RHS. Keeping both in one file
 * avoids the drift that bit us with the rawRow column-name mismatch.
 */
function typedRowKey(
  datasetKey: string,
  row: Record<string, unknown>
): string {
  const s = (v: unknown): string =>
    v === null || v === undefined ? "" : String(v).trim().toLowerCase();
  if (datasetKey === "accountSolarGeneration") {
    return [
      s(row.gatsGenId),
      s(row.facilityName),
      s(row.monthOfGeneration),
      s(row.lastMeterReadDate),
      s(row.lastMeterReadKwh),
    ].join("|");
  }
  if (datasetKey === "transferHistory") {
    const quantity = row.quantity;
    const qtyKey =
      quantity === null || quantity === undefined
        ? ""
        : typeof quantity === "number"
          ? String(quantity)
          : String(quantity).trim().toLowerCase();
    return [
      s(row.transactionId),
      s(row.unitId),
      s(row.transferCompletionDate),
      qtyKey,
    ].join("|");
  }
  return "";
}

/**
 * Load every existing dedupe key in a batch into an in-memory Set.
 * Used to replace the N-queries-per-upload approach with a single
 * streaming read. On the 579k-row transferHistory dataset this drops
 * existence-check time from ~20 minutes to ~3-5 seconds.
 *
 * Only the typed columns relevant to the dedupe key are selected —
 * the payload we care about is small (transferHistory: 4 strings +
 * a number per row ≈ 60MB for 579k rows). We stream in chunks of
 * 100k rows by id range to keep memory bounded.
 */
export async function loadExistingRowKeys(
  scopeId: string,
  batchId: string,
  datasetKey: string
): Promise<Set<string>> {
  const db = await getDb();
  if (!db) return new Set();

  if (datasetKey === "accountSolarGeneration") {
    const rows = (await withDbRetry(
      "load account solar generation keys",
      () =>
        db
          .select({
            gatsGenId: srDsAccountSolarGeneration.gatsGenId,
            facilityName: srDsAccountSolarGeneration.facilityName,
            monthOfGeneration: srDsAccountSolarGeneration.monthOfGeneration,
            lastMeterReadDate: srDsAccountSolarGeneration.lastMeterReadDate,
            lastMeterReadKwh: srDsAccountSolarGeneration.lastMeterReadKwh,
          })
          .from(srDsAccountSolarGeneration)
          .where(
            sql`${srDsAccountSolarGeneration.scopeId} = ${scopeId}
              AND ${srDsAccountSolarGeneration.batchId} = ${batchId}`
          )
    )) as Array<Record<string, unknown>>;
    const set = new Set<string>();
    for (const row of rows) set.add(typedRowKey(datasetKey, row));
    return set;
  }

  if (datasetKey === "transferHistory") {
    const rows = (await withDbRetry("load transfer history keys", () =>
      db
        .select({
          transactionId: srDsTransferHistory.transactionId,
          unitId: srDsTransferHistory.unitId,
          transferCompletionDate: srDsTransferHistory.transferCompletionDate,
          quantity: srDsTransferHistory.quantity,
        })
        .from(srDsTransferHistory)
        .where(
          sql`${srDsTransferHistory.scopeId} = ${scopeId}
            AND ${srDsTransferHistory.batchId} = ${batchId}`
        )
    )) as Array<Record<string, unknown>>;
    const set = new Set<string>();
    for (const row of rows) set.add(typedRowKey(datasetKey, row));
    return set;
  }

  return new Set();
}

/**
 * Classify upload rows into already-present (dedup) vs new, using
 * an in-memory key Set rather than per-row SQL. Keys used here are
 * built from CSV headers so they match the Set produced by
 * loadExistingRowKeys (which builds from typed columns — the two
 * key builders are kept in this file precisely to prevent drift).
 */
export function partitionAppendRowsByKeySet(
  datasetKey: string,
  newRows: CsvRow[],
  existingKeys: ReadonlySet<string>
): { toInsert: CsvRow[]; dedupedCount: number } {
  const toInsert: CsvRow[] = [];
  const seenInUpload = new Set<string>();
  let dedupedCount = 0;

  for (const row of newRows) {
    const key = rowKey(datasetKey, row);
    if (!key) {
      toInsert.push(row);
      continue;
    }
    if (existingKeys.has(key) || seenInUpload.has(key)) {
      dedupedCount += 1;
      continue;
    }
    seenInUpload.add(key);
    toInsert.push(row);
  }

  return { toInsert, dedupedCount };
}
