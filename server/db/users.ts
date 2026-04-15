import { eq, sql, getDb, withDbRetry, ENV } from "./_core";
import { InsertUser, users } from "../../drizzle/schema";

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await withDbRetry("upsert user", async () => {
      await db.insert(users).values(values).onDuplicateKeyUpdate({
        set: updateSet,
      });
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function deleteUser(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("delete user", async () =>
    db.delete(users).where(eq(users.id, userId))
  );
}

export async function updateUserOpenId(userId: number, newOpenId: string): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await withDbRetry("update user openId", async () =>
    db.update(users).set({ openId: newOpenId }).where(eq(users.id, userId))
  );
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await withDbRetry("load user", async () =>
    db.select().from(users).where(eq(users.openId, openId)).limit(1)
  );

  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user by email: database not available");
    return undefined;
  }

  const normalized = email.trim().toLowerCase();
  if (!normalized) return undefined;

  const result = await withDbRetry("load user by email", async () =>
    db
      .select()
      .from(users)
      .where(sql`LOWER(${users.email}) = ${normalized}`)
      .limit(1)
  );

  return result.length > 0 ? result[0] : undefined;
}

export async function listUsers() {
  const db = await getDb();
  if (!db) return [];

  return withDbRetry("list users", async () => db.select().from(users));
}
