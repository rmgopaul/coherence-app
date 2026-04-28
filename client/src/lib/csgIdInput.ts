/**
 * Task 9.3 (2026-04-28) — pure parser for paste-IDs textareas.
 *
 * Lives in `lib/` (not the WorksetSelector's directory) so the
 * vitest config's `client/src/lib` glob picks up the tests without
 * touching the suite's include list. The component imports from
 * here.
 */

/**
 * Split a free-text input on newlines, commas, and tabs; trim each
 * fragment; drop empties; preserve the order callers paste in.
 *
 * Used by the `<WorksetSelector />` component to compute the live
 * "N IDs detected" counter, the disabled-state of Save-as-workset,
 * and the array passed to `worksets.create({csgIds})`. Every legacy
 * paste-IDs surface used the same regex inline; centralizing it
 * here means future deduplication / casing rules can be applied
 * once.
 */
export function parseCsgIdInput(input: string): string[] {
  return input
    .split(/[\n,\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
