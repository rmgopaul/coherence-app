/**
 * Per-dataset parser registry — Phase 4 expansion.
 *
 * Phase 1 shipped one parser (`contractedDate`) as a proof-of-
 * concept. Phase 4 fills the registry for the remaining 16
 * dataset keys that support CSV upload. `deliveryScheduleBase`
 * stays null — it's populated by the Schedule B PDF scanner on
 * the Delivery Tracker tab, not a direct CSV upload.
 *
 * Every srDs* row table follows the same shape (typed primary
 * columns + `rawRow` JSON of the full source row), so the
 * parsers all share the helper layer below: pickField for
 * header-alias resolution, pickNumber for typed coercion,
 * buildBaseInsert for the auto-fields.
 *
 * No DOM, no network — pure data shaping over already-parsed CSV
 * rows. Each parser is exported as a const so tests can target
 * it directly without going through `getDatasetParser`.
 */

import { nanoid } from "nanoid";
import {
  srDsAbpCsgPortalDatabaseRows,
  srDsAbpCsgSystemMapping,
  srDsAbpIccReport2Rows,
  srDsAbpIccReport3Rows,
  srDsAbpPortalInvoiceMapRows,
  srDsAbpProjectApplicationRows,
  srDsAbpQuickBooksRows,
  srDsAbpReport,
  srDsAbpUtilityInvoiceRows,
  srDsAccountSolarGeneration,
  srDsAnnualProductionEstimates,
  srDsContractedDate,
  srDsConvertedReads,
  srDsGenerationEntry,
  srDsGeneratorDetails,
  srDsSolarApplications,
  srDsTransferHistory,
  type InsertSrDsAbpCsgPortalDatabaseRows,
  type InsertSrDsAbpCsgSystemMapping,
  type InsertSrDsAbpIccReport2Rows,
  type InsertSrDsAbpIccReport3Rows,
  type InsertSrDsAbpPortalInvoiceMapRows,
  type InsertSrDsAbpProjectApplicationRows,
  type InsertSrDsAbpQuickBooksRows,
  type InsertSrDsAbpReport,
  type InsertSrDsAbpUtilityInvoiceRows,
  type InsertSrDsAccountSolarGeneration,
  type InsertSrDsAnnualProductionEstimates,
  type InsertSrDsContractedDate,
  type InsertSrDsConvertedReads,
  type InsertSrDsGenerationEntry,
  type InsertSrDsGeneratorDetails,
  type InsertSrDsSolarApplication,
  type InsertSrDsTransferHistory,
} from "../../../drizzle/schemas/solar";
import {
  isDatasetKey,
  type DatasetKey,
} from "../../../shared/datasetUpload.helpers";

/** Per-row context that every parser receives. */
export interface DatasetParseContext {
  scopeId: string;
  batchId: string;
  /** Zero-based row index in the source CSV (header excluded). */
  rowIndex: number;
}

/**
 * A single row's outcome. Returning `null` means "skip this row
 * silently" (e.g., it's a blank line or a header repetition).
 * Throwing means "this is a parse error" — the runner catches it,
 * logs to `datasetUploadJobErrors`, and continues.
 */
export type DatasetUploadParser<TInsert> = {
  table: { _: { name: string } };
  parseRow(
    rawRow: Record<string, string>,
    ctx: DatasetParseContext
  ): TInsert | null;
};

// ── Header-alias resolution ────────────────────────────────────────

/**
 * Strip all separators (underscores, spaces, hyphens) and lowercase
 * for header comparison. Treats `Part_2_App_Verification_Date`,
 * `Part 2 App Verification Date`, `part-2-app-verification-date`,
 * and `part2AppVerificationDate` as the same key.
 *
 * Why: production CSVs from CSG, GATS, ABP, and Zillow use a mix of
 * snake_case_with_underscores (Solar Applications, ABP Report) and
 * "Title Case With Spaces" (Generation Entry, Transfer History).
 * Per-parser alias chains have repeatedly missed one form or the
 * other and silently dropped data into rawRow without populating
 * typed columns. Normalizing once at the lookup site makes the
 * alias chain a list of *concepts* rather than a list of every
 * possible CSV header spelling.
 */
function normalizeHeaderKey(s: string): string {
  return s.toLowerCase().replace(/[_\s\-]+/g, "");
}

/**
 * Look up `aliases[i]` in `row`, returning the first non-empty
 * trimmed value found. Comparison is case-insensitive AND
 * separator-insensitive — `_`, space, and `-` are all stripped, so
 * `Part_2_App_Verification_Date` matches alias
 * `"Part 2 App Verification Date"`. Returns null when no alias
 * matches or every match is empty.
 */
export function pickField(
  row: Record<string, string>,
  aliases: readonly string[]
): string | null {
  for (const alias of aliases) {
    const direct = row[alias];
    if (direct != null) {
      const trimmed = String(direct).trim();
      if (trimmed.length > 0) return trimmed;
    }
    const normalizedAlias = normalizeHeaderKey(alias);
    for (const key of Object.keys(row)) {
      if (normalizeHeaderKey(key) !== normalizedAlias) continue;
      const trimmed = String(row[key] ?? "").trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

/**
 * Pick a numeric field. Strips currency / whitespace / comma
 * formatting so "$1,234.56" → 1234.56. Returns `null` when no
 * alias matches OR when the matched value isn't a finite number.
 *
 * Pure — exposed for testability. The runner doesn't treat a
 * non-numeric value as an error; the typed column just lands
 * null and the original string survives in `rawRow` for forensics.
 */
export function pickNumber(
  row: Record<string, string>,
  aliases: readonly string[]
): number | null {
  const raw = pickField(row, aliases);
  if (raw == null) return null;
  // Strip $ , and surrounding whitespace; preserve the decimal
  // and the leading minus.
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Common scaffolding for every parsed Insert: id + scope/batch
 * keys + the original row stringified for forensics. Returns a
 * partial typed shape so each parser narrows it via spread.
 */
export function buildBaseInsert(
  rawRow: Record<string, string>,
  ctx: DatasetParseContext
): {
  id: string;
  scopeId: string;
  batchId: string;
  rawRow: string;
  createdAt: Date;
} {
  return {
    id: nanoid(),
    scopeId: ctx.scopeId,
    batchId: ctx.batchId,
    rawRow: JSON.stringify(rawRow),
    createdAt: new Date(),
  };
}

// Common alias chains reused across parsers. Defined once so a
// future header rename only needs editing in one place.
const APPLICATION_ID = [
  "applicationId",
  "Application ID",
  "ApplicationId",
  "application_id",
  "App ID",
] as const;
const SYSTEM_ID = ["systemId", "System ID", "system_id", "id"] as const;
const TRACKING_REF = [
  "trackingSystemRefId",
  "GATS Unit ID",
  "trackingId",
  "tracking_system_ref_id",
  "reporting_entity_ref_id",
  "PJM_GATS_or_MRETS_Unit_ID_Part_2",
  "Unit ID",
] as const;
const CSG_ID = ["csgId", "CSG ID", "csg_id"] as const;
const FACILITY_NAME = [
  "facilityName",
  "Facility Name",
  "facility_name",
] as const;
const UNIT_ID = ["unitId", "Unit ID", "unit_id", "GATS Unit ID"] as const;
const INVOICE_NUMBER = [
  "invoiceNumber",
  "Invoice Number",
  "Invoice #",
  "invoice_number",
] as const;

// ── contractedDate (Phase 1) ───────────────────────────────────────

const CONTRACTED_DATE_SYSTEM_ID = [
  "id",
  "systemId",
  "system_id",
  "system id",
  "csgId",
  "CSG ID",
] as const;

const CONTRACTED_DATE_DATE = [
  "contracted",
  "contractedDate",
  "contracted_date",
  "contracted date",
  "ContractedDate",
] as const;

export const CONTRACTED_DATE_PARSER: DatasetUploadParser<InsertSrDsContractedDate> =
  {
    table: srDsContractedDate,
    parseRow(rawRow, ctx) {
      const systemId = pickField(rawRow, CONTRACTED_DATE_SYSTEM_ID);
      const contractedDate = pickField(rawRow, CONTRACTED_DATE_DATE);
      if (!systemId && !contractedDate) return null;
      if (!systemId) {
        throw new Error(
          `Row ${ctx.rowIndex + 1}: missing systemId (alias chain: ${CONTRACTED_DATE_SYSTEM_ID.join(", ")})`
        );
      }
      return {
        id: nanoid(),
        scopeId: ctx.scopeId,
        batchId: ctx.batchId,
        systemId,
        contractedDate,
        createdAt: new Date(),
      };
    },
  };

// ── solarApplications ──────────────────────────────────────────────

export const SOLAR_APPLICATIONS_PARSER: DatasetUploadParser<InsertSrDsSolarApplication> =
  {
    table: srDsSolarApplications,
    parseRow(rawRow, ctx) {
      const applicationId = pickField(rawRow, APPLICATION_ID);
      const systemId = pickField(rawRow, SYSTEM_ID);
      const trackingSystemRefId = pickField(rawRow, TRACKING_REF);
      if (!applicationId && !systemId && !trackingSystemRefId) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        applicationId,
        systemId,
        trackingSystemRefId,
        stateCertificationNumber: pickField(rawRow, [
          "stateCertificationNumber",
          "State Certification Number",
          "Certification Number",
        ]),
        systemName: pickField(rawRow, [
          "systemName",
          "system_name",
          "System Name",
          "name",
          "Project Name",
          "Project_Name",
        ]),
        installedKwAc: pickNumber(rawRow, [
          "installedKwAc",
          "installed_system_size_kw_ac",
          "planned_system_size_kw_ac",
          "financialDetail.contract_kw_ac",
          "Inverter_Size_kW_AC_Part_2",
          "Inverter_Size_kW_AC_Part_1",
          "Installed kW AC",
          "kW AC",
          "AC kW",
        ]),
        installedKwDc: pickNumber(rawRow, [
          "installedKwDc",
          "installed_system_size_kw_dc",
          "planned_system_size_kw_dc",
          "financialDetail.contract_kw_dc",
          "Inverter_Size_kW_DC_Part_2",
          "Inverter_Size_kW_DC_Part_1",
          "Installed kW DC",
          "kW DC",
          "DC kW",
        ]),
        recPrice: pickNumber(rawRow, ["recPrice", "REC Price", "rec_price"]),
        totalContractAmount: pickNumber(rawRow, [
          "totalContractAmount",
          "total_contract_amount",
          "Total Contract Amount",
          "Total Contract Value",
        ]),
        annualRecs: pickNumber(rawRow, [
          "annualRecs",
          "Annual RECs",
          "Annual REC",
          "Annual REC Quantity",
        ]),
        contractType: pickField(rawRow, [
          "contractType",
          "contract_type",
          "Contract Type",
        ]),
        installerName: pickField(rawRow, [
          "installerName",
          "installer_name",
          "installer_company_name",
          "partnerCompany.name",
          "system_installer",
          "Installer Name",
          "Installer",
        ]),
        county: pickField(rawRow, ["county", "system_county", "County"]),
        state: pickField(rawRow, ["state", "system_state", "State"]),
        zipCode: pickField(rawRow, [
          "zipCode",
          "zip_code",
          "system_zip",
          "ZIP",
          "Zip Code",
          "Zip",
        ]),
      };
    },
  };

// ── abpReport ──────────────────────────────────────────────────────

export const ABP_REPORT_PARSER: DatasetUploadParser<InsertSrDsAbpReport> = {
  table: srDsAbpReport,
  parseRow(rawRow, ctx) {
    const applicationId = pickField(rawRow, APPLICATION_ID);
    const systemId = pickField(rawRow, SYSTEM_ID);
    const trackingSystemRefId = pickField(rawRow, TRACKING_REF);
    if (!applicationId && !systemId && !trackingSystemRefId) return null;
    return {
      ...buildBaseInsert(rawRow, ctx),
      applicationId,
      systemId,
      trackingSystemRefId,
      projectName: pickField(rawRow, [
        "projectName",
        "Project Name",
        "project_name",
      ]),
      part2AppVerificationDate: pickField(rawRow, [
        "part2AppVerificationDate",
        "Part 2 App Verification Date",
        "Part 2 Verification Date",
      ]),
      inverterSizeKwAc: pickNumber(rawRow, [
        "inverterSizeKwAc",
        "Inverter_Size_kW_AC_Part_2",
        "Inverter_Size_kW_AC_Part_1",
        "Inverter Size kW AC",
        "Inverter kW AC",
      ]),
    };
  },
};

// ── generationEntry ────────────────────────────────────────────────

export const GENERATION_ENTRY_PARSER: DatasetUploadParser<InsertSrDsGenerationEntry> =
  {
    table: srDsGenerationEntry,
    parseRow(rawRow, ctx) {
      const unitId = pickField(rawRow, UNIT_ID);
      const facilityName = pickField(rawRow, FACILITY_NAME);
      if (!unitId && !facilityName) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        unitId,
        facilityName,
        lastMonthOfGen: pickField(rawRow, [
          "lastMonthOfGen",
          "Last Month of Gen",
          "Last Month of Generation",
        ]),
        effectiveDate: pickField(rawRow, ["effectiveDate", "Effective Date"]),
        onlineMonitoring: pickField(rawRow, [
          "onlineMonitoring",
          "Online Monitoring",
          "Monitoring",
        ]),
        onlineMonitoringAccessType: pickField(rawRow, [
          "onlineMonitoringAccessType",
          "Online Monitoring Access Type",
          "Monitoring Access Type",
        ]),
        onlineMonitoringSystemId: pickField(rawRow, [
          "onlineMonitoringSystemId",
          "Online Monitoring System ID",
          "Monitoring System ID",
        ]),
        onlineMonitoringSystemName: pickField(rawRow, [
          "onlineMonitoringSystemName",
          "Online Monitoring System Name",
          "Monitoring System Name",
        ]),
      };
    },
  };

// ── accountSolarGeneration ─────────────────────────────────────────

export const ACCOUNT_SOLAR_GENERATION_PARSER: DatasetUploadParser<InsertSrDsAccountSolarGeneration> =
  {
    table: srDsAccountSolarGeneration,
    parseRow(rawRow, ctx) {
      const gatsGenId = pickField(rawRow, [
        "gatsGenId",
        "GATS Gen ID",
        "gats_gen_id",
      ]);
      const facilityName = pickField(rawRow, FACILITY_NAME);
      const monthOfGeneration = pickField(rawRow, [
        "monthOfGeneration",
        "Month of Generation",
        "month_of_generation",
      ]);
      if (!gatsGenId && !facilityName && !monthOfGeneration) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        gatsGenId,
        facilityName,
        monthOfGeneration,
        lastMeterReadDate: pickField(rawRow, [
          "lastMeterReadDate",
          "Last Meter Read Date",
          "Meter Read Date",
        ]),
        // 2026-04-30 — added the 4 parenthesised header aliases the
        // CSG portal export actually uses ("(kWh)", "(kWh/Btu)",
        // "(kW)", and the bare "Last Meter Read"). Pre-fix the parser
        // only matched "Last Meter Read kWh" (no parens), so every
        // row from the actual portal export landed with this typed
        // column null + the value only present in `rawRow`. That
        // forced the snapshot builder to keep rawRow loaded for the
        // whole table, which on a populated scope blew Render's 4 GB
        // heap.
        lastMeterReadKwh: pickField(rawRow, [
          "lastMeterReadKwh",
          "Last Meter Read (kWh)",
          "Last Meter Read (kWh/Btu)",
          "Last Meter Read (kW)",
          "Last Meter Read",
          "Last Meter Read kWh",
          "Meter Read kWh",
        ]),
      };
    },
  };

// ── convertedReads ─────────────────────────────────────────────────

export const CONVERTED_READS_PARSER: DatasetUploadParser<InsertSrDsConvertedReads> =
  {
    table: srDsConvertedReads,
    parseRow(rawRow, ctx) {
      const monitoringSystemId = pickField(rawRow, [
        "monitoring_system_id",
        "monitoringSystemId",
        "Monitoring System ID",
      ]);
      const readDate = pickField(rawRow, [
        "read_date",
        "readDate",
        "Read Date",
        "date",
      ]);
      if (!monitoringSystemId && !readDate) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        monitoring: pickField(rawRow, ["monitoring", "Monitoring", "vendor"]),
        monitoringSystemId,
        monitoringSystemName: pickField(rawRow, [
          "monitoring_system_name",
          "monitoringSystemName",
          "Monitoring System Name",
        ]),
        lifetimeMeterReadWh: pickNumber(rawRow, [
          "lifetime_meter_read_wh",
          "lifetimeMeterReadWh",
          "Lifetime Meter Read Wh",
          "Lifetime Wh",
        ]),
        readDate,
      };
    },
  };

// ── annualProductionEstimates ──────────────────────────────────────

const MONTH_ALIASES: ReadonlyArray<readonly string[]> = [
  ["jan", "Jan", "January"],
  ["feb", "Feb", "February"],
  ["mar", "Mar", "March"],
  ["apr", "Apr", "April"],
  ["may", "May"],
  ["jun", "Jun", "June"],
  ["jul", "Jul", "July"],
  ["aug", "Aug", "August"],
  ["sep", "Sep", "September", "Sept"],
  ["oct", "Oct", "October"],
  ["nov", "Nov", "November"],
  ["dec", "Dec", "December"],
];

export const ANNUAL_PRODUCTION_ESTIMATES_PARSER: DatasetUploadParser<InsertSrDsAnnualProductionEstimates> =
  {
    table: srDsAnnualProductionEstimates,
    parseRow(rawRow, ctx) {
      const unitId = pickField(rawRow, UNIT_ID);
      const facilityName = pickField(rawRow, FACILITY_NAME);
      if (!unitId && !facilityName) return null;
      const months = MONTH_ALIASES.map(aliases => pickNumber(rawRow, aliases));
      return {
        ...buildBaseInsert(rawRow, ctx),
        unitId,
        facilityName,
        jan: months[0],
        feb: months[1],
        mar: months[2],
        apr: months[3],
        may: months[4],
        jun: months[5],
        jul: months[6],
        aug: months[7],
        sep: months[8],
        oct: months[9],
        nov: months[10],
        decMonth: months[11],
      };
    },
  };

// ── generatorDetails ───────────────────────────────────────────────

export const GENERATOR_DETAILS_PARSER: DatasetUploadParser<InsertSrDsGeneratorDetails> =
  {
    table: srDsGeneratorDetails,
    parseRow(rawRow, ctx) {
      const gatsUnitId = pickField(rawRow, [
        "gatsUnitId",
        "GATS Unit ID",
        "gats_unit_id",
      ]);
      const dateOnline = pickField(rawRow, [
        "dateOnline",
        "Date Online",
        "date_online",
      ]);
      if (!gatsUnitId && !dateOnline) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        gatsUnitId,
        dateOnline,
      };
    },
  };

// ── abpUtilityInvoiceRows ──────────────────────────────────────────

export const ABP_UTILITY_INVOICE_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpUtilityInvoiceRows> =
  {
    table: srDsAbpUtilityInvoiceRows,
    parseRow(rawRow, ctx) {
      const systemId = pickField(rawRow, SYSTEM_ID);
      if (!systemId) return null;
      return { ...buildBaseInsert(rawRow, ctx), systemId };
    },
  };

// ── abpCsgSystemMapping ────────────────────────────────────────────

export const ABP_CSG_SYSTEM_MAPPING_PARSER: DatasetUploadParser<InsertSrDsAbpCsgSystemMapping> =
  {
    table: srDsAbpCsgSystemMapping,
    parseRow(rawRow, ctx) {
      const csgId = pickField(rawRow, CSG_ID);
      const systemId = pickField(rawRow, SYSTEM_ID);
      if (!csgId && !systemId) return null;
      return { ...buildBaseInsert(rawRow, ctx), csgId, systemId };
    },
  };

// ── abpQuickBooksRows ──────────────────────────────────────────────

export const ABP_QUICK_BOOKS_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpQuickBooksRows> =
  {
    table: srDsAbpQuickBooksRows,
    parseRow(rawRow, ctx) {
      const invoiceNumber = pickField(rawRow, [
        ...INVOICE_NUMBER,
        "Num", // QuickBooks export header
      ]);
      if (!invoiceNumber) return null;
      return { ...buildBaseInsert(rawRow, ctx), invoiceNumber };
    },
  };

// ── abpProjectApplicationRows ──────────────────────────────────────

export const ABP_PROJECT_APPLICATION_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpProjectApplicationRows> =
  {
    table: srDsAbpProjectApplicationRows,
    parseRow(rawRow, ctx) {
      const applicationId = pickField(rawRow, APPLICATION_ID);
      if (!applicationId) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        applicationId,
        // These three live as varchar — no coercion. Typed
        // varchar(32) so over-long strings throw at the DB; the
        // alias chain catches the most common header variants.
        inverterSizeKwAcPart1: pickField(rawRow, [
          "inverterSizeKwAcPart1",
          "Inverter Size kW AC (Part 1)",
          "Inverter Size Part 1",
        ]),
        part1SubmissionDate: pickField(rawRow, [
          "part1SubmissionDate",
          "Part 1 Submission Date",
          "Part1SubmissionDate",
        ]),
        part1OriginalSubmissionDate: pickField(rawRow, [
          "part1OriginalSubmissionDate",
          "Part 1 Original Submission Date",
          "Original Submission Date",
        ]),
      };
    },
  };

// ── abpPortalInvoiceMapRows ────────────────────────────────────────

export const ABP_PORTAL_INVOICE_MAP_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpPortalInvoiceMapRows> =
  {
    table: srDsAbpPortalInvoiceMapRows,
    parseRow(rawRow, ctx) {
      const csgId = pickField(rawRow, CSG_ID);
      const invoiceNumber = pickField(rawRow, INVOICE_NUMBER);
      if (!csgId && !invoiceNumber) return null;
      return { ...buildBaseInsert(rawRow, ctx), csgId, invoiceNumber };
    },
  };

// ── abpCsgPortalDatabaseRows ───────────────────────────────────────

export const ABP_CSG_PORTAL_DATABASE_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpCsgPortalDatabaseRows> =
  {
    table: srDsAbpCsgPortalDatabaseRows,
    parseRow(rawRow, ctx) {
      const systemId = pickField(rawRow, SYSTEM_ID);
      const csgId = pickField(rawRow, CSG_ID);
      if (!systemId && !csgId) return null;
      return { ...buildBaseInsert(rawRow, ctx), systemId, csgId };
    },
  };

// ── abpIccReport2Rows ──────────────────────────────────────────────

export const ABP_ICC_REPORT_2_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpIccReport2Rows> =
  {
    table: srDsAbpIccReport2Rows,
    parseRow(rawRow, ctx) {
      const applicationId = pickField(rawRow, APPLICATION_ID);
      if (!applicationId) return null;
      return { ...buildBaseInsert(rawRow, ctx), applicationId };
    },
  };

// ── abpIccReport3Rows ──────────────────────────────────────────────

export const ABP_ICC_REPORT_3_ROWS_PARSER: DatasetUploadParser<InsertSrDsAbpIccReport3Rows> =
  {
    table: srDsAbpIccReport3Rows,
    parseRow(rawRow, ctx) {
      const applicationId = pickField(rawRow, APPLICATION_ID);
      if (!applicationId) return null;
      return { ...buildBaseInsert(rawRow, ctx), applicationId };
    },
  };

// ── transferHistory ────────────────────────────────────────────────

export const TRANSFER_HISTORY_PARSER: DatasetUploadParser<InsertSrDsTransferHistory> =
  {
    table: srDsTransferHistory,
    parseRow(rawRow, ctx) {
      const transactionId = pickField(rawRow, [
        "transactionId",
        "Transaction ID",
        "transaction_id",
        "Txn ID",
      ]);
      const unitId = pickField(rawRow, UNIT_ID);
      if (!transactionId && !unitId) return null;
      return {
        ...buildBaseInsert(rawRow, ctx),
        transactionId,
        unitId,
        transferCompletionDate: pickField(rawRow, [
          "transferCompletionDate",
          "Transfer Completion Date",
          "Completion Date",
        ]),
        quantity: pickNumber(rawRow, ["quantity", "Quantity", "Qty"]),
        transferor: pickField(rawRow, ["transferor", "Transferor", "From"]),
        transferee: pickField(rawRow, ["transferee", "Transferee", "To"]),
      };
    },
  };

// ── Registry ───────────────────────────────────────────────────────

const PARSERS: Record<DatasetKey, DatasetUploadParser<unknown> | null> = {
  contractedDate: CONTRACTED_DATE_PARSER as DatasetUploadParser<unknown>,
  solarApplications: SOLAR_APPLICATIONS_PARSER as DatasetUploadParser<unknown>,
  abpReport: ABP_REPORT_PARSER as DatasetUploadParser<unknown>,
  generationEntry: GENERATION_ENTRY_PARSER as DatasetUploadParser<unknown>,
  accountSolarGeneration:
    ACCOUNT_SOLAR_GENERATION_PARSER as DatasetUploadParser<unknown>,
  convertedReads: CONVERTED_READS_PARSER as DatasetUploadParser<unknown>,
  annualProductionEstimates:
    ANNUAL_PRODUCTION_ESTIMATES_PARSER as DatasetUploadParser<unknown>,
  generatorDetails: GENERATOR_DETAILS_PARSER as DatasetUploadParser<unknown>,
  abpUtilityInvoiceRows:
    ABP_UTILITY_INVOICE_ROWS_PARSER as DatasetUploadParser<unknown>,
  abpCsgSystemMapping:
    ABP_CSG_SYSTEM_MAPPING_PARSER as DatasetUploadParser<unknown>,
  abpQuickBooksRows:
    ABP_QUICK_BOOKS_ROWS_PARSER as DatasetUploadParser<unknown>,
  abpProjectApplicationRows:
    ABP_PROJECT_APPLICATION_ROWS_PARSER as DatasetUploadParser<unknown>,
  abpPortalInvoiceMapRows:
    ABP_PORTAL_INVOICE_MAP_ROWS_PARSER as DatasetUploadParser<unknown>,
  abpCsgPortalDatabaseRows:
    ABP_CSG_PORTAL_DATABASE_ROWS_PARSER as DatasetUploadParser<unknown>,
  abpIccReport2Rows:
    ABP_ICC_REPORT_2_ROWS_PARSER as DatasetUploadParser<unknown>,
  abpIccReport3Rows:
    ABP_ICC_REPORT_3_ROWS_PARSER as DatasetUploadParser<unknown>,
  transferHistory: TRANSFER_HISTORY_PARSER as DatasetUploadParser<unknown>,
  // `deliveryScheduleBase` stays null — it's populated by the
  // Schedule B PDF scanner on the Delivery Tracker tab, not a
  // direct CSV upload.
  deliveryScheduleBase: null,
};

/**
 * Returns the parser for `datasetKey`, or null if either the key
 * is unknown OR a parser hasn't been wired (only `deliveryScheduleBase`
 * after Phase 4). The runner short-circuits to `failed` with a
 * clear message in the latter case.
 */
export function getDatasetParser(
  datasetKey: string
): DatasetUploadParser<unknown> | null {
  if (!isDatasetKey(datasetKey)) return null;
  return PARSERS[datasetKey];
}

/**
 * The list of dataset keys whose parsers are wired. Used by the
 * client to gate the v2 upload button per dataset.
 */
export function listImplementedDatasetParsers(): DatasetKey[] {
  return (Object.keys(PARSERS) as DatasetKey[]).filter(
    key => PARSERS[key] != null
  );
}
