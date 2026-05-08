/**
 * Dashboard ownership fact-table builder
 * (Phase 2 PR-E-2).
 *
 * Plugs into the build runner via `setDashboardBuildSteps`. After
 * this PR every successful build runs three steps:
 *   1. `monitoringDetailsFacts` (PR-C-2)
 *   2. `changeOwnershipFacts` (PR-D-2)
 *   3. `ownershipFacts`        ← this PR
 *
 * Architectural shape mirrors PR-D-2 1:1, with two key
 * simplifications relative to changeOwnership:
 *   - The aggregator entry point is `getOrBuildOverviewSummary`
 *     and the ownership rows live nested at `result.ownershipRows`.
 *   - `OwnershipOverviewExportRow` has zero numeric/decimal
 *     fields — every column on `solarRecDashboardOwnershipFacts`
 *     is a string / boolean / Date / null. No
 *     `numberToDecimalString` shim required.
 *
 * Everything else (build-tag stamping, orphan-sweep, abort-signal
 * checkpoints, single metric line) follows the proven C-2 / D-2
 * template.
 */

import type { DashboardBuildStep } from "./dashboardBuildJobRunner";
import {
  getOrBuildOverviewSummary,
  type OwnershipOverviewExportRow,
} from "./buildOverviewSummaryAggregates";
import {
  upsertOwnershipFacts,
  deleteOrphanedOwnershipFacts,
} from "../../db/dashboardOwnershipFacts";
import type { InsertSolarRecDashboardOwnershipFact } from "../../../drizzle/schema";
import { startDashboardJobMetric } from "./dashboardJobMetrics";

const STEP_NAME = "ownershipFacts";
const METRIC_PREFIX = "[dashboard:fact-build:ownership]";

/**
 * Pure transformation: OwnershipOverviewExportRow → fact-row.
 *
 * Extracted as a discrete signature so the test fixtures stay
 * focused on the row-shape contract — not the aggregator's full
 * `OverviewSummaryAggregate` (totals, ownershipOverview counts,
 * value sums). The runner-step adapter calls the aggregator and
 * narrows to `result.ownershipRows`.
 *
 * `buildId` is required because every fact row carries the build
 * that wrote it (the orphan-sweep mechanism in
 * `deleteOrphanedOwnershipFacts` keys on this).
 *
 * Field count: 20 source-row fields → 20 fact columns + scopeId +
 * buildId. No decimal serialization (no numeric columns on this
 * fact table); no empty-string-to-null normalization needed
 * because the source rows already use `null` for absent values.
 */
export function buildOwnershipFactRows(args: {
  scopeId: string;
  buildId: string;
  rows: readonly OwnershipOverviewExportRow[];
}): InsertSolarRecDashboardOwnershipFact[] {
  const { scopeId, buildId, rows } = args;
  return rows.map(row => ({
    scopeId,
    systemKey: row.key,
    part2ProjectName: row.part2ProjectName,
    part2ApplicationId: row.part2ApplicationId,
    part2SystemId: row.part2SystemId,
    part2TrackingId: row.part2TrackingId,
    source: row.source,
    systemName: row.systemName,
    systemId: row.systemId,
    stateApplicationRefId: row.stateApplicationRefId,
    trackingSystemRefId: row.trackingSystemRefId,
    ownershipStatus: row.ownershipStatus,
    isReporting: row.isReporting,
    isTransferred: row.isTransferred,
    isTerminated: row.isTerminated,
    contractType: row.contractType,
    contractStatusText: row.contractStatusText,
    latestReportingDate: row.latestReportingDate,
    contractedDate: row.contractedDate,
    zillowStatus: row.zillowStatus,
    zillowSoldDate: row.zillowSoldDate,
    buildId,
  }));
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
async function runOwnershipStep(args: {
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
    if (signal.aborted) throw new Error("aborted before aggregate fetch");
    const { result, fromCache } = await getOrBuildOverviewSummary(scopeId);

    if (signal.aborted) throw new Error("aborted after aggregate fetch");

    const rows = buildOwnershipFactRows({
      scopeId,
      buildId,
      rows: result.ownershipRows,
    });

    if (signal.aborted) throw new Error("aborted before upsert");
    await upsertOwnershipFacts(rows);
    if (signal.aborted) throw new Error("aborted before orphan sweep");
    const orphanedDeleted = await deleteOrphanedOwnershipFacts(
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
 * The exported step. Registered with the runner via
 * `registerOwnershipBuildStep()`.
 */
export const ownershipBuildStep: DashboardBuildStep = {
  name: STEP_NAME,
  run: runOwnershipStep,
};

let registered = false;

/**
 * Idempotent registration. First call appends `ownershipBuildStep`
 * to the runner's steps array; subsequent calls are no-ops.
 * Designed so a module-level call in `_core/index.ts` (server
 * boot) wires it once.
 *
 * Order independence: the runner iterates steps sequentially in
 * registration order, but the steps themselves are independent
 * (each writes to a distinct fact table). Registering this step
 * after `monitoringDetailsFacts` + `changeOwnershipFacts` means
 * ownership runs third; that's fine — they have no dependency.
 */
export async function registerOwnershipBuildStep(): Promise<void> {
  if (registered) return;
  const { getDashboardBuildSteps, setDashboardBuildSteps } = await import(
    "./dashboardBuildJobRunner"
  );
  const previous = getDashboardBuildSteps();
  if (previous.some(step => step.name === STEP_NAME)) {
    registered = true;
    return;
  }
  setDashboardBuildSteps([...previous, ownershipBuildStep]);
  registered = true;
}

/**
 * Test-only — reset the idempotency flag so a test can call
 * `registerOwnershipBuildStep()` repeatedly to verify its
 * behavior. Production code MUST NOT call this.
 */
export function __resetOwnershipBuildStepRegistrationForTests(): void {
  registered = false;
}
