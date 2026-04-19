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
import { gzipSync, gunzipSync } from "node:zlib";
import {
  srDsDeliverySchedule,
  srDsTransferHistory,
} from "../../../drizzle/schema";
import {
  claimComputeRun,
  getComputeRun,
  reclaimComputeRun,
  completeComputeRun,
  failComputeRun,
  getActiveVersionsForKeys,
  getComputedArtifact,
  upsertComputedArtifact,
} from "../../db/solarRecDatasets";

// Re-use the same loadDatasetRows helper pattern from buildSystemSnapshot.
// TODO: Extract to a shared utility once Step 4 and Step 6 both stabilize.
import { getDb, withDbRetry } from "../../db/_core";
import { and, eq } from "drizzle-orm";

type CsvRow = Record<string, string>;

const DELIVERY_DEPS = ["deliveryScheduleBase", "transferHistory"] as const;
const DELIVERY_ARTIFACT_TYPE = "delivery_allocations";
const STUCK_RUN_THRESHOLD_MS = 10 * 60 * 1000;

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
  runId: string | null;
  building: boolean;
}> {
  const inputVersionHash = await computeDeliveryHash(scopeId);
  const cached = await readDeliverySnapshotCache(scopeId, inputVersionHash);

  if (cached !== null) {
    return {
      data: cached,
      fromCache: true,
      inputVersionHash,
      runId: null,
      building: false,
    };
  }

  const existing = await getComputeRun(
    scopeId,
    DELIVERY_ARTIFACT_TYPE,
    inputVersionHash
  );

  if (existing?.status === "running") {
    const startedAtMs = existing.startedAt
      ? new Date(existing.startedAt).getTime()
      : 0;
    const ageMs = Date.now() - startedAtMs;
    if (ageMs < STUCK_RUN_THRESHOLD_MS) {
      const racedCache = await readDeliverySnapshotCache(scopeId, inputVersionHash);
      if (racedCache !== null) {
        return {
          data: racedCache,
          fromCache: true,
          inputVersionHash,
          runId: existing.id,
          building: false,
        };
      }

      return {
        data: null,
        fromCache: false,
        inputVersionHash,
        runId: existing.id,
        building: true,
      };
    }

    await reclaimComputeRun(existing.id);
  }

  let runId: string | null;
  if (
    existing &&
    (existing.status === "running" ||
      existing.status === "failed" ||
      existing.status === "completed")
  ) {
    if (existing.status !== "running") {
      await reclaimComputeRun(existing.id);
    }
    runId = existing.id;
  } else {
    runId = await claimComputeRun({
      scopeId,
      artifactType: DELIVERY_ARTIFACT_TYPE,
      inputVersionHash,
      status: "running",
      rowCount: null,
      error: null,
    });
  }

  if (!runId) {
    const racedCache = await readDeliverySnapshotCache(scopeId, inputVersionHash);
    if (racedCache !== null) {
      return {
        data: racedCache,
        fromCache: true,
        inputVersionHash,
        runId: null,
        building: false,
      };
    }

    return {
      data: null,
      fromCache: false,
      inputVersionHash,
      runId: null,
      building: true,
    };
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

    await writeDeliverySnapshotCache(scopeId, inputVersionHash, data);
    await completeComputeRun(runId, getDeliverySnapshotRowCount(data));

    return {
      data,
      fromCache: false,
      inputVersionHash,
      runId,
      building: false,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delivery snapshot build failed";
    await failComputeRun(runId, message);
    throw err;
  }
}

async function readDeliverySnapshotCache(
  scopeId: string,
  inputVersionHash: string
): Promise<unknown | null> {
  const artifact = await getComputedArtifact(
    scopeId,
    DELIVERY_ARTIFACT_TYPE,
    inputVersionHash
  );
  if (!artifact?.payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(artifact.payload);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { encoding?: unknown }).encoding === "gzip-base64-json" &&
      typeof (parsed as { data?: unknown }).data === "string"
    ) {
      const json = gunzipSync(
        Buffer.from((parsed as { data: string }).data, "base64")
      ).toString("utf8");
      return JSON.parse(json);
    }
    return parsed;
  } catch {
    return null;
  }
}

function getDeliverySnapshotRowCount(data: unknown): number {
  if (!data || typeof data !== "object") return 0;
  const rows = (data as { rows?: unknown }).rows;
  return Array.isArray(rows) ? rows.length : 0;
}

async function writeDeliverySnapshotCache(
  scopeId: string,
  inputVersionHash: string,
  data: unknown
): Promise<void> {
  const serializedData = JSON.stringify(data);
  const compressedPayload = JSON.stringify({
    encoding: "gzip-base64-json",
    data: gzipSync(Buffer.from(serializedData, "utf8")).toString("base64"),
  });

  await upsertComputedArtifact({
    scopeId,
    artifactType: DELIVERY_ARTIFACT_TYPE,
    inputVersionHash,
    payload: compressedPayload,
    rowCount: getDeliverySnapshotRowCount(data),
  });
}
