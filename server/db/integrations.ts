import { eq, and, getDb, withDbRetry } from "./_core";
import { integrations, InsertIntegration } from "../../drizzle/schema";

export async function getUserIntegrations(userId: number) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list integrations", async () =>
    db.select().from(integrations).where(eq(integrations.userId, userId))
  );
}

export async function getIntegrationsByProvider(provider: string) {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list integrations by provider", async () =>
    db.select().from(integrations).where(eq(integrations.provider, provider))
  );
}

export async function getIntegrationByProvider(userId: number, provider: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load integration", async () =>
    db.select().from(integrations)
      .where(and(eq(integrations.userId, userId), eq(integrations.provider, provider)))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function upsertIntegration(integration: InsertIntegration) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load integration before upsert", async () =>
    db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.userId, integration.userId),
          eq(integrations.provider, integration.provider)
        )
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update integration", async () => {
      await db
        .update(integrations)
        .set({
          accessToken: integration.accessToken,
          refreshToken: integration.refreshToken,
          expiresAt: integration.expiresAt,
          scope: integration.scope,
          metadata: integration.metadata,
          updatedAt: now,
        })
        .where(eq(integrations.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert integration", async () => {
    await db.insert(integrations).values({
      ...integration,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function deleteIntegration(id: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete integration", async () => {
    await db.delete(integrations).where(eq(integrations.id, id));
  });
}
