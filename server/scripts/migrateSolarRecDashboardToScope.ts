/**
 * Task 1.2b PR C — one-shot S3 migration from per-user paths to
 * scope-keyed paths.
 *
 * Context: PR A added `scopeId` to `solarRecDashboardStorage` and
 * `solarRecDatasetSyncState` (backfilled to `scope-user-${userId}`).
 * PR B flipped reads/writes to scope-keyed DB filters and S3 paths,
 * with a read-compat shim that falls back to the legacy
 * `solar-rec-dashboard/${userId}/…` S3 prefix for data written
 * before PR B deployed.
 *
 * This script copies existing S3 blobs forward so the shim can
 * retire. Copy only; no deletes. Idempotent — safe to re-run.
 *
 * Usage:
 *   pnpm solarrec:migrate-scope               # live migration
 *   pnpm solarrec:migrate-scope --dry-run     # list work, no writes
 *   pnpm solarrec:migrate-scope --user-id N   # limit to one userId
 *
 * Migrates two S3 path families per row the DB knows about:
 *   - `state` storageKey → `state.json`
 *   - `dataset:${key}` → `datasets/${key}.json`
 *   - (plus `deliveryScheduleBase` is covered as
 *     `dataset:deliveryScheduleBase` by the saveDataset path today)
 *
 * Schedule B upload paths (`schedule-b/${jobId}/…`) are transient
 * file uploads not tracked in `solarRecDashboardStorage`; they're
 * intentionally skipped. If a future uploaded file needs to be
 * preserved, re-run the Schedule B import.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  solarRecDashboardStorage,
  solarRecDatasetSyncState,
} from "../../drizzle/schema";
import { resolveSolarRecScopeId } from "../_core/solarRecAuth";
import { storageExists, storageGet, storagePut } from "../storage";

type ScriptOptions = {
  dryRun: boolean;
  userId: number | null;
};

function parseArgs(argv: string[]): ScriptOptions {
  let dryRun = false;
  let userId: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--dry-run") dryRun = true;
    if (token === "--user-id" && argv[i + 1]) {
      const parsed = Number(argv[i + 1]);
      if (Number.isFinite(parsed) && parsed > 0) userId = Math.trunc(parsed);
      i += 1;
    }
  }
  return { dryRun, userId };
}

function storageKeyToRelativePath(storageKey: string): string | null {
  if (storageKey === "state") return "state.json";
  if (storageKey.startsWith("dataset:")) {
    const rawKey = storageKey.slice("dataset:".length);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(rawKey)) return null;
    return `datasets/${rawKey}.json`;
  }
  // Non-S3 DB-only keys (e.g. snapshot:system:*, abpSettlement:*).
  return null;
}

async function copyObject(
  fromKey: string,
  toKey: string
): Promise<{ copied: boolean; reason: string }> {
  if (await storageExists(toKey)) {
    return { copied: false, reason: "destination already exists" };
  }
  if (!(await storageExists(fromKey))) {
    return { copied: false, reason: "source missing" };
  }
  const { url } = await storageGet(fromKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) {
    return {
      copied: false,
      reason: `source read failed with HTTP ${response.status}`,
    };
  }
  const bytes = await response.arrayBuffer();
  const contentType =
    response.headers.get("content-type") ?? "application/octet-stream";
  await storagePut(toKey, Buffer.from(bytes), contentType);
  return { copied: true, reason: "ok" };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await getDb();
  if (!db) {
    console.error("[migrate-scope] DB not configured. Set DATABASE_URL.");
    process.exit(1);
  }

  const scopeId = await resolveSolarRecScopeId();
  console.log(
    `[migrate-scope] target scope: ${scopeId}${
      options.dryRun ? " (dry run)" : ""
    }${options.userId !== null ? ` (userId=${options.userId})` : ""}`
  );

  // Gather all (userId, storageKey) pairs the DB knows about. Dedupe
  // the pair across both tables so a single rename copies exactly one
  // S3 blob.
  const dashboardRows = await db
    .selectDistinct({
      userId: solarRecDashboardStorage.userId,
      storageKey: solarRecDashboardStorage.storageKey,
    })
    .from(solarRecDashboardStorage)
    .orderBy(
      asc(solarRecDashboardStorage.userId),
      asc(solarRecDashboardStorage.storageKey)
    );

  const syncStateRows = await db
    .selectDistinct({
      userId: solarRecDatasetSyncState.userId,
      storageKey: solarRecDatasetSyncState.storageKey,
    })
    .from(solarRecDatasetSyncState)
    .orderBy(
      asc(solarRecDatasetSyncState.userId),
      asc(solarRecDatasetSyncState.storageKey)
    );

  const seen = new Set<string>();
  const pairs: Array<{ userId: number; storageKey: string }> = [];
  for (const row of [...dashboardRows, ...syncStateRows]) {
    const tag = `${row.userId}:${row.storageKey}`;
    if (seen.has(tag)) continue;
    if (options.userId !== null && row.userId !== options.userId) continue;
    seen.add(tag);
    pairs.push({ userId: row.userId, storageKey: row.storageKey });
  }

  console.log(
    `[migrate-scope] ${pairs.length} (userId, storageKey) pairs to inspect`
  );

  let copied = 0;
  let skippedAlreadyMigrated = 0;
  let skippedNonS3 = 0;
  let skippedSourceMissing = 0;
  let failed = 0;

  for (const pair of pairs) {
    const relativePath = storageKeyToRelativePath(pair.storageKey);
    if (!relativePath) {
      skippedNonS3 += 1;
      continue;
    }
    const legacyKey = `solar-rec-dashboard/${pair.userId}/${relativePath}`;
    const scopeKey = `solar-rec-dashboard/${scopeId}/${relativePath}`;

    if (options.dryRun) {
      console.log(`  would copy ${legacyKey} -> ${scopeKey}`);
      continue;
    }

    try {
      const result = await copyObject(legacyKey, scopeKey);
      if (result.copied) {
        copied += 1;
        console.log(`  copied ${legacyKey} -> ${scopeKey}`);
      } else if (result.reason === "destination already exists") {
        skippedAlreadyMigrated += 1;
      } else if (result.reason === "source missing") {
        skippedSourceMissing += 1;
      } else {
        failed += 1;
        console.warn(`  skipped ${legacyKey}: ${result.reason}`);
      }
    } catch (error) {
      failed += 1;
      console.error(
        `  error copying ${legacyKey}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Sanity check: the sync-state count should match the dashboard
  // count when a pair appears in both tables. Report imbalance so an
  // operator can investigate orphaned rows.
  const dashboardUserIds = new Set(dashboardRows.map((row) => row.userId));
  const syncUserIds = new Set(syncStateRows.map((row) => row.userId));
  const missingSync = Array.from(dashboardUserIds).filter(
    (uid) => !syncUserIds.has(uid)
  );
  const missingDashboard = Array.from(syncUserIds).filter(
    (uid) => !dashboardUserIds.has(uid)
  );

  console.log("---");
  console.log(`[migrate-scope] copied:                ${copied}`);
  console.log(`[migrate-scope] skipped (already done): ${skippedAlreadyMigrated}`);
  console.log(`[migrate-scope] skipped (source missing): ${skippedSourceMissing}`);
  console.log(`[migrate-scope] skipped (non-S3 key):   ${skippedNonS3}`);
  console.log(`[migrate-scope] failed:                 ${failed}`);
  if (missingSync.length > 0) {
    console.log(
      `[migrate-scope] warn: userIds with dashboard rows but no sync state: ${missingSync.join(", ")}`
    );
  }
  if (missingDashboard.length > 0) {
    console.log(
      `[migrate-scope] warn: userIds with sync state but no dashboard rows: ${missingDashboard.join(", ")}`
    );
  }

  if (failed > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[migrate-scope] fatal:", error);
    process.exit(1);
  });

// Shut up unused import warnings for `eq`/`inArray` — they're not
// needed in this version but may be useful if the script is extended
// to filter by specific storageKey later.
void eq;
void inArray;
