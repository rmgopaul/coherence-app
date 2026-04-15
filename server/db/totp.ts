import { nanoid } from "nanoid";
import { eq, and, sql, getDb, withDbRetry } from "./_core";
import { userTotpSecrets, userRecoveryCodes } from "../../drizzle/schema";

// ── TOTP 2FA functions ──────────────────────────────────────────────

export async function getTotpSecret(userId: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await withDbRetry("get totp secret", async () =>
    db.select().from(userTotpSecrets).where(eq(userTotpSecrets.userId, userId)).limit(1)
  );
  return result.length > 0 ? result[0] : undefined;
}

export async function saveTotpSecret(userId: number, secret: string) {
  const db = await getDb();
  if (!db) return;

  // Delete any existing (unverified) secret first
  await withDbRetry("delete old totp secret", async () =>
    db.delete(userTotpSecrets).where(eq(userTotpSecrets.userId, userId))
  );

  await withDbRetry("save totp secret", async () =>
    db.insert(userTotpSecrets).values({
      id: nanoid(),
      userId,
      secret,
      verified: false,
    })
  );
}

export async function markTotpVerified(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("mark totp verified", async () =>
    db.update(userTotpSecrets).set({ verified: true }).where(eq(userTotpSecrets.userId, userId))
  );
}

export async function deleteTotpSecret(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete totp secret", async () =>
    db.delete(userTotpSecrets).where(eq(userTotpSecrets.userId, userId))
  );
}

export async function saveRecoveryCodes(userId: number, codeHashes: string[]) {
  const db = await getDb();
  if (!db) return;

  // Delete existing codes first
  await withDbRetry("delete old recovery codes", async () =>
    db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
  );

  if (codeHashes.length === 0) return;

  const rows = codeHashes.map((hash) => ({
    id: nanoid(),
    userId,
    codeHash: hash,
  }));

  await withDbRetry("save recovery codes", async () =>
    db.insert(userRecoveryCodes).values(rows)
  );
}

export async function getUnusedRecoveryCodeCount(userId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const result = await withDbRetry("count unused recovery codes", async () =>
    db
      .select({ count: sql<number>`count(*)` })
      .from(userRecoveryCodes)
      .where(and(eq(userRecoveryCodes.userId, userId), sql`${userRecoveryCodes.usedAt} IS NULL`))
  );
  return result[0]?.count ?? 0;
}

export async function consumeRecoveryCode(userId: number, codeHash: string): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const result = await withDbRetry("consume recovery code", async () =>
    db
      .update(userRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(userRecoveryCodes.userId, userId),
          eq(userRecoveryCodes.codeHash, codeHash),
          sql`${userRecoveryCodes.usedAt} IS NULL`
        )
      )
  );
  // MySQL returns affectedRows for updates
  return (result as any)?.[0]?.affectedRows > 0 || (result as any)?.rowsAffected > 0;
}

export async function deleteRecoveryCodes(userId: number) {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete recovery codes", async () =>
    db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId))
  );
}
