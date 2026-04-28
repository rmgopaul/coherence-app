/**
 * Pure helper functions for the Settings page.
 *
 * Extracted from Settings.tsx during refactoring.
 */
import {
  SETTINGS_DEFAULT_TAB,
  SETTINGS_TABS,
  type SettingsTabId,
} from "./settings.constants";

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

/**
 * Phase E (2026-04-28) — parse a URL hash fragment into a Settings
 * tab id. Used to seed the active tab on initial mount so deep
 * links like `/settings#integrations` open on the right tab.
 *
 *   "#integrations"   → "integrations"
 *   "#profile"        → "profile"
 *   ""                → SETTINGS_DEFAULT_TAB
 *   "#unknown"        → SETTINGS_DEFAULT_TAB
 *   "  #ai  "         → "ai"  (trimmed + leading-hash stripped)
 *
 * Pure — exposed for testability.
 */
export function parseSettingsTabFromHash(hash: string): SettingsTabId {
  const cleaned = (hash ?? "").trim().replace(/^#/, "").toLowerCase();
  if (!cleaned) return SETTINGS_DEFAULT_TAB;
  const match = SETTINGS_TABS.find((tab) => tab.id === cleaned);
  return match ? match.id : SETTINGS_DEFAULT_TAB;
}
