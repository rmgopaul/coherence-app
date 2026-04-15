import { eq, and, asc, desc, getDb, withDbRetry } from "./_core";
import {
  supplementLogs,
  supplementDefinitions,
  supplementPriceLogs,
  InsertSupplementLog,
  InsertSupplementDefinition,
  InsertSupplementPriceLog,
} from "../../drizzle/schema";

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
