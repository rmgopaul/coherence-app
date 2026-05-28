/**
 * Pure derivation of the `Standing` risk tier from the three signals
 * that drive it:
 *
 *   - `contractType` — string from the CSG portal
 *     `abpCsgPortalDatabaseRows` dataset (normalized case-insensitively
 *     via `normalizeContractType`). Three load-bearing values:
 *       - `"IL ABP - Transferred"` → contract has been assigned (the
 *         healthy transfer path: proper assignment doc on file).
 *       - `"IL ABP - Terminated"` → terminated with RECs repaid
 *         (closed in good standing — no remaining exposure).
 *       - `"IL ABP - Defaulted"` → terminated without RECs repaid
 *         (closed in default — financial loss).
 *     Any other non-empty value (PSA, Full Upfront, Pay-as-you-go,
 *     plain "IL ABP", etc.) flows through the Active/At-Risk branches
 *     determined by `transferSeen` + `isReporting`.
 *   - `transferSeen` — `true` when the system has at least one row in
 *     `srDsTransferHistory` (a GATS transfer happened). Combined with
 *     a non-"IL ABP - Transferred" contract type, this is the
 *     "orphaned transfer" failure mode the taxonomy was built to
 *     surface: RECs moved but no contract assignment paperwork.
 *   - `isReporting` — meter freshness predicate (latestReportingDate
 *     within the last 3 months). Distinguishes "Good Standing" from
 *     "Reporting Lapse" inside the Active/Assigned branches and
 *     escalates Orphaned to "Jeopardy / Default-Track" when stale.
 *
 * Decision tree (matches the user-confirmed taxonomy):
 *
 *   contractType === null/empty                  → "Unknown"
 *   contractType === "IL ABP - Terminated"       → "Closed — RECs Repaid (Good Standing)"
 *   contractType === "IL ABP - Defaulted"        → "Closed — Default"
 *
 *   ownership tier:
 *     contractType === "IL ABP - Transferred"    → Assigned
 *     transferSeen                               → Orphaned
 *     else                                       → Intact
 *
 *   Intact     + reporting    → "Active — Good Standing"
 *   Intact     + not reporting → "At Risk — Reporting Lapse"
 *   Assigned   + reporting    → "Active — Good Standing (Assigned)"
 *   Assigned   + not reporting → "At Risk — Reporting Lapse (Assigned)"
 *   Orphaned   + reporting    → "At Risk — Unassigned Transfer"
 *   Orphaned   + not reporting → "Jeopardy / Default-Track"
 *
 * PR A: parallel coexistence with `ownershipStatus`. PR B migrates
 * tabs / aggregates / exports + drops `ownershipStatus`.
 */

import {
  isDefaultedContractType,
  isTerminatedContractType,
  isTransferredContractType,
} from "@/solar-rec-dashboard/lib/helpers/abp";
import type { Standing } from "@/solar-rec-dashboard/state/types";

export function deriveStanding(
  contractType: string | null | undefined,
  transferSeen: boolean,
  isReporting: boolean,
): Standing {
  // 1. Null/empty contractType → Unknown (~15k rows in prod).
  if (!contractType || contractType.trim() === "") {
    return "Unknown";
  }

  // 2. Closed states — both bypass ownership + reporting branches.
  if (isTerminatedContractType(contractType)) {
    return "Closed — RECs Repaid (Good Standing)";
  }
  if (isDefaultedContractType(contractType)) {
    return "Closed — Default";
  }

  // 3. Ownership tier — explicit Assigned beats observed transfer.
  if (isTransferredContractType(contractType)) {
    return isReporting
      ? "Active — Good Standing (Assigned)"
      : "At Risk — Reporting Lapse (Assigned)";
  }

  // 4. Orphaned: GATS transfer observed without contract assignment.
  //    Reporting → still on watchlist; not reporting → jeopardy.
  if (transferSeen) {
    return isReporting
      ? "At Risk — Unassigned Transfer"
      : "Jeopardy / Default-Track";
  }

  // 5. Intact: no transfer, no termination, just contract running.
  return isReporting ? "Active — Good Standing" : "At Risk — Reporting Lapse";
}
