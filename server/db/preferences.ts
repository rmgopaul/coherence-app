import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  inArray,
  like,
  getDb,
  withDbRetry,
  ensureSolarRecDashboardStorageTable,
  ensureSolarRecDatasetSyncStateTable,
  splitIntoChunks,
  SOLAR_REC_DB_CHUNK_CHARS,
} from "./_core";
import {
  userPreferences,
  InsertUserPreference,
  solarRecDashboardStorage,
  solarRecDatasetSyncState,
} from "../../drizzle/schema";

export async function getUserPreferences(userId: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load user preferences", async () =>
    db.select().from(userPreferences)
      .where(eq(userPreferences.userId, userId))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function upsertUserPreferences(prefs: InsertUserPreference) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load user preferences before upsert", async () =>
    db
      .select({ id: userPreferences.id })
      .from(userPreferences)
      .where(eq(userPreferences.userId, prefs.userId))
      .limit(1)
  );

  if (existing.length > 0) {
    const updatePayload: Partial<InsertUserPreference> & { updatedAt: Date } = {
      updatedAt: now,
    };
    if (prefs.displayName !== undefined) updatePayload.displayName = prefs.displayName;
    if (prefs.enabledWidgets !== undefined) updatePayload.enabledWidgets = prefs.enabledWidgets;
    if (prefs.widgetLayout !== undefined) updatePayload.widgetLayout = prefs.widgetLayout;
    if (prefs.theme !== undefined) updatePayload.theme = prefs.theme;

    await withDbRetry("update user preferences", async () => {
      await db
        .update(userPreferences)
        .set(updatePayload)
        .where(eq(userPreferences.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert user preferences", async () => {
    await db.insert(userPreferences).values({
      ...prefs,
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * Task 1.2b (PR B) — scope-keyed DB resolution.
 *
 * The `userId` parameter on these helpers is retained as a
 * compatibility shim so the 30+ existing call sites don't churn; the
 * actual filter/write predicate is `scopeId`, derived once via
 * `resolveSolarRecScopeId()` (returns `scope-user-${ownerUserId}` for
 * the single-scope model — same string regardless of caller). Writes
 * still set `userId` to keep the NOT NULL column populated for audit;
 * the legacy `(userId, storageKey)` unique index is retained by PR A
 * for backward compat, so existing data remains readable until PR C
 * migrates the S3 blobs.
 */
async function resolveScopeIdFromUserId(userId: number): Promise<string> {
  const { resolveSolarRecScopeId } = await import("../_core/solarRecAuth");
  return resolveSolarRecScopeId();
  // userId is accepted for call-site compatibility; today's
  // single-scope model derives the canonical scope string without
  // consulting the passed userId.
  void userId;
}

export async function getSolarRecDashboardPayload(userId: number, storageKey: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return null;
  const scopeId = await resolveScopeIdFromUserId(userId);

  const rows = await withDbRetry("load solar rec dashboard payload", async () =>
    db
      .select({
        payload: solarRecDashboardStorage.payload,
        chunkIndex: solarRecDashboardStorage.chunkIndex,
      })
      .from(solarRecDashboardStorage)
      .where(
        and(
          eq(solarRecDashboardStorage.scopeId, scopeId),
          eq(solarRecDashboardStorage.storageKey, storageKey)
        )
      )
      .orderBy(asc(solarRecDashboardStorage.chunkIndex))
  );

  if (rows.length === 0) return null;
  return rows.map((row) => row.payload ?? "").join("");
}

// Task 5.14 PR-6 (2026-04-27): `getSolarRecDashboardPayloadsBatch`
// removed. The only caller — the `getDatasetAssembled` tRPC procedure
// it was built for — was deleted in this same PR. The single-key
// `getSolarRecDashboardPayload` above remains the canonical dashboard
// storage reader.

/**
 * List `solarRecDashboardStorage` rows whose `storageKey` starts
 * with the given prefix, scoped to the caller's scopeId. Returns
 * the storageKey + chunkIndex + payload of each row (no `scopeId`
 * leak in the result shape — caller already specified it).
 *
 * Read-only. No deletes. No upserts. Used today by the
 * snapshot-log recovery proc to find orphaned `_chunk_NNNN` rows
 * that aren't pointed to by the main key. The bound (`maxRows`)
 * exists so a misconfigured prefix can't pull a multi-MB result;
 * default 256 is comfortable for snapshot logs (6 chunks observed
 * on prod).
 *
 * The prefix is escaped so SQL `LIKE` wildcards in the user-
 * supplied portion (`_` and `%`) are treated literally. Trailing
 * `%` is appended by the caller's intent ("startsWith").
 */
export async function listSolarRecDashboardStorageByPrefix(
  userId: number,
  storageKeyPrefix: string,
  options: { maxRows?: number } = {}
): Promise<
  Array<{ storageKey: string; chunkIndex: number; payload: string | null }>
> {
  const db = await getDb();
  if (!db) return [];
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return [];
  const scopeId = await resolveScopeIdFromUserId(userId);
  const maxRows = options.maxRows ?? 256;

  // Escape SQL LIKE wildcards in the supplied prefix so the caller
  // gets exact prefix-match semantics. The Drizzle `like` operator
  // takes a single SQL string; we backslash-escape `_` and `%`,
  // then append the trailing `%` ourselves.
  const escaped = storageKeyPrefix
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  const likePattern = `${escaped}%`;

  const rows = await withDbRetry(
    "list solar rec dashboard storage by prefix",
    async () =>
      db
        .select({
          storageKey: solarRecDashboardStorage.storageKey,
          chunkIndex: solarRecDashboardStorage.chunkIndex,
          payload: solarRecDashboardStorage.payload,
        })
        .from(solarRecDashboardStorage)
        .where(
          and(
            eq(solarRecDashboardStorage.scopeId, scopeId),
            like(solarRecDashboardStorage.storageKey, likePattern)
          )
        )
        .orderBy(
          asc(solarRecDashboardStorage.storageKey),
          asc(solarRecDashboardStorage.chunkIndex)
        )
        .limit(maxRows)
  );

  return rows.map((row) => ({
    storageKey: row.storageKey,
    chunkIndex: row.chunkIndex,
    payload: row.payload,
  }));
}

export async function saveSolarRecDashboardPayload(userId: number, storageKey: string, payload: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return false;
  const scopeId = await resolveScopeIdFromUserId(userId);

  const chunks = splitIntoChunks(payload, SOLAR_REC_DB_CHUNK_CHARS);
  const now = new Date();

  await withDbRetry("save solar rec dashboard payload", async () => {
    await db.transaction(async (tx) => {
      await tx
        .delete(solarRecDashboardStorage)
        .where(
          and(
            eq(solarRecDashboardStorage.scopeId, scopeId),
            eq(solarRecDashboardStorage.storageKey, storageKey)
          )
        );

      await tx.insert(solarRecDashboardStorage).values(
        chunks.map((chunk, index) => ({
          id: nanoid(),
          userId,
          scopeId,
          storageKey,
          chunkIndex: index,
          payload: chunk,
          createdAt: now,
          updatedAt: now,
        }))
      );
    });
  });

  return true;
}

export type SolarRecDatasetSyncStateRecord = {
  storageKey: string;
  payloadSha256: string;
  payloadBytes: number;
  dbPersisted: boolean;
  storageSynced: boolean;
  updatedAt: Date | null;
};

export function hashSolarRecPayload(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

export async function upsertSolarRecDatasetSyncState(input: {
  userId: number;
  storageKey: string;
  payload: string;
  dbPersisted: boolean;
  storageSynced: boolean;
}): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const ensured = await ensureSolarRecDatasetSyncStateTable();
  if (!ensured) return false;
  const scopeId = await resolveScopeIdFromUserId(input.userId);

  const now = new Date();
  await withDbRetry("upsert solar rec dataset sync state", async () => {
    await db
      .insert(solarRecDatasetSyncState)
      .values({
        id: nanoid(),
        userId: input.userId,
        scopeId,
        storageKey: input.storageKey,
        payloadSha256: input.payload.length > 0 ? hashSolarRecPayload(input.payload) : "",
        payloadBytes: Buffer.byteLength(input.payload, "utf8"),
        dbPersisted: input.dbPersisted,
        storageSynced: input.storageSynced,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: {
          // Bumps whichever row the unique index points to — since PR A
          // retained both (userId, storageKey) and (scopeId, storageKey)
          // unique indexes, we're still safe against double-writes.
          scopeId,
          payloadSha256: input.payload.length > 0 ? hashSolarRecPayload(input.payload) : "",
          payloadBytes: Buffer.byteLength(input.payload, "utf8"),
          dbPersisted: input.dbPersisted,
          storageSynced: input.storageSynced,
          updatedAt: now,
        },
      });
  });

  return true;
}

export async function getSolarRecDatasetSyncStates(
  userId: number,
  storageKeys: string[]
): Promise<SolarRecDatasetSyncStateRecord[]> {
  const db = await getDb();
  if (!db || storageKeys.length === 0) return [];
  const ensured = await ensureSolarRecDatasetSyncStateTable();
  if (!ensured) return [];
  const scopeId = await resolveScopeIdFromUserId(userId);

  const rows = await withDbRetry("load solar rec dataset sync states", async () =>
    db
      .select({
        storageKey: solarRecDatasetSyncState.storageKey,
        payloadSha256: solarRecDatasetSyncState.payloadSha256,
        payloadBytes: solarRecDatasetSyncState.payloadBytes,
        dbPersisted: solarRecDatasetSyncState.dbPersisted,
        storageSynced: solarRecDatasetSyncState.storageSynced,
        updatedAt: solarRecDatasetSyncState.updatedAt,
      })
      .from(solarRecDatasetSyncState)
      .where(
        and(
          eq(solarRecDatasetSyncState.scopeId, scopeId),
          inArray(solarRecDatasetSyncState.storageKey, storageKeys)
        )
      )
  );

  return rows.map((row) => ({
    storageKey: row.storageKey,
    payloadSha256: row.payloadSha256 ?? "",
    payloadBytes: Number(row.payloadBytes ?? 0),
    dbPersisted: Boolean(row.dbPersisted),
    storageSynced: Boolean(row.storageSynced),
    updatedAt: row.updatedAt ?? null,
  }));
}
