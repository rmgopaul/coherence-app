/**
 * View-model types for the Supplements feature.
 *
 * Reuses canonical `SupplementDefinition` / `SupplementLog` types inferred
 * from tRPC router outputs in `features/dashboard/types.ts` — do not redefine.
 */

import type { SupplementDefinition, SupplementLog } from "@/features/dashboard/types";

/** One row in the protocol table — display shape, not a DB row. */
export interface SupplementProtocolRow {
  definition: SupplementDefinition;
  costPerDose: number | null;
  monthlyCost: number | null;
  adherenceTaken: number;
  adherenceExpected: number;
  adherencePct: number;
  lastLog: SupplementLog | null;
}

/** Summary used by the dashboard card footer. */
export interface DashboardProtocolSummary {
  lockedCount: number;
  takenLockedToday: number;
  monthlyProtocolCost: number;
  /** adherencePct in [0, 1] per definitionId over the short dashboard window. */
  adherenceByDefinitionId: Record<string, number>;
}
