import { eq, and, asc, desc, gte, sql, getDb, withDbRetry } from "./_core";
import {
  supplementLogs,
  supplementDefinitions,
  supplementPriceLogs,
  InsertSupplementLog,
  InsertSupplementDefinition,
  InsertSupplementPriceLog,
} from "../../drizzle/schema";

/**
 * Compute a `YYYY-MM-DD` string `days` days before `reference`, using
 * local-time components (not UTC). Inclusive window: to cover N days
 * ending today, subtract N-1.
 */
function localDateKeyDaysAgo(days: number, reference: Date = new Date()): string {
  const d = new Date(reference);
  d.setDate(d.getDate() - days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

type SupplementDefinitionUpdateInput = {
  name?: string;
  brand?: string | null;
  dose?: string;
  doseUnit?: string;
  dosePerUnit?: string | null;
  productUrl?: string | null;
  pricePerBottle?: number | null;
  quantityPerBottle?: number | null;
  timing?: string;
  isLocked?: boolean;
};

export async function listSupplementLogs(userId: number, dateKey?: string, limit = 100) {
  const db = await getDb();
  if (!db) return [];

  if (dateKey) {
    return withDbRetry("list supplement logs by date", async () =>
      db
        .select()
        .from(supplementLogs)
        .where(and(eq(supplementLogs.userId, userId), eq(supplementLogs.dateKey, dateKey)))
        .orderBy(desc(supplementLogs.takenAt))
        .limit(limit)
    );
  }

  return withDbRetry("list supplement logs", async () =>
    db
      .select()
      .from(supplementLogs)
      .where(eq(supplementLogs.userId, userId))
      .orderBy(desc(supplementLogs.takenAt))
      .limit(limit)
  );
}

export async function addSupplementLog(entry: InsertSupplementLog) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert supplement log", async () => {
    await db.insert(supplementLogs).values({
      ...entry,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function getSupplementLogByDefinitionAndDate(
  userId: number,
  definitionId: string,
  dateKey: string
) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load supplement log by definition/date", async () =>
    db
      .select()
      .from(supplementLogs)
      .where(
        and(
          eq(supplementLogs.userId, userId),
          eq(supplementLogs.definitionId, definitionId),
          eq(supplementLogs.dateKey, dateKey)
        )
      )
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function deleteSupplementLog(userId: number, id: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete supplement log", async () => {
    await db
      .delete(supplementLogs)
      .where(and(eq(supplementLogs.id, id), eq(supplementLogs.userId, userId)));
  });
}

export async function listSupplementDefinitions(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list supplement definitions", async () =>
    db
      .select()
      .from(supplementDefinitions)
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.isActive, true)))
      .orderBy(asc(supplementDefinitions.sortOrder), asc(supplementDefinitions.name))
  );
}

export async function getSupplementDefinitionById(userId: number, definitionId: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load supplement definition by id", async () =>
    db
      .select()
      .from(supplementDefinitions)
      .where(
        and(
          eq(supplementDefinitions.userId, userId),
          eq(supplementDefinitions.id, definitionId),
          eq(supplementDefinitions.isActive, true)
        )
      )
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function createSupplementDefinition(definition: InsertSupplementDefinition) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert supplement definition", async () => {
    await db.insert(supplementDefinitions).values({
      ...definition,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function listSupplementPriceLogs(
  userId: number,
  options?: {
    definitionId?: string;
    limit?: number;
  }
) {
  const db = await getDb();
  if (!db) return [];

  const safeLimit = Math.max(1, Math.min(options?.limit ?? 100, 500));
  const definitionId = options?.definitionId?.trim();

  if (definitionId) {
    return withDbRetry("list supplement price logs by definition", async () =>
      db
        .select()
        .from(supplementPriceLogs)
        .where(
          and(
            eq(supplementPriceLogs.userId, userId),
            eq(supplementPriceLogs.definitionId, definitionId)
          )
        )
        .orderBy(desc(supplementPriceLogs.capturedAt), desc(supplementPriceLogs.createdAt))
        .limit(safeLimit)
    );
  }

  return withDbRetry("list supplement price logs", async () =>
    db
      .select()
      .from(supplementPriceLogs)
      .where(eq(supplementPriceLogs.userId, userId))
      .orderBy(desc(supplementPriceLogs.capturedAt), desc(supplementPriceLogs.createdAt))
      .limit(safeLimit)
  );
}

export async function addSupplementPriceLog(entry: InsertSupplementPriceLog) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert supplement price log", async () => {
    await db.insert(supplementPriceLogs).values({
      ...entry,
      createdAt: now,
      updatedAt: now,
      capturedAt: entry.capturedAt ?? now,
    });
  });
}

export async function updateSupplementDefinition(
  userId: number,
  definitionId: string,
  updates: SupplementDefinitionUpdateInput
) {
  const db = await getDb();
  if (!db) return;

  const updatePayload: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) updatePayload.name = updates.name;
  if (updates.brand !== undefined) updatePayload.brand = updates.brand;
  if (updates.dose !== undefined) updatePayload.dose = updates.dose;
  if (updates.doseUnit !== undefined) updatePayload.doseUnit = updates.doseUnit;
  if (updates.dosePerUnit !== undefined) updatePayload.dosePerUnit = updates.dosePerUnit;
  if (updates.productUrl !== undefined) updatePayload.productUrl = updates.productUrl;
  if (updates.pricePerBottle !== undefined) updatePayload.pricePerBottle = updates.pricePerBottle;
  if (updates.quantityPerBottle !== undefined) {
    updatePayload.quantityPerBottle = updates.quantityPerBottle;
  }
  if (updates.timing !== undefined) updatePayload.timing = updates.timing;
  if (updates.isLocked !== undefined) updatePayload.isLocked = updates.isLocked;

  await withDbRetry("update supplement definition", async () => {
    await db
      .update(supplementDefinitions)
      .set(updatePayload)
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.id, definitionId)));
  });
}

export async function setSupplementDefinitionLock(
  userId: number,
  definitionId: string,
  isLocked: boolean
) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("update supplement definition lock", async () => {
    await db
      .update(supplementDefinitions)
      .set({
        isLocked,
        updatedAt: new Date(),
      })
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.id, definitionId)));
  });
}

/**
 * Per-definition adherence over the trailing `windowDays`-day window.
 *
 * Returns one row per active definition owned by the user:
 * - `takenDays`: distinct dateKeys in the window with at least one log
 * - `expectedDays`: `windowDays` when the definition is currently locked +
 *   active; 0 otherwise. (We do not yet track lock history, so "expected" is
 *   computed from current state. Revisit when protocol snapshots exist.)
 *
 * Uses a single grouped query for the counts, then merges with the
 * definition list to include zeroes for locked defs with no logs.
 */
export async function getSupplementAdherence(
  userId: number,
  opts: { windowDays: number }
): Promise<
  {
    definitionId: string;
    takenDays: number;
    expectedDays: number;
  }[]
> {
  const db = await getDb();
  if (!db) return [];

  const windowDays = Math.max(1, Math.min(365, Math.floor(opts.windowDays)));
  // Inclusive window: today counts, plus the prior (windowDays - 1) days.
  const startDateKey = localDateKeyDaysAgo(windowDays - 1);

  const definitions = await listSupplementDefinitions(userId);

  const counts = await withDbRetry("count supplement logs by definition", async () =>
    db
      .select({
        definitionId: supplementLogs.definitionId,
        takenDays: sql<number>`COUNT(DISTINCT ${supplementLogs.dateKey})`,
      })
      .from(supplementLogs)
      .where(
        and(
          eq(supplementLogs.userId, userId),
          gte(supplementLogs.dateKey, startDateKey)
        )
      )
      .groupBy(supplementLogs.definitionId)
  );

  const takenByDefinitionId = new Map<string, number>();
  for (const row of counts) {
    if (!row.definitionId) continue;
    // mysql2 can return COUNT(*) as string depending on config — normalise.
    const raw = row.takenDays as unknown;
    const num = typeof raw === "number" ? raw : Number(raw);
    takenByDefinitionId.set(row.definitionId, Number.isFinite(num) ? num : 0);
  }

  return definitions.map((def) => ({
    definitionId: def.id,
    takenDays: takenByDefinitionId.get(def.id) ?? 0,
    expectedDays: def.isLocked && def.isActive ? windowDays : 0,
  }));
}

export async function deleteSupplementDefinition(userId: number, definitionId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete supplement definition price logs", async () => {
    await db
      .delete(supplementPriceLogs)
      .where(and(eq(supplementPriceLogs.userId, userId), eq(supplementPriceLogs.definitionId, definitionId)));
  });

  await withDbRetry("delete supplement definition logs", async () => {
    await db
      .delete(supplementLogs)
      .where(and(eq(supplementLogs.userId, userId), eq(supplementLogs.definitionId, definitionId)));
  });

  await withDbRetry("delete supplement definition", async () => {
    await db
      .delete(supplementDefinitions)
      .where(and(eq(supplementDefinitions.userId, userId), eq(supplementDefinitions.id, definitionId)));
  });
}
