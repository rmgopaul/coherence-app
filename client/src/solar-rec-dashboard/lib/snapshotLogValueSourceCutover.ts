/**
 * Snapshot log trend chart — value-source cutover marker.
 *
 * 2026-05-09 follow-up review remediation of PR-FU-4 (#542). The
 * cutover memo logic was inlined in `SnapshotLogTab.tsx` and not
 * unit-tested; this module extracts the pure logic so vitest can
 * exercise the branch coverage without mounting the full tab.
 *
 * **Read-side semantics for `valueSource`:**
 *
 * - `"slim"` — entry was captured against slim summary values
 *   (post-PR-4 entries — the post-cutover state).
 * - `"row-walk"` — entry was captured against the row-walk values
 *   (legacy, pre-PR-4 entries that still hold their captured
 *   numbers; never written by post-PR-4 code).
 * - `null` (or missing) — entry was created before the
 *   `valueSource` field existed (pre-FU-4). Treated as
 *   "not slim" for marker purposes since legacy entries used the
 *   row-walk path. Any future `valueSource` value the chart
 *   doesn't recognize falls into the same bucket.
 *
 * The marker draws a vertical reference line at the FIRST entry
 * whose `valueSource === "slim"`. Returns `null` when:
 *   - There are no entries (no marker needed).
 *   - The FIRST entry is already slim (everything is post-cutover;
 *     no discontinuity to mark).
 *   - No entry has `valueSource === "slim"` (everything is pre-
 *     cutover; the chart is fully on the legacy basis).
 *
 * The function takes a generic shape so it stays decoupled from
 * the full trend row type — only `valueSource` and `label` matter
 * for cutover detection.
 */

export type CutoverCandidate = {
  /** X-axis label rendered on the chart. The reference line uses
   *  this string as its `x` prop, so two entries on the same day
   *  with identical labels would land on the same gridline (the
   *  first one wins). Acceptable under typical ≤1-snapshot/day
   *  cadence; if cadence increases, switch to a tuple-keyed label
   *  or a separate timestamp axis. */
  label: string;
  valueSource: "slim" | "row-walk" | null | undefined;
};

export function findValueSourceCutoverLabel(
  rows: readonly CutoverCandidate[]
): string | null {
  const firstSlimIndex = rows.findIndex((row) => row.valueSource === "slim");
  // <= 0 covers two distinct cases:
  //   - -1 (no slim entries at all) → no marker, full pre-cutover.
  //   - 0 (first entry already slim) → no marker, fully post-cutover.
  // In both, drawing a marker would mislead.
  if (firstSlimIndex <= 0) return null;
  return rows[firstSlimIndex]!.label;
}
