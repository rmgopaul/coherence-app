/**
 * Dashboard system fact-table builder
 * (Phase 2 PR-F-2).
 *
 * Plugs into the build runner via `setDashboardBuildSteps`. After
 * this PR every successful build runs four steps:
 *   1. `monitoringDetailsFacts` (PR-C-2)
 *   2. `changeOwnershipFacts` (PR-D-2)
 *   3. `ownershipFacts`        (PR-E-2)
 *   4. `systemFacts`            ← this PR
 *
 * Architectural shape mirrors PR-D-2 / PR-E-2 with one difference:
 *   - The aggregator entry point is `getOrBuildSystemSnapshot` and
 *     the array lives at `result.systems`. Type is `unknown[]` at
 *     the wire boundary (the aggregator is server-side only and
 *     SystemRecord lives in client types) so we narrow via an
 *     inline subset type before reshaping.
 *
 * Decimal serialization: SystemRecord has 9 numeric-or-null fields
 * (`installedKwAc`, `installedKwDc`, `recPrice`, `totalContractAmount`,
 * `contractedRecs`, `deliveredRecs`, `contractedValue`,
 * `deliveredValue`, `valueGap`, plus `latestReportingKwh`). All
 * write to `decimal()` columns which Drizzle wire-encodes as
 * `string | null`. Same `numberToDecimalString` shim from PR-D-2.
 *
 * Everything else (build-tag stamping, orphan-sweep, abort-signal
 * checkpoints, single metric line) follows the proven C-2 / D-2 /
 * E-2 template.
 */

import type { DashboardBuildStep } from "./dashboardBuildJobRunner";
import { getOrBuildSystemSnapshot } from "./buildSystemSnapshot";
import {
  upsertSystemFacts,
  deleteOrphanedSystemFacts,
} from "../../db/dashboardSystemFacts";
import type { InsertSolarRecDashboardSystemFact } from "../../../drizzle/schema";

const STEP_NAME = "systemFacts";
const METRIC_PREFIX = "[dashboard:fact-build:system]";

/**
 * Subset of `SystemRecord` (defined client-side at
 * `client/src/solar-rec-dashboard/state/types.ts`) the builder
 * reads. Mirrors the type's 31 fields 1:1. Kept inline rather than
 * cross-importing because the aggregator output is typed as
 * `unknown[]` at the wire boundary; the cast happens here, once,
 * with a comment.
 *
 * Adding a field here means: (a) declare it in this type, (b) map
 * it in `buildSystemFactRows` below, (c) add a column to the
 * `solarRecDashboardSystemFacts` schema.
 */
export interface SystemRecordSubset {
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string | null;
  systemName: string;
  installedKwAc: number | null;
  installedKwDc: number | null;
  sizeBucket: string;
  recPrice: number | null;
  totalContractAmount: number | null;
  contractedRecs: number | null;
  deliveredRecs: number | null;
  contractedValue: number | null;
  deliveredValue: number | null;
  valueGap: number | null;
  latestReportingDate: Date | null;
  latestReportingKwh: number | null;
  isReporting: boolean;
  isTerminated: boolean;
  isTransferred: boolean;
  ownershipStatus: string;
  hasChangedOwnership: boolean;
  changeOwnershipStatus: string | null;
  contractStatusText: string;
  contractType: string | null;
  zillowStatus: string | null;
  zillowSoldDate: Date | null;
  contractedDate: Date | null;
  monitoringType: string;
  monitoringPlatform: string;
  installerName: string;
  part2VerificationDate: Date | null;
}

/**
 * Pure transformation: SystemRecord → fact-row.
 *
 * `buildId` is required because every fact row carries the build
 * that wrote it (the orphan-sweep mechanism in
 * `deleteOrphanedSystemFacts` keys on this).
 *
 * Decimal serialization: 10 `decimal()` columns map to `string`
 * at the Drizzle wire level. Convert numerically-finite values
 * via `String(n)` (preserves precision up to JS double's mantissa;
 * the schema columns are `decimal(12, 4)` for kw and
 * `decimal(18, 4)` for money/RECs — well within representable
 * range).
 */
export function buildSystemFactRows(args: {
  scopeId: string;
  buildId: string;
  rows: readonly SystemRecordSubset[];
}): InsertSolarRecDashboardSystemFact[] {
  const { scopeId, buildId, rows } = args;
  return rows.map(row => ({
    scopeId,
    systemKey: row.key,
    systemId: row.systemId,
    stateApplicationRefId: row.stateApplicationRefId,
    trackingSystemRefId: row.trackingSystemRefId,
    systemName: row.systemName,
    installedKwAc: numberToDecimalString(row.installedKwAc),
    installedKwDc: numberToDecimalString(row.installedKwDc),
    sizeBucket: row.sizeBucket,
    recPrice: numberToDecimalString(row.recPrice),
    totalContractAmount: numberToDecimalString(row.totalContractAmount),
    contractedRecs: numberToDecimalString(row.contractedRecs),
    deliveredRecs: numberToDecimalString(row.deliveredRecs),
    contractedValue: numberToDecimalString(row.contractedValue),
    deliveredValue: numberToDecimalString(row.deliveredValue),
    valueGap: numberToDecimalString(row.valueGap),
    latestReportingDate: row.latestReportingDate,
    latestReportingKwh: numberToDecimalString(row.latestReportingKwh),
    isReporting: row.isReporting,
    isTerminated: row.isTerminated,
    isTransferred: row.isTransferred,
    ownershipStatus: row.ownershipStatus,
    hasChangedOwnership: row.hasChangedOwnership,
    changeOwnershipStatus: row.changeOwnershipStatus,
    contractStatusText: row.contractStatusText,
    contractType: row.contractType,
    zillowStatus: row.zillowStatus,
    zillowSoldDate: row.zillowSoldDate,
    contractedDate: row.contractedDate,
    monitoringType: row.monitoringType,
    monitoringPlatform: row.monitoringPlatform,
    installerName: row.installerName,
    part2VerificationDate: row.part2VerificationDate,
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
async function runSystemStep(args: {
  scopeId: string;
  buildId: string;
  signal: AbortSignal;
}): Promise<void> {
  const { scopeId, buildId, signal } = args;
  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = Date.now();

  if (signal.aborted) throw new Error("aborted before aggregate fetch");
  const { systems, fromCache } = await getOrBuildSystemSnapshot(scopeId);

  if (signal.aborted) throw new Error("aborted after aggregate fetch");

  // Cast `unknown[]` → `SystemRecordSubset[]`. The aggregator IS
  // the source of these rows; this is the validated boundary
  // every other downstream consumer assumes.
  const rows = buildSystemFactRows({
    scopeId,
    buildId,
    rows: systems as readonly SystemRecordSubset[],
  });

  if (signal.aborted) throw new Error("aborted before upsert");
  await upsertSystemFacts(rows);
  if (signal.aborted) throw new Error("aborted before orphan sweep");
  const orphanedDeleted = await deleteOrphanedSystemFacts(scopeId, buildId);

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
 * `registerSystemBuildStep()`.
 */
export const systemBuildStep: DashboardBuildStep = {
  name: STEP_NAME,
  run: runSystemStep,
};

let registered = false;

/**
 * Idempotent registration. First call appends `systemBuildStep`
 * to the runner's steps array; subsequent calls are no-ops.
 * Designed so a module-level call in `_core/index.ts` (server
 * boot) wires it once.
 *
 * Order independence: the runner iterates steps sequentially in
 * registration order, but the steps themselves are independent
 * (each writes to a distinct fact table). Registering this step
 * after `monitoringDetailsFacts` + `changeOwnershipFacts` +
 * `ownershipFacts` means system runs fourth; that's fine — they
 * have no dependency on each other.
 */
export async function registerSystemBuildStep(): Promise<void> {
  if (registered) return;
  const { getDashboardBuildSteps, setDashboardBuildSteps } = await import(
    "./dashboardBuildJobRunner"
  );
  const previous = getDashboardBuildSteps();
  if (previous.some(step => step.name === STEP_NAME)) {
    registered = true;
    return;
  }
  setDashboardBuildSteps([...previous, systemBuildStep]);
  registered = true;
}

/**
 * Test-only — reset the idempotency flag so a test can call
 * `registerSystemBuildStep()` repeatedly to verify its behavior.
 * Production code MUST NOT call this.
 */
export function __resetSystemBuildStepRegistrationForTests(): void {
  registered = false;
}
