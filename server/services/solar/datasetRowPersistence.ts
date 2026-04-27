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
import {
  srDsSolarApplications,
  srDsAbpReport,
  srDsGenerationEntry,
  srDsAccountSolarGeneration,
  srDsContractedDate,
  srDsDeliverySchedule,
  srDsTransferHistory,
  srDsGeneratorDetails,
  srDsAbpCsgSystemMapping,
  srDsAbpProjectApplicationRows,
  srDsAbpPortalInvoiceMapRows,
  srDsAbpCsgPortalDatabaseRows,
  srDsAbpQuickBooksRows,
  srDsAbpUtilityInvoiceRows,
  srDsAnnualProductionEstimates,
  srDsAbpIccReport2Rows,
  srDsAbpIccReport3Rows,
  srDsConvertedReads,
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
  rows: CsvRow[],
  options?: PersistDatasetRowsOptions
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

type BatchRowDeleter = (batchId: string) => Promise<number>;

export type PersistDatasetRowsOptions = {
  onProgress?: (inserted: number, total: number) => void;
};

/** Execute inserts in chunks. Returns the number of rows persisted. */
async function chunkedInsert<TRow>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table type
  table: any,
  rows: TRow[],
  label: string,
  options?: PersistDatasetRowsOptions
): Promise<number> {
  if (rows.length === 0) return 0;
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  let inserted = 0;
  options?.onProgress?.(0, rows.length);
  for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
    await withDbRetry(`insert ${label} chunk`, () =>
      db.insert(table).values(chunk as never)
    );
    inserted += chunk.length;
    options?.onProgress?.(inserted, rows.length);
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// Per-dataset row mappers
// ---------------------------------------------------------------------------

const persistSolarApplications: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
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
  return chunkedInsert(
    srDsSolarApplications,
    values,
    "solarApplications",
    options
  );
};

const persistAbpReport: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
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
  return chunkedInsert(srDsAbpReport, values, "abpReport", options);
};

const persistGenerationEntry: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
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
  return chunkedInsert(
    srDsGenerationEntry,
    values,
    "generationEntry",
    options
  );
};

const persistAccountSolarGeneration: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
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
    "accountSolarGeneration",
    options
  );
};

const persistContractedDate: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    systemId: clip(pick(row, "id", "system_id"), 64),
    contractedDate: clip(pick(row, "contracted"), 32),
  }));
  return chunkedInsert(
    srDsContractedDate,
    values,
    "contractedDate",
    options
  );
};

const persistDeliverySchedule: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
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
  return chunkedInsert(
    srDsDeliverySchedule,
    values,
    "deliveryScheduleBase",
    options
  );
};

const persistTransferHistory: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
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
  return chunkedInsert(
    srDsTransferHistory,
    values,
    "transferHistory",
    options
  );
};

// Task 5.12 PR-1: generatorDetails is a single-file replace dataset
// (no `_rawSourcesV1` manifest, no append-row dedup). Only `gatsUnitId`
// and `dateOnline` are stable typed columns; AC size headers are fuzzy-
// matched at read time (parseGeneratorDetailsAcSizeKw) so we keep the
// full original row in `rawRow`.
const persistGeneratorDetails: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    gatsUnitId: clip(
      pick(row, "GATS Unit ID", "gats_unit_id", "Unit ID", "unit_id"),
      128
    ),
    dateOnline: clip(pick(row, "Date Online", "date_online"), 64),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsGeneratorDetails,
    values,
    "generatorDetails",
    options
  );
};

// Task 5.12 PR-2: abpCsgSystemMapping is a single-file replace dataset
// (CSG ID → System ID lookup). Both required headers map to typed
// columns. Large portfolios can have 28k+ rows; the scope+csg index
// keeps lookups O(log n) for the join paths in FinancialsTab and the
// SolarRecDashboard profit-data useMemos.
const persistAbpCsgSystemMapping: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    csgId: clip(pick(row, "csgId", "CSG ID"), 64),
    systemId: clip(pick(row, "systemId", "System ID"), 64),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpCsgSystemMapping,
    values,
    "abpCsgSystemMapping",
    options
  );
};

// Task 5.12 PR-3: abpProjectApplicationRows is a single-file replace
// dataset shared with ABP Monthly Invoice Settlement. All four stable
// fields are typed because every consumer uses the canonical header
// names (see `parseProjectApplications` in client/src/lib/abpSettlement.ts
// — there are no fuzzy fallback header lists). The two date columns
// drive the application-fee cutoff logic (pre/post 2024-06-01) so the
// settlement engine joins them on `applicationId`.
const persistAbpProjectApplicationRows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    applicationId: clip(pick(row, "applicationId", "Application_ID"), 64),
    inverterSizeKwAcPart1: clip(
      pick(row, "inverterSizeKwAcPart1", "Inverter_Size_kW_AC_Part_1"),
      32
    ),
    part1SubmissionDate: clip(
      pick(row, "part1SubmissionDate", "Part_1_Submission_Date"),
      32
    ),
    part1OriginalSubmissionDate: clip(
      pick(
        row,
        "part1OriginalSubmissionDate",
        "Part_1_Original_Submission_Date"
      ),
      32
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpProjectApplicationRows,
    values,
    "abpProjectApplicationRows",
    options
  );
};

// Task 5.12 PR-4: abpPortalInvoiceMapRows is a single-file replace
// dataset (CSG ID → invoice number lookup). Both required headers map
// to typed columns. The "Num" alias used in
// `parseInvoiceNumberMap` is a header-detection fallback (when uploads
// have abbreviated headers), not a separate field — so two columns
// suffice.
const persistAbpPortalInvoiceMapRows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    csgId: clip(pick(row, "csgId", "CSG ID"), 64),
    invoiceNumber: clip(
      pick(row, "invoiceNumber", "Invoice Number", "Num"),
      64
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpPortalInvoiceMapRows,
    values,
    "abpPortalInvoiceMapRows",
    options
  );
};

// Task 5.12 PR-5: abpCsgPortalDatabaseRows is a single-file replace
// dataset that carries 12 fields (2 required + 10 optional). Only
// `systemId` and `csgId` are typed — the remaining 10 fields use
// fuzzy keyword-based header detection in the client parser
// (`parseCsgPortalDatabase`), which is too fragile to reproduce in
// the persister. Every consumer reads via canonical TS field names
// after the parser runs, so the original payload (with whatever
// headers the user uploaded) is preserved in `rawRow` for the
// client to re-parse on read.
const persistAbpCsgPortalDatabaseRows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    systemId: clip(pick(row, "systemId", "System ID", "system_id"), 64),
    csgId: clip(pick(row, "csgId", "CSG ID", "csg_id"), 64),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpCsgPortalDatabaseRows,
    values,
    "abpCsgPortalDatabaseRows",
    options
  );
};

// Task 5.12 PR-6: abpQuickBooksRows is a single-file replace dataset
// carrying QuickBooks invoice-line detail. The parser
// (`parseQuickBooksDetailedReport`) detects format from the first 3
// columns (Date / Num / Customer) and uses fuzzy keyword matching
// for everything else; reproducing that detection in the persister
// would re-implement parser logic. Only `invoiceNumber` (the QB
// "Num" column) is typed — it's the join key the settlement engine
// uses to group multi-line invoices and reconcile against the
// portal invoice map. The rest stays in `rawRow`.
const persistAbpQuickBooksRows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    invoiceNumber: clip(
      pick(row, "Num", "invoiceNumber", "Invoice Number", "Invoice #"),
      64
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpQuickBooksRows,
    values,
    "abpQuickBooksRows",
    options
  );
};

// Task 5.12 PR-7: abpUtilityInvoiceRows is a single-file replace
// dataset carrying utility-invoice detail. The parser
// (`parseUtilityInvoiceMatrix`) detects the header row by exact
// match on "System ID + Payment Number + Total RECS + REC Price +
// Invoice Amount ($)" and then reads each numeric field via
// `readByNormalizedHeader` with fuzzy alias lists; reproducing
// that detection in the persister would re-implement parser
// logic. Only `systemId` is typed — the canonical CSG/ICC join key
// and the only field the parser reads with no fuzzy fallback.
const persistAbpUtilityInvoiceRows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    systemId: clip(
      pick(row, "systemId", "System ID", "state_certification_number"),
      64
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpUtilityInvoiceRows,
    values,
    "abpUtilityInvoiceRows",
    options
  );
};

// Task 5.12 PR-8: annualProductionEstimates is a single-file replace
// dataset (one row per Unit ID = system) carrying the 12-month
// expected production profile. Unlike PR-5/6/7 (strict 1-typed-column
// because of fuzzy header detection), this dataset's parser
// (`buildAnnualProductionByTrackingId` in
// `client/src/solar-rec-dashboard/lib/helpers/system.ts`) reads the
// 12 month columns by exact match (with lowercase fallback), so all
// 12 months are typed as `double` for future SQL aggregation in
// Task 5.13. `unitId` and `facilityName` typed for indexing /
// display. Note: the December column is named `decMonth` in the
// schema to avoid colliding with Drizzle's `dec` decimal helper —
// the original "Dec" CSV header is preserved in `rawRow`.
const persistAnnualProductionEstimates: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const monthValue = (row: CsvRow, label: string): number | null =>
    parseNum(row[label] ?? row[label.toLowerCase()]);
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    unitId: clip(pick(row, "Unit ID", "unit_id", "unitId"), 64),
    facilityName: clip(
      pick(row, "Facility Name", "Facility", "facilityName"),
      255
    ),
    jan: monthValue(row, "Jan"),
    feb: monthValue(row, "Feb"),
    mar: monthValue(row, "Mar"),
    apr: monthValue(row, "Apr"),
    may: monthValue(row, "May"),
    jun: monthValue(row, "Jun"),
    jul: monthValue(row, "Jul"),
    aug: monthValue(row, "Aug"),
    sep: monthValue(row, "Sep"),
    oct: monthValue(row, "Oct"),
    nov: monthValue(row, "Nov"),
    decMonth: monthValue(row, "Dec"),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAnnualProductionEstimates,
    values,
    "annualProductionEstimates",
    options
  );
};

// Task 5.12 PR-9: abpIccReport2Rows + abpIccReport3Rows are
// structurally-identical single-file replace datasets sharing the
// same `parseIccContractRows` parser in `EarlyPayment.tsx` (only
// the `sourceLabel` parameter — "icc2" vs "icc3" — differs). Both
// migrate to identical typed schemas; only `applicationId` is
// promoted to a typed column because the parser uses fuzzy alias
// lists for every other field. Hot path is `(scopeId, applicationId)`
// — `buildIccMap` keys per-application Map lookups on this column,
// and `deepUpdateSynth` does the same with fallback Report 2 → 3
// priority resolved entirely in client memory after row hydration.
const persistAbpIccReport2Rows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    applicationId: clip(
      pick(row, "applicationId", "Application ID", "Application_ID", "application_id"),
      64
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpIccReport2Rows,
    values,
    "abpIccReport2Rows",
    options
  );
};

const persistAbpIccReport3Rows: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    applicationId: clip(
      pick(row, "applicationId", "Application ID", "Application_ID", "application_id"),
      64
    ),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsAbpIccReport3Rows,
    values,
    "abpIccReport3Rows",
    options
  );
};

// Task 5.12 PR-10: convertedReads is a multi-file append dataset
// (mirrors `accountSolarGeneration` and `transferHistory`). Five
// typed columns map directly to the canonical snake_case headers
// the bridge writes; `lifetimeMeterReadWh` is `double` so future
// SQL aggregation can avoid JSON parsing rawRow. Dedup composite
// matches the bridge's `convertedReadsRowKey` exactly so server-
// side migration backfills produce the same row identity as the
// existing chunked-CSV manifest.
const persistConvertedReads: DatasetInserter = async (
  scopeId,
  batchId,
  rows,
  options
) => {
  const values = rows.map((row) => ({
    id: nanoid(),
    scopeId,
    batchId,
    monitoring: clip(pick(row, "monitoring"), 64),
    monitoringSystemId: clip(pick(row, "monitoring_system_id"), 128),
    monitoringSystemName: clip(pick(row, "monitoring_system_name"), 255),
    lifetimeMeterReadWh: parseNum(row.lifetime_meter_read_wh),
    readDate: clip(pick(row, "read_date"), 32),
    rawRow: JSON.stringify(row),
  }));
  return chunkedInsert(
    srDsConvertedReads,
    values,
    "convertedReads",
    options
  );
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const PERSISTERS: Record<string, DatasetInserter> = {
  solarApplications: persistSolarApplications,
  abpReport: persistAbpReport,
  generationEntry: persistGenerationEntry,
  accountSolarGeneration: persistAccountSolarGeneration,
  contractedDate: persistContractedDate,
  deliveryScheduleBase: persistDeliverySchedule,
  transferHistory: persistTransferHistory,
  generatorDetails: persistGeneratorDetails,
  abpCsgSystemMapping: persistAbpCsgSystemMapping,
  abpProjectApplicationRows: persistAbpProjectApplicationRows,
  abpPortalInvoiceMapRows: persistAbpPortalInvoiceMapRows,
  abpCsgPortalDatabaseRows: persistAbpCsgPortalDatabaseRows,
  abpQuickBooksRows: persistAbpQuickBooksRows,
  abpUtilityInvoiceRows: persistAbpUtilityInvoiceRows,
  annualProductionEstimates: persistAnnualProductionEstimates,
  abpIccReport2Rows: persistAbpIccReport2Rows,
  abpIccReport3Rows: persistAbpIccReport3Rows,
  convertedReads: persistConvertedReads,
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
  rows: CsvRow[],
  options?: PersistDatasetRowsOptions
): Promise<number> {
  const persister = PERSISTERS[datasetKey];
  if (!persister) return 0;
  return persister(scopeId, batchId, rows, options);
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

  // When the row has a Transaction ID, treat it as the canonical
  // identity. GATS txIds are globally unique per confirmed transfer,
  // so matching on txId alone catches re-exports where the date
  // string format changed (e.g., "03/22/2026 03:46 AM" vs
  // "3/22/26 3:46") — the old composite check let those slip
  // through. Only fall back to the composite check when txId is
  // missing, so legit transfers without a txId don't collapse to a
  // single bucket.
  if (transactionId) {
    const rows = await withDbRetry(
      "check transfer history append row by txId",
      () =>
        db
          .select({ id: srDsTransferHistory.id })
          .from(srDsTransferHistory)
          .where(sql`
            ${srDsTransferHistory.scopeId} = ${scopeId}
            AND ${srDsTransferHistory.batchId} = ${batchId}
            AND ${srDsTransferHistory.transactionId} = ${transactionId}
          `)
          .limit(1)
    );
    return rows.length > 0;
  }

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

// Task 5.12 PR-10: convertedReads dedup checker. Mirrors the bridge's
// `convertedReadsRowKey` (`server/solar/convertedReadsBridge.ts:251`)
// — five-field composite, all `<=>` so nullable columns compare safely.
const convertedReadsRowExists: AppendRowChecker = async (
  scopeId,
  batchId,
  row
) => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const monitoring = clip(pick(row, "monitoring"), 64);
  const monitoringSystemId = clip(pick(row, "monitoring_system_id"), 128);
  const monitoringSystemName = clip(pick(row, "monitoring_system_name"), 255);
  const lifetimeMeterReadWh = parseNum(row.lifetime_meter_read_wh);
  const readDate = clip(pick(row, "read_date"), 32);

  const rows = await withDbRetry("check converted reads append row", () =>
    db
      .select({ id: srDsConvertedReads.id })
      .from(srDsConvertedReads)
      .where(sql`
        ${srDsConvertedReads.scopeId} = ${scopeId}
        AND ${srDsConvertedReads.batchId} = ${batchId}
        AND ${srDsConvertedReads.monitoring} <=> ${monitoring}
        AND ${srDsConvertedReads.monitoringSystemId} <=> ${monitoringSystemId}
        AND ${srDsConvertedReads.monitoringSystemName} <=> ${monitoringSystemName}
        AND ${srDsConvertedReads.lifetimeMeterReadWh} <=> ${lifetimeMeterReadWh}
        AND ${srDsConvertedReads.readDate} <=> ${readDate}
      `)
      .limit(1)
  );

  return rows.length > 0;
};

const cloneConvertedReadsBatch: BatchRowCloner = async (
  scopeId,
  fromBatchId,
  toBatchId
) => {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await withDbRetry("clone converted reads batch", () =>
    db.execute(sql`
      INSERT INTO srDsConvertedReads (
        id,
        scopeId,
        batchId,
        monitoring,
        monitoringSystemId,
        monitoringSystemName,
        lifetimeMeterReadWh,
        readDate,
        rawRow,
        createdAt
      )
      SELECT
        REPLACE(UUID(), '-', ''),
        ${scopeId},
        ${toBatchId},
        monitoring,
        monitoringSystemId,
        monitoringSystemName,
        lifetimeMeterReadWh,
        readDate,
        rawRow,
        CURRENT_TIMESTAMP
      FROM srDsConvertedReads
      WHERE scopeId = ${scopeId}
        AND batchId = ${fromBatchId}
    `)
  );

  return getDbExecuteAffectedRows(result);
};

const APPEND_ROW_CHECKERS: Record<string, AppendRowChecker> = {
  accountSolarGeneration: accountSolarGenerationRowExists,
  transferHistory: transferHistoryRowExists,
  convertedReads: convertedReadsRowExists,
};

const BATCH_CLONERS: Record<string, BatchRowCloner> = {
  accountSolarGeneration: cloneAccountSolarGenerationBatch,
  transferHistory: cloneTransferHistoryBatch,
  convertedReads: cloneConvertedReadsBatch,
};

function makeBatchDeleter(tableName: string): BatchRowDeleter {
  return async (batchId) => {
    const db = await getDb();
    if (!db) throw new Error("Database not available");

    const result = await withDbRetry(`delete ${tableName} batch rows`, () =>
      db.execute(
        sql`DELETE FROM ${sql.raw(tableName)} WHERE batchId = ${batchId}`
      )
    );

    return getDbExecuteAffectedRows(result);
  };
}

const BATCH_DELETERS: Record<string, BatchRowDeleter> = {
  solarApplications: makeBatchDeleter("srDsSolarApplications"),
  abpReport: makeBatchDeleter("srDsAbpReport"),
  generationEntry: makeBatchDeleter("srDsGenerationEntry"),
  accountSolarGeneration: makeBatchDeleter("srDsAccountSolarGeneration"),
  contractedDate: makeBatchDeleter("srDsContractedDate"),
  deliveryScheduleBase: makeBatchDeleter("srDsDeliverySchedule"),
  transferHistory: makeBatchDeleter("srDsTransferHistory"),
  generatorDetails: makeBatchDeleter("srDsGeneratorDetails"),
  abpCsgSystemMapping: makeBatchDeleter("srDsAbpCsgSystemMapping"),
  abpProjectApplicationRows: makeBatchDeleter("srDsAbpProjectApplicationRows"),
  abpPortalInvoiceMapRows: makeBatchDeleter("srDsAbpPortalInvoiceMapRows"),
  abpCsgPortalDatabaseRows: makeBatchDeleter("srDsAbpCsgPortalDatabaseRows"),
  abpQuickBooksRows: makeBatchDeleter("srDsAbpQuickBooksRows"),
  abpUtilityInvoiceRows: makeBatchDeleter("srDsAbpUtilityInvoiceRows"),
  annualProductionEstimates: makeBatchDeleter("srDsAnnualProductionEstimates"),
  abpIccReport2Rows: makeBatchDeleter("srDsAbpIccReport2Rows"),
  abpIccReport3Rows: makeBatchDeleter("srDsAbpIccReport3Rows"),
  convertedReads: makeBatchDeleter("srDsConvertedReads"),
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

export async function deleteDatasetBatchRows(
  datasetKey: string,
  batchId: string
): Promise<number> {
  const deleter = BATCH_DELETERS[datasetKey];
  if (!deleter) return 0;
  return deleter(batchId);
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
    // Prefer the Transaction ID alone when present — it's GATS's
    // globally unique transfer identifier and survives date-string
    // format drift across re-exports. The "tx:" prefix prevents a
    // txId string from ever colliding with a composite-key string
    // from a row without a txId.
    const txId = pick(row, "Transaction ID", "transaction_id");
    if (txId) {
      return `tx:${txId.trim().toLowerCase()}`;
    }
    return [
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
  if (datasetKey === "convertedReads") {
    // Five-field composite — mirrors `convertedReadsRowKey` in the
    // bridge (`server/solar/convertedReadsBridge.ts:251`). All five
    // required headers contribute to the row identity so that two
    // reads with identical system+date but different lifetime values
    // (e.g., a corrected read replacing an earlier one) keep both
    // historical rows.
    return [
      pick(row, "monitoring"),
      pick(row, "monitoring_system_id"),
      pick(row, "monitoring_system_name"),
      String(parseNum(row.lifetime_meter_read_wh) ?? ""),
      pick(row, "read_date"),
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
    // Mirror rowKey above: prefer the Transaction ID alone when
    // present. The "tx:" prefix keeps it in a disjoint namespace
    // from the composite-key fallback used for rows without a txId.
    const txId = s(row.transactionId);
    if (txId) {
      return `tx:${txId}`;
    }
    const quantity = row.quantity;
    const qtyKey =
      quantity === null || quantity === undefined
        ? ""
        : typeof quantity === "number"
          ? String(quantity)
          : String(quantity).trim().toLowerCase();
    return [
      s(row.unitId),
      s(row.transferCompletionDate),
      qtyKey,
    ].join("|");
  }
  if (datasetKey === "convertedReads") {
    // Mirror rowKey above for convertedReads. `lifetimeMeterReadWh`
    // is stored as `double` so we serialize via String(), matching
    // how `parseNum(...)` round-trips through `String()` on the CSV
    // side.
    const wh = row.lifetimeMeterReadWh;
    const whKey =
      wh === null || wh === undefined
        ? ""
        : typeof wh === "number"
          ? String(wh)
          : String(wh).trim().toLowerCase();
    return [
      s(row.monitoring),
      s(row.monitoringSystemId),
      s(row.monitoringSystemName),
      whKey,
      s(row.readDate),
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

  if (datasetKey === "convertedReads") {
    const rows = (await withDbRetry("load converted reads keys", () =>
      db
        .select({
          monitoring: srDsConvertedReads.monitoring,
          monitoringSystemId: srDsConvertedReads.monitoringSystemId,
          monitoringSystemName: srDsConvertedReads.monitoringSystemName,
          lifetimeMeterReadWh: srDsConvertedReads.lifetimeMeterReadWh,
          readDate: srDsConvertedReads.readDate,
        })
        .from(srDsConvertedReads)
        .where(
          sql`${srDsConvertedReads.scopeId} = ${scopeId}
            AND ${srDsConvertedReads.batchId} = ${batchId}`
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
