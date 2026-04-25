import { nanoid } from "nanoid";
import { eq, and, asc, desc, sql, getDb, withDbRetry } from "./_core";
import {
  solarRecUsers,
  solarRecInvites,
  solarRecTeamCredentials,
} from "../../drizzle/schema";

// ── Solar REC Users ─────────────────────────────────────────────────

export async function getSolarRecUserById(id: number) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user by id", async () => {
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.id, id)).limit(1);
    return user ?? null;
  });
}

export async function getSolarRecUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user by email", async () => {
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.email, email.toLowerCase())).limit(1);
    return user ?? null;
  });
}

export async function getSolarRecUserByGoogleOpenId(googleOpenId: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user by google open id", async () => {
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.googleOpenId, googleOpenId)).limit(1);
    return user ?? null;
  });
}

export async function createSolarRecUser(data: {
  email: string;
  name: string;
  googleOpenId: string;
  avatarUrl: string | null;
  role: "owner" | "admin" | "operator" | "viewer";
  invitedBy?: number | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  return withDbRetry("create solar rec user", async () => {
    await db.insert(solarRecUsers).values({
      email: data.email.toLowerCase(),
      name: data.name,
      googleOpenId: data.googleOpenId,
      avatarUrl: data.avatarUrl,
      role: data.role,
      invitedBy: data.invitedBy ?? null,
      lastSignedIn: new Date(),
    });
    const [user] = await db.select().from(solarRecUsers).where(eq(solarRecUsers.email, data.email.toLowerCase())).limit(1);
    return user!;
  });
}

export async function updateSolarRecUserLastSignIn(
  id: number,
  googleOpenId?: string,
  name?: string,
  avatarUrl?: string
) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update solar rec user last sign in", async () => {
    const updates: Record<string, unknown> = { lastSignedIn: new Date() };
    if (googleOpenId) updates.googleOpenId = googleOpenId;
    if (name) updates.name = name;
    if (avatarUrl) updates.avatarUrl = avatarUrl;
    await db.update(solarRecUsers).set(updates).where(eq(solarRecUsers.id, id));
  });
}

export async function updateSolarRecUserRole(id: number, role: "admin" | "operator" | "viewer") {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update solar rec user role", async () => {
    await db.update(solarRecUsers).set({ role }).where(eq(solarRecUsers.id, id));
  });
}

export async function deactivateSolarRecUser(id: number) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("deactivate solar rec user", async () => {
    await db.update(solarRecUsers).set({ isActive: false }).where(eq(solarRecUsers.id, id));
  });
}

export async function listSolarRecUsers() {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec users", async () =>
    db.select().from(solarRecUsers).orderBy(asc(solarRecUsers.id))
  );
}

// ── Solar REC Invites ───────────────────────────────────────────────

export async function createSolarRecInvite(data: {
  email: string;
  role: "admin" | "operator" | "viewer";
  createdBy: number;
  expiresInDays?: number;
  /**
   * Task 5.2 — bind the invite to a permission preset whose entries are
   * snapshotted onto the invitee on accept. Optional; absent means the
   * invitee starts at "all none" and the admin will dial permissions
   * per-cell after they sign in.
   */
  presetId?: string | null;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");

  const token = nanoid(32);
  const tokenHash = (await import("crypto")).createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + (data.expiresInDays ?? 30) * 24 * 60 * 60 * 1000);

  await withDbRetry("create solar rec invite", async () => {
    await db.insert(solarRecInvites).values({
      id: nanoid(),
      email: data.email.toLowerCase(),
      role: data.role,
      tokenHash,
      createdBy: data.createdBy,
      expiresAt,
      presetId: data.presetId ?? null,
    });
  });

  return { token, expiresAt };
}

export async function getSolarRecInviteByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec invite by email", async () => {
    const [invite] = await db
      .select()
      .from(solarRecInvites)
      .where(
        and(
          eq(solarRecInvites.email, email.toLowerCase()),
          sql`${solarRecInvites.usedAt} IS NULL`,
          sql`${solarRecInvites.expiresAt} > NOW()`
        )
      )
      .orderBy(desc(solarRecInvites.createdAt))
      .limit(1);
    return invite ?? null;
  });
}

export async function markSolarRecInviteUsed(id: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("mark solar rec invite used", async () => {
    await db.update(solarRecInvites).set({ usedAt: new Date() }).where(eq(solarRecInvites.id, id));
  });
}

export async function listSolarRecInvites(createdBy?: number) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec invites", async () => {
    const where = createdBy ? eq(solarRecInvites.createdBy, createdBy) : undefined;
    return db
      .select()
      .from(solarRecInvites)
      .where(where)
      .orderBy(desc(solarRecInvites.createdAt))
      .limit(50);
  });
}

export async function deleteSolarRecInvite(id: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete solar rec invite", async () => {
    await db.delete(solarRecInvites).where(eq(solarRecInvites.id, id));
  });
}

// ── Solar REC Team Credentials ──────────────────────────────────────

export async function listSolarRecTeamCredentials() {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec team credentials", async () =>
    db.select().from(solarRecTeamCredentials).orderBy(asc(solarRecTeamCredentials.provider))
  );
}

export async function getSolarRecTeamCredential(id: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec team credential", async () => {
    const [cred] = await db.select().from(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.id, id)).limit(1);
    return cred ?? null;
  });
}

export async function getSolarRecTeamCredentialsByProvider(provider: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("get solar rec team credentials by provider", async () =>
    db.select().from(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.provider, provider))
  );
}

export async function upsertSolarRecTeamCredential(data: {
  id?: string;
  provider: string;
  connectionName?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  metadata?: string;
  createdBy: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = data.id ?? nanoid();
  return withDbRetry("upsert solar rec team credential", async () => {
    const [existing] = await db.select().from(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.id, id)).limit(1);
    if (existing) {
      await db.update(solarRecTeamCredentials).set({
        connectionName: data.connectionName ?? existing.connectionName,
        accessToken: data.accessToken ?? existing.accessToken,
        refreshToken: data.refreshToken ?? existing.refreshToken,
        expiresAt: data.expiresAt ?? existing.expiresAt,
        metadata: data.metadata ?? existing.metadata,
        updatedBy: data.createdBy,
      }).where(eq(solarRecTeamCredentials.id, id));
    } else {
      await db.insert(solarRecTeamCredentials).values({
        id,
        provider: data.provider,
        connectionName: data.connectionName ?? null,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
        metadata: data.metadata ?? null,
        createdBy: data.createdBy,
        updatedBy: data.createdBy,
      });
    }
    return id;
  });
}

export async function deleteSolarRecTeamCredential(id: string) {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete solar rec team credential", async () => {
    await db.delete(solarRecTeamCredentials).where(eq(solarRecTeamCredentials.id, id));
  });
}
