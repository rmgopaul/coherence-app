/**
 * Solar REC dashboard "Standing" risk taxonomy — single source of
 * truth shared between server aggregators (fact-table builders,
 * overview/change-ownership summary builders) and client tabs.
 *
 * Hoisted to `shared/` in PR B2 so the same derive function can run
 * in three places without three implementations:
 *   - the client worker that builds `SystemRecord[]` in
 *     `client/src/solar-rec-dashboard/lib/buildSystems.ts`
 *   - the server aggregator that emits `OwnershipOverviewExportRow[]`
 *     in `server/services/solar/buildOverviewSummaryAggregates.ts`
 *   - the server aggregator that emits `ChangeOwnershipExportRow[]`
 *     in `server/services/solar/buildChangeOwnershipAggregates.ts`
 *
 * Replaces the prior client-only `lib/deriveStanding.ts` (the
 * client module now re-exports from here).
 *
 * History:
 *   - PR A (#647): introduced the type + helper at
 *     `client/src/solar-rec-dashboard/lib/deriveStanding.ts` and
 *     populated `solarRecDashboardSystemFacts.standing`.
 *   - PR B1 (#648): retired the legacy "Status" column from
 *     SystemsIndex + the dedicated `ownershipStatus` zod input on
 *     `getDashboardSystemsPage`.
 *   - PR B2 (this PR): hoisted to shared so the aggregate fact
 *     tables (`solarRecDashboardOwnershipFacts`,
 *     `solarRecDashboardChangeOwnershipFacts`) can populate
 *     `standing` from the server aggregators.
 *
 * See `client/src/solar-rec-dashboard/state/types.ts` for the prose
 * spec of each tier and the decision tree.
 */

// ---------------------------------------------------------------------------
// Contract-type constants + predicates
// ---------------------------------------------------------------------------
//
// Normalized form: lowercase + collapsed internal whitespace. Matches
// `normalizeContractType` semantics from
// `client/src/solar-rec-dashboard/lib/helpers/abp.ts` (which now
// re-exports `isDefaultedContractType` from here too).

export const IL_ABP_TRANSFERRED_CONTRACT_TYPE = "il abp - transferred";
export const IL_ABP_TERMINATED_CONTRACT_TYPE = "il abp - terminated";
/**
 * "Terminated and RECs were not repaid" — distinct from
 * `IL_ABP_TERMINATED_CONTRACT_TYPE` (which closes in good standing).
 * Drives the "Closed — Default" tier on the Standing taxonomy.
 */
export const IL_ABP_DEFAULTED_CONTRACT_TYPE = "il abp - defaulted";

export function normalizeContractType(
  value: string | null | undefined,
): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isTransferredContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_TRANSFERRED_CONTRACT_TYPE;
}

export function isTerminatedContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_TERMINATED_CONTRACT_TYPE;
}

export function isDefaultedContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_DEFAULTED_CONTRACT_TYPE;
}

// ---------------------------------------------------------------------------
// Standing type + derivation
// ---------------------------------------------------------------------------

/**
 * Risk-tier "Standing" taxonomy keyed off CSG portal `contractType`.
 *
 * Replaces (on user-facing tiles) the legacy 6-value `OwnershipStatus`
 * for surfaces that need to differentiate proper assignment
 * (`IL ABP - Transferred` → a legitimate ownership handoff with
 * paperwork) from orphaned transfers (a GATS transfer observed
 * without contract assignment — the failure mode the risk taxonomy
 * was designed to surface).
 *
 * 9 values:
 *   - "Active — Good Standing"
 *   - "Active — Good Standing (Assigned)"
 *   - "At Risk — Unassigned Transfer"
 *   - "At Risk — Reporting Lapse"
 *   - "At Risk — Reporting Lapse (Assigned)"
 *   - "Jeopardy / Default-Track"
 *   - "Closed — RECs Repaid (Good Standing)"
 *   - "Closed — Default"
 *   - "Unknown"
 */
export type Standing =
  | "Active — Good Standing"
  | "Active — Good Standing (Assigned)"
  | "At Risk — Unassigned Transfer"
  | "At Risk — Reporting Lapse"
  | "At Risk — Reporting Lapse (Assigned)"
  | "Jeopardy / Default-Track"
  | "Closed — RECs Repaid (Good Standing)"
  | "Closed — Default"
  | "Unknown";

/**
 * Pure derivation of the `Standing` risk tier.
 *
 * Inputs:
 *   - `contractType`: from CSG portal `abpCsgPortalDatabaseRows`.
 *   - `transferSeen`: true ⇔ system has at least one row in
 *     `srDsTransferHistory` (a GATS transfer happened). Equivalent
 *     to `SystemRecord.isTransferred` (the builder maps
 *     `builder.transferSeen` → `isTransferred` 1:1).
 *   - `isReporting`: meter freshness predicate (latestReportingDate
 *     within the last 3 months).
 *
 * Decision tree:
 *
 *   contractType === null/empty                    → "Unknown"
 *   contractType === "IL ABP - Terminated"         → "Closed — RECs Repaid (Good Standing)"
 *   contractType === "IL ABP - Defaulted"          → "Closed — Default"
 *
 *   ownership tier:
 *     contractType === "IL ABP - Transferred"      → Assigned
 *     transferSeen                                 → Orphaned
 *     else                                         → Intact
 *
 *   Intact     + reporting     → "Active — Good Standing"
 *   Intact     + not reporting → "At Risk — Reporting Lapse"
 *   Assigned   + reporting     → "Active — Good Standing (Assigned)"
 *   Assigned   + not reporting → "At Risk — Reporting Lapse (Assigned)"
 *   Orphaned   + reporting     → "At Risk — Unassigned Transfer"
 *   Orphaned   + not reporting → "Jeopardy / Default-Track"
 */
export function deriveStanding(
  contractType: string | null | undefined,
  transferSeen: boolean,
  isReporting: boolean,
): Standing {
  if (!contractType || contractType.trim() === "") {
    return "Unknown";
  }

  if (isTerminatedContractType(contractType)) {
    return "Closed — RECs Repaid (Good Standing)";
  }
  if (isDefaultedContractType(contractType)) {
    return "Closed — Default";
  }

  if (isTransferredContractType(contractType)) {
    return isReporting
      ? "Active — Good Standing (Assigned)"
      : "At Risk — Reporting Lapse (Assigned)";
  }

  if (transferSeen) {
    return isReporting
      ? "At Risk — Unassigned Transfer"
      : "Jeopardy / Default-Track";
  }

  return isReporting ? "Active — Good Standing" : "At Risk — Reporting Lapse";
}
