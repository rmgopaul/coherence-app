/**
 * Server-side delivery tracker snapshot builder.
 *
 * Same pattern as buildSystemSnapshot: loads normalized DB rows,
 * reconstructs CsvRow[] arrays, calls the EXISTING client-side
 * buildDeliveryTrackerData() pure function.
 *
 * Dependencies: 2 datasets (deliveryScheduleBase, transferHistory).
 * Per-artifact version hash — independent from system snapshot.
 */

import { createHash } from "node:crypto";
import {
  srDsDeliverySchedule,
  srDsTransferHistory,
} from "../../../drizzle/schema";
import {
  claimComputeRun,
  getComputeRun,
  completeComputeRun,
  failComputeRun,
  getActiveVersionsForKeys,
} from "../../db/solarRecDatasets";

// Re-use the same loadDatasetRows helper pattern from buildSystemSnapshot.
// TODO: Extract to a shared utility once Step 4 and Step 6 both stabilize.
import { getDb, withDbRetry } from "../../db/_core";
import { and, eq } from "drizzle-orm";

type CsvRow = Record<string, string>;

const DELIVERY_DEPS = ["deliveryScheduleBase", "transferHistory"] as const;

// ---------------------------------------------------------------------------
// Version hash (2-dataset dependency)
// ---------------------------------------------------------------------------

export async function computeDeliveryHash(scopeId: string): Promise<string> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    DELIVERY_DEPS as unknown as string[]
  );
  const sorted = versions
    .map((v) => `${v.datasetKey}:${v.batchId}`)
    .sort();
  return createHash("sha256").update(sorted.join("|")).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Load rows from DB
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadRows(scopeId: string, batchId: string | null, table: any): Promise<CsvRow[]> {
  if (!batchId) return [];
  const db = await getDb();
  if (!db) return [];

  const rows = await withDbRetry("load delivery rows", () =>
    db.select().from(table).where(and(eq(table.scopeId, scopeId), eq(table.batchId, batchId)))
  );

  return (rows as Record<string, unknown>[]).map((row) => {
    const rawRowStr = row.rawRow as string | null;
    const base: CsvRow = rawRowStr ? JSON.parse(rawRowStr) : {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "id" || key === "scopeId" || key === "batchId" || key === "rawRow" || key === "createdAt") continue;
      if (value !== null && value !== undefined) base[key] = String(value);
    }
    return base;
  });
}

// ---------------------------------------------------------------------------
// Build delivery tracker data
// ---------------------------------------------------------------------------

export async function getOrBuildDeliverySnapshot(scopeId: string): Promise<{
  data: unknown;
  fromCache: boolean;
  inputVersionHash: string;
}> {
  const inputVersionHash = await computeDeliveryHash(scopeId);

  // Check for existing completed run
  const existing = await getComputeRun(scopeId, "delivery_allocations", inputVersionHash);
  if (existing?.status === "completed") {
    // TODO: Load cached result from a delivery fact table.
  }

  if (existing?.status === "running") {
    return { data: null, fromCache: false, inputVersionHash };
  }

  // Claim the run
  const runId = await claimComputeRun({
    scopeId,
    artifactType: "delivery_allocations",
    inputVersionHash,
    status: "running",
    rowCount: null,
    error: null,
  });

  if (!runId) {
    return { data: null, fromCache: false, inputVersionHash };
  }

  try {
    const versions = await getActiveVersionsForKeys(
      scopeId,
      DELIVERY_DEPS as unknown as string[]
    );
    const versionMap = new Map(versions.map((v) => [v.datasetKey, v.batchId]));

    const [scheduleRows, transferRows] = await Promise.all([
      loadRows(scopeId, versionMap.get("deliveryScheduleBase") ?? null, srDsDeliverySchedule),
      loadRows(scopeId, versionMap.get("transferHistory") ?? null, srDsTransferHistory),
    ]);

    // Import and call the existing pure function
    const { buildDeliveryTrackerData } = await import(
      "../../../client/src/solar-rec-dashboard/lib/buildDeliveryTrackerData"
    );

    const data = buildDeliveryTrackerData({ scheduleRows, transferRows });

    await completeComputeRun(runId, data.rows?.length ?? 0);

    return { data, fromCache: false, inputVersionHash };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delivery snapshot build failed";
    await failComputeRun(runId, message);
    throw err;
  }
}
