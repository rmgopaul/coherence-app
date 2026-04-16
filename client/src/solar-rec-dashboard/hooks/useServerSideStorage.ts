/**
 * Feature flag + migration state hook for server-side storage.
 *
 * Controls the transition from IndexedDB to server-side normalized storage.
 * When enabled, tabs fetch data from tRPC endpoints instead of parent props.
 *
 * The flag is stored in localStorage so it persists across page loads
 * and can be toggled from the Settings UI or browser console.
 */

import { useState, useEffect, useCallback } from "react";
import {
  hasIndexedDbDatasets,
  migrateIndexedDbToServer,
  type MigrationProgress,
} from "../lib/migrateToServer";

const FEATURE_FLAG_KEY = "solarRec:serverSideStorage";

/**
 * Check if server-side storage is enabled.
 * Can also be checked synchronously from non-React code.
 */
export function isServerSideStorageEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(FEATURE_FLAG_KEY) === "true";
}

/**
 * Hook for managing server-side storage feature flag + migration.
 */
export function useServerSideStorage(scopeId: string | null) {
  const [enabled, setEnabled] = useState(() => isServerSideStorageEnabled());
  const [hasLocalData, setHasLocalData] = useState(false);
  const [migrationProgress, setMigrationProgress] =
    useState<MigrationProgress | null>(null);

  // Check for IndexedDB data on mount
  useEffect(() => {
    hasIndexedDbDatasets().then(setHasLocalData).catch(() => setHasLocalData(false));
  }, []);

  const toggle = useCallback((value: boolean) => {
    localStorage.setItem(FEATURE_FLAG_KEY, String(value));
    setEnabled(value);
  }, []);

  const startMigration = useCallback(async () => {
    if (!scopeId) return;

    const result = await migrateIndexedDbToServer(scopeId, (progress) => {
      setMigrationProgress({ ...progress });
    });

    if (result.status === "done" && result.errors.length === 0) {
      // Migration successful — enable server-side storage
      toggle(true);
      setHasLocalData(false);
    }

    return result;
  }, [scopeId, toggle]);

  return {
    /** Whether server-side storage is currently enabled */
    enabled,
    /** Toggle the feature flag */
    toggle,
    /** Whether IndexedDB has datasets that could be migrated */
    hasLocalData,
    /** Start the IndexedDB → server migration */
    startMigration,
    /** Current migration progress (null if not migrating) */
    migrationProgress,
    /** Whether a migration needs to happen (local data exists, server not enabled) */
    needsMigration: hasLocalData && !enabled,
  };
}
