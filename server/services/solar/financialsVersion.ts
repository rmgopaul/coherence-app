/**
 * Financials version hash computation.
 *
 * The financials artifact depends on:
 * 1. Multiple ABP CSV datasets (8 dataset keys)
 * 2. The latest COMPLETED contract scan job ID
 * 3. The latest override timestamp (MAX(overriddenAt))
 *
 * This is a per-artifact hash — independent from system snapshot and
 * delivery tracker hashes.
 */

import { createHash } from "node:crypto";
import {
  getActiveVersionsForKeys,
  getScopeContractScanVersion,
} from "../../db/solarRecDatasets";

const FINANCIALS_CSV_DEPS = [
  "abpCsgSystemMapping",
  "abpUtilityInvoiceRows",
  "abpQuickBooksRows",
  "abpProjectApplicationRows",
  "abpPortalInvoiceMapRows",
  "abpCsgPortalDatabaseRows",
  "abpIccReport2Rows",
  "abpIccReport3Rows",
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
