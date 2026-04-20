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
 * Rule: hydrate EVERY manifest entry, plus any priority keys not in
 * the manifest (so the landing tab's CORE_REQUIRED_DATASET_KEYS
 * always get a fetch attempt even on a fresh scope). Lazy-rows
 * (buildLazyCsvDataset) makes full hydration cheap — tabs that never
 * mount never materialize row objects.
 */

import type { DatasetKey } from "../state/types";

export function resolveHydrationKeys(params: {
  manifestKeys: Iterable<string>;
  priorityKeys: Iterable<DatasetKey>;
  isDatasetKey: (value: string) => value is DatasetKey;
}): Set<DatasetKey> {
  const { manifestKeys, priorityKeys, isDatasetKey } = params;
  const keys = new Set<DatasetKey>();
  for (const rawKey of manifestKeys) {
    if (!isDatasetKey(rawKey)) continue;
    keys.add(rawKey);
  }
  for (const key of priorityKeys) {
    keys.add(key);
  }
  return keys;
}
