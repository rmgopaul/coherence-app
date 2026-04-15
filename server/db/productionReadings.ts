import { eq, and, desc, sql, getDb, withDbRetry } from "./_core";
import { productionReadings, InsertProductionReading } from "../../drizzle/schema";

// ── Production Readings (SunPower PVS mobile app) ──────────────────

export async function insertProductionReading(reading: InsertProductionReading) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("insert production reading", async () =>
    db.insert(productionReadings).values(reading)
  );
}

export async function listProductionReadings(opts?: {
  limit?: number;
  email?: string;
  nonId?: string;
}) {
  const db = await getDb();
  if (!db) return [];

  const limit = opts?.limit ?? 200;
  const conditions = [];
  if (opts?.email) conditions.push(eq(productionReadings.customerEmail, opts.email));
  if (opts?.nonId) conditions.push(eq(productionReadings.nonId, opts.nonId));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  return withDbRetry("list production readings", async () =>
    db
      .select()
      .from(productionReadings)
      .where(where)
      .orderBy(desc(productionReadings.readAt))
      .limit(limit)
  );
}

export async function getProductionReadingSummary() {
  const db = await getDb();
  if (!db) return { totalReadings: 0, uniqueCustomers: 0, latestReadings: [] };

  return withDbRetry("production reading summary", async () => {
    const [countResult] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(productionReadings);

    const [uniqueResult] = await db
      .select({ count: sql<number>`COUNT(DISTINCT ${productionReadings.customerEmail})` })
      .from(productionReadings);

    const latestReadings = await db
      .select()
      .from(productionReadings)
      .orderBy(desc(productionReadings.readAt))
      .limit(10);

    return {
      totalReadings: countResult?.count ?? 0,
      uniqueCustomers: uniqueResult?.count ?? 0,
      latestReadings,
    };
  });
}
