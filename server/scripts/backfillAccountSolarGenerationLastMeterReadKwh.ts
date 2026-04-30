/**
 * One-off backfill: populate `srDsAccountSolarGeneration.lastMeterReadKwh`
 * from the row's `rawRow` JSON for batches uploaded before the
 * 2026-04-30 parser-alias fix.
 *
 * Why this exists:
 *   The v2 upload parser used to recognise only `Last Meter Read kWh`
 *   (no parens). The CSG portal export actually emits
 *   `Last Meter Read (kWh/Btu)` (and similar parenthesised forms).
 *   Result: every row uploaded pre-fix has the value present in
 *   `rawRow` JSON but `lastMeterReadKwh` typed-column null. The
 *   snapshot builder used to compensate by loading rawRow for the
 *   whole table — which on a populated scope blew Render's 4 GB
 *   heap and crashed the instance.
 *
 *   The hotfix dropped `srDsAccountSolarGeneration` from the
 *   rawRow-loaded set, so the snapshot stops materialising
 *   ~500 MB of JSON it doesn't need. The cost: existing batches'
 *   meter-read values disappear from the snapshot until either
 *   re-uploaded or backfilled. This script does the backfill
 *   in-place — no re-upload required.
 *
 * Usage:
 *   tsx server/scripts/backfillAccountSolarGenerationLastMeterReadKwh.ts [--dry-run] [--scope <scopeId>]
 *
 *   --dry-run     Report counts; do not write.
 *   --scope <id>  Limit to one scope (default: all scopes).
 *
 * Idempotent — only updates rows whose typed column is currently
 * null AND whose rawRow contains a recognisable value.
 */
import { and, eq, isNull } from "drizzle-orm";
import "dotenv/config";
import { getDb } from "../db";
import { srDsAccountSolarGeneration } from "../../drizzle/schemas/solar";

const HEADER_ALIASES = [
  "lastMeterReadKwh",
  "Last Meter Read (kWh)",
  "Last Meter Read (kWh/Btu)",
  "Last Meter Read (kW)",
  "Last Meter Read",
  "Last Meter Read kWh",
  "Meter Read kWh",
];

function pickFromRawRow(rawRowJson: string | null): string | null {
  if (!rawRowJson) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawRowJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const alias of HEADER_ALIASES) {
    const value = parsed[alias];
    if (value === undefined || value === null) continue;
    const stringValue = String(value).trim();
    if (stringValue.length > 0) return stringValue;
  }
  return null;
}

interface RunOptions {
  dryRun: boolean;
  scopeId: string | null;
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = { dryRun: false, scopeId: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--scope") {
      opts.scopeId = argv[i + 1] ?? null;
      i += 1;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) {
    throw new Error("Database not configured (DATABASE_URL missing).");
  }

  const whereClause = opts.scopeId
    ? and(
        isNull(srDsAccountSolarGeneration.lastMeterReadKwh),
        eq(srDsAccountSolarGeneration.scopeId, opts.scopeId)
      )
    : isNull(srDsAccountSolarGeneration.lastMeterReadKwh);

  const candidates = await db
    .select({
      id: srDsAccountSolarGeneration.id,
      rawRow: srDsAccountSolarGeneration.rawRow,
    })
    .from(srDsAccountSolarGeneration)
    .where(whereClause);

  let toUpdate = 0;
  let unrecoverable = 0;
  const updates: Array<{ id: string; value: string }> = [];

  for (const row of candidates) {
    const value = pickFromRawRow(row.rawRow);
    if (value === null) {
      unrecoverable += 1;
      continue;
    }
    toUpdate += 1;
    updates.push({ id: row.id, value });
  }

  process.stdout.write(
    `[backfill] candidates: ${candidates.length}, ` +
      `toUpdate: ${toUpdate}, unrecoverable: ${unrecoverable}\n`
  );

  if (opts.dryRun) {
    process.stdout.write("[backfill] --dry-run: no writes\n");
    return;
  }

  let written = 0;
  // Update one row at a time to keep transactions small. On very
  // large datasets a chunked UPDATE would be faster, but per-row is
  // simpler and the script is one-off.
  for (const update of updates) {
    await db
      .update(srDsAccountSolarGeneration)
      .set({ lastMeterReadKwh: update.value })
      .where(eq(srDsAccountSolarGeneration.id, update.id));
    written += 1;
    if (written % 1000 === 0) {
      process.stdout.write(`[backfill] wrote ${written} rows\n`);
    }
  }

  process.stdout.write(`[backfill] done — wrote ${written} rows\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
