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
import { and, asc, eq, getDb, withDbRetry } from "./_core";
import {
  solarRecPermissionPresets,
  solarRecScopes,
  solarRecUserModulePermissions,
  solarRecUsers,
} from "../../drizzle/schema";
import {
  isModuleKey,
  PERMISSION_LEVELS,
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
// Presets
// ---------------------------------------------------------------------------

export interface PresetPermissionEntry {
  moduleKey: ModuleKey;
  permission: PermissionLevel;
}

export interface HydratedPreset {
  id: string;
  scopeId: string;
  name: string;
  description: string | null;
  permissions: PresetPermissionEntry[];
  createdBy: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}

function serializePresetEntries(entries: PresetPermissionEntry[]): string {
  return JSON.stringify(
    entries.map((entry) => ({
      moduleKey: entry.moduleKey,
      permission: entry.permission,
    }))
  );
}

/**
 * Parse the JSON blob in `permissionsJson`. Entries with unknown module
 * keys or invalid permission levels are dropped rather than throwing —
 * presets stay usable after a module rename without a manual data fix.
 */
function parsePresetEntries(raw: string): PresetPermissionEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const validLevels = new Set<string>(PERMISSION_LEVELS);
  const out: PresetPermissionEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const moduleKey = (item as Record<string, unknown>).moduleKey;
    const permission = (item as Record<string, unknown>).permission;
    if (
      typeof moduleKey !== "string" ||
      typeof permission !== "string" ||
      !isModuleKey(moduleKey) ||
      !validLevels.has(permission)
    ) {
      continue;
    }
    out.push({
      moduleKey: moduleKey as ModuleKey,
      permission: permission as PermissionLevel,
    });
  }
  return out;
}

function hydratePreset(row: {
  id: string;
  scopeId: string;
  name: string;
  description: string | null;
  permissionsJson: string;
  createdBy: number;
  createdAt: Date | null;
  updatedAt: Date | null;
}): HydratedPreset {
  return {
    id: row.id,
    scopeId: row.scopeId,
    name: row.name,
    description: row.description,
    permissions: parsePresetEntries(row.permissionsJson),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listSolarRecPermissionPresets(
  scopeId: string
): Promise<HydratedPreset[]> {
  const db = await getDb();
  if (!db) return [];
  return withDbRetry("list solar rec permission presets", async () => {
    const rows = await db
      .select()
      .from(solarRecPermissionPresets)
      .where(eq(solarRecPermissionPresets.scopeId, scopeId))
      .orderBy(asc(solarRecPermissionPresets.name));
    return rows.map(hydratePreset);
  });
}

export async function getSolarRecPermissionPreset(
  id: string
): Promise<HydratedPreset | null> {
  const db = await getDb();
  if (!db) return null;
  return withDbRetry("get solar rec permission preset", async () => {
    const [row] = await db
      .select()
      .from(solarRecPermissionPresets)
      .where(eq(solarRecPermissionPresets.id, id))
      .limit(1);
    return row ? hydratePreset(row) : null;
  });
}

export async function createSolarRecPermissionPreset(data: {
  scopeId: string;
  name: string;
  description: string | null;
  permissions: PresetPermissionEntry[];
  createdBy: number;
}): Promise<string> {
  const db = await getDb();
  if (!db) throw new Error("Database unavailable");
  const id = nanoid();
  await withDbRetry("create solar rec permission preset", async () => {
    await db.insert(solarRecPermissionPresets).values({
      id,
      scopeId: data.scopeId,
      name: data.name,
      description: data.description,
      permissionsJson: serializePresetEntries(data.permissions),
      createdBy: data.createdBy,
    });
  });
  return id;
}

export async function updateSolarRecPermissionPreset(data: {
  id: string;
  name?: string;
  description?: string | null;
  permissions?: PresetPermissionEntry[];
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("update solar rec permission preset", async () => {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.name !== undefined) updates.name = data.name;
    if (data.description !== undefined) updates.description = data.description;
    if (data.permissions !== undefined) {
      updates.permissionsJson = serializePresetEntries(data.permissions);
    }
    await db
      .update(solarRecPermissionPresets)
      .set(updates)
      .where(eq(solarRecPermissionPresets.id, data.id));
  });
}

export async function deleteSolarRecPermissionPreset(id: string): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await withDbRetry("delete solar rec permission preset", async () => {
    await db
      .delete(solarRecPermissionPresets)
      .where(eq(solarRecPermissionPresets.id, id));
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export { permissionAtLeast, PERMISSION_ORDER };
