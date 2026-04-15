/**
 * Pipeline chart + ownership badge helpers. The 4-month alternating
 * band logic used by the application pipeline chart/table, plus the
 * Tailwind class strings the Ownership and Change Ownership tab badges
 * render with.
 */

import type {
  ChangeOwnershipStatus,
  OwnershipStatus,
} from "@/solar-rec-dashboard/state/types";

/**
 * Build alternating 4-month shaded bands for pipeline charts. Returns
 * ReferenceArea x1/x2 pairs for every other group of 4 months so that
 * even 4-month groups stay white and odd groups render shaded.
 */
export function buildPipelineBands(
  rows: Array<{ month: string }>,
): Array<{ x1: string; x2: string }> {
  if (rows.length === 0) return [];
  const bands: Array<{ x1: string; x2: string }> = [];
  let i = 0;
  while (i < rows.length) {
    // skip 4 (unshaded)
    i += 4;
    // shade next 4
    if (i < rows.length) {
      const start = rows[i].month;
      const end = rows[Math.min(i + 3, rows.length - 1)].month;
      bands.push({ x1: start, x2: end });
      i += 4;
    }
  }
  return bands;
}

/**
 * Given a list of rows (sorted by month) and a target month, return the
 * 0-based 4-month group index. Even groups render white in the table;
 * odd groups render shaded.
 */
export function pipelineRowGroupIndex(
  rows: Array<{ month: string }>,
  month: string,
): number {
  const idx = rows.findIndex((r) => r.month === month);
  return Math.floor(idx / 4);
}

export function ownershipBadgeClass(status: OwnershipStatus): string {
  if (status.startsWith("Transferred"))
    return "bg-blue-100 text-blue-800 border-blue-200";
  if (status.startsWith("Terminated"))
    return "bg-rose-100 text-rose-800 border-rose-200";
  return "bg-emerald-100 text-emerald-800 border-emerald-200";
}

export function changeOwnershipBadgeClass(status: ChangeOwnershipStatus): string {
  if (status.startsWith("Transferred"))
    return "bg-blue-100 text-blue-800 border-blue-200";
  if (status.startsWith("Terminated"))
    return "bg-rose-100 text-rose-800 border-rose-200";
  return "bg-amber-100 text-amber-900 border-amber-200";
}
