import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  inArray,
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

export async function getSolarRecDashboardPayload(userId: number, storageKey: string): Promise<string | null> {
  const db = await getDb();
  if (!db) return null;
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return null;

  const rows = await withDbRetry("load solar rec dashboard payload", async () =>
    db
      .select({
        payload: solarRecDashboardStorage.payload,
        chunkIndex: solarRecDashboardStorage.chunkIndex,
      })
      .from(solarRecDashboardStorage)
      .where(
        and(
          eq(solarRecDashboardStorage.userId, userId),
          eq(solarRecDashboardStorage.storageKey, storageKey)
        )
      )
      .orderBy(asc(solarRecDashboardStorage.chunkIndex))
  );

  if (rows.length === 0) return null;
  return rows.map((row) => row.payload ?? "").join("");
}

export async function saveSolarRecDashboardPayload(userId: number, storageKey: string, payload: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const ensured = await ensureSolarRecDashboardStorageTable();
  if (!ensured) return false;

  const chunks = splitIntoChunks(payload, SOLAR_REC_DB_CHUNK_CHARS);
  const now = new Date();

  await withDbRetry("save solar rec dashboard payload", async () => {
    await db.transaction(async (tx) => {
      await tx
        .delete(solarRecDashboardStorage)
        .where(
          and(
            eq(solarRecDashboardStorage.userId, userId),
            eq(solarRecDashboardStorage.storageKey, storageKey)
          )
        );

      await tx.insert(solarRecDashboardStorage).values(
        chunks.map((chunk, index) => ({
          id: nanoid(),
          userId,
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

  const now = new Date();
  await withDbRetry("upsert solar rec dataset sync state", async () => {
    await db
      .insert(solarRecDatasetSyncState)
      .values({
        id: nanoid(),
        userId: input.userId,
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
          eq(solarRecDatasetSyncState.userId, userId),
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
