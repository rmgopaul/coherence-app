/**
 * Financials version hash computation.
 *
 * The financials artifact depends on:
 * 1. ABP CSV datasets (9 dataset keys — see `FINANCIALS_CSV_DEPS`).
 * 2. The latest COMPLETED contract scan job ID.
 * 3. The latest override timestamp (MAX(overriddenAt)).
 *
 * This is a per-artifact hash — independent from system snapshot and
 * delivery tracker hashes.
 *
 * `FINANCIALS_CSV_DEPS` MUST stay in sync with what
 * `getOrBuildFinancialsAggregates` (in `buildFinancialsAggregates.ts`)
 * actually loads via `loadDatasetRows`. The slim KPI side cache
 * derives its key from this hash, so any dataset the heavy aggregator
 * reads must appear here — otherwise a re-upload of that dataset
 * leaves the slim cache stale-true.
 */

import { createHash } from "node:crypto";
import {
  getActiveVersionsForKeys,
  getScopeContractScanVersion,
} from "../../db/solarRecDatasets";

/**
 * Active dataset batches the financials aggregator depends on.
 *
 * `abpReport` was added 2026-05-04 (PR #337 follow-up item 3) — the
 * heavy aggregator's join chain reads `srDsAbpReport` via
 * `loadDatasetRows`, but the canonical hash had been omitting it,
 * which meant a re-upload of `abpReport` alone did NOT bump
 * `getFinancialsHash` and did NOT invalidate the slim KPI side cache.
 * Both consequences were silent staleness bugs.
 */
const FINANCIALS_CSV_DEPS = [
  "abpCsgSystemMapping",
  "abpUtilityInvoiceRows",
  "abpQuickBooksRows",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
  "abpReport",
] as const;

/**
 * Compute the version hash for the financials artifact.
 *
 * Includes CSV dataset batch IDs + completed scan job ID + latest override
 * timestamp. If a scan job is still running or failed, its ID is NOT included
 * (only completed jobs produce stable results).
 */
export async function computeFinancialsHash(
  scopeId: string
): Promise<string> {
  const csvVersions = await getActiveVersionsForKeys(
    scopeId,
    FINANCIALS_CSV_DEPS as unknown as string[]
  );

  const scanVersion = await getScopeContractScanVersion(scopeId);

  const parts = csvVersions
    .map((v) => `${v.datasetKey}:${v.batchId}`)
    .sort();

  if (scanVersion?.latestCompletedJobId) {
    parts.push(`scanJob:${scanVersion.latestCompletedJobId}`);
  }
  if (scanVersion?.latestOverrideAt) {
    parts.push(`override:${scanVersion.latestOverrideAt.toISOString()}`);
  }

  return createHash("sha256")
    .update(parts.join("|"))
    .digest("hex")
    .slice(0, 16);
}
