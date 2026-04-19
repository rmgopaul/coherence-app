/**
 * Client-side display + assembly helpers for the Supplements feature.
 *
 * Pure functions only (no React, no tRPC calls) — keeps them testable and
 * reusable across the dashboard card and the standalone page.
 *
 * Shared math (costPerDose, monthlyProtocolCost, etc.) lives in
 * `@shared/supplements.math` so server cost summaries match the UI exactly.
 */

import {
  adherencePct as rawAdherencePct,
  costPerDose as rawCostPerDose,
  DAYS_PER_MONTH,
  monthlyProtocolCost,
} from "@shared/supplements.math";
import { formatCurrency, toLocalDateKey } from "@/lib/helpers";
import type {
  SupplementDefinition,
  SupplementLog,
} from "@/features/dashboard/types";
import type {
  DashboardProtocolSummary,
  SupplementProtocolRow,
} from "./supplements.types";

/** Shape returned by `trpc.supplements.getAdherenceStats`. */
export interface AdherenceRow {
  definitionId: string;
  takenDays: number;
  expectedDays: number;
}

/** `$0.28/dose` or `—` when cost inputs are missing. */
export function formatCostPerDose(
  def: Pick<SupplementDefinition, "pricePerBottle" | "quantityPerBottle">,
): string {
  const value = rawCostPerDose(def);
  if (value === null) return "—";
  return `${formatCurrency(value)}/dose`;
}

/** `$15.00` for a single dose, no trailing unit — for tables where the column is "Cost/dose". */
export function formatCostPerDoseBare(
  def: Pick<SupplementDefinition, "pricePerBottle" | "quantityPerBottle">,
): string {
  const value = rawCostPerDose(def);
  if (value === null) return "—";
  return formatCurrency(value);
}

/** Monthly cost of a single definition at one-dose-per-day, or `—` when not computable. */
export function formatMonthlyCostForDef(
  def: Pick<SupplementDefinition, "pricePerBottle" | "quantityPerBottle">,
): string {
  const value = rawCostPerDose(def);
  if (value === null) return "—";
  return formatCurrency(value * DAYS_PER_MONTH);
}

/** `86%` or `—` when no expected doses. Uses whole-number percentages for compact UI. */
export function formatAdherencePct(taken: number, expected: number): string {
  if (expected <= 0) return "—";
  const pct = Math.round(rawAdherencePct(taken, expected) * 100);
  return `${pct}%`;
}

/** Short chip label used on the dashboard card: `7d 86%` or `7d —`. */
export function formatAdherenceChip(
  windowDays: number,
  taken: number,
  expected: number,
): string {
  return `${windowDays}d ${formatAdherencePct(taken, expected)}`;
}

/**
 * Number of locked definitions that have at least one log with matching
 * `dateKey == today`. Used for the "today X/Y" footer on the card.
 */
export function countTakenLockedToday(
  defs: readonly SupplementDefinition[],
  todayLogs: readonly SupplementLog[],
  today: string = toLocalDateKey(),
): number {
  const lockedIds = new Set(
    defs.filter((d) => d.isLocked && d.isActive).map((d) => d.id),
  );
  const takenIds = new Set<string>();
  for (const log of todayLogs) {
    if (log.dateKey !== today) continue;
    if (!log.definitionId) continue;
    if (!lockedIds.has(log.definitionId)) continue;
    takenIds.add(log.definitionId);
  }
  return takenIds.size;
}

/** Locked active count used for "today X/Y". */
export function countLockedActive(defs: readonly SupplementDefinition[]): number {
  return defs.filter((d) => d.isLocked && d.isActive).length;
}

/** Build the dashboard-card summary from raw query results. */
export function buildDashboardSummary(
  defs: readonly SupplementDefinition[],
  todayLogs: readonly SupplementLog[],
  adherence: readonly AdherenceRow[],
  today: string = toLocalDateKey(),
): DashboardProtocolSummary {
  const adherenceByDefinitionId: Record<string, number> = {};
  for (const row of adherence) {
    adherenceByDefinitionId[row.definitionId] = rawAdherencePct(
      row.takenDays,
      row.expectedDays,
    );
  }
  return {
    lockedCount: countLockedActive(defs),
    takenLockedToday: countTakenLockedToday(defs, todayLogs, today),
    monthlyProtocolCost: monthlyProtocolCost(defs),
    adherenceByDefinitionId,
  };
}

/** Assemble the protocol table rows from raw query results. */
export function buildProtocolRows(
  defs: readonly SupplementDefinition[],
  logs: readonly SupplementLog[],
  adherence: readonly AdherenceRow[],
): SupplementProtocolRow[] {
  const adherenceById = new Map<string, AdherenceRow>();
  for (const row of adherence) {
    adherenceById.set(row.definitionId, row);
  }

  const latestLogByDefId = new Map<string, SupplementLog>();
  for (const log of logs) {
    if (!log.definitionId) continue;
    const prior = latestLogByDefId.get(log.definitionId);
    if (!prior) {
      latestLogByDefId.set(log.definitionId, log);
      continue;
    }
    // Latest wins by `takenAt`.
    const priorTime = new Date(prior.takenAt).getTime();
    const currTime = new Date(log.takenAt).getTime();
    if (currTime > priorTime) latestLogByDefId.set(log.definitionId, log);
  }

  return defs.map((def) => {
    const perDose = rawCostPerDose(def);
    const monthly = perDose === null ? null : perDose * DAYS_PER_MONTH;
    const adherenceRow = adherenceById.get(def.id);
    const taken = adherenceRow?.takenDays ?? 0;
    const expected = adherenceRow?.expectedDays ?? 0;
    return {
      definition: def,
      costPerDose: perDose,
      monthlyCost: monthly,
      adherenceTaken: taken,
      adherenceExpected: expected,
      adherencePct: rawAdherencePct(taken, expected),
      lastLog: latestLogByDefId.get(def.id) ?? null,
    };
  });
}
