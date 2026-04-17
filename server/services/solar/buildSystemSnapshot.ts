/**
 * Server-side system snapshot builder.
 *
 * Loads the 7 core datasets from normalized DB tables, reconstructs
 * CsvRow[] arrays, calls the EXISTING buildSystems() pure function
 * (identical to the client-side version), and stores the output
 * as solar_rec_system_snapshot rows.
 *
 * This approach preserves golden-test parity: same function, same
 * input format, same output. The only difference is where the data
 * comes from (DB) and where the result goes (DB table).
 */

import { eq, and } from "drizzle-orm";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import {
  srDsSolarApplications,
  srDsAbpReport,
  srDsGenerationEntry,
  srDsAccountSolarGeneration,
  srDsContractedDate,
  srDsDeliverySchedule,
  srDsTransferHistory,
  solarRecActiveDatasetVersions,
} from "../../../drizzle/schema";
import { getDb, withDbRetry } from "../../db/_core";
import {
  claimComputeRun,
  reclaimComputeRun,
  getComputeRun,
  completeComputeRun,
  failComputeRun,
  getActiveVersionsForKeys,
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
 * Only needed for tables that don't have a rawRow column (where we
 * must reconstruct the CSV-style keys buildSystems reads from the
 * typed columns alone). For tables WITH rawRow, all CSV keys come
 * from the JSON blob and this mapping is a no-op.
 */
const TYPED_COLUMN_TO_CSV_KEY: Record<string, Record<string, string>> = {
  srDsContractedDate: {
    systemId: "id",
    contractedDate: "contracted",
  },
};

/**
 * Load rows from a dataset table and reconstruct CsvRow[] from
 * typed columns + rawRow JSON. Works with any of the 7 tables.
 */
async function loadDatasetRows(
  scopeId: string,
  batchId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle table types are complex unions
  table: any
): Promise<CsvRow[]> {
  if (!batchId) return [];
  const db = await getDb();
  if (!db) return [];

  const rows = await withDbRetry("load dataset rows", () =>
    db
      .select()
      .from(table)
      .where(and(eq(table.scopeId, scopeId), eq(table.batchId, batchId)))
  );

  const tableName: string | undefined =
    (table as { _?: { name?: string } })?._?.name ??
    (table as { name?: string })?.name;
  const remap = tableName ? TYPED_COLUMN_TO_CSV_KEY[tableName] : undefined;

  // Reconstruct CsvRow from rawRow JSON + typed columns.
  return (rows as Record<string, unknown>[]).map((row) => {
    const rawRowStr = row.rawRow as string | null;
    const base: CsvRow = rawRowStr ? JSON.parse(rawRowStr) : {};

    // For tables without rawRow, the typed columns are the only
    // source of truth. Apply the per-table column→CSV mapping so
    // buildSystems finds the keys it expects (e.g. `id`, `contracted`
    // for contractedDate rather than `systemId`, `contractedDate`).
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
  });
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
  const { readCachedSnapshot, writeCachedSnapshot } = await import(
    "./systemSnapshotCache"
  );

  // ------------------------------------------------------------
  // Fast path: serve from cache if we have a result for this hash.
  // ------------------------------------------------------------
  const cached = await readCachedSnapshot(ownerUserId, inputVersionHash);
  if (cached) {
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
    "system_snapshot",
    inputVersionHash
  );

  const STUCK_RUN_THRESHOLD_MS = 10 * 60 * 1000;
  const now = Date.now();

  if (existing?.status === "running") {
    const startedAtMs = existing.startedAt
      ? new Date(existing.startedAt).getTime()
      : 0;
    const ageMs = now - startedAtMs;
    if (ageMs < STUCK_RUN_THRESHOLD_MS) {
      // Compute actively running — client should poll.
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
  }

  // ------------------------------------------------------------
  // Claim a run (or reuse an existing row in running/failed state)
  // and kick off the actual compute in the background. We DO NOT
  // await it — the tRPC request returns immediately with
  // building=true and the client polls until fromCache=true.
  // ------------------------------------------------------------
  let runId: string | null;
  if (existing && (existing.status === "running" || existing.status === "failed")) {
    if (existing.status === "failed") {
      await reclaimComputeRun(existing.id);
    }
    runId = existing.id;
  } else {
    runId = await claimComputeRun({
      scopeId,
      artifactType: "system_snapshot",
      inputVersionHash,
      status: "running",
      rowCount: null,
      error: null,
    });
  }

  if (!runId) {
    // Another process won the claim race — return building=true so
    // the client polls for its result.
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
      await writeCachedSnapshot(ownerUserId, inputVersionHash, systems);
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
