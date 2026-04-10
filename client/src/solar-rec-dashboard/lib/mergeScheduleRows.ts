/**
 * Merge two CSV-row collections that both describe Schedule B delivery
 * obligations, keyed by `tracking_system_ref_id` (GATS / NONID).
 *
 * The Delivery Tracker reads from two separate dataset slots:
 *   - `recDeliverySchedules` — the canonical CSV the user has uploaded over
 *     time (the "6554 rows from previous scrapes" the user described)
 *   - `deliveryScheduleBase`   — rows synthesized from Schedule B PDF imports
 *
 * Before this module, the tracker used an either/or ternary that hid
 * recDeliverySchedules the moment deliveryScheduleBase had any rows. That
 * was the root cause of the user's "total doesn't change after Apply" bug.
 *
 * Semantics (per user specification):
 *   1. Key on `clean(row.tracking_system_ref_id).toUpperCase()`.
 *   2. Rows without a tracking ID are passed through untouched and never
 *      merged (no fuzzy matching — that would invent duplicates).
 *   3. If a tracking ID appears in both sides:
 *        - Emit one row.
 *        - For each field: primary wins if its value is non-empty; secondary
 *          fills in any field primary left empty.
 *        - For each field where both sides have non-empty values that differ
 *          (after clean()), record the field in `differingFields` and emit
 *          one ScheduleMergeConflict for that tracking ID.
 *   4. If a tracking ID is only in one side, include its row untouched.
 *   5. Output row order is stable: primary order first, then any secondary
 *      rows not already covered, in secondary order.
 */

import { clean } from "./parsers";

export type CsvRow = Record<string, string>;

export type ScheduleMergeConflict = {
  trackingSystemRefId: string;
  primaryRow: CsvRow;
  secondaryRow: CsvRow;
  differingFields: string[];
};

export type ScheduleMergeResult = {
  rows: CsvRow[];
  conflicts: ScheduleMergeConflict[];
};

function trackingKey(row: CsvRow): string {
  return clean(row.tracking_system_ref_id).toUpperCase();
}

function mergeRowPair(
  primary: CsvRow,
  secondary: CsvRow
): { merged: CsvRow; differingFields: string[] } {
  const merged: CsvRow = { ...primary };
  const differingFields: string[] = [];

  // Union of keys across both rows, without using Set iteration (which
  // requires downlevelIteration under the current tsconfig target).
  const keysSeen: Record<string, true> = {};
  const allKeys: string[] = [];
  for (const key of Object.keys(primary)) {
    if (!keysSeen[key]) {
      keysSeen[key] = true;
      allKeys.push(key);
    }
  }
  for (const key of Object.keys(secondary)) {
    if (!keysSeen[key]) {
      keysSeen[key] = true;
      allKeys.push(key);
    }
  }

  for (const key of allKeys) {
    const primaryVal = clean(primary[key]);
    const secondaryVal = clean(secondary[key]);

    // The tracking key itself is the merge key — case differences are not
    // a real data conflict, just normalization noise.
    if (key === "tracking_system_ref_id") {
      merged[key] = primary[key] ?? secondary[key];
      continue;
    }

    if (primaryVal && secondaryVal && primaryVal !== secondaryVal) {
      // Both sides non-empty and different → conflict; primary wins.
      differingFields.push(key);
      merged[key] = primary[key];
      continue;
    }
    if (!primaryVal && secondaryVal) {
      // Primary missing → secondary fills in.
      merged[key] = secondary[key];
      continue;
    }
    // Otherwise primary already held the right value (or both were empty).
    if (primary[key] !== undefined) {
      merged[key] = primary[key];
    } else if (secondary[key] !== undefined) {
      merged[key] = secondary[key];
    }
  }

  return { merged, differingFields };
}

export function mergeScheduleRows(
  primary: CsvRow[],
  secondary: CsvRow[]
): ScheduleMergeResult {
  const rows: CsvRow[] = [];
  const conflicts: ScheduleMergeConflict[] = [];

  // Index secondary rows by tracking key so we can look them up while
  // walking primary (preserving primary order).
  const secondaryByKey = new Map<string, CsvRow>();
  const secondaryNoIdRows: CsvRow[] = [];
  for (const row of secondary) {
    const key = trackingKey(row);
    if (!key) {
      secondaryNoIdRows.push(row);
      continue;
    }
    // If secondary has duplicates on the same key, last one wins — matching
    // the existing merge behavior in SolarRecDashboard's onApply handler.
    secondaryByKey.set(key, row);
  }

  const consumedSecondaryKeys = new Set<string>();

  for (const primaryRow of primary) {
    const key = trackingKey(primaryRow);
    if (!key) {
      // No tracking ID → pass through, never merged.
      rows.push(primaryRow);
      continue;
    }

    const secondaryRow = secondaryByKey.get(key);
    if (!secondaryRow) {
      rows.push(primaryRow);
      continue;
    }

    const { merged, differingFields } = mergeRowPair(primaryRow, secondaryRow);
    rows.push(merged);
    consumedSecondaryKeys.add(key);

    if (differingFields.length > 0) {
      conflicts.push({
        trackingSystemRefId: key,
        primaryRow,
        secondaryRow,
        differingFields,
      });
    }
  }

  // Append any secondary rows that primary did not cover (new GATS IDs).
  for (const row of secondary) {
    const key = trackingKey(row);
    if (!key) continue; // handled below
    if (consumedSecondaryKeys.has(key)) continue;
    rows.push(row);
  }

  // Append secondary rows that had no tracking ID last. They are always
  // included and never merged.
  for (const row of secondaryNoIdRows) {
    rows.push(row);
  }

  return { rows, conflicts };
}
