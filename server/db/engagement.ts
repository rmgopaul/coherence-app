import { nanoid } from "nanoid";
import { eq, and, sql, getDb, withDbRetry } from "./_core";
import { sectionEngagement, InsertSectionEngagement } from "../../drizzle/schema";

// ── Section Engagement ──

export async function insertSectionEngagementBatch(
  rows: Array<Omit<InsertSectionEngagement, "id" | "createdAt">>
) {
  const db = await getDb();
  if (!db || rows.length === 0) return;

  const toInsert = rows.map((row) => ({
    ...row,
    id: nanoid(),
  }));

  await withDbRetry("insert section engagement batch", async () => {
    await db.insert(sectionEngagement).values(toInsert);
  });
}

export async function getSectionEngagementSummary(
  userId: number,
  sinceDateKey: string
) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get section engagement summary", async () => {
    return db
      .select({
        sectionId: sectionEngagement.sectionId,
        eventType: sectionEngagement.eventType,
        totalDurationMs: sql<number>`COALESCE(SUM(${sectionEngagement.durationMs}), 0)`,
        eventCount: sql<number>`COUNT(*)`,
      })
      .from(sectionEngagement)
      .where(
        and(
          eq(sectionEngagement.userId, userId),
          sql`${sectionEngagement.sessionDate} >= ${sinceDateKey}`
        )
      )
      .groupBy(sectionEngagement.sectionId, sectionEngagement.eventType);
  });
}

export async function getSectionRatings(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("get section ratings", async () => {
    // Get the most recent rating per section
    const subquery = db
      .select({
        sectionId: sectionEngagement.sectionId,
        maxCreatedAt: sql<Date>`MAX(${sectionEngagement.createdAt})`.as("maxCreatedAt"),
      })
      .from(sectionEngagement)
      .where(
        and(
          eq(sectionEngagement.userId, userId),
          eq(sectionEngagement.eventType, "rating")
        )
      )
      .groupBy(sectionEngagement.sectionId)
      .as("latest");

    return db
      .select({
        sectionId: sectionEngagement.sectionId,
        eventValue: sectionEngagement.eventValue,
      })
      .from(sectionEngagement)
      .innerJoin(
        subquery,
        and(
          eq(sectionEngagement.sectionId, subquery.sectionId),
          eq(sectionEngagement.createdAt, subquery.maxCreatedAt)
        )
      )
      .where(
        and(
          eq(sectionEngagement.userId, userId),
          eq(sectionEngagement.eventType, "rating")
        )
      );
  });
}

export async function pruneSectionEngagement(olderThanDateKey: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("prune section engagement", async () => {
    await db
      .delete(sectionEngagement)
      .where(sql`${sectionEngagement.sessionDate} < ${olderThanDateKey}`);
  });
}

export async function clearSectionEngagement(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("clear section engagement", async () => {
    await db
      .delete(sectionEngagement)
      .where(eq(sectionEngagement.userId, userId));
  });
}
