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
 *   The 2026-05-04 fix to `pickField` normalizes underscores,
 *   spaces, and hyphens at the lookup site. Future uploads pick
 *   up both forms automatically. This script repairs the existing
 *   batches in-place — no re-upload required, no row-count change,
 *   no batch supersession.
 *
 * Usage:
 *   tsx server/scripts/backfillSrDsTypedColumnsFromRawRow.ts \
 *     [--dry-run] [--scope <scopeId>] [--dataset <key>]
 *
 *   --dry-run        Report counts; do not write.
 *   --scope <id>     Limit to one scope (default: all scopes).
 *   --dataset <key>  Limit to one dataset (default: all 17 implemented).
 *
 * Idempotent — re-parsing a row that's already correct produces
 * the same typed-column values, so re-running is a no-op write.
 *
 * Safety:
 *   - Does NOT touch `id`, `scopeId`, `batchId`, `rawRow`, or
 *     `createdAt`. Only the typed columns the parser maps.
 *   - Per-row UPDATE keyed by `id` — multi-tenant safe.
 *   - Skips rows whose rawRow JSON fails to parse.
 *   - Skips rows where the parser returns null (insufficient
 *     identifier columns); those are not valid v2 inserts to
 *     begin with.
 */
import "dotenv/config";
import { eq, and, sql } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { getDb } from "../db";
import {
  getDatasetParser,
  listImplementedDatasetParsers,
  type DatasetUploadParser,
} from "../services/core/datasetUploadParsers";
import type { DatasetKey } from "../../shared/datasetUpload.helpers";

interface RunOptions {
  dryRun: boolean;
  scopeId: string | null;
  datasetKey: DatasetKey | null;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {
    dryRun: false,
    scopeId: null,
    datasetKey: null,
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
    }
  }
  return opts;
}

// Constant fields populated at insert time and NEVER overwritten
// by the backfill — these ride through `parseRow` output unchanged
// per parser, but updating them via `set()` would be a no-op at
// best and a tenancy bug at worst.
const PRESERVE = new Set([
  "id",
  "scopeId",
  "batchId",
  "rawRow",
  "createdAt",
]);

interface DatasetCounts {
  candidates: number;
  parsed: number;
  written: number;
  unparseableRawRow: number;
  parserReturnedNull: number;
}

async function backfillOneDataset(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  datasetKey: DatasetKey,
  parser: DatasetUploadParser<unknown>,
  opts: RunOptions
): Promise<DatasetCounts> {
  const counts: DatasetCounts = {
    candidates: 0,
    parsed: 0,
    written: 0,
    unparseableRawRow: 0,
    parserReturnedNull: 0,
  };

  // The parser's `table` is its own `MySqlTable` reference. We use
  // sql`` raw selects to avoid having to import the column shape
  // statically — the script is parser-driven.
  const table = parser.table as unknown as MySqlTable;
  // `getSQL()` exposes the table's identifier so we can compose a
  // raw SELECT. Drizzle's typed select would require knowing the
  // column shape statically; we just want id + scopeId + batchId +
  // rawRow.
  const tableRef = sql`${table}`;

  const whereScope = opts.scopeId
    ? sql`scopeId = ${opts.scopeId}`
    : sql`1 = 1`;
  const rows = (await db.execute(
    sql`SELECT id, scopeId, batchId, rawRow FROM ${tableRef} WHERE ${whereScope}`
  )) as unknown as Array<{
    id: string;
    scopeId: string;
    batchId: string;
    rawRow: string | null;
  }>;

  counts.candidates = rows.length;

  for (const row of rows) {
    if (!row.rawRow) {
      counts.unparseableRawRow += 1;
      continue;
    }
    let rawRowParsed: Record<string, string>;
    try {
      const json = JSON.parse(row.rawRow) as Record<string, unknown>;
      rawRowParsed = Object.fromEntries(
        Object.entries(json).map(([k, v]) => [k, v == null ? "" : String(v)])
      );
    } catch {
      counts.unparseableRawRow += 1;
      continue;
    }
    const insert = parser.parseRow(rawRowParsed, {
      scopeId: row.scopeId,
      batchId: row.batchId,
      rowIndex: 0,
    });
    if (insert == null) {
      counts.parserReturnedNull += 1;
      continue;
    }
    counts.parsed += 1;
    const typedCols: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(insert as Record<string, unknown>)) {
      if (PRESERVE.has(key)) continue;
      typedCols[key] = value;
    }
    if (Object.keys(typedCols).length === 0) continue;

    if (!opts.dryRun) {
      await db
        .update(table)
        .set(typedCols)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .where(and(eq((table as any).id, row.id)));
      counts.written += 1;
      if (counts.written % 1000 === 0) {
        process.stdout.write(
          `[backfill ${datasetKey}] wrote ${counts.written} / ${counts.parsed}\n`
        );
      }
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) {
    throw new Error("Database not configured (DATABASE_URL missing).");
  }

  const datasets = opts.datasetKey
    ? [opts.datasetKey]
    : listImplementedDatasetParsers();

  process.stdout.write(
    `[backfill] datasets: ${datasets.join(", ")}\n` +
      `[backfill] scope: ${opts.scopeId ?? "<all>"}\n` +
      `[backfill] dryRun: ${opts.dryRun}\n`
  );

  const totals: DatasetCounts = {
    candidates: 0,
    parsed: 0,
    written: 0,
    unparseableRawRow: 0,
    parserReturnedNull: 0,
  };

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
        `parsed=${counts.parsed} written=${counts.written} ` +
        `unparseableRawRow=${counts.unparseableRawRow} ` +
        `parserReturnedNull=${counts.parserReturnedNull}\n`
    );
    totals.candidates += counts.candidates;
    totals.parsed += counts.parsed;
    totals.written += counts.written;
    totals.unparseableRawRow += counts.unparseableRawRow;
    totals.parserReturnedNull += counts.parserReturnedNull;
  }

  process.stdout.write(
    `[backfill] DONE candidates=${totals.candidates} ` +
      `parsed=${totals.parsed} written=${totals.written} ` +
      `unparseableRawRow=${totals.unparseableRawRow} ` +
      `parserReturnedNull=${totals.parserReturnedNull}\n`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
