/**
 * Pure helper functions for the Settings page.
 *
 * Extracted from Settings.tsx during refactoring.
 */

/**
 * Parse a user-entered numeric string into a non-negative number or null.
 * Throws with a descriptive message if the input is invalid.
 */
export const parseOptionalNonNegativeNumber = (
  raw: string,
  label: string
): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (!Number.isFinite(numeric) || numeric < 0) {
    throw new Error(`${label} must be a valid non-negative number`);
  }
  return numeric;
};
