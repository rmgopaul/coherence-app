import { eq, and, getDb, withDbRetry } from "./_core";
import { oauthCredentials, InsertOAuthCredential } from "../../drizzle/schema";

export async function getOAuthCredential(userId: number, provider: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await withDbRetry("load oauth credentials", async () =>
    db.select().from(oauthCredentials)
      .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)))
      .limit(1)
  );

  return result.length > 0 ? result[0] : null;
}

export async function upsertOAuthCredential(cred: InsertOAuthCredential) {
  const db = await getDb();
  if (!db) return;

  const now = new Date();
  const existing = await withDbRetry("load oauth credentials before upsert", async () =>
    db
      .select({ id: oauthCredentials.id })
      .from(oauthCredentials)
      .where(
        and(
          eq(oauthCredentials.userId, cred.userId),
          eq(oauthCredentials.provider, cred.provider)
        )
      )
      .limit(1)
  );

  if (existing.length > 0) {
    await withDbRetry("update oauth credentials", async () => {
      await db
        .update(oauthCredentials)
        .set({
          clientId: cred.clientId,
          clientSecret: cred.clientSecret,
          updatedAt: now,
        })
        .where(eq(oauthCredentials.id, existing[0].id));
    });
    return;
  }

  await withDbRetry("insert oauth credentials", async () => {
    await db.insert(oauthCredentials).values({
      ...cred,
      createdAt: now,
      updatedAt: now,
    });
  });
}

export async function deleteOAuthCredential(userId: number, provider: string) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete oauth credentials", async () => {
    await db.delete(oauthCredentials)
      .where(and(eq(oauthCredentials.userId, userId), eq(oauthCredentials.provider, provider)));
  });
}
