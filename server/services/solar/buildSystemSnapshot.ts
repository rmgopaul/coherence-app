/**
 * Server-side system snapshot builder.
 *
 * Loads the 7 core datasets from normalized DB tables, reconstructs
 * CsvRow[] arrays, calls the EXISTING buildSystems() pure function
 * (identical to the client-side version), and caches the output
 * by input version hash for fast re-use.
 *
 * This approach preserves golden-test parity: same function, same
 * input format, same output. The only difference is where the data
 * comes from (DB) and where the result goes (DB table).
 */

import { eq, and } from "drizzle-orm";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  srDsSolarApplications,
  srDsAbpReport,
  srDsGenerationEntry,
  srDsAccountSolarGeneration,
  srDsContractedDate,
  srDsDeliverySchedule,
  srDsTransferHistory,
} from "../../../drizzle/schema";
import { getDb, withDbRetry } from "../../db/_core";
import {
  claimComputeRun,
  reclaimComputeRun,
  getComputeRun,
  completeComputeRun,
  failComputeRun,
  getActiveVersionsForKeys,
  getComputedArtifact,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CsvRow = Record<string, string>;

const SYSTEM_SNAPSHOT_DEPS = [
  "solarApplications",
  "abpReport",
  "generationEntry",
  "accountSolarGeneration",
  "contractedDate",
  "deliveryScheduleBase",
  "transferHistory",
] as const;
const SYSTEM_SNAPSHOT_ARTIFACT_TYPE = "system_snapshot";
const STUCK_RUN_THRESHOLD_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Version hash
// ---------------------------------------------------------------------------

export async function computeSystemSnapshotHash(
  scopeId: string
): Promise<string> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    SYSTEM_SNAPSHOT_DEPS as unknown as string[]
  );
  const sorted = versions
    .map((v) => `${v.datasetKey}:${v.batchId}`)
    .sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Load dataset rows from DB → CsvRow[]
// ---------------------------------------------------------------------------

/**
 * Per-table mapping of typed column name → original CSV header name.
 * Required for:
 *   (a) tables with no rawRow column (contractedDate), where typed
 *       columns are the only source of truth
 *   (b) large tables where we deliberately skip rawRow to keep
 *       server memory under Render's ~1GB heap ceiling
 *       (convertedReads, transferHistory)
 * For remaining tables the rawRow JSON provides all original CSV
 * keys and this mapping is a no-op.
 */
const TYPED_COLUMN_TO_CSV_KEY: Record<string, Record<string, string>> = {
  srDsContractedDate: {
    systemId: "id",
    contractedDate: "contracted",
  },
  srDsAccountSolarGeneration: {
    gatsGenId: "GATS Gen ID",
    facilityName: "Facility Name",
    monthOfGeneration: "Month of Generation",
    lastMeterReadDate: "Last Meter Read Date",
    lastMeterReadKwh: "Last Meter Read (kWh)",
  },
  srDsTransferHistory: {
    unitId: "Unit ID",
    transferor: "Transferor",
    transferee: "Transferee",
    transferCompletionDate: "Transfer Completion Date",
    quantity: "Quantity",
    transactionId: "Transaction ID",
  },
  srDsConvertedReads: {
    monitoring: "monitoring",
    monitoringSystemId: "monitoring_system_id",
    monitoringSystemName: "monitoring_system_name",
    lifetimeMeterReadWh: "lifetime_meter_read_wh",
    readDate: "read_date",
  },
};

/**
 * Tables where rawRow is NOT fetched at read time. Every field
 * buildSystems reads from these rows is already covered by a
 * typed column (see TYPED_COLUMN_TO_CSV_KEY). Skipping rawRow
 * drops roughly 500MB of wire transfer + JSON parse work on a
 * million-row dataset.
 *
 * 2026-04-30 — added `srDsAccountSolarGeneration` after a
 * production OOM. The historical comment claimed rawRow was
 * required because the actual CSV header `"Last Meter Read
 * (kWh/Btu)"` didn't match `"Last Meter Read (kWh)"` in the
 * typed-column remap, forcing a fallback substring scan that
 * needs rawRow. The real fix was to extend the upload parser's
 * `pickField` alias list to recognise the parenthesised forms
 * (see `datasetUploadParsers.ts :: ACCOUNT_SOLAR_GENERATION_PARSER`).
 * After that change, every newly uploaded row has the value in
 * the typed `lastMeterReadKwh` column and reconstructs to
 * `"Last Meter Read (kWh)"` via `TYPED_COLUMN_TO_CSV_KEY` — so
 * `resolveLastMeterReadRawValue`'s direct lookup at the head of
 * the function finds it without needing the fallback scan.
 *
 * Caveat for existing batches uploaded before this fix: the
 * typed column may be null for those rows, and without rawRow
 * the snapshot loses their meter-read values. Re-uploading
 * accountSolarGeneration through the v2 button repopulates the
 * typed column with the new alias list. Acceptable hotfix
 * tradeoff to keep the server alive.
 */
const SKIP_RAW_ROW_TABLES = new Set<string>([
  "srDsConvertedReads",
  "srDsTransferHistory",
  "srDsAccountSolarGeneration",
]);

/**
 * Load rows from a dataset table and reconstruct CsvRow[] from
 * typed columns + rawRow JSON. Works with any of the 7 tables.
 *
 * Exported so `getDatasetRowsFromSrDs` can reuse the exact CsvRow
 * reconstruction (typed-column → CSV-key remap + rawRow merge) — both
 * call sites need identical output and the remap table is the only
 * source of truth.
 */
export async function loadDatasetRows(
  scopeId: string,
  batchId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table types are complex unions
  table: any
): Promise<CsvRow[]> {
  if (!batchId) return [];
  const db = await getDb();
  if (!db) return [];

  // Drizzle stores the table name on a Symbol-keyed property. The
  // obvious paths (table._.name, table.name) are BOTH undefined, which
  // previously silently disabled every per-table remap and caused
  // ~24k contractedDate mismatches + transferHistory / accountSolar-
  // Generation lookup failures.
  const NAME_SYMBOL = Symbol.for("drizzle:Name");
  const tableName: string | undefined =
    (table as unknown as { [k: symbol]: unknown })?.[NAME_SYMBOL] as
      | string
      | undefined;
  const remap = tableName ? TYPED_COLUMN_TO_CSV_KEY[tableName] : undefined;
  const skipRawRow = tableName ? SKIP_RAW_ROW_TABLES.has(tableName) : false;

  // For big tables we build an explicit select that omits rawRow —
  // saves ~500MB of wire transfer on the accountSolarGeneration +
  // transferHistory pair, which is what was OOMing Render.
  const selectCols = skipRawRow
    ? (() => {
        const cols: Record<string, unknown> = {};
        const fromTable = table as Record<string, unknown>;
        for (const [col, val] of Object.entries(fromTable)) {
          if (col === "rawRow") continue;
          cols[col] = val;
        }
        return cols;
      })()
    : undefined;

  const rows = await withDbRetry("load dataset rows", () =>
    selectCols
      ? db
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic column set
          .select(selectCols as any)
          .from(table)
          .where(and(eq(table.scopeId, scopeId), eq(table.batchId, batchId)))
      : db
          .select()
          .from(table)
          .where(and(eq(table.scopeId, scopeId), eq(table.batchId, batchId)))
  );

  return (rows as Record<string, unknown>[]).map((row) =>
    reconstructCsvRow(row, remap)
  );
}

/**
 * Reconstruct a single CsvRow from a raw DB row using the same
 * typed-column → CSV-key remap as `loadDatasetRows`. Extracted so the
 * paginated row loader and the bulk loader share one implementation
 * (the remap table is the only source of truth and must not be
 * duplicated).
 */
function reconstructCsvRow(
  row: Record<string, unknown>,
  remap: Record<string, string> | undefined
): CsvRow {
  const rawRowStr = row.rawRow as string | null;
  const base: CsvRow = rawRowStr ? JSON.parse(rawRowStr) : {};
  for (const [key, value] of Object.entries(row)) {
    if (
      key === "id" ||
      key === "scopeId" ||
      key === "batchId" ||
      key === "rawRow" ||
      key === "createdAt"
    ) {
      continue;
    }
    if (value === null || value === undefined) continue;
    const mapped = remap?.[key];
    if (mapped) {
      base[mapped] = String(value);
    } else {
      base[key] = String(value);
    }
  }
  return base;
}

/**
 * PR-4: paginated row loader for the row-backed datasets.
 *
 * Returns at most `limit` rows, ordered by `id` (the primary key) for
 * stable keyset pagination. Pass the last returned `id` back as
 * `cursor` to fetch the next page.
 *
 * Memory bound per call: `limit` rows × per-row size. With the default
 * limit of 100 and accountSolarGeneration's ~3 KB rawRow, each call
 * peaks at ~300 KB on the wire — well below the per-tab 800 MB
 * incognito memory ceiling we're holding ourselves to.
 *
 * Reuses `reconstructCsvRow` so output is bit-identical to the bulk
 * `loadDatasetRows`. Same typed-column remap table; same handling of
 * skipRawRow tables. The row's `id` is returned alongside the CsvRow
 * because callers need it for the cursor (the CsvRow itself excludes
 * `id` to match the original CSV column shape).
 */
export async function loadDatasetRowsPage(
  scopeId: string,
  batchId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table types are complex unions
  table: any,
  options: { cursor: string | null; limit: number }
): Promise<{
  rows: CsvRow[];
  rowIds: string[];
  nextCursor: string | null;
}> {
  if (!batchId) return { rows: [], rowIds: [], nextCursor: null };
  const db = await getDb();
  if (!db) return { rows: [], rowIds: [], nextCursor: null };

  const NAME_SYMBOL = Symbol.for("drizzle:Name");
  const tableName: string | undefined =
    (table as unknown as { [k: symbol]: unknown })?.[NAME_SYMBOL] as
      | string
      | undefined;
  const remap = tableName ? TYPED_COLUMN_TO_CSV_KEY[tableName] : undefined;
  const skipRawRow = tableName ? SKIP_RAW_ROW_TABLES.has(tableName) : false;

  const selectCols = skipRawRow
    ? (() => {
        const cols: Record<string, unknown> = {};
        const fromTable = table as Record<string, unknown>;
        for (const [col, val] of Object.entries(fromTable)) {
          if (col === "rawRow") continue;
          cols[col] = val;
        }
        return cols;
      })()
    : undefined;

  const { gt } = await import("drizzle-orm");
  const limitPlusOne = options.limit + 1;
  const cursorClause = options.cursor ? gt(table.id, options.cursor) : undefined;
  const whereClause = cursorClause
    ? and(eq(table.scopeId, scopeId), eq(table.batchId, batchId), cursorClause)
    : and(eq(table.scopeId, scopeId), eq(table.batchId, batchId));

  const rawRows = await withDbRetry("load dataset rows page", () =>
    selectCols
      ? db
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic column set
          .select(selectCols as any)
          .from(table)
          .where(whereClause)
          .orderBy(table.id)
          .limit(limitPlusOne)
      : db
          .select()
          .from(table)
          .where(whereClause)
          .orderBy(table.id)
          .limit(limitPlusOne)
  );

  const fetched = rawRows as Record<string, unknown>[];
  const hasMore = fetched.length > options.limit;
  const sliced = hasMore ? fetched.slice(0, options.limit) : fetched;
  const rows = sliced.map((row) => reconstructCsvRow(row, remap));
  const rowIds = sliced.map((row) => String(row.id ?? ""));
  const nextCursor = hasMore ? rowIds[rowIds.length - 1] : null;

  return { rows, rowIds, nextCursor };
}

/**
 * 2026-05-08 (consolidation) — shared streaming helper that walks an
 * `srDs*` table page-by-page and feeds each page to a caller-supplied
 * accumulator. Replaces the two near-identical local copies in
 * `loadPerformanceRatioInput.ts` and `buildOfflineMonitoringAggregates.ts`
 * (the latter's CLAUDE.md note explicitly called out this consolidation
 * as the right next step "if a third aggregator wants the same
 * primitive").
 *
 * Cursor-paginated via `loadDatasetRowsPage` (already proven on
 * convertedReads). Default page size is 2,500 rows — matches the
 * post-#488 per-page allocation budget and stays uniform across the
 * build step.
 *
 * Logs progress every page-1, page % 10, and the terminal page; the
 * caller passes `logPrefix` (e.g. `[loadPerformanceRatioInput]`) and
 * an optional `label` (e.g. `"abpReport"`) which renders as
 * `[<prefix>] streamed [<label> ]page=N totalRows=K heapUsed=...MB`.
 *
 * Returns the total number of rows that were emitted to the
 * accumulator (sum of every page's `rows.length`).
 */
const SHARED_STREAM_PAGE_SIZE_DEFAULT = 2_500;

export async function streamDatasetRowsPage(
  scopeId: string,
  batchId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table types are complex unions
  table: any,
  onPage: (rows: CsvRow[]) => void | Promise<void>,
  options: {
    pageSize?: number;
    logPrefix?: string;
    label?: string;
  } = {}
): Promise<number> {
  const pageSize = options.pageSize ?? SHARED_STREAM_PAGE_SIZE_DEFAULT;
  const logPrefix = options.logPrefix ?? "[dataset-stream]";
  const labelSegment = options.label ? `${options.label} ` : "";
  let cursor: string | null = null;
  let totalRows = 0;
  let pageCount = 0;
  for (;;) {
    const page = await loadDatasetRowsPage(scopeId, batchId, table, {
      cursor,
      limit: pageSize,
    });
    if (page.rows.length > 0) {
      await onPage(page.rows);
    }
    totalRows += page.rows.length;
    pageCount += 1;
    if (pageCount === 1 || pageCount % 10 === 0 || !page.nextCursor) {
      process.stdout.write(
        `${logPrefix} streamed ${labelSegment}page=${pageCount} ` +
          `totalRows=${totalRows} ` +
          `heapUsed=${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB\n`
      );
    }
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return totalRows;
}

// ---------------------------------------------------------------------------
// Build snapshot
// ---------------------------------------------------------------------------

/**
 * Build or retrieve a cached system snapshot for a scope.
 *
 * 1. Compute the input version hash from active dataset versions
 * 2. Check if a completed compute run exists for this hash
 * 3. If yes, return cached (the snapshot rows are already in the DB)
 * 4. If no, claim a compute run, load data, run buildSystems, store results
 *
 * Returns: { systems, fromCache, inputVersionHash }
 */
export async function getOrBuildSystemSnapshot(scopeId: string): Promise<{
  systems: unknown[]; // SystemRecord[] — typed as unknown to avoid client-type dependency
  fromCache: boolean;
  inputVersionHash: string;
  runId: string | null;
  building: boolean;
}> {
  const inputVersionHash = await computeSystemSnapshotHash(scopeId);
  const { resolveSolarRecOwnerUserId } = await import("../../_core/solarRecAuth");
  const ownerUserId = await resolveSolarRecOwnerUserId();
  const cached = await readSystemSnapshotCache(
    scopeId,
    inputVersionHash,
    ownerUserId
  );
  if (cached !== null) {
    return {
      systems: cached,
      fromCache: true,
      inputVersionHash,
      runId: null,
      building: false,
    };
  }

  // ------------------------------------------------------------
  // No cache — check for an in-progress compute. Stuck-run self-
  // heal kicks in if the row has been in "running" for > 10 min.
  // ------------------------------------------------------------
  const existing = await getComputeRun(
    scopeId,
    SYSTEM_SNAPSHOT_ARTIFACT_TYPE,
    inputVersionHash
  );
  const now = Date.now();
  let reclaimedExistingRun = false;

  if (existing?.status === "running") {
    const startedAtMs = existing.startedAt
      ? new Date(existing.startedAt).getTime()
      : 0;
    const ageMs = now - startedAtMs;
    if (ageMs < STUCK_RUN_THRESHOLD_MS) {
      const racedCache = await readSystemSnapshotCache(
        scopeId,
        inputVersionHash,
        ownerUserId
      );
      if (racedCache !== null) {
        return {
          systems: racedCache,
          fromCache: true,
          inputVersionHash,
          runId: existing.id,
          building: false,
        };
      }

      return {
        systems: [],
        fromCache: false,
        inputVersionHash,
        runId: existing.id,
        building: true,
      };
    }
    console.warn(
      `[buildSystemSnapshot] reclaiming stale run ${existing.id} (age ${Math.round(ageMs / 1000)}s)`
    );
    await reclaimComputeRun(existing.id);
    reclaimedExistingRun = true;
  }

  // ------------------------------------------------------------
  // Claim a run (or reuse an existing row) and kick off the actual
  // compute in the background. We do not
  // await it — the tRPC request returns immediately with
  // building=true and the client polls until fromCache=true.
  // ------------------------------------------------------------
  let runId: string | null;
  if (
    existing &&
    (existing.status === "running" ||
      existing.status === "failed" ||
      existing.status === "completed")
  ) {
    if (!reclaimedExistingRun) {
      await reclaimComputeRun(existing.id);
    }
    runId = existing.id;
  } else {
    runId = await claimComputeRun({
      scopeId,
      artifactType: SYSTEM_SNAPSHOT_ARTIFACT_TYPE,
      inputVersionHash,
      status: "running",
      rowCount: null,
      error: null,
    });
  }

  if (!runId) {
    const racedCache = await readSystemSnapshotCache(
      scopeId,
      inputVersionHash,
      ownerUserId
    );
    if (racedCache !== null) {
      return {
        systems: racedCache,
        fromCache: true,
        inputVersionHash,
        runId: null,
        building: false,
      };
    }

    return {
      systems: [],
      fromCache: false,
      inputVersionHash,
      runId: null,
      building: true,
    };
  }

  // Fire-and-forget background compute. Errors are logged and
  // recorded on the compute_run row; the HTTP caller does not wait.
  const claimedRunId = runId;
  void (async () => {
    try {
      const systems = await runComputeInline(scopeId, inputVersionHash);
      await writeSystemSnapshotCache(
        scopeId,
        inputVersionHash,
        ownerUserId,
        systems
      );
      await completeComputeRun(claimedRunId, systems.length);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "System snapshot build failed";
      console.error(
        `[buildSystemSnapshot] compute ${claimedRunId} failed:`,
        message
      );
      await failComputeRun(claimedRunId, message);
    }
  })();

  return {
    systems: [],
    fromCache: false,
    inputVersionHash,
    runId: claimedRunId,
    building: true,
  };
}

function parseSystemSnapshotPayload(payload: string): unknown[] | null {
  try {
    const parsed = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { encoding?: unknown }).encoding === "gzip-base64-json" &&
      typeof (parsed as { data?: unknown }).data === "string"
    ) {
      const compressed = Buffer.from(
        (parsed as { data: string }).data,
        "base64"
      );
      const json = gunzipSync(compressed).toString("utf8");
      const decoded = JSON.parse(json);
      return Array.isArray(decoded) ? decoded : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function readSystemSnapshotCache(
  scopeId: string,
  inputVersionHash: string,
  ownerUserId: number
): Promise<unknown[] | null> {
  const artifact = await getComputedArtifact(
    scopeId,
    SYSTEM_SNAPSHOT_ARTIFACT_TYPE,
    inputVersionHash
  );
  if (artifact?.payload) {
    const parsed = parseSystemSnapshotPayload(artifact.payload);
    if (parsed !== null) {
      return parsed;
    }
  }

  // Temporary fallback until the computed-artifact migration is applied.
  const { readCachedSnapshot } = await import("./systemSnapshotCache");
  return readCachedSnapshot(ownerUserId, inputVersionHash);
}

async function writeSystemSnapshotCache(
  scopeId: string,
  inputVersionHash: string,
  ownerUserId: number,
  systems: unknown[]
): Promise<void> {
  const serializedSystems = JSON.stringify(systems);
  const { writeSerializedCachedSnapshot } = await import("./systemSnapshotCache");

  // The legacy chunked cache is proven to handle the current 50MB+ payload,
  // so write it first and treat the single-row artifact cache as best-effort.
  const legacyStored = await writeSerializedCachedSnapshot(
    ownerUserId,
    inputVersionHash,
    serializedSystems
  );

  let artifactStored = false;
  try {
    const compressedPayload = JSON.stringify({
      encoding: "gzip-base64-json",
      data: gzipSync(Buffer.from(serializedSystems, "utf8")).toString("base64"),
    });

    await upsertComputedArtifact({
      scopeId,
      artifactType: SYSTEM_SNAPSHOT_ARTIFACT_TYPE,
      inputVersionHash,
      payload: compressedPayload,
      rowCount: systems.length,
    });
    artifactStored = true;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown system snapshot cache error";
    console.warn(`[buildSystemSnapshot] artifact cache write skipped: ${message}`);
  }

  if (!legacyStored && !artifactStored) {
    throw new Error("Failed to persist system snapshot cache");
  }
}

/**
 * The actual compute work — synchronous from the caller's view but
 * invoked from a fire-and-forget wrapper so the HTTP request that
 * triggered it doesn't block.
 */
async function runComputeInline(
  scopeId: string,
  inputVersionHash: string
): Promise<unknown[]> {
  const startTime = Date.now();
  const versions = await getActiveVersionsForKeys(
    scopeId,
    SYSTEM_SNAPSHOT_DEPS as unknown as string[]
  );
  const versionMap = new Map(versions.map((v) => [v.datasetKey, v.batchId]));

  const [
    solarApplicationsRows,
    abpReportRows,
    generationEntryRows,
    accountSolarGenerationRows,
    contractedDateRows,
    deliveryScheduleBaseRows,
    transferHistoryRows,
  ] = await Promise.all([
    loadDatasetRows(scopeId, versionMap.get("solarApplications") ?? null, srDsSolarApplications),
    loadDatasetRows(scopeId, versionMap.get("abpReport") ?? null, srDsAbpReport),
    loadDatasetRows(scopeId, versionMap.get("generationEntry") ?? null, srDsGenerationEntry),
    loadDatasetRows(scopeId, versionMap.get("accountSolarGeneration") ?? null, srDsAccountSolarGeneration),
    loadDatasetRows(scopeId, versionMap.get("contractedDate") ?? null, srDsContractedDate),
    loadDatasetRows(scopeId, versionMap.get("deliveryScheduleBase") ?? null, srDsDeliverySchedule),
    loadDatasetRows(scopeId, versionMap.get("transferHistory") ?? null, srDsTransferHistory),
  ]);

  const loadMs = Date.now() - startTime;
  const part2VerifiedAbpRows = abpReportRows;
  const { buildSystems } = await import(
    "../../../client/src/solar-rec-dashboard/lib/buildSystems"
  );
  const systems = buildSystems({
    part2VerifiedAbpRows,
    solarApplicationsRows,
    contractedDateRows,
    accountSolarGenerationRows,
    generationEntryRows,
    transferHistoryRows,
    deliveryScheduleBaseRows,
  });
  const totalMs = Date.now() - startTime;
  console.log(
    `[buildSystemSnapshot] hash=${inputVersionHash.slice(0, 10)} ` +
      `loaded=${solarApplicationsRows.length + abpReportRows.length + generationEntryRows.length + accountSolarGenerationRows.length + contractedDateRows.length + deliveryScheduleBaseRows.length + transferHistoryRows.length}rows ` +
      `systems=${systems.length} loadMs=${loadMs} totalMs=${totalMs}`
  );
  return systems;
}
