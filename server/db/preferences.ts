import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  getDb,
  withDbRetry,
  ensureSolarRecDashboardStorageTable,
  splitIntoChunks,
  SOLAR_REC_DB_CHUNK_CHARS,
} from "./_core";
import {
  userPreferences,
  InsertUserPreference,
  solarRecDashboardStorage,
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
