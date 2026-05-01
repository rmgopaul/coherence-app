/**
 * Server-side aggregator for the Offline Monitoring tab.
 *
 * Phase 5e Followup #4 step 4 PR-A (2026-04-30) — replaces four
 * client-side useMemos in `SolarRecDashboard.tsx` that derived from
 * `datasets.abpReport.rows` + `datasets.solarApplications.rows`:
 *
 *   - `abpEligibleTrackingIdsStrict` (Set<string>)
 *   - `abpApplicationIdBySystemKey` (Map<string, string>)
 *   - `monitoringDetailsBySystemKey` (Map<string, MonitoringDetailsRecord>)
 *   - the 3 ID Sets that drive `part2EligibleSystemsForSizeReporting`
 *
 * The first and the inner `eligiblePart2TrackingIds` set are
 * byte-identical at the source; this aggregator computes the union
 * once, the client wraps the returned arrays in `new Set` / `new Map`
 * and feeds them through the same downstream filter logic as before.
 *
 * Plain JSON serde — every field is `string` or `Record<string, *>` of
 * strings, so superjson buys nothing here.
 */
import { createHash } from "node:crypto";
import {
  srDsAbpReport,
  srDsSolarApplications,
} from "../../../drizzle/schemas/solar";
import type { FoundationArtifactPayload } from "../../../shared/solarRecFoundation";
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  type CsvRow,
  clean,
  isPart2VerifiedAbpRow,
  parseAbpAcSizeKw,
  parsePart2VerificationDate,
  resolvePart2ProjectIdentity,
} from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
import { getOrBuildFoundation } from "./foundationRunner";
import { jsonSerde, withArtifactCache } from "./withArtifactCache";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Mirrors `client/src/solar-rec-dashboard/state/types.ts ::
 * MonitoringDetailsRecord` exactly. Kept here (not in `shared/`) to
 * avoid the broader hoist; if a third consumer appears, lift this
 * type to `@shared/`.
 */
export type MonitoringDetailsRecord = {
  online_monitoring_access_type: string;
  online_monitoring: string;
  online_monitoring_granted_username: string;
  online_monitoring_username: string;
  online_monitoring_system_name: string;
  online_monitoring_system_id: string;
  online_monitoring_password: string;
  online_monitoring_website_api_link: string;
  online_monitoring_entry_method: string;
  online_monitoring_notes: string;
  online_monitoring_self_report: string;
  online_monitoring_rgm_info: string;
  online_monitoring_no_submit_generation: string;
  system_online: string;
  last_reported_online_date: string;
};

export interface BuildOfflineMonitoringInput {
  abpReportRows: CsvRow[];
  solarApplicationsRows: CsvRow[];
  /**
   * Phase 3.1 (2026-05-01) — Set of ABP application IDs the foundation
   * considers Part II Verified per the locked v3 def (mapped CSG +
   * valid Part II date + ABP status not in
   * {rejected, cancelled, withdrawn}). When provided, the builder
   * uses it instead of the legacy `isPart2VerifiedAbpRow` date-only
   * check so the 3 ID Sets and per-system maps include only systems
   * the other Phase 3.1 tabs also count. When absent (older callers
   * + the 22 existing pure-builder tests) the legacy filter applies.
   */
  eligibleApplicationIds?: Set<string>;
}

export interface OfflineMonitoringAggregate {
  /**
   * The 3 ID Sets the client uses to filter `systems` into
   * `part2EligibleSystemsForSizeReporting`. Returned as arrays
   * (JSON-friendly); client wraps in `new Set` once.
   *
   * `eligiblePart2TrackingIds` is the same set the previous
   * `abpEligibleTrackingIdsStrict` memo built — they're computed
   * from byte-identical inputs. Client uses this single array for
   * both the `abpEligibleTrackingIdsStrict` filter and the
   * tracking-ID branch of the `part2EligibleSystemsForSizeReporting`
   * filter.
   */
  eligiblePart2ApplicationIds: string[];
  eligiblePart2PortalSystemIds: string[];
  eligiblePart2TrackingIds: string[];

  /**
   * `${idType}:${id}` → ABP application ID. Three keying schemes
   * (`id:`, `tracking:`, `name:`); the lookup priority is preserved
   * from the original client memo (see `OfflineMonitoringTab.tsx`
   * line ~579 which prefers id-keys, then tracking, then name).
   */
  abpApplicationIdBySystemKey: Record<string, string>;

  /**
   * Same `${idType}:${id}` keying scheme. 15-field record per system.
   * Built from `srDsSolarApplications` rows — the password field is
   * already client-visible via the existing dataset hydration; this
   * aggregator does not introduce a new API surface for it.
   */
  monitoringDetailsBySystemKey: Record<string, MonitoringDetailsRecord>;

  /**
   * Phase 5e step 4 PR-C1 (2026-04-30) — derived `part2VerifiedAbpRows`
   * fields. The aggregator's name remains "OfflineMonitoring" for
   * historical continuity; in practice it now serves any client
   * memo that derives state from part2-verified ABP rows.
   *
   * `${idType}:${id}` → AC size in kW. First non-null value wins
   * per key (mirrors the client memo's `setIfMissing` semantics).
   * Used by SizeReportingTab and the snapshotPart2ValueSummary
   * tile to attribute installed kW back to systems.
   */
  abpAcSizeKwBySystemKey: Record<string, number>;

  /**
   * Application-ID → AC size (first non-null wins). Mirrors the
   * client's `abpAcSizeKwByApplicationId` memo.
   */
  abpAcSizeKwByApplicationId: Record<string, number>;

  /**
   * Application-ID → earliest Part-2 verification date (ISO
   * `YYYY-MM-DD`). Mirrors the client's
   * `abpPart2VerificationDateByApplicationId` memo. Stored as a
   * string for plain-JSON serde — the client wraps each value in
   * `new Date(...)` once, same as the prior local memo did.
   */
  abpPart2VerificationDateByApplicationId: Record<string, string>;

  /**
   * Distinct part-2-verified application IDs. Mirrors the client's
   * `part2VerifiedSystemIds` memo (Set<string>). Returned as a
   * sorted array; client wraps in `new Set(...)`.
   */
  part2VerifiedSystemIds: string[];

  /**
   * Count of part-2-verified rows in the active `srDsAbpReport`
   * batch (post `isPart2VerifiedAbpRow` filter). Mirrors
   * `part2VerifiedAbpRows.length` for the `part2FilterAudit`
   * diagnostic.
   */
  part2VerifiedAbpRowsCount: number;

  /**
   * Count of unique part-2 projects keyed by
   * `resolvePart2ProjectIdentity(row, index).dedupeKey`. Mirrors
   * the client's `abpEligibleTotalSystems` memo.
   */
  abpEligibleTotalSystemsCount: number;
}

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

export function buildOfflineMonitoringAggregates(
  input: BuildOfflineMonitoringInput
): OfflineMonitoringAggregate {
  const {
    abpReportRows,
    solarApplicationsRows,
    eligibleApplicationIds: foundationEligibleApplicationIds,
  } = input;

  // -------------------------------------------------------------------------
  // ABP-derived eligibility + application-id mapping + size/date/identity
  // (Phase 5e step 4 PR-C1, 2026-04-30: extended with the 5
  // `abp*By*` derivations the client used to compute locally —
  // `abpAcSizeKwBySystemKey`, `abpAcSizeKwByApplicationId`,
  // `abpPart2VerificationDateByApplicationId`,
  // `part2VerifiedSystemIds`, plus the `part2FilterAudit` counts.)
  //
  // Phase 3.1 (2026-05-01): when `foundationEligibleApplicationIds`
  // is supplied, that Set replaces `isPart2VerifiedAbpRow` as the
  // eligibility filter so this aggregator agrees with the foundation
  // definition the Overview + Change of Ownership tabs use.
  // -------------------------------------------------------------------------
  const eligibleApplicationIds = new Set<string>();
  const eligiblePortalSystemIds = new Set<string>();
  const eligibleTrackingIds = new Set<string>();
  const abpApplicationIdBySystemKey: Record<string, string> = {};
  const abpAcSizeKwBySystemKey: Record<string, number> = {};
  const abpAcSizeKwByApplicationId: Record<string, number> = {};
  const abpPart2VerificationDateByApplicationId: Record<string, Date> = {};
  const part2VerifiedSystemIdSet = new Set<string>();
  const part2DedupeKeys = new Set<string>();
  let part2VerifiedAbpRowsCount = 0;

  const setIfMissingNumber = (
    target: Record<string, number>,
    key: string,
    value: number | null
  ) => {
    if (!key || value === null || !Number.isFinite(value)) return;
    if (Object.prototype.hasOwnProperty.call(target, key)) return;
    target[key] = value;
  };

  abpReportRows.forEach((row, index) => {
    const applicationIdForFilter = clean(row.Application_ID);
    if (foundationEligibleApplicationIds) {
      if (
        !applicationIdForFilter ||
        !foundationEligibleApplicationIds.has(applicationIdForFilter)
      ) {
        return;
      }
    } else if (!isPart2VerifiedAbpRow(row)) {
      return;
    }
    part2VerifiedAbpRowsCount += 1;

    const applicationId = applicationIdForFilter;
    const portalSystemId = clean(row.system_id);
    const trackingId =
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
      clean(row.tracking_system_ref_id);

    if (applicationId) eligibleApplicationIds.add(applicationId);
    if (portalSystemId) eligiblePortalSystemIds.add(portalSystemId);
    if (trackingId) eligibleTrackingIds.add(trackingId);

    // Mirrors the client memo at SolarRecDashboard.tsx ~L3475:
    //   - id-key uses Application_ID OR system_id (first non-empty)
    //   - tracking-key uses GATS unit OR tracking_system_ref_id
    //   - name-key uses Project_Name OR system_name (lowercased)
    const abpApplicationId = applicationId || portalSystemId;
    const projectName = clean(row.Project_Name) || clean(row.system_name);
    const projectNameKey = projectName.toLowerCase();

    if (abpApplicationId) {
      abpApplicationIdBySystemKey[`id:${abpApplicationId}`] = abpApplicationId;
      if (trackingId) {
        abpApplicationIdBySystemKey[`tracking:${trackingId}`] = abpApplicationId;
      }
      if (projectName) {
        abpApplicationIdBySystemKey[`name:${projectNameKey}`] = abpApplicationId;
      }
    }

    // abpAcSizeKwBySystemKey — first-non-null per key (matches
    // client `setIfMissing` semantics).
    const acSizeKw = parseAbpAcSizeKw(row);
    if (abpApplicationId) {
      setIfMissingNumber(
        abpAcSizeKwBySystemKey,
        `id:${abpApplicationId}`,
        acSizeKw
      );
    }
    if (trackingId) {
      setIfMissingNumber(
        abpAcSizeKwBySystemKey,
        `tracking:${trackingId}`,
        acSizeKw
      );
    }
    if (projectName) {
      setIfMissingNumber(
        abpAcSizeKwBySystemKey,
        `name:${projectNameKey}`,
        acSizeKw
      );
    }

    // abpAcSizeKwByApplicationId — first-non-null per app id.
    // Note: the client uses `Application_ID || application_id`
    // here, NOT `Application_ID || system_id`. Preserved.
    const appIdLowerFallback =
      clean(row.Application_ID) || clean(row.application_id);
    if (appIdLowerFallback && acSizeKw !== null) {
      if (
        !Object.prototype.hasOwnProperty.call(
          abpAcSizeKwByApplicationId,
          appIdLowerFallback
        )
      ) {
        abpAcSizeKwByApplicationId[appIdLowerFallback] = acSizeKw;
      }
    }

    // abpPart2VerificationDateByApplicationId — earliest date wins
    // (client memo: `if (!existing || part2VerifiedDate < existing)`).
    const part2VerifiedDateRaw =
      clean(row.Part_2_App_Verification_Date) ||
      clean(row.part_2_app_verification_date);
    const part2VerifiedDate = parsePart2VerificationDate(part2VerifiedDateRaw);
    if (part2VerifiedDate && abpApplicationId) {
      const existing = abpPart2VerificationDateByApplicationId[abpApplicationId];
      if (!existing || part2VerifiedDate < existing) {
        abpPart2VerificationDateByApplicationId[abpApplicationId] =
          part2VerifiedDate;
      }
    }

    // part2VerifiedSystemIds — uses `Application_ID || system_id`
    // as the key (matches client memo).
    const verifiedSystemId = applicationId || portalSystemId;
    if (verifiedSystemId) part2VerifiedSystemIdSet.add(verifiedSystemId);

    // abpEligibleTotalSystemsCount — distinct dedupe keys.
    const { dedupeKey } = resolvePart2ProjectIdentity(row, index);
    part2DedupeKeys.add(dedupeKey);
  });

  // -------------------------------------------------------------------------
  // Solar applications → monitoring details
  // -------------------------------------------------------------------------
  const monitoringDetailsBySystemKey: Record<string, MonitoringDetailsRecord> =
    {};

  const mergeDetails = (key: string, detail: MonitoringDetailsRecord) => {
    const current = monitoringDetailsBySystemKey[key];
    if (!current) {
      monitoringDetailsBySystemKey[key] = detail;
      return;
    }
    const merged: MonitoringDetailsRecord = { ...current };
    (Object.keys(detail) as Array<keyof MonitoringDetailsRecord>).forEach(
      (field) => {
        if (!merged[field] && detail[field]) merged[field] = detail[field];
      }
    );
    monitoringDetailsBySystemKey[key] = merged;
  };

  for (const row of solarApplicationsRows) {
    const systemId = clean(row.system_id) || clean(row.Application_ID);
    const trackingId =
      clean(row.tracking_system_ref_id) ||
      clean(row.reporting_entity_ref_id) ||
      clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2);
    const systemName = clean(row.system_name) || clean(row.Project_Name);
    if (!systemId && !trackingId && !systemName) continue;

    const detail: MonitoringDetailsRecord = {
      online_monitoring_access_type: clean(row.online_monitoring_access_type),
      online_monitoring: clean(row.online_monitoring),
      online_monitoring_granted_username: clean(
        row.online_monitoring_granted_username
      ),
      online_monitoring_username: clean(row.online_monitoring_username),
      online_monitoring_system_name: clean(row.online_monitoring_system_name),
      online_monitoring_system_id: clean(row.online_monitoring_system_id),
      online_monitoring_password: clean(row.online_monitoring_password),
      online_monitoring_website_api_link: clean(
        row.online_monitoring_website_api_link
      ),
      online_monitoring_entry_method: clean(row.online_monitoring_entry_method),
      online_monitoring_notes: clean(row.online_monitoring_notes),
      online_monitoring_self_report: clean(row.online_monitoring_self_report),
      online_monitoring_rgm_info: clean(row.online_monitoring_rgm_info),
      online_monitoring_no_submit_generation: clean(
        row.online_monitoring_no_submit_generation
      ),
      system_online: clean(row.system_online),
      last_reported_online_date: clean(row.last_reported_online_date),
    };

    if (systemId) mergeDetails(`id:${systemId}`, detail);
    if (trackingId) mergeDetails(`tracking:${trackingId}`, detail);
    if (systemName) mergeDetails(`name:${systemName.toLowerCase()}`, detail);
  }

  // Serialize Date values to ISO yyyy-mm-dd strings for plain-JSON
  // serde. Client wraps each back in `new Date(...)` once when
  // building the consumer Map.
  const abpPart2VerificationDateByApplicationIdString: Record<string, string> =
    {};
  for (const [key, date] of Object.entries(
    abpPart2VerificationDateByApplicationId
  )) {
    abpPart2VerificationDateByApplicationIdString[key] = date
      .toISOString()
      .slice(0, 10);
  }

  return {
    eligiblePart2ApplicationIds: Array.from(eligibleApplicationIds).sort(),
    eligiblePart2PortalSystemIds: Array.from(eligiblePortalSystemIds).sort(),
    eligiblePart2TrackingIds: Array.from(eligibleTrackingIds).sort(),
    abpApplicationIdBySystemKey,
    monitoringDetailsBySystemKey,
    abpAcSizeKwBySystemKey,
    abpAcSizeKwByApplicationId,
    abpPart2VerificationDateByApplicationId:
      abpPart2VerificationDateByApplicationIdString,
    part2VerifiedSystemIds: Array.from(part2VerifiedSystemIdSet).sort(),
    part2VerifiedAbpRowsCount,
    abpEligibleTotalSystemsCount: part2DedupeKeys.size,
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint
// ---------------------------------------------------------------------------

const OFFLINE_MONITORING_DEPS = ["abpReport", "solarApplications"] as const;
// Phase 3.1 (2026-05-01) — bumped from `"offlineMonitoring"` so old
// cache rows under the legacy date-only Part II filter don't leak
// in. The new payload's eligibility comes from the foundation's
// locked Part II definition.
const ARTIFACT_TYPE = "offlineMonitoring-v2";

export const OFFLINE_MONITORING_RUNNER_VERSION =
  "phase-3.1-offlinemonitoring-foundation@1";

interface OfflineMonitoringInputBatchIds {
  abpReportBatchId: string | null;
  solarApplicationsBatchId: string | null;
}

async function computeOfflineMonitoringInputHash(
  scopeId: string,
  foundationInputVersionHash: string
): Promise<{ hash: string } & OfflineMonitoringInputBatchIds> {
  const versions = await getActiveVersionsForKeys(
    scopeId,
    OFFLINE_MONITORING_DEPS as unknown as string[]
  );
  const abpReportBatchId =
    versions.find((v) => v.datasetKey === "abpReport")?.batchId ?? null;
  const solarApplicationsBatchId =
    versions.find((v) => v.datasetKey === "solarApplications")?.batchId ?? null;

  const hash = createHash("sha256")
    .update(
      [
        `runner:${OFFLINE_MONITORING_RUNNER_VERSION}`,
        `abp:${abpReportBatchId ?? ""}`,
        `solarApps:${solarApplicationsBatchId ?? ""}`,
        `foundation:${foundationInputVersionHash}`,
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, solarApplicationsBatchId };
}

/**
 * Build the union of ABP application IDs the foundation considers
 * Part II Verified. Walks `foundation.part2EligibleCsgIds` and
 * collects `abpIds[]` per CSG. Used by both the cached entrypoint
 * and the cross-tab parity test fixture.
 */
export function collectFoundationEligibleApplicationIds(
  foundation: FoundationArtifactPayload
): Set<string> {
  const out = new Set<string>();
  for (const csgId of foundation.part2EligibleCsgIds) {
    const sys = foundation.canonicalSystemsByCsgId[csgId];
    if (!sys) continue;
    for (const abpId of sys.abpIds) {
      out.add(abpId);
    }
  }
  return out;
}

/**
 * Pure recompute body — extracted so cross-tab parity tests can
 * exercise the full foundation-eligibility path without touching
 * the DB. Cached entrypoint passes already-loaded inputs.
 */
export function buildOfflineMonitoringAggregatesWithFoundationOverlay(
  foundation: FoundationArtifactPayload,
  abpReportRows: CsvRow[],
  solarApplicationsRows: CsvRow[]
): OfflineMonitoringAggregate {
  return buildOfflineMonitoringAggregates({
    abpReportRows,
    solarApplicationsRows,
    eligibleApplicationIds: collectFoundationEligibleApplicationIds(foundation),
  });
}

/**
 * Public entrypoint for the tRPC query.
 *
 * Cache miss path:
 *   1. Loads `srDsAbpReport` rows (typically a few hundred KB).
 *   2. Loads `srDsSolarApplications` rows (similar size).
 *   3. Runs the pure aggregator above.
 *
 * No early-return on missing batches — both paths produce empty
 * outputs that the client renders correctly (empty Sets/Maps =
 * "no eligible systems").
 *
 * Plain JSON serde because everything in the output is plain
 * strings and string-keyed records.
 */
export async function getOrBuildOfflineMonitoringAggregates(
  scopeId: string
): Promise<{ result: OfflineMonitoringAggregate; fromCache: boolean }> {
  // Phase 3.1: foundation defines Part II eligibility for all 3
  // tabs. The eligibility set passed to the pure builder is the
  // union of `abpIds` across foundation.part2EligibleCsgIds.
  const { payload: foundation, inputVersionHash: foundationHash } =
    await getOrBuildFoundation(scopeId);

  const { hash, abpReportBatchId, solarApplicationsBatchId } =
    await computeOfflineMonitoringInputHash(scopeId, foundationHash);

  const { result, fromCache } = await withArtifactCache<OfflineMonitoringAggregate>(
    {
      scopeId,
      artifactType: ARTIFACT_TYPE,
      inputVersionHash: hash,
      serde: jsonSerde<OfflineMonitoringAggregate>(),
      rowCount: (agg) =>
        agg.eligiblePart2ApplicationIds.length +
        agg.eligiblePart2PortalSystemIds.length +
        agg.eligiblePart2TrackingIds.length +
        Object.keys(agg.abpApplicationIdBySystemKey).length +
        Object.keys(agg.monitoringDetailsBySystemKey).length +
        Object.keys(agg.abpAcSizeKwBySystemKey).length +
        Object.keys(agg.abpAcSizeKwByApplicationId).length +
        Object.keys(agg.abpPart2VerificationDateByApplicationId).length +
        agg.part2VerifiedSystemIds.length,
      recompute: async () => {
        const [abpReportRows, solarApplicationsRows] = await Promise.all([
          abpReportBatchId
            ? loadDatasetRows(scopeId, abpReportBatchId, srDsAbpReport)
            : Promise.resolve([] as CsvRow[]),
          solarApplicationsBatchId
            ? loadDatasetRows(
                scopeId,
                solarApplicationsBatchId,
                srDsSolarApplications
              )
            : Promise.resolve([] as CsvRow[]),
        ]);
        return buildOfflineMonitoringAggregatesWithFoundationOverlay(
          foundation,
          abpReportRows,
          solarApplicationsRows
        );
      },
    }
  );

  return { result, fromCache };
}
