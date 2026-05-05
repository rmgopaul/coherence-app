/**
 * Backfill: re-parse `rawRow` JSON for every `srDs*` row and
 * populate typed columns the v2 upload parser dropped pre-fix.
 *
 * Why this exists:
 *   The v2 upload parser shipped with alias chains that listed
 *   only the space-separated form of CSV headers (e.g.
 *   "Part 2 App Verification Date"). Production CSVs from CSG /
 *   GATS / ABP use snake_case_with_underscores
 *   (`Part_2_App_Verification_Date`). `pickField` was case-
 *   insensitive but did not normalize separators — so every row
 *   uploaded via v2 had the value preserved in `rawRow` JSON but
 *   the matching typed column landed null.
 *
 *   The 2026-05-04 fix to `pickField` (PR #361) normalizes
 *   underscores, spaces, and hyphens at the lookup site. Future
 *   uploads pick up both forms automatically. This script repairs
 *   the existing batches in-place — no re-upload required, no
 *   row-count change, no batch supersession.
 *
 * Usage:
 *   tsx server/scripts/backfillSrDsTypedColumnsFromRawRow.ts \
 *     [--dry-run] [--scope <scopeId>] [--dataset <key>] [--page-size <n>]
 *
 *   --dry-run           Report counts; do not write.
 *   --scope <id>        Limit to one scope (default: all scopes).
 *   --dataset <key>     Limit to one dataset (default: all datasets
 *                       with `rawRow` — see DATASETS_WITH_RAW_ROW).
 *   --page-size <n>     Rows per SELECT page. Default 500. Smaller
 *                       pages reduce peak heap usage at the cost
 *                       of more round-trips to TiDB.
 *
 * Phase 6 PR-B follow-up (#361 follow-up) safety properties:
 *   - **Memory-bounded.** Keyset pagination by `id` reads in
 *     pages of `--page-size` rows. Production tables with 400k+
 *     rows (`srDsAccountSolarGeneration`) no longer load fully
 *     into Node heap.
 *   - **Idempotent in DB-write terms.** Each row is reparsed
 *     and compared against its current typed columns; UPDATE
 *     only fires when at least one column would change. Re-
 *     running the backfill after a successful pass writes zero
 *     rows.
 *   - **Dry-run reports `wouldUpdate`.** Operators can preview
 *     the write count before authorizing the real run.
 *   - **`srDsContractedDate` is rejected explicitly.** That
 *     table has no `rawRow` column, so a generic rawRow → typed-
 *     columns repair is structurally impossible. Default-loop
 *     skips it; an explicit `--dataset contractedDate` fails
 *     fast with a clear message.
 *   - **Preserved fields:** `id`, `scopeId`, `batchId`, `rawRow`,
 *     `createdAt` are never written. Only typed columns the
 *     parser maps.
 *   - **Per-row UPDATE keyed by `id`.** No bulk overwrites,
 *     no transaction-scoped lock fan-out.
 */
import "dotenv/config";
import { eq, gt, sql, and, asc } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { getDb } from "../db";
import {
  getDatasetParser,
  type DatasetUploadParser,
} from "../services/core/datasetUploadParsers";
import type { DatasetKey } from "../../shared/datasetUpload.helpers";

// ────────────────────────────────────────────────────────────────────
// Datasets that have a `rawRow` JSON column AND a v2 parser. Only
// these are repairable by this script — `srDsContractedDate` has no
// `rawRow` (pre-Phase-1 schema choice; the table stores typed
// {systemId, contractedDate} only).
//
// `deliveryScheduleBase` is also excluded because it has no parser
// (populated by the Schedule B PDF scanner, not CSV upload).
//
// Adding a new dataset to v2 means: add a parser in the registry
// AND add the key here when the row table includes `rawRow`.
// ────────────────────────────────────────────────────────────────────
export const DATASETS_WITH_RAW_ROW: readonly DatasetKey[] = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "annualProductionEstimates",
  "convertedReads",
  "transferHistory",
  "generatorDetails",
  "abpCsgSystemMapping",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpQuickBooksRows",
  "abpUtilityInvoiceRows",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
] as const;

// Datasets the user is most likely to pass via `--dataset` that
// this script CANNOT repair, with reasons. We fail fast rather
// than silently skip so the operator doesn't think the run was a
// no-op.
const REJECT_DATASETS: Record<string, string> = {
  contractedDate:
    "srDsContractedDate has no rawRow column — typed values cannot be reparsed. " +
    "If a contracted-date import is wrong, re-upload the source CSV.",
  deliveryScheduleBase:
    "srDsDeliverySchedule is populated by the Schedule B PDF scanner, not CSV upload. " +
    "No CSV parser exists. Re-run the scanner from the Delivery Tracker tab.",
};

// Constant fields populated at insert time and NEVER overwritten
// by the backfill — these ride through `parseRow` output unchanged
// per parser, but updating them via `set()` would be a no-op at
// best and a tenancy bug at worst.
export const PRESERVE_KEYS = new Set([
  "id",
  "scopeId",
  "batchId",
  "rawRow",
  "createdAt",
]);

// ────────────────────────────────────────────────────────────────────
// CLI arg parsing
// ────────────────────────────────────────────────────────────────────

export interface RunOptions {
  dryRun: boolean;
  scopeId: string | null;
  datasetKey: DatasetKey | null;
  pageSize: number;
}

const DEFAULT_PAGE_SIZE = 500;

export function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    dryRun: false,
    scopeId: null,
    datasetKey: null,
    pageSize: DEFAULT_PAGE_SIZE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--scope") {
      opts.scopeId = argv[i + 1] ?? null;
      i += 1;
    } else if (arg === "--dataset") {
      const key = argv[i + 1] ?? null;
      if (key) opts.datasetKey = key as DatasetKey;
      i += 1;
    } else if (arg === "--page-size") {
      const raw = argv[i + 1] ?? "";
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed > 0) opts.pageSize = parsed;
      i += 1;
    }
  }
  return opts;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers — exported for testing
// ────────────────────────────────────────────────────────────────────

/**
 * Drizzle's `db.execute(sql`...`)` returns mysql2's `[rows, fields]`
 * tuple. Treating that as the rows array yields exactly two
 * iterations (the rows array + the fields array) and updates
 * nothing. The wider Drizzle API surface (e.g. `db.select().from()`)
 * unwraps internally, but raw `db.execute()` does not.
 *
 * This script uses the typed select path so the helper is mostly
 * a defensive convenience — but it's exported (and tested) so a
 * future contributor doing a raw execute() in this file gets a
 * type-safe path to the rows.
 */
export function unwrapExecuteRows<T>(result: unknown): T[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    // mysql2 tuple: [rows, fields]. The rows are an array.
    if (result.length >= 1 && Array.isArray(result[0])) {
      return result[0] as T[];
    }
    // Already-unwrapped: array of row objects.
    return result as T[];
  }
  return [];
}

/**
 * Decide whether parser-derived typed cols differ from the row's
 * current typed cols. Returns the keys that would change so the
 * UPDATE can be scoped to just those columns (smaller payload,
 * less binlog churn). Empty array means the row is already
 * correct and no UPDATE is needed.
 *
 * Equality semantics:
 *   - `null` and `undefined` collapse together.
 *   - Date objects compare by `.getTime()`.
 *   - Numbers compare by `===`.
 *   - Strings compare by `===`.
 *   - PRESERVE_KEYS are excluded — they're never written.
 */
export function diffTypedColumns(
  current: Record<string, unknown>,
  parsed: Record<string, unknown>
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [key, parsedValue] of Object.entries(parsed)) {
    if (PRESERVE_KEYS.has(key)) continue;
    const currentValue = current[key];
    if (valuesEqual(currentValue, parsedValue)) continue;
    changed[key] = parsedValue;
  }
  return changed;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return false;
}

/**
 * Parse `rawRow` JSON into a `Record<string, string>` shaped for
 * `parser.parseRow`. Returns null on JSON parse error or null
 * input.
 */
export function parseRawRowJson(
  rawRowJson: string | null | undefined
): Record<string, string> | null {
  if (!rawRowJson) return null;
  try {
    const json = JSON.parse(rawRowJson) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(json).map(([k, v]) => [k, v == null ? "" : String(v)])
    );
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Per-dataset backfill (impure — talks to DB)
// ────────────────────────────────────────────────────────────────────

export interface DatasetCounts {
  candidates: number;
  parsed: number;
  wouldUpdate: number;
  unchanged: number;
  written: number;
  unparseableRawRow: number;
  parserReturnedNull: number;
}

function emptyCounts(): DatasetCounts {
  return {
    candidates: 0,
    parsed: 0,
    wouldUpdate: 0,
    unchanged: 0,
    written: 0,
    unparseableRawRow: 0,
    parserReturnedNull: 0,
  };
}

async function backfillOneDataset(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  datasetKey: DatasetKey,
  parser: DatasetUploadParser<unknown>,
  opts: RunOptions
): Promise<DatasetCounts> {
  const counts = emptyCounts();

  // Use Drizzle's typed `db.select()` — it returns `T[]` directly,
  // sidestepping the mysql2 `[rows, fields]` tuple unwrap problem
  // that bit the original implementation. The parser's `table`
  // is the canonical Drizzle table reference; selecting all
  // columns (`select()` with no projection) returns each row's
  // typed shape including `id`, `scopeId`, `batchId`, `rawRow`,
  // `createdAt`, AND every typed column the parser maps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const table = parser.table as any;

  let lastId = "";
  // Keyset pagination by `id`: stable under concurrent writes
  // (which the backfill should not race against, but defensive),
  // O(log n) per page on the primary-key index, and avoids the
  // OFFSET deep-scan cost that would grow with each page.
  while (true) {
    const whereClauses = [gt(table.id, lastId)];
    if (opts.scopeId) whereClauses.push(eq(table.scopeId, opts.scopeId));
    const page = (await db
      .select()
      .from(table)
      .where(and(...whereClauses))
      .orderBy(asc(table.id))
      .limit(opts.pageSize)) as Array<Record<string, unknown>>;

    if (page.length === 0) break;
    counts.candidates += page.length;

    for (const row of page) {
      const rowId = String(row.id ?? "");
      // Advance the keyset cursor as soon as we observe the row
      // so a parser-throw mid-page doesn't infinite-loop.
      if (rowId > lastId) lastId = rowId;

      const rawRow = row.rawRow as string | null | undefined;
      const rawRowParsed = parseRawRowJson(rawRow);
      if (!rawRowParsed) {
        counts.unparseableRawRow += 1;
        continue;
      }
      const insert = parser.parseRow(rawRowParsed, {
        scopeId: String(row.scopeId ?? ""),
        batchId: String(row.batchId ?? ""),
        rowIndex: 0,
      });
      if (insert == null) {
        counts.parserReturnedNull += 1;
        continue;
      }
      counts.parsed += 1;

      const changed = diffTypedColumns(
        row,
        insert as Record<string, unknown>
      );
      if (Object.keys(changed).length === 0) {
        counts.unchanged += 1;
        continue;
      }
      counts.wouldUpdate += 1;

      if (!opts.dryRun) {
        await db
          .update(table)
          .set(changed)
          .where(eq(table.id, rowId));
        counts.written += 1;
        if (counts.written % 1000 === 0) {
          process.stdout.write(
            `[backfill ${datasetKey}] wrote ${counts.written} ` +
              `(wouldUpdate=${counts.wouldUpdate}, ` +
              `unchanged=${counts.unchanged}, ` +
              `parsed=${counts.parsed}, ` +
              `candidates=${counts.candidates})\n`
          );
        }
      }
    }

    // Page size sanity: if the page was shorter than requested,
    // we've reached the end of the table.
    if (page.length < opts.pageSize) break;
  }
  return counts;
}

// ────────────────────────────────────────────────────────────────────
// CLI entry
// ────────────────────────────────────────────────────────────────────

function selectDatasetsToBackfill(opts: RunOptions): DatasetKey[] {
  if (opts.datasetKey) {
    const reason = REJECT_DATASETS[opts.datasetKey];
    if (reason) {
      throw new Error(
        `[backfill] Cannot run on --dataset ${opts.datasetKey}: ${reason}`
      );
    }
    return [opts.datasetKey];
  }
  return [...DATASETS_WITH_RAW_ROW];
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) {
    throw new Error("Database not configured (DATABASE_URL missing).");
  }

  const datasets = selectDatasetsToBackfill(opts);

  process.stdout.write(
    `[backfill] datasets: ${datasets.join(", ")}\n` +
      `[backfill] scope: ${opts.scopeId ?? "<all>"}\n` +
      `[backfill] dryRun: ${opts.dryRun}\n` +
      `[backfill] pageSize: ${opts.pageSize}\n`
  );

  const totals: DatasetCounts = emptyCounts();

  for (const datasetKey of datasets) {
    const parser = getDatasetParser(datasetKey);
    if (!parser) {
      process.stdout.write(
        `[backfill ${datasetKey}] no parser wired — skipping\n`
      );
      continue;
    }
    process.stdout.write(`[backfill ${datasetKey}] starting\n`);
    const counts = await backfillOneDataset(db, datasetKey, parser, opts);
    process.stdout.write(
      `[backfill ${datasetKey}] candidates=${counts.candidates} ` +
        `parsed=${counts.parsed} ` +
        `wouldUpdate=${counts.wouldUpdate} ` +
        `unchanged=${counts.unchanged} ` +
        `written=${counts.written} ` +
        `unparseableRawRow=${counts.unparseableRawRow} ` +
        `parserReturnedNull=${counts.parserReturnedNull}\n`
    );
    totals.candidates += counts.candidates;
    totals.parsed += counts.parsed;
    totals.wouldUpdate += counts.wouldUpdate;
    totals.unchanged += counts.unchanged;
    totals.written += counts.written;
    totals.unparseableRawRow += counts.unparseableRawRow;
    totals.parserReturnedNull += counts.parserReturnedNull;
  }

  process.stdout.write(
    `[backfill] DONE candidates=${totals.candidates} ` +
      `parsed=${totals.parsed} ` +
      `wouldUpdate=${totals.wouldUpdate} ` +
      `unchanged=${totals.unchanged} ` +
      `written=${totals.written} ` +
      `unparseableRawRow=${totals.unparseableRawRow} ` +
      `parserReturnedNull=${totals.parserReturnedNull}\n`
  );
}

// ────────────────────────────────────────────────────────────────────
// Test surface — internal helpers exported for unit-test access
// without polluting the production import surface. Production
// callers import the script as a CLI entry; tests import these.
// ────────────────────────────────────────────────────────────────────
export const __TEST_ONLY__ = {
  selectDatasetsToBackfill,
  REJECT_DATASETS,
};

// Only run main() when invoked as a CLI, not when imported as a
// module (test imports must NOT trigger db connection).
const isCli =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1]?.endsWith("backfillSrDsTypedColumnsFromRawRow.ts") === true;
if (isCli) {
  void main()
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}

// Suppress unused-import warning for `sql` — kept available for
// future raw-execute paths without forcing a re-import.
void sql;
