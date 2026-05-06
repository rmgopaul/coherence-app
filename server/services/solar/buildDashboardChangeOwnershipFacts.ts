/**
 * Dashboard change-of-ownership fact-table builder
 * (Phase 2 PR-D-2).
 *
 * Plugs into the build runner ([#415](https://github.com/rmgopaul/coherence-app/pull/415))
 * via `setDashboardBuildSteps`. After this PR every successful
 * build runs both `monitoringDetailsFacts` (PR-C-2) AND the new
 * `changeOwnershipFacts` step.
 *
 * Architectural shape mirrors PR-C-2 1:1:
 *   1. Call `getOrBuildChangeOwnership(scopeId)` — returns
 *      cached `ChangeOwnershipAggregate` (or rebuilds on cache
 *      miss).
 *   2. Reshape `result.rows: ChangeOwnershipExportRow[]` into
 *      `solarRecDashboardChangeOwnershipFacts` row records (one
 *      per system).
 *   3. UPSERT the rows tagged with the current `buildId`, then
 *      delete orphaned rows.
 *   4. Log a one-line metric on completion.
 *
 * Reusing the existing aggregator means we don't duplicate the
 * `ChangeOwnershipExportRow[]` derivation logic. The aggregator
 * already runs through `withArtifactCache` so a build that fires
 * shortly after a previous one hits the cache rather than
 * re-scanning srDs* tables.
 */

import type { DashboardBuildStep } from "./dashboardBuildJobRunner";
import {
  getOrBuildChangeOwnership,
  type ChangeOwnershipExportRow,
} from "./buildChangeOwnershipAggregates";
import {
  upsertChangeOwnershipFacts,
  deleteOrphanedChangeOwnershipFacts,
} from "../../db/dashboardChangeOwnershipFacts";
import type { InsertSolarRecDashboardChangeOwnershipFact } from "../../../drizzle/schema";

const STEP_NAME = "changeOwnershipFacts";
const METRIC_PREFIX = "[dashboard:fact-build:changeOwnership]";

/**
 * Pure transformation: ChangeOwnershipExportRow → fact-row.
 *
 * Extracted as a discrete signature so the test fixtures stay
 * focused on the row-shape contract — not the aggregator's full
 * 4-field output (`rows`, `summary`, `cooNotTransferredNotReportingCurrentCount`,
 * `ownershipStackedChartRows`). The runner-step adapter calls the
 * aggregator and narrows to `result.rows`.
 *
 * `buildId` is required because every fact row carries the build
 * that wrote it (the orphan-sweep mechanism in
 * `deleteOrphanedChangeOwnershipFacts` keys on this).
 *
 * Decimal serialization: `installedKwAc`, `totalContractAmount`,
 * `contractedValue` are `number | null` in the source row but
 * Drizzle's MySQL `decimal()` columns map to `string` at the
 * wire level. Convert numerically-finite values via `String(n)`
 * (preserves precision up to JS double's mantissa; the schema
 * columns are `decimal(18, 4)` which is well within representable
 * range).
 */
export function buildChangeOwnershipFactRows(args: {
  scopeId: string;
  buildId: string;
  rows: readonly ChangeOwnershipExportRow[];
}): InsertSolarRecDashboardChangeOwnershipFact[] {
  const { scopeId, buildId, rows } = args;
  return rows.map(row => ({
    scopeId,
    systemKey: row.key,
    systemName: row.systemName,
    systemId: row.systemId,
    trackingSystemRefId: row.trackingSystemRefId,
    installedKwAc: numberToDecimalString(row.installedKwAc),
    contractType: row.contractType,
    contractStatusText: row.contractStatusText,
    contractedDate: row.contractedDate,
    zillowStatus: row.zillowStatus,
    zillowSoldDate: row.zillowSoldDate,
    latestReportingDate: row.latestReportingDate,
    changeOwnershipStatus: row.changeOwnershipStatus,
    ownershipStatus: row.ownershipStatus,
    isReporting: row.isReporting,
    isTerminated: row.isTerminated,
    isTransferred: row.isTransferred,
    hasChangedOwnership: row.hasChangedOwnership,
    totalContractAmount: numberToDecimalString(row.totalContractAmount),
    contractedValue: numberToDecimalString(row.contractedValue),
    buildId,
  }));
}

function numberToDecimalString(value: number | null): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(value);
}

/**
 * Runner step. Drives the whole table-refresh in one pass:
 * aggregator → reshape → upsert → orphan-sweep.
 *
 * Step contract (from `DashboardBuildStep`): never throws unless
 * the work genuinely failed. The runner converts thrown errors
 * into the build row's `errorMessage` and stops at the first
 * failing step.
 */
async function runChangeOwnershipStep(args: {
  scopeId: string;
  buildId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { scopeId, buildId, signal } = args;
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();

  if (signal.aborted) throw new Error("aborted before aggregate fetch");
  const { result, fromCache } = await getOrBuildChangeOwnership(scopeId);

  if (signal.aborted) throw new Error("aborted after aggregate fetch");

  const rows = buildChangeOwnershipFactRows({
    scopeId,
    buildId,
    rows: result.rows,
  });

  if (signal.aborted) throw new Error("aborted before upsert");
  await upsertChangeOwnershipFacts(rows);
  if (signal.aborted) throw new Error("aborted before orphan sweep");
  const orphanedDeleted = await deleteOrphanedChangeOwnershipFacts(
    scopeId,
    buildId
  );

  const heapAfter = process.memoryUsage().heapUsed;
  const elapsedMs = Date.now() - startedAt;
  // eslint-disable-next-line no-console
  console.log(
    `${METRIC_PREFIX} metric ${JSON.stringify({
      scopeId,
      buildId,
      rowsWritten: rows.length,
      orphanedDeleted,
      fromCache,
      elapsedMs,
      heapDeltaBytes: heapAfter - heapBefore,
    })}`
  );
}

/**
 * The exported step. Registered with the runner via
 * `registerChangeOwnershipBuildStep()`.
 */
export const changeOwnershipBuildStep: DashboardBuildStep = {
  name: STEP_NAME,
  run: runChangeOwnershipStep,
};

let registered = false;

/**
 * Idempotent registration. First call appends
 * `changeOwnershipBuildStep` to the runner's steps array;
 * subsequent calls are no-ops. Designed so a module-level call
 * in `_core/index.ts` (server boot) wires it once.
 *
 * Order independence: the runner iterates steps sequentially in
 * registration order, but the steps themselves are independent
 * (each writes to a distinct fact table). Registering this step
 * after `monitoringDetailsFacts` means changeOwnership runs
 * second; that's fine — they have no dependency.
 */
export async function registerChangeOwnershipBuildStep(): Promise<void> {
  if (registered) return;
  const { getDashboardBuildSteps, setDashboardBuildSteps } = await import(
    "./dashboardBuildJobRunner"
  );
  const previous = getDashboardBuildSteps();
  if (previous.some(step => step.name === STEP_NAME)) {
    registered = true;
    return;
  }
  setDashboardBuildSteps([...previous, changeOwnershipBuildStep]);
  registered = true;
}

/**
 * Test-only — reset the idempotency flag so a test can call
 * `registerChangeOwnershipBuildStep()` repeatedly to verify its
 * behavior. Production code MUST NOT call this.
 */
export function __resetChangeOwnershipBuildStepRegistrationForTests(): void {
  registered = false;
}
