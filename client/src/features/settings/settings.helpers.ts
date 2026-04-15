/**
 * Pure helper functions for the Settings page.
 *
 * Extracted from Settings.tsx during refactoring.
 */

export const toDateKeyLocal = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

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
