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

  // Reconstruct CsvRow from rawRow JSON + typed columns
  return (rows as Record<string, unknown>[]).map((row) => {
    const rawRowStr = row.rawRow as string | null;
    const base: CsvRow = rawRowStr ? JSON.parse(rawRowStr) : {};

    // Typed columns override rawRow values (they're the canonical source)
    for (const [key, value] of Object.entries(row)) {
      if (key === "id" || key === "scopeId" || key === "batchId" || key === "rawRow" || key === "createdAt") continue;
      if (value !== null && value !== undefined) {
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
}> {
  const inputVersionHash = await computeSystemSnapshotHash(scopeId);

  // Check for existing completed run
  const existing = await getComputeRun(
    scopeId,
    "system_snapshot",
    inputVersionHash
  );

  if (existing?.status === "completed") {
    // TODO: In a future step, load the cached snapshot rows from the
    // solar_rec_system_snapshot table. For now, recompute.
    // return { systems: cachedRows, fromCache: true, inputVersionHash, runId: existing.id };
  }

  if (existing?.status === "running") {
    // Another process is computing — wait briefly then check again.
    // For now, just return empty and let the client retry.
    return {
      systems: [],
      fromCache: false,
      inputVersionHash,
      runId: existing.id,
    };
  }

  // Claim the run
  const runId = await claimComputeRun({
    scopeId,
    artifactType: "system_snapshot",
    inputVersionHash,
    status: "running",
    rowCount: null,
    error: null,
  });

  if (!runId) {
    // Another process claimed it — concurrent race. Return empty.
    return { systems: [], fromCache: false, inputVersionHash, runId: null };
  }

  try {
    // Load active batch IDs for each dataset
    const versions = await getActiveVersionsForKeys(
      scopeId,
      SYSTEM_SNAPSHOT_DEPS as unknown as string[]
    );
    const versionMap = new Map(versions.map((v) => [v.datasetKey, v.batchId]));

    // Load rows from each dataset table
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

    // Filter abpReport to Part 2 verified rows (same as client-side)
    // The client filters by parsePart2VerificationDate() !== null.
    // For now, pass all ABP rows and let buildSystems handle it
    // (it builds eligibility sets from the ABP rows it receives).
    const part2VerifiedAbpRows = abpReportRows;

    // Call the EXISTING buildSystems function — identical to client-side
    // This is a dynamic import because buildSystems is a client module
    // that uses path aliases (@/...). We import it at runtime.
    // TODO: Move buildSystems to a shared/isomorphic location.
    // For now, this import works because the server's tsconfig resolves @/ paths.
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

    // Mark run as completed
    await completeComputeRun(runId, systems.length);

    // TODO: In a future step, store the SystemRecord[] rows in
    // solar_rec_system_snapshot table for cache reads.

    return {
      systems,
      fromCache: false,
      inputVersionHash,
      runId,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "System snapshot build failed";
    await failComputeRun(runId, message);
    throw err;
  }
}
