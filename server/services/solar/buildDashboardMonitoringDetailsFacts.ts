/**
 * Dashboard monitoring-details fact-table builder
 * (Phase 2 PR-C-2).
 *
 * Plugs into the build runner ([#415](https://github.com/rmgopaul/coherence-app/pull/415))
 * via `setDashboardBuildSteps`. On every successful build, this
 * step:
 *
 *   1. Calls the EXISTING `getOrBuildOfflineMonitoringAggregates`
 *      aggregator. The aggregator already produces the per-system
 *      maps we need (`monitoringDetailsBySystemKey`,
 *      `abpApplicationIdBySystemKey`, `abpAcSizeKwBySystemKey`).
 *      Reusing it means we don't duplicate the abpReport →
 *      monitoring-record parsing logic.
 *
 *   2. Reshapes those maps into `solarRecDashboardMonitoringDetailsFacts`
 *      row records (one per `${idType}:${id}` system key).
 *
 *   3. UPSERTs the rows tagged with the current `buildId`, then
 *      deletes orphaned rows (rows for systems that disappeared
 *      from the input — i.e., rows whose `buildId` doesn't match
 *      the current build).
 *
 *   4. Logs a one-line metric on completion: rows written + rows
 *      orphan-deleted + heap delta.
 *
 * After this step runs, the table reflects EXACTLY the systems in
 * the latest successful build. PR-C-3 will add the paginated read
 * proc that reads from this table.
 *
 * The pure transformation
 * (`buildMonitoringDetailsFactRows`) is unit-tested in isolation
 * so the row-shape contract can be pinned without spinning up the
 * runner. The runner step (`monitoringDetailsBuildStep`) is
 * tested separately with mocked DB helpers.
 */

import type { DashboardBuildStep } from "./dashboardBuildJobRunner";
import {
  getOrBuildOfflineMonitoringAggregates,
  type MonitoringDetailsRecord,
} from "./buildOfflineMonitoringAggregates";
import {
  upsertMonitoringDetailsFacts,
  deleteOrphanedMonitoringDetailsFacts,
} from "../../db/dashboardMonitoringDetailsFacts";
import type { InsertSolarRecDashboardMonitoringDetailsFact } from "../../../drizzle/schema";
import { startDashboardJobMetric } from "./dashboardJobMetrics";

const STEP_NAME = "monitoringDetailsFacts";
const METRIC_PREFIX = "[dashboard:fact-build:monitoringDetails]";

/**
 * Pure transformation: aggregate → fact-row array.
 *
 * Input shape mirrors the existing `OfflineMonitoringAggregate`
 * subset we need. Extracted as a discrete signature (rather than
 * passing the full aggregate) so the test fixtures stay focused
 * on the transformation contract — not the aggregator's full 9-
 * field output. The runner-step adapter calls the aggregator and
 * narrows to this subset.
 *
 * `buildId` is required because every fact row carries the build
 * that wrote it (the orphan-sweep mechanism in
 * `deleteOrphanedMonitoringDetailsFacts` keys on this).
 *
 * Decimal serialization: `abpAcSizeKwBySystemKey` is a `number`
 * map, but Drizzle's MySQL `decimal()` columns map to `string` at
 * the wire level. Convert numerically-finite values to their
 * canonical string form via `String(n)` (preserves precision up
 * to JS double's mantissa; the schema column is `decimal(12, 4)`
 * which is well within representable range).
 */
export function buildMonitoringDetailsFactRows(args: {
  scopeId: string;
  buildId: string;
  monitoringDetailsBySystemKey: Record<string, MonitoringDetailsRecord>;
  abpApplicationIdBySystemKey: Record<string, string>;
  abpAcSizeKwBySystemKey: Record<string, number>;
}): InsertSolarRecDashboardMonitoringDetailsFact[] {
  const {
    scopeId,
    buildId,
    monitoringDetailsBySystemKey,
    abpApplicationIdBySystemKey,
    abpAcSizeKwBySystemKey,
  } = args;

  const rows: InsertSolarRecDashboardMonitoringDetailsFact[] = [];
  for (const [systemKey, details] of Object.entries(
    monitoringDetailsBySystemKey
  )) {
    const abpApplicationId =
      abpApplicationIdBySystemKey[systemKey] ?? null;
    const acSize = abpAcSizeKwBySystemKey[systemKey];
    const abpAcSizeKw =
      typeof acSize === "number" && Number.isFinite(acSize)
        ? String(acSize)
        : null;

    rows.push({
      scopeId,
      systemKey,
      onlineMonitoringAccessType: emptyToNull(details.online_monitoring_access_type),
      onlineMonitoring: emptyToNull(details.online_monitoring),
      onlineMonitoringGrantedUsername: emptyToNull(
        details.online_monitoring_granted_username
      ),
      onlineMonitoringUsername: emptyToNull(details.online_monitoring_username),
      onlineMonitoringSystemName: emptyToNull(
        details.online_monitoring_system_name
      ),
      onlineMonitoringSystemId: emptyToNull(details.online_monitoring_system_id),
      onlineMonitoringPassword: emptyToNull(details.online_monitoring_password),
      onlineMonitoringWebsiteApiLink: emptyToNull(
        details.online_monitoring_website_api_link
      ),
      onlineMonitoringEntryMethod: emptyToNull(
        details.online_monitoring_entry_method
      ),
      onlineMonitoringNotes: emptyToNull(details.online_monitoring_notes),
      onlineMonitoringSelfReport: emptyToNull(
        details.online_monitoring_self_report
      ),
      onlineMonitoringRgmInfo: emptyToNull(details.online_monitoring_rgm_info),
      onlineMonitoringNoSubmitGeneration: emptyToNull(
        details.online_monitoring_no_submit_generation
      ),
      systemOnline: emptyToNull(details.system_online),
      lastReportedOnlineDate: emptyToNull(details.last_reported_online_date),
      abpApplicationId,
      abpAcSizeKw,
      buildId,
    });
  }

  return rows;
}

/**
 * Convert empty strings to null. The aggregator's `clean(...)`
 * helper returns `""` for missing source fields; the fact column
 * is nullable text, so we want `NULL` for absent values rather
 * than empty string. Lets queries distinguish "system has no
 * online_monitoring_password set" from "system has explicit empty
 * string" downstream.
 */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  if (value.length === 0) return null;
  return value;
}

/**
 * Runner step. The build runner calls this with `{ scopeId,
 * buildId, signal }`; we drive the whole table-refresh in one
 * pass.
 *
 * Step contract (from `DashboardBuildStep`): never throws unless
 * the work genuinely failed. The runner converts thrown errors
 * into the build row's `errorMessage` and stops at the first
 * failing step. We lean on that: any DB-helper error bubbles up
 * and the runner records it.
 */
async function runMonitoringDetailsStep(args: {
  scopeId: string;
  buildId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { scopeId, buildId, signal } = args;
  // 2026-05-08 (consolidation) — see buildDashboardChangeOwnershipFacts.ts
  // for the consolidation rationale; this builder follows the same shape.
  const metric = startDashboardJobMetric({
    prefix: METRIC_PREFIX,
    jobId: buildId,
    context: { scopeId },
  });

  try {
    // 1. Build (or fetch from artifact cache) the existing
    // OfflineMonitoring aggregate. The cached path is a sub-second
    // read; the cache-miss path can take 5-15 seconds on a busy
    // scope. Either way, the runner's per-step timeout (4 minutes)
    // gives us plenty of headroom.
    if (signal.aborted) throw new Error("aborted before aggregate fetch");
    const { result, fromCache } =
      await getOrBuildOfflineMonitoringAggregates(scopeId);

    if (signal.aborted) throw new Error("aborted after aggregate fetch");

    // 2. Reshape into fact rows.
    const rows = buildMonitoringDetailsFactRows({
      scopeId,
      buildId,
      monitoringDetailsBySystemKey: result.monitoringDetailsBySystemKey,
      abpApplicationIdBySystemKey: result.abpApplicationIdBySystemKey,
      abpAcSizeKwBySystemKey: result.abpAcSizeKwBySystemKey,
    });

    // 3. UPSERT then orphan-sweep. The two-step pattern guarantees
    // the table reflects EXACTLY the current build's systems after
    // the step completes. Order matters: UPSERT first (so current
    // systems' rows are tagged with the new buildId), then DELETE
    // orphans (rows still tagged with a prior buildId).
    if (signal.aborted) throw new Error("aborted before upsert");
    await upsertMonitoringDetailsFacts(rows);
    if (signal.aborted) throw new Error("aborted before orphan sweep");
    const orphanedDeleted = await deleteOrphanedMonitoringDetailsFacts(
      scopeId,
      buildId
    );

    metric.finish({
      rowsWritten: rows.length,
      orphanedDeleted,
      fromCache,
    });
  } catch (err) {
    metric.fail(err);
    throw err;
  }
}

/**
 * The exported step. PR-C-2's wiring is responsible for
 * registering this with `setDashboardBuildSteps([...prev,
 * monitoringDetailsBuildStep])` at boot — typically inside an
 * `_core` initialization module. PR-C-2 keeps the registration
 * lazy: the step ships, but PR consumers can opt in by importing
 * `registerMonitoringDetailsBuildStep()` once (idempotent).
 */
export const monitoringDetailsBuildStep: DashboardBuildStep = {
  name: STEP_NAME,
  run: runMonitoringDetailsStep,
};

let registered = false;

/**
 * Idempotent registration. First call appends
 * `monitoringDetailsBuildStep` to the runner's steps array;
 * subsequent calls are no-ops. Designed so a module-level import
 * in `_core/index.ts` (server boot) wires it once and the test
 * suite can opt in selectively without polluting other tests.
 */
export async function registerMonitoringDetailsBuildStep(): Promise<void> {
  if (registered) return;
  // Lazy import to avoid a circular dep at module-load time
  // (the runner depends on db helpers; we depend on the runner;
  // either order is fine but the lazy import keeps the import
  // graph simple).
  const { getDashboardBuildSteps, setDashboardBuildSteps } = await import(
    "./dashboardBuildJobRunner"
  );
  const previous = getDashboardBuildSteps();
  if (previous.some(step => step.name === STEP_NAME)) {
    registered = true;
    return;
  }
  setDashboardBuildSteps([...previous, monitoringDetailsBuildStep]);
  registered = true;
}

/**
 * Test-only — reset the idempotency flag so a test can call
 * `registerMonitoringDetailsBuildStep()` repeatedly to verify
 * its behavior. Production code MUST NOT call this.
 */
export function __resetMonitoringDetailsBuildStepRegistrationForTests(): void {
  registered = false;
}
