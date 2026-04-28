/**
 * Task 9.1 (2026-04-28) — Solar Applications as the system registry.
 *
 * The Portfolio Workbench (Phase 9) keys every surface off the
 * canonical CSG ID. Before building the workbench, we need a
 * server-side primitive that takes a CSG ID and returns the joined
 * record across the three datasets that together describe a system:
 *
 *   1. **Solar Applications** (`srDsSolarApplications`) — system
 *      size, REC price, contract amount, installer, location, raw
 *      contract type. The "system list" source of truth.
 *
 *   2. **ABP CSG-System Mapping** (`srDsAbpCsgSystemMapping`) —
 *      `csgId` ↔ `systemId`. ABP IDs are not always present, but
 *      every system that ever interacted with ABP shows up here.
 *
 *   3. **Contracted Date** (`srDsContractedDate`) — the per-system
 *      contracted date. Keyed by systemId.
 *
 * Join chain:
 *
 *   csgId  ──(mapping)──▶  systemId  ──▶  Solar Applications
 *                                    └──▶  Contracted Date
 *
 * Fallback when the mapping row is missing: try a direct lookup
 * where `srDsSolarApplications.applicationId === csgId` OR
 * `srDsSolarApplications.systemId === csgId`. This covers older
 * single-tenant data where the CSG ID was inlined into the system
 * row before the mapping dataset existed.
 *
 * Active batch resolution: each row table is partitioned by batchId,
 * and the "live" version is pinned in `solarRecActiveDatasetVersions`
 * (one row per (scopeId, datasetKey)). This helper resolves all
 * three pointers in one query, then runs the targeted lookups in
 * parallel.
 *
 * Read shape: returns `null` if no Solar Applications row matches
 * (with or without the mapping fallback). Otherwise returns a
 * normalized `SystemRegistryRecord` — primitive fields only, no
 * raw CSV passthrough — so downstream callers (Phase 9 detail page
 * + workset builder) get a stable contract.
 */

import {
  eq,
  and,
  inArray,
  getDb,
  withDbRetry,
} from "./_core";
import { or } from "drizzle-orm";
import {
  srDsSolarApplications,
  srDsAbpCsgSystemMapping,
  srDsContractedDate,
  solarRecActiveDatasetVersions,
} from "../../drizzle/schema";

/** The dataset keys this helper depends on. Centralized here so a
 *  rename of any of them surfaces as a tsc error. */
const DATASET_KEYS = {
  solarApplications: "solarApplications",
  abpCsgSystemMapping: "abpCsgSystemMapping",
  contractedDate: "contractedDate",
} as const;

export interface SystemRegistryRecord {
  /** Input CSG ID — echoed back so callers can pass an array. */
  csgId: string;
  /** ABP ID if the mapping was found. Always equals the system row's
   *  `systemId` field (the column ABP populates). */
  abpId: string | null;
  /** Solar Applications applicationId — equal to the CSG ID for
   *  legacy fallback rows, otherwise from `Application_ID` in the
   *  Solar Applications CSV. */
  applicationId: string | null;
  /** Solar Applications systemId — same column ABP joins on. */
  systemId: string | null;
  /** GATS / MRETS unit ID — used by tracking joins. */
  trackingSystemRefId: string | null;
  stateCertificationNumber: string | null;
  systemName: string | null;
  installedKwAc: number | null;
  installedKwDc: number | null;
  recPrice: number | null;
  totalContractAmount: number | null;
  annualRecs: number | null;
  contractType: string | null;
  installerName: string | null;
  county: string | null;
  state: string | null;
  zipCode: string | null;
  /** Contracted Date as ISO string ("YYYY-MM-DD" preferred but raw
   *  CSV value passed through if it differs — Phase 9 callers parse
   *  on display). */
  contractedDate: string | null;
}

/** Resolve the three active batch IDs in one DB round-trip. Returns
 *  a map keyed by datasetKey; missing keys (i.e. the dataset hasn't
 *  been activated for this scope yet) map to `null`. Exposed for
 *  testability and reuse. */
export type SystemRegistryBatchIds = Record<
  keyof typeof DATASET_KEYS,
  string | null
>;

export async function resolveSystemRegistryBatchIds(
  scopeId: string
): Promise<SystemRegistryBatchIds> {
  const db = await getDb();
  const out: SystemRegistryBatchIds = {
    solarApplications: null,
    abpCsgSystemMapping: null,
    contractedDate: null,
  };
  if (!db) return out;

  const keys = Object.values(DATASET_KEYS);
  const rows = await withDbRetry("system registry — active batches", () =>
    db
      .select({
        datasetKey: solarRecActiveDatasetVersions.datasetKey,
        batchId: solarRecActiveDatasetVersions.batchId,
      })
      .from(solarRecActiveDatasetVersions)
      .where(
        and(
          eq(solarRecActiveDatasetVersions.scopeId, scopeId),
          inArray(solarRecActiveDatasetVersions.datasetKey, keys)
        )
      )
  );

  for (const row of rows) {
    if (row.datasetKey === DATASET_KEYS.solarApplications) {
      out.solarApplications = row.batchId;
    } else if (row.datasetKey === DATASET_KEYS.abpCsgSystemMapping) {
      out.abpCsgSystemMapping = row.batchId;
    } else if (row.datasetKey === DATASET_KEYS.contractedDate) {
      out.contractedDate = row.batchId;
    }
  }
  return out;
}

/**
 * Look up one system by CSG ID. Returns `null` when no Solar
 * Applications row matches (even after the legacy fallback). The
 * caller decides how to render a missing system (e.g. "system not
 * yet imported" vs "CSG ID typo").
 */
export async function getSystemByCsgId(
  scopeId: string,
  csgId: string
): Promise<SystemRegistryRecord | null> {
  const trimmedCsgId = csgId.trim();
  if (!trimmedCsgId) return null;

  const db = await getDb();
  if (!db) return null;

  const batches = await resolveSystemRegistryBatchIds(scopeId);

  // Step 1 — resolve mapping (if the dataset is active for this
  // scope). The mapping is the canonical CSG → systemId resolver.
  let mappedSystemId: string | null = null;
  const mappingBatchId = batches.abpCsgSystemMapping;
  if (mappingBatchId) {
    const mappingRows = await withDbRetry(
      "system registry — mapping lookup",
      () =>
        db
          .select({
            csgId: srDsAbpCsgSystemMapping.csgId,
            systemId: srDsAbpCsgSystemMapping.systemId,
          })
          .from(srDsAbpCsgSystemMapping)
          .where(
            and(
              eq(srDsAbpCsgSystemMapping.scopeId, scopeId),
              eq(srDsAbpCsgSystemMapping.batchId, mappingBatchId),
              eq(srDsAbpCsgSystemMapping.csgId, trimmedCsgId)
            )
          )
          .limit(1)
    );
    mappedSystemId = mappingRows[0]?.systemId?.trim() || null;
  }

  // Step 2 — find the Solar Applications row. We have two candidate
  // join keys: the mapping-resolved systemId, OR the input CSG ID
  // itself for legacy rows that pre-date the mapping dataset. Try
  // `applicationId` first (Application_ID is the documented PK),
  // then `systemId` (older CSVs put the same value here).
  const appsBatchId = batches.solarApplications;
  if (!appsBatchId) return null;

  const candidates: string[] = [];
  if (mappedSystemId) candidates.push(mappedSystemId);
  candidates.push(trimmedCsgId);
  // Dedupe in case mapping returned the input verbatim.
  const uniqueCandidates = Array.from(new Set(candidates));

  const appRows = await withDbRetry(
    "system registry — applications lookup",
    () =>
      db
        .select()
        .from(srDsSolarApplications)
        .where(
          and(
            eq(srDsSolarApplications.scopeId, scopeId),
            eq(srDsSolarApplications.batchId, appsBatchId),
            // Match either applicationId or systemId against any of
            // the candidate values. drizzle's `or(...)` plus two
            // `inArray`s returns rows whose applicationId OR
            // systemId is in the candidate set.
            or(
              inArray(srDsSolarApplications.applicationId, uniqueCandidates),
              inArray(srDsSolarApplications.systemId, uniqueCandidates)
            )
          )
        )
        .limit(1)
  );

  const appRow = appRows[0];
  if (!appRow) return null;

  const resolvedSystemId =
    mappedSystemId ?? appRow.systemId?.trim() ?? appRow.applicationId?.trim() ?? null;

  // Step 3 — look up the contracted date by the resolved systemId.
  // If the contracted-date dataset isn't active OR there's no row,
  // we just return null for that field.
  let contractedDate: string | null = null;
  const datesBatchId = batches.contractedDate;
  if (resolvedSystemId && datesBatchId) {
    const dateRows = await withDbRetry(
      "system registry — contracted date lookup",
      () =>
        db
          .select({ contractedDate: srDsContractedDate.contractedDate })
          .from(srDsContractedDate)
          .where(
            and(
              eq(srDsContractedDate.scopeId, scopeId),
              eq(srDsContractedDate.batchId, datesBatchId),
              eq(srDsContractedDate.systemId, resolvedSystemId)
            )
          )
          .limit(1)
    );
    contractedDate = dateRows[0]?.contractedDate ?? null;
  }

  return {
    csgId: trimmedCsgId,
    abpId: mappedSystemId,
    applicationId: appRow.applicationId ?? null,
    systemId: appRow.systemId ?? null,
    trackingSystemRefId: appRow.trackingSystemRefId ?? null,
    stateCertificationNumber: appRow.stateCertificationNumber ?? null,
    systemName: appRow.systemName ?? null,
    installedKwAc: appRow.installedKwAc ?? null,
    installedKwDc: appRow.installedKwDc ?? null,
    recPrice: appRow.recPrice ?? null,
    totalContractAmount: appRow.totalContractAmount ?? null,
    annualRecs: appRow.annualRecs ?? null,
    contractType: appRow.contractType ?? null,
    installerName: appRow.installerName ?? null,
    county: appRow.county ?? null,
    state: appRow.state ?? null,
    zipCode: appRow.zipCode ?? null,
    contractedDate,
  };
}
