import { useMemo } from "react";
import { solarRecTrpc } from "@/solar-rec/solarRecTrpc";
import {
  permissionAtLeast,
  type ModuleKey,
  type PermissionLevel,
} from "@shared/solarRecModules";

type MyPermissions = {
  scopeId: string;
  isScopeAdmin: boolean;
  permissions: Record<ModuleKey, PermissionLevel>;
};

/**
 * Permission snapshot for a single module on the current user. Call sites
 * use `canRead` / `canEdit` / `canAdmin` to gate sidebar entries and
 * disable/hide write controls.
 *
 * The underlying `permissions.getMyPermissions` query is cached for the
 * whole app, so every page using this hook shares one round-trip.
 */
export function useSolarRecPermission(moduleKey: ModuleKey): {
  loading: boolean;
  level: PermissionLevel;
  canRead: boolean;
  canEdit: boolean;
  canAdmin: boolean;
  isScopeAdmin: boolean;
} {
  const query = solarRecTrpc.permissions.getMyPermissions.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });

  return useMemo(() => {
    const data = query.data as MyPermissions | undefined;
    const level: PermissionLevel = data?.permissions?.[moduleKey] ?? "none";
    return {
      loading: query.isLoading,
      level,
      canRead: permissionAtLeast(level, "read"),
      canEdit: permissionAtLeast(level, "edit"),
      canAdmin: permissionAtLeast(level, "admin"),
      isScopeAdmin: data?.isScopeAdmin ?? false,
    };
  }, [query.data, query.isLoading, moduleKey]);
}

/**
 * Returns the full permission map for the current user. Prefer the
 * per-module hook above for point-of-use gating; use this one in a
 * sidebar that iterates every module to decide what to render.
 */
export function useSolarRecPermissions(): {
  loading: boolean;
  isScopeAdmin: boolean;
  scopeId: string | null;
  permissions: Record<ModuleKey, PermissionLevel> | null;
} {
  const query = solarRecTrpc.permissions.getMyPermissions.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  });
  const data = query.data as MyPermissions | undefined;
  return {
    loading: query.isLoading,
    isScopeAdmin: data?.isScopeAdmin ?? false,
    scopeId: data?.scopeId ?? null,
    permissions: data?.permissions ?? null,
  };
}
