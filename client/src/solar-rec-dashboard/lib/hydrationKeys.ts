/**
 * Single source of truth for "which dataset keys should hydrate."
 *
 * The dashboard has two hydration paths:
 *   - IDB path (loadDatasetsFromStorage): reads IndexedDB and
 *     materializes dataset state on mount.
 *   - Cloud path (inside the SolarRecDashboard useEffect): reads the
 *     server-side manifest via tRPC and reassembles chunked payloads.
 *
 * Both must agree on which keys to hydrate. When they drifted in the
 * past, the cloud path silently dropped datasets that weren't in any
 * tab's priority set — the UI cards read from the manifest and
 * looked present, but the memos that actually needed
 * `dataset.rows` saw empty arrays (notably ICC Report 3 → empty
 * Financials).
 *
 * Rule for local IDB: hydrate EVERY manifest entry, plus any priority
 * keys not in the manifest. Lazy-rows (buildLazyCsvDataset) makes full
 * local hydration cheap.
 *
 * Rule for remote cloud fallback: callers may opt out of manifest-wide
 * hydration and fetch priority keys only. Cloud payloads can be raw CSV
 * source files, so automatic full-manifest hydration can overload the
 * server and browser on large portfolios.
 */

import type { DatasetKey } from "../state/types";

export function resolveHydrationKeys(params: {
  manifestKeys: readonly string[];
  priorityKeys: ReadonlySet<DatasetKey> | readonly DatasetKey[];
  isDatasetKey: (value: string) => value is DatasetKey;
  includeManifestEntries?: boolean;
}): Set<DatasetKey> {
  const {
    manifestKeys,
    priorityKeys,
    isDatasetKey,
    includeManifestEntries = true,
  } = params;
  const keys = new Set<DatasetKey>();
  if (includeManifestEntries) {
    manifestKeys.forEach((rawKey) => {
      if (isDatasetKey(rawKey)) keys.add(rawKey);
    });
  }
  priorityKeys.forEach((key) => {
    keys.add(key);
  });
  return keys;
}
