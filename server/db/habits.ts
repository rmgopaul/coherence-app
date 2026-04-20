import { nanoid } from "nanoid";
import {
  eq,
  and,
  asc,
  desc,
  gte,
  getDb,
  withDbRetry,
} from "./_core";
import {
  habitDefinitions,
  habitCompletions,
  habitCategories,
  dailySnapshots,
  samsungSyncPayloads,
  InsertHabitDefinition,
  InsertHabitCategory,
  InsertDailySnapshot,
  InsertSamsungSyncPayload,
} from "../../drizzle/schema";

// Habit definition + completion
export async function listHabitDefinitions(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit definitions", async () =>
    db
      .select()
      .from(habitDefinitions)
      .where(and(eq(habitDefinitions.userId, userId), eq(habitDefinitions.isActive, true)))
      .orderBy(asc(habitDefinitions.sortOrder), asc(habitDefinitions.name))
  );
}

export async function createHabitDefinition(habit: InsertHabitDefinition) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert habit definition", async () => {
    await db.insert(habitDefinitions).values({
      ...habit,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function deleteHabitDefinition(userId: number, habitId: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete habit completions", async () => {
    await db
      .delete(habitCompletions)
      .where(and(eq(habitCompletions.userId, userId), eq(habitCompletions.habitId, habitId)));
  });

  await withDbRetry("delete habit definition", async () => {
    await db
      .delete(habitDefinitions)
      .where(and(eq(habitDefinitions.userId, userId), eq(habitDefinitions.id, habitId)));
  });
}

export async function getHabitCompletionsByDate(userId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit completions by date", async () =>
    db
      .select()
      .from(habitCompletions)
      .where(and(eq(habitCompletions.userId, userId), eq(habitCompletions.dateKey, dateKey)))
  );
}

export async function upsertHabitCompletion(
  userId: number,
  habitId: string,
  dateKey: string,
  completed: boolean
) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load habit completion before upsert", async () =>
    db
      .select({ id: habitCompletions.id })
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.userId, userId),
          eq(habitCompletions.habitId, habitId),
          eq(habitCompletions.dateKey, dateKey)
        )
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update habit completion", async () => {
      await db
        .update(habitCompletions)
        .set({
          completed,
          completedAt: completed ? now : null,
          updatedAt: now,
        })
        .where(eq(habitCompletions.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert habit completion", async () => {
    await db.insert(habitCompletions).values({
      id: nanoid(),
      userId,
      habitId,
      dateKey,
      completed,
      completedAt: completed ? now : null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function listHabitCompletions(userId: number, limit = 200) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit completions", async () =>
    db
      .select()
      .from(habitCompletions)
      .where(eq(habitCompletions.userId, userId))
      .orderBy(desc(habitCompletions.updatedAt))
      .limit(limit)
  );
}

/**
 * Returns habit completion data for the last N days for streak calculation.
 * Returns rows grouped by habitId + dateKey with completed status.
 */
export async function getHabitCompletionsRange(
  userId: number,
  sinceDateKey: string
) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get habit completions range", async () =>
    db
      .select({
        habitId: habitCompletions.habitId,
        dateKey: habitCompletions.dateKey,
        completed: habitCompletions.completed,
      })
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.userId, userId),
          gte(habitCompletions.dateKey, sinceDateKey),
          eq(habitCompletions.completed, true)
        )
      )
  );
}

export async function getDailySnapshotByDate(userId: number, dateKey: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load daily snapshot", async () =>
    db
      .select()
      .from(dailySnapshots)
      .where(and(eq(dailySnapshots.userId, userId), eq(dailySnapshots.dateKey, dateKey)))
      .limit(1)
  );
  return result.length > 0 ? result[0] : null;
}

export async function upsertDailySnapshot(snapshot: InsertDailySnapshot) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load daily snapshot before upsert", async () =>
    db
      .select({ id: dailySnapshots.id })
      .from(dailySnapshots)
      .where(and(eq(dailySnapshots.userId, snapshot.userId), eq(dailySnapshots.dateKey, snapshot.dateKey)))
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update daily snapshot", async () => {
      await db
        .update(dailySnapshots)
        .set({
          capturedAt: snapshot.capturedAt,
          whoopPayload: snapshot.whoopPayload,
          samsungPayload: snapshot.samsungPayload,
          supplementsPayload: snapshot.supplementsPayload,
          habitsPayload: snapshot.habitsPayload,
          todoistCompletedCount: snapshot.todoistCompletedCount,
          updatedAt: now,
        })
        .where(eq(dailySnapshots.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert daily snapshot", async () => {
    await db.insert(dailySnapshots).values({
      ...snapshot,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function listDailySnapshots(userId: number, limit = 60) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list daily snapshots", async () =>
    db
      .select()
      .from(dailySnapshots)
      .where(eq(dailySnapshots.userId, userId))
      .orderBy(desc(dailySnapshots.dateKey))
      .limit(limit)
  );
}

export async function addSamsungSyncPayload(entry: InsertSamsungSyncPayload) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("insert samsung sync payload", async () => {
    await db.insert(samsungSyncPayloads).values({
      ...entry,
      createdAt: new Date(),
    });
  });
}

export async function getLatestSamsungSyncPayload(userId: number, dateKey?: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load latest samsung sync payload", async () => {
    if (dateKey) {
      return db
        .select()
        .from(samsungSyncPayloads)
        .where(and(eq(samsungSyncPayloads.userId, userId), eq(samsungSyncPayloads.dateKey, dateKey)))
        .orderBy(desc(samsungSyncPayloads.capturedAt))
        .limit(1);
    }

    return db
      .select()
      .from(samsungSyncPayloads)
      .where(eq(samsungSyncPayloads.userId, userId))
      .orderBy(desc(samsungSyncPayloads.capturedAt))
      .limit(1);
  });

  return result.length > 0 ? result[0] : null;
}

// ────────────────────────────────────────────────────────────────────
// Habit categories (new in Habits+Health feature)
// ────────────────────────────────────────────────────────────────────

export async function listHabitCategories(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit categories", async () =>
    db
      .select()
      .from(habitCategories)
      .where(
        and(
          eq(habitCategories.userId, userId),
          eq(habitCategories.isActive, true)
        )
      )
      .orderBy(asc(habitCategories.sortOrder), asc(habitCategories.name))
  );
}

export async function createHabitCategory(row: InsertHabitCategory) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  await withDbRetry("insert habit category", async () => {
    await db.insert(habitCategories).values({
      ...row,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function updateHabitCategory(
  userId: number,
  id: string,
  updates: Partial<{
    name: string;
    color: string;
    sortOrder: number;
    isActive: boolean;
  }>
) {
  const db = await getDb();
  if (!db) return;

  const payload: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.color !== undefined) payload.color = updates.color;
  if (updates.sortOrder !== undefined) payload.sortOrder = updates.sortOrder;
  if (updates.isActive !== undefined) payload.isActive = updates.isActive;

  await withDbRetry("update habit category", async () => {
    await db
      .update(habitCategories)
      .set(payload)
      .where(
        and(eq(habitCategories.userId, userId), eq(habitCategories.id, id))
      );
  });
}

/**
 * Deletes the category AND clears categoryId on any habits that reference
 * it. Not a hard FK, so we do this in two queries.
 */
export async function deleteHabitCategory(userId: number, id: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("clear habitDefinitions.categoryId", async () => {
    await db
      .update(habitDefinitions)
      .set({ categoryId: null, updatedAt: new Date() })
      .where(
        and(
          eq(habitDefinitions.userId, userId),
          eq(habitDefinitions.categoryId, id)
        )
      );
  });

  await withDbRetry("delete habit category", async () => {
    await db
      .delete(habitCategories)
      .where(
        and(eq(habitCategories.userId, userId), eq(habitCategories.id, id))
      );
  });
}

// ────────────────────────────────────────────────────────────────────
// Habit definition updates (rename, recolor, recategorize, reorder)
// ────────────────────────────────────────────────────────────────────

export async function updateHabitDefinition(
  userId: number,
  habitId: string,
  updates: Partial<{
    name: string;
    color: string;
    sortOrder: number;
    isActive: boolean;
    categoryId: string | null;
  }>
) {
  const db = await getDb();
  if (!db) return;

  const payload: Record<string, unknown> = { updatedAt: new Date() };
  if (updates.name !== undefined) payload.name = updates.name;
  if (updates.color !== undefined) payload.color = updates.color;
  if (updates.sortOrder !== undefined) payload.sortOrder = updates.sortOrder;
  if (updates.isActive !== undefined) payload.isActive = updates.isActive;
  if (updates.categoryId !== undefined) payload.categoryId = updates.categoryId;

  await withDbRetry("update habit definition", async () => {
    await db
      .update(habitDefinitions)
      .set(payload)
      .where(
        and(
          eq(habitDefinitions.userId, userId),
          eq(habitDefinitions.id, habitId)
        )
      );
  });
}

/**
 * All completions for a single definition across a date range. Used by
 * the history heatmap and the habit-vs-health correlation procedure.
 */
export async function getHabitCompletionsForDefinitionRange(
  userId: number,
  habitId: string,
  startDateKey: string,
  endDateKey: string
) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list habit completions for definition range", async () =>
    db
      .select()
      .from(habitCompletions)
      .where(
        and(
          eq(habitCompletions.userId, userId),
          eq(habitCompletions.habitId, habitId),
          gte(habitCompletions.dateKey, startDateKey)
        )
      )
      .orderBy(asc(habitCompletions.dateKey))
  ).then((rows) => rows.filter((r) => r.dateKey <= endDateKey));
}
