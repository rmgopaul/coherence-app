/**
 * Pure math for supplements — cost per dose, monthly protocol cost, adherence.
 *
 * Imported by both the server (routers/personalData.ts cost summary) and the
 * client (features/supplements/*). No dependencies on DB, tRPC, React, or any
 * environment-specific code. Keep it pure so both sides stay consistent and
 * tests run anywhere.
 */

/** Minimal shape required to compute cost-per-dose. */
export interface CostInputs {
  pricePerBottle: number | null | undefined;
  quantityPerBottle: number | null | undefined;
}

/** Minimal shape required to compute protocol-level cost/adherence. */
export interface ProtocolDefinition extends CostInputs {
  isLocked: boolean;
  isActive?: boolean;
}

export const DAYS_PER_MONTH = 30;

/**
 * Cost of a single dose. Returns null when inputs are missing or invalid
 * (zero quantity, negative price, etc.) so callers can show a dash instead
 * of a misleading `$0.00`.
 */
export function costPerDose(def: CostInputs): number | null {
  const price = def.pricePerBottle;
  const qty = def.quantityPerBottle;
  if (price === null || price === undefined || !Number.isFinite(price)) return null;
  if (qty === null || qty === undefined || !Number.isFinite(qty)) return null;
  if (price < 0 || qty <= 0) return null;
  return price / qty;
}

/**
 * Expected monthly cost of the currently-locked (auto-logged) protocol.
 * Assumes one dose per locked definition per day, matching the auto-log
 * behaviour of `supplements.getLogs`. Definitions with missing cost inputs
 * are skipped (not counted as zero).
 */
export function monthlyProtocolCost(defs: readonly ProtocolDefinition[]): number {
  let total = 0;
  for (const def of defs) {
    if (!def.isLocked) continue;
    if (def.isActive === false) continue;
    const perDose = costPerDose(def);
    if (perDose === null) continue;
    total += perDose * DAYS_PER_MONTH;
  }
  return total;
}

/**
 * Adherence as a ratio in [0, 1]. Returns 0 when `expected` is 0 — no expected
 * doses means no adherence score to compute. Caps at 1 when `taken > expected`
 * (over-logging shouldn't show as >100%).
 */
export function adherencePct(taken: number, expected: number): number {
  if (!Number.isFinite(taken) || !Number.isFinite(expected)) return 0;
  if (expected <= 0) return 0;
  const ratio = taken / expected;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * Number of doses expected across a date range given a count of locked
 * definitions. Trivial today, but centralised so future protocol schedules
 * (twice-daily, every-other-day) have one place to grow.
 */
export function dosesExpectedInRange(lockedCount: number, days: number): number {
  if (!Number.isFinite(lockedCount) || !Number.isFinite(days)) return 0;
  if (lockedCount <= 0 || days <= 0) return 0;
  return lockedCount * days;
}

/**
 * Cheapest and most-expensive locked definition by cost-per-dose. Ignores
 * definitions with missing cost inputs. Returns `null` for each slot when
 * no locked definition has a computable cost.
 *
 * Generic over the input type so callers get back their full record shape
 * (with `id`, `name`, etc.) rather than the minimal `ProtocolDefinition`.
 */
export function costExtremes<T extends ProtocolDefinition>(
  defs: readonly T[],
): {
  cheapest: { def: T; costPerDose: number } | null;
  mostExpensive: { def: T; costPerDose: number } | null;
} {
  let cheapest: { def: T; costPerDose: number } | null = null;
  let mostExpensive: { def: T; costPerDose: number } | null = null;
  for (const def of defs) {
    if (!def.isLocked) continue;
    if (def.isActive === false) continue;
    const perDose = costPerDose(def);
    if (perDose === null) continue;
    if (cheapest === null || perDose < cheapest.costPerDose) {
      cheapest = { def, costPerDose: perDose };
    }
    if (mostExpensive === null || perDose > mostExpensive.costPerDose) {
      mostExpensive = { def, costPerDose: perDose };
    }
  }
  return { cheapest, mostExpensive };
}
