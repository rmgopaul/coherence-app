/**
 * DB helpers for the Task 5.1 permission matrix.
 *
 * Two concerns live here:
 *   - `solarRecUserModulePermissions` rows (the matrix itself).
 *   - Scope-owner / scope-admin lookups that the middleware uses to decide
 *     whether a given user bypasses the matrix entirely.
 *
 * The middleware in `server/_core/solarRecRouter.ts` calls
 * `resolveEffectivePermission(userId, scopeId, moduleKey)` on every gated
 * procedure. Keep it cheap: one row read + two small lookups.
 */

import { nanoid } from "nanoid";
import { and, eq, getDb, withDbRetry } from "./_core";
import {
  solarRecScopes,
  solarRecUserModulePermissions,
  solarRecUsers,
} from "../../drizzle/schema";
import {
  PERMISSION_ORDER,
  permissionAtLeast,
  type ModuleKey,
  type PermissionLevel,
} from "../../shared/solarRecModules";

// ---------------------------------------------------------------------------
// Scope lookups
// ---------------------------------------------------------------------------

export async function getSolarRecScope(scopeId: string) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec scope", async () => {
    const [row] = await db
      .select()
      .from(solarRecScopes)
      .where(eq(solarRecScopes.id, scopeId))
      .limit(1);
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// isScopeAdmin flag on solarRecUsers
// ---------------------------------------------------------------------------

export async function setSolarRecUserScopeAdmin(
  userId: number,
  isScopeAdmin: boolean
): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("set solar rec user scope admin flag", async () => {
    await db
      .update(solarRecUsers)
      .set({ isScopeAdmin })
      .where(eq(solarRecUsers.id, userId));
  });
}

// ---------------------------------------------------------------------------
// solarRecUserModulePermissions rows
// ---------------------------------------------------------------------------

export async function listSolarRecUserModulePermissions(scopeId: string) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec user module permissions", async () =>
    db
      .select()
      .from(solarRecUserModulePermissions)
      .where(eq(solarRecUserModulePermissions.scopeId, scopeId))
  );
}

export async function getSolarRecUserModulePermissionsForUser(
  userId: number,
  scopeId: string
) {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry(
    "get solar rec user module permissions for user",
    async () =>
      db
        .select()
        .from(solarRecUserModulePermissions)
        .where(
          and(
            eq(solarRecUserModulePermissions.userId, userId),
            eq(solarRecUserModulePermissions.scopeId, scopeId)
          )
        )
  );
}

export async function getSolarRecUserModulePermission(
  userId: number,
  scopeId: string,
  moduleKey: ModuleKey
) {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user module permission", async () => {
    const [row] = await db
      .select()
      .from(solarRecUserModulePermissions)
      .where(
        and(
          eq(solarRecUserModulePermissions.userId, userId),
          eq(solarRecUserModulePermissions.scopeId, scopeId),
          eq(solarRecUserModulePermissions.moduleKey, moduleKey)
        )
      )
      .limit(1);
    return row ?? null;
  });
}

export async function upsertSolarRecUserModulePermission(data: {
  userId: number;
  scopeId: string;
  moduleKey: ModuleKey;
  permission: PermissionLevel;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("upsert solar rec user module permission", async () => {
    await db
      .insert(solarRecUserModulePermissions)
      .values({
        id: nanoid(),
        userId: data.userId,
        scopeId: data.scopeId,
        moduleKey: data.moduleKey,
        permission: data.permission,
      })
      .onDuplicateKeyUpdate({
        set: {
          permission: data.permission,
          updatedAt: new Date(),
        },
      });
  });
}

/**
 * Overwrite a user's permissions for the given scope. Any row in
 * `permissions` is upserted; any existing row whose moduleKey is NOT in
 * `permissions` is deleted. This matches Task 5.1's "apply preset overwrites
 * a user's permissions" semantic.
 */
export async function replaceSolarRecUserModulePermissions(data: {
  userId: number;
  scopeId: string;
  permissions: Array<{ moduleKey: ModuleKey; permission: PermissionLevel }>;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry(
    "replace solar rec user module permissions",
    async () => {
      await db
        .delete(solarRecUserModulePermissions)
        .where(
          and(
            eq(solarRecUserModulePermissions.userId, data.userId),
            eq(solarRecUserModulePermissions.scopeId, data.scopeId)
          )
        );
      if (data.permissions.length > 0) {
        await db.insert(solarRecUserModulePermissions).values(
          data.permissions.map((p) => ({
            id: nanoid(),
            userId: data.userId,
            scopeId: data.scopeId,
            moduleKey: p.moduleKey,
            permission: p.permission,
          }))
        );
      }
    }
  );
}

// ---------------------------------------------------------------------------
// resolveEffectivePermission — the hot path used by middleware
// ---------------------------------------------------------------------------

export interface EffectivePermission {
  level: PermissionLevel;
  /**
   * If true the user bypasses the matrix entirely because they are the
   * scope owner or `isScopeAdmin=true`. The caller can use this to short-
   * circuit further checks in the same request.
   */
  isBypass: boolean;
}

/**
 * Resolve a user's effective permission for a module. Implements the rules
 * documented in the Task 5.1 plan:
 *
 *   - Scope owner (`solarRecScopes.ownerUserId`) → admin (bypass)
 *   - `solarRecUsers.isScopeAdmin = true`        → admin (bypass)
 *   - Row in `solarRecUserModulePermissions`     → row's level
 *   - No row                                     → none
 *
 * The `user` and `scope` arguments are optional; if you already have them
 * loaded pass them in to skip the extra DB reads.
 */
export async function resolveEffectivePermission(
  userId: number,
  scopeId: string,
  moduleKey: ModuleKey,
  opts?: {
    user?: { id: number; isScopeAdmin: boolean } | null;
    scope?: { id: string; ownerUserId: number } | null;
  }
): Promise<EffectivePermission> {
  const scope =
    opts?.scope !== undefined
      ? opts.scope
      : await getSolarRecScope(scopeId);
  if (scope && scope.ownerUserId === userId) {
    return { level: "admin", isBypass: true };
  }

  const user =
    opts?.user !== undefined
      ? opts.user
      : await getSolarRecScopeAdminFlag(userId);
  if (user?.isScopeAdmin) {
    return { level: "admin", isBypass: true };
  }

  const row = await getSolarRecUserModulePermission(userId, scopeId, moduleKey);
  if (!row) return { level: "none", isBypass: false };
  return { level: row.permission as PermissionLevel, isBypass: false };
}

async function getSolarRecScopeAdminFlag(
  userId: number
): Promise<{ id: number; isScopeAdmin: boolean } | null> {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec user scope admin flag", async () => {
    const [row] = await db
      .select({
        id: solarRecUsers.id,
        isScopeAdmin: solarRecUsers.isScopeAdmin,
      })
      .from(solarRecUsers)
      .where(eq(solarRecUsers.id, userId))
      .limit(1);
    return row ?? null;
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export { permissionAtLeast, PERMISSION_ORDER };
