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
import { getActiveVersionsForKeys } from "../../db/solarRecDatasets";
import {
  type CsvRow,
  clean,
  isPart2VerifiedAbpRow,
} from "./aggregatorHelpers";
import { loadDatasetRows } from "./buildSystemSnapshot";
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
}

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

export function buildOfflineMonitoringAggregates(
  input: BuildOfflineMonitoringInput
): OfflineMonitoringAggregate {
  const { abpReportRows, solarApplicationsRows } = input;

  // -------------------------------------------------------------------------
  // ABP-derived eligibility + application-id mapping
  // -------------------------------------------------------------------------
  const eligibleApplicationIds = new Set<string>();
  const eligiblePortalSystemIds = new Set<string>();
  const eligibleTrackingIds = new Set<string>();
  const abpApplicationIdBySystemKey: Record<string, string> = {};

  for (const row of abpReportRows) {
    if (!isPart2VerifiedAbpRow(row)) continue;

    const applicationId = clean(row.Application_ID);
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

    if (abpApplicationId) {
      abpApplicationIdBySystemKey[`id:${abpApplicationId}`] = abpApplicationId;
      if (trackingId) {
        abpApplicationIdBySystemKey[`tracking:${trackingId}`] = abpApplicationId;
      }
      if (projectName) {
        abpApplicationIdBySystemKey[`name:${projectName.toLowerCase()}`] =
          abpApplicationId;
      }
    }
  }

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

  return {
    eligiblePart2ApplicationIds: Array.from(eligibleApplicationIds).sort(),
    eligiblePart2PortalSystemIds: Array.from(eligiblePortalSystemIds).sort(),
    eligiblePart2TrackingIds: Array.from(eligibleTrackingIds).sort(),
    abpApplicationIdBySystemKey,
    monitoringDetailsBySystemKey,
  };
}

// ---------------------------------------------------------------------------
// Cached server entrypoint
// ---------------------------------------------------------------------------

const OFFLINE_MONITORING_DEPS = ["abpReport", "solarApplications"] as const;
const ARTIFACT_TYPE = "offlineMonitoring";

export const OFFLINE_MONITORING_RUNNER_VERSION =
  "phase-5e-step4a-offlinemonitoring@1";

interface OfflineMonitoringInputBatchIds {
  abpReportBatchId: string | null;
  solarApplicationsBatchId: string | null;
}

async function computeOfflineMonitoringInputHash(
  scopeId: string
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
      ].join("|")
    )
    .digest("hex")
    .slice(0, 16);

  return { hash, abpReportBatchId, solarApplicationsBatchId };
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
  const { hash, abpReportBatchId, solarApplicationsBatchId } =
    await computeOfflineMonitoringInputHash(scopeId);

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
        Object.keys(agg.monitoringDetailsBySystemKey).length,
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

        return buildOfflineMonitoringAggregates({
          abpReportRows,
          solarApplicationsRows,
        });
      },
    }
  );

  return { result, fromCache };
}
