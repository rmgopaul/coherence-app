/**
 * Per-dataset parser registry — Phase 1 of the server-side
 * dashboard refactor (docs/server-side-dashboard-refactor.md).
 *
 * Each entry knows:
 *   - which `srDs*` table the rows go in
 *   - how to coerce a `Record<string, string>` (raw CSV row) into
 *     an Insert<table> shape, with the header-alias chains the
 *     CSVs carry
 *
 * Phase 1 ships ONE working parser (`contractedDate` — simplest
 * 2-field dataset) as a proof-of-concept end-to-end. Phase 4
 * fills the other 17 entries; until then `getParser(key)` returns
 * `null` for unimplemented datasets and the runner fails fast
 * with a clear error message.
 *
 * No DOM, no network — pure data shaping over already-parsed CSV
 * rows. Exposed for test injection.
 */

import { nanoid } from "nanoid";
import {
  srDsContractedDate,
  type InsertSrDsContractedDate,
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
  /**
   * Drizzle table reference for `db.insert(table).values(rows)`.
   * Loosely-typed at the registry boundary so the registry can
   * hold parsers for different tables; each parser narrows the
   * shape via its `parseRow` return type.
   */
  table: { _: { name: string } };
  parseRow(
    rawRow: Record<string, string>,
    ctx: DatasetParseContext
  ): TInsert | null;
};

// ── Header-alias resolution ────────────────────────────────────────

/**
 * Look up `aliases[i]` in `row` (case-insensitive on the keys),
 * returning the first non-empty trimmed value found. Returns null
 * when no alias matches or every match is empty.
 */
export function pickField(
  row: Record<string, string>,
  aliases: readonly string[]
): string | null {
  // Build a lowercase-key index once per row would be cheaper for
  // many fields but per-call is fine at typical CSV sizes (the JS
  // engine inlines the loop anyway).
  for (const alias of aliases) {
    // Try exact match first (fast path).
    const direct = row[alias];
    if (direct != null) {
      const trimmed = String(direct).trim();
      if (trimmed.length > 0) return trimmed;
    }
    // Fall back to case-insensitive match.
    const lower = alias.toLowerCase();
    for (const key of Object.keys(row)) {
      if (key.toLowerCase() !== lower) continue;
      const trimmed = String(row[key] ?? "").trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

// ── contractedDate parser ──────────────────────────────────────────

/**
 * `Contracted Date - Sheet1.csv` shape per the dashboard's existing
 * mapping in `client/src/solar-rec-dashboard/lib/buildSystems.ts`:
 * the CSV carries `id` (which maps to `systemId`) and `contracted`
 * (which maps to `contractedDate`). Aliases included for the
 * common header variants the team has uploaded historically.
 */
const CONTRACTED_DATE_SYSTEM_ID_ALIASES = [
  "id",
  "systemId",
  "system_id",
  "system id",
  "csgId",
  "CSG ID",
];

const CONTRACTED_DATE_DATE_ALIASES = [
  "contracted",
  "contractedDate",
  "contracted_date",
  "contracted date",
  "ContractedDate",
];

export const CONTRACTED_DATE_PARSER: DatasetUploadParser<InsertSrDsContractedDate> =
  {
    table: srDsContractedDate,
    parseRow(rawRow, ctx) {
      const systemId = pickField(rawRow, CONTRACTED_DATE_SYSTEM_ID_ALIASES);
      const contractedDate = pickField(rawRow, CONTRACTED_DATE_DATE_ALIASES);
      // Skip blank rows silently. A row with neither field is a
      // header-repeat or a CSV trailing newline; not worth logging
      // as an error.
      if (!systemId && !contractedDate) return null;
      // A row with one but not the other is a real input problem
      // — surface it.
      if (!systemId) {
        throw new Error(
          `Row ${ctx.rowIndex + 1}: missing systemId (alias chain: ${CONTRACTED_DATE_SYSTEM_ID_ALIASES.join(", ")})`
        );
      }
      return {
        id: nanoid(),
        scopeId: ctx.scopeId,
        batchId: ctx.batchId,
        systemId,
        contractedDate,
        createdAt: new Date(),
      } satisfies InsertSrDsContractedDate;
    },
  };

// ── Registry ───────────────────────────────────────────────────────

/**
 * Every dataset key maps to either a parser or `null` (not yet
 * implemented). `getDatasetParser` resolves at runtime; the
 * runner uses it to decide whether to accept a job.
 *
 * Phase 4 fills in the 17 nulls.
 */
const PARSERS: Record<DatasetKey, DatasetUploadParser<unknown> | null> = {
  contractedDate: CONTRACTED_DATE_PARSER as DatasetUploadParser<unknown>,
  // Phase 4 — to-do.
  solarApplications: null,
  abpReport: null,
  generationEntry: null,
  accountSolarGeneration: null,
  convertedReads: null,
  annualProductionEstimates: null,
  generatorDetails: null,
  abpUtilityInvoiceRows: null,
  abpCsgSystemMapping: null,
  abpQuickBooksRows: null,
  abpProjectApplicationRows: null,
  abpPortalInvoiceMapRows: null,
  abpCsgPortalDatabaseRows: null,
  abpIccReport2Rows: null,
  abpIccReport3Rows: null,
  deliveryScheduleBase: null,
  transferHistory: null,
};

/**
 * Returns the parser for `datasetKey`, or null if either the key
 * is unknown OR a parser hasn't been wired yet (Phase 4 work).
 * The runner short-circuits to `failed` with a clear message in
 * the latter case.
 */
export function getDatasetParser(
  datasetKey: string
): DatasetUploadParser<unknown> | null {
  if (!isDatasetKey(datasetKey)) return null;
  return PARSERS[datasetKey];
}

/**
 * The list of dataset keys whose parsers are wired. Used by the
 * UI to disable the "Upload v2" button on datasets that still
 * fall through to the legacy IDB path.
 */
export function listImplementedDatasetParsers(): DatasetKey[] {
  return (Object.keys(PARSERS) as DatasetKey[]).filter(
    (key) => PARSERS[key] != null
  );
}
