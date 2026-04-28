/**
 * Task 9.5 PR-2 (2026-04-28) — invoice status per CSG ID.
 *
 * Powers the new "Invoice status" section on the system detail
 * page. Joins three datasets to give the user a single-glance read
 * on the system's payment lifecycle:
 *
 *   1. **`srDsAbpUtilityInvoiceRows`** — one row per
 *      (system × payment cycle × monthly true-up). The canonical
 *      "what did the utility actually pay" record. Keyed by
 *      `systemId` (the typed column the persister types from
 *      `parseUtilityInvoiceMatrix` in `client/src/lib/abpSettlement.ts`).
 *      All other fields live in `rawRow` JSON because the parser
 *      uses fuzzy header detection and reproducing it in the
 *      persister would re-implement parser logic.
 *
 *   2. **`srDsAbpIccReport3Rows`** — ICC contract value report.
 *      Keyed by `applicationId`. Provides `Total REC Delivery
 *      Contract Value`, `Total Quantity of RECs Contracted`, and
 *      `REC Price` — the "what was contracted" baseline.
 *
 *   3. **`srDsAbpIccReport2Rows`** — older ICC variant. Adds
 *      `Scheduled Energization Date` which the detail page uses
 *      as a sanity check against `srDsContractedDate`.
 *
 * Active batch IDs for all three resolve in one round-trip via
 * `resolveInvoiceStatusBatchIds`, mirroring the pattern from
 * `systemRegistry` and `systemMeterReads`.
 *
 * Output shape: see `SystemInvoiceStatus` below. The utility-
 * invoice section returns up to N most recent rows (default 12) +
 * roll-up totals so the UI can show a "12 invoices · $X total"
 * stat without re-summing on the client. The ICC pieces return
 * single typed records (or null when no row matches).
 */

import { eq, and, desc, getDb, withDbRetry } from "./_core";
import {
  srDsAbpUtilityInvoiceRows,
  srDsAbpIccReport3Rows,
  srDsAbpIccReport2Rows,
  solarRecActiveDatasetVersions,
} from "../../drizzle/schema";
import { getSystemByCsgId } from "./systemRegistry";

export interface UtilityInvoiceRow {
  paymentNumber: string | null;
  totalRecs: number | null;
  recPrice: number | null;
  invoiceAmount: number | null;
}

export interface IccReportSummary {
  applicationId: string | null;
  grossContractValue: number | null;
  contractedRecs: number | null;
  recPrice: number | null;
  scheduledEnergizationDate: string | null;
}

export interface SystemInvoiceStatus {
  utilityInvoices: {
    count: number;
    /** Most-recent first, capped at `limit`. The persister doesn't
     *  store a stable ordering column; we sort by the `Payment Number`
     *  field parsed out of rawRow, descending. Rows without a parseable
     *  payment number sort to the bottom. */
    rows: UtilityInvoiceRow[];
    /** Sum of `Total RECS` across ALL invoice rows for this system —
     *  not just the rows returned. `null` when zero rows exist. */
    totalRecs: number | null;
    /** Sum of `Invoice Amount ($)` across ALL invoice rows. */
    totalInvoiceAmount: number | null;
  };
  iccReport: IccReportSummary | null;
}

const EMPTY_RESULT: SystemInvoiceStatus = {
  utilityInvoices: {
    count: 0,
    rows: [],
    totalRecs: null,
    totalInvoiceAmount: null,
  },
  iccReport: null,
};

const DATASET_KEYS = {
  abpUtilityInvoiceRows: "abpUtilityInvoiceRows",
  abpIccReport3Rows: "abpIccReport3Rows",
  abpIccReport2Rows: "abpIccReport2Rows",
} as const;

export type SystemInvoiceStatusBatchIds = Record<
  keyof typeof DATASET_KEYS,
  string | null
>;

/** Resolve the three active batch IDs in one DB round-trip.
 *  Exposed for testability + reuse. */
export async function resolveInvoiceStatusBatchIds(
  scopeId: string
): Promise<SystemInvoiceStatusBatchIds> {
  const db = await getDb();
  const out: SystemInvoiceStatusBatchIds = {
    abpUtilityInvoiceRows: null,
    abpIccReport3Rows: null,
    abpIccReport2Rows: null,
  };
  if (!db) return out;
  const rows = await withDbRetry("invoice status — active batches", () =>
    db
      .select({
        datasetKey: solarRecActiveDatasetVersions.datasetKey,
        batchId: solarRecActiveDatasetVersions.batchId,
      })
      .from(solarRecActiveDatasetVersions)
      .where(eq(solarRecActiveDatasetVersions.scopeId, scopeId))
  );
  for (const row of rows) {
    if (row.datasetKey === DATASET_KEYS.abpUtilityInvoiceRows) {
      out.abpUtilityInvoiceRows = row.batchId;
    } else if (row.datasetKey === DATASET_KEYS.abpIccReport3Rows) {
      out.abpIccReport3Rows = row.batchId;
    } else if (row.datasetKey === DATASET_KEYS.abpIccReport2Rows) {
      out.abpIccReport2Rows = row.batchId;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pure rawRow parsers — exposed for testability so the field-name
// fallback chains can be exercised without DB I/O.
// ---------------------------------------------------------------------------

function parseRawRow(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseNumberFromRaw(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  // Strip "$" / "," / spaces — utility invoices come in as currency
  // strings and ICC reports as numbers-with-commas. parseFloat alone
  // would silently truncate "1,234" to 1.
  const cleaned = value.replace(/[$,\s]/g, "").trim();
  if (!cleaned) return null;
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickStringField(
  row: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function pickNumberField(
  row: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const v = parseNumberFromRaw(row[key]);
    if (v !== null) return v;
  }
  return null;
}

/**
 * Extract a UtilityInvoiceRow from a row's rawRow string. Pure.
 * Tries the same field aliases the legacy parser
 * (`parseUtilityInvoiceMatrix`) honors so the surfaced values match
 * what the user sees in ABP Invoice Settlement.
 */
export function extractUtilityInvoiceFields(
  rawRowStr: string | null | undefined
): UtilityInvoiceRow {
  const raw = parseRawRow(rawRowStr);
  return {
    paymentNumber: pickStringField(raw, "Payment Number", "Payment #"),
    totalRecs: pickNumberField(raw, "Total RECS", "REC Quantity"),
    recPrice: pickNumberField(raw, "REC Price"),
    invoiceAmount: pickNumberField(
      raw,
      "Invoice Amount ($)",
      "Invoice Amount"
    ),
  };
}

/**
 * Extract an IccReportSummary from a row's rawRow string. Pure.
 * Mirrors the field aliases from `buildAppPipelineCashFlow.ts` plus
 * the Report-2-only `Scheduled Energization Date`.
 */
export function extractIccReportFields(
  rawRowStr: string | null | undefined,
  applicationId: string | null
): IccReportSummary {
  const raw = parseRawRow(rawRowStr);
  // GCV: prefer the explicit field; if it's missing fall back to
  // qty × price (same fallback the cash-flow aggregator uses).
  let gcv = pickNumberField(
    raw,
    "Total REC Delivery Contract Value",
    "REC Delivery Contract Value",
    "Total Contract Value"
  );
  const contractedRecs = pickNumberField(
    raw,
    "Total Quantity of RECs Contracted",
    "Contracted SRECs",
    "SRECs"
  );
  const recPrice = pickNumberField(raw, "REC Price");
  if (gcv === null && contractedRecs !== null && recPrice !== null) {
    gcv = contractedRecs * recPrice;
  }
  return {
    applicationId,
    grossContractValue: gcv,
    contractedRecs,
    recPrice,
    scheduledEnergizationDate: pickStringField(
      raw,
      "Scheduled Energization Date"
    ),
  };
}

/** Parse "Payment Number" as a sortable integer when possible.
 *  Returns -Infinity for unparseable values so they sort to the
 *  end. Exposed for testability. */
export function paymentNumberSortKey(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const cleaned = value.replace(/[^\d.-]/g, "");
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

// ---------------------------------------------------------------------------
// Public DB helper
// ---------------------------------------------------------------------------

export async function getInvoiceStatusForCsgId(
  scopeId: string,
  csgId: string,
  opts: {
    /** Cap on utility-invoice rows returned. Roll-up totals are
     *  computed from ALL rows regardless. Default 12; clamped to
     *  [1, 100]. */
    limit?: number;
    preResolvedRegistry?: Awaited<ReturnType<typeof getSystemByCsgId>>;
  } = {}
): Promise<SystemInvoiceStatus> {
  const trimmed = csgId.trim();
  if (!trimmed) return EMPTY_RESULT;
  const limit = Math.min(Math.max(opts.limit ?? 12, 1), 100);

  const db = await getDb();
  if (!db) return EMPTY_RESULT;

  const registry =
    opts.preResolvedRegistry ?? (await getSystemByCsgId(scopeId, csgId));
  if (!registry) return EMPTY_RESULT;

  const batches = await resolveInvoiceStatusBatchIds(scopeId);

  const utilityInvoices = await loadUtilityInvoices(
    db,
    scopeId,
    batches.abpUtilityInvoiceRows,
    registry.systemId,
    limit
  );

  const iccReport = await loadIccReport(
    db,
    scopeId,
    batches.abpIccReport3Rows,
    batches.abpIccReport2Rows,
    registry.applicationId,
    registry.systemId
  );

  return { utilityInvoices, iccReport };
}

async function loadUtilityInvoices(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  scopeId: string,
  batchId: string | null,
  systemId: string | null,
  limit: number
): Promise<SystemInvoiceStatus["utilityInvoices"]> {
  if (!batchId || !systemId) {
    return EMPTY_RESULT.utilityInvoices;
  }
  const allRows = await withDbRetry(
    "invoice status — utility invoice lookup",
    () =>
      db
        .select({ rawRow: srDsAbpUtilityInvoiceRows.rawRow })
        .from(srDsAbpUtilityInvoiceRows)
        .where(
          and(
            eq(srDsAbpUtilityInvoiceRows.scopeId, scopeId),
            eq(srDsAbpUtilityInvoiceRows.batchId, batchId),
            eq(srDsAbpUtilityInvoiceRows.systemId, systemId)
          )
        )
  );

  const parsed = allRows.map((r) => extractUtilityInvoiceFields(r.rawRow));
  parsed.sort(
    (a, b) =>
      paymentNumberSortKey(b.paymentNumber) -
      paymentNumberSortKey(a.paymentNumber)
  );

  // Roll-ups span the entire result set; the limited slice is for
  // display only. `null` when zero parseable values exist so the UI
  // can show "—" instead of "$0.00 of nothing".
  let totalRecs: number | null = null;
  let totalInvoiceAmount: number | null = null;
  for (const row of parsed) {
    if (row.totalRecs !== null) {
      totalRecs = (totalRecs ?? 0) + row.totalRecs;
    }
    if (row.invoiceAmount !== null) {
      totalInvoiceAmount = (totalInvoiceAmount ?? 0) + row.invoiceAmount;
    }
  }

  return {
    count: parsed.length,
    rows: parsed.slice(0, limit),
    totalRecs,
    totalInvoiceAmount,
  };
}

async function loadIccReport(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  scopeId: string,
  report3BatchId: string | null,
  report2BatchId: string | null,
  applicationId: string | null,
  systemId: string | null
): Promise<IccReportSummary | null> {
  // Try Report 3 first (canonical "ICC payments"); fall back to
  // Report 2 if Report 3 has no row (some scopes only have Report 2
  // ingested). For each, try applicationId first, then systemId
  // (older variants reuse systemId).
  const candidates: Array<string> = [];
  if (applicationId) candidates.push(applicationId);
  if (systemId && systemId !== applicationId) candidates.push(systemId);
  if (candidates.length === 0) return null;

  if (report3BatchId) {
    for (const candidate of candidates) {
      const rows = await withDbRetry(
        "invoice status — icc report 3 lookup",
        () =>
          db
            .select({
              applicationId: srDsAbpIccReport3Rows.applicationId,
              rawRow: srDsAbpIccReport3Rows.rawRow,
            })
            .from(srDsAbpIccReport3Rows)
            .where(
              and(
                eq(srDsAbpIccReport3Rows.scopeId, scopeId),
                eq(srDsAbpIccReport3Rows.batchId, report3BatchId),
                eq(srDsAbpIccReport3Rows.applicationId, candidate)
              )
            )
            .limit(1)
      );
      const row = rows[0];
      if (row) {
        return extractIccReportFields(row.rawRow, row.applicationId ?? candidate);
      }
    }
  }

  if (report2BatchId) {
    for (const candidate of candidates) {
      const rows = await withDbRetry(
        "invoice status — icc report 2 lookup",
        () =>
          db
            .select({
              applicationId: srDsAbpIccReport2Rows.applicationId,
              rawRow: srDsAbpIccReport2Rows.rawRow,
            })
            .from(srDsAbpIccReport2Rows)
            .where(
              and(
                eq(srDsAbpIccReport2Rows.scopeId, scopeId),
                eq(srDsAbpIccReport2Rows.batchId, report2BatchId),
                eq(srDsAbpIccReport2Rows.applicationId, candidate)
              )
            )
            .limit(1)
      );
      const row = rows[0];
      if (row) {
        return extractIccReportFields(row.rawRow, row.applicationId ?? candidate);
      }
    }
  }

  return null;
}
