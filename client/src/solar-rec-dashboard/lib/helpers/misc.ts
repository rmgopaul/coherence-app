/**
 * Small utility helpers that don't fit cleanly into a single domain.
 * Used across several of the other helpers modules.
 */

import { clean } from "@/lib/helpers";

export function firstNonNull(
  ...values: Array<number | null>
): number | null {
  for (const value of values) {
    if (value !== null) return value;
  }
  return null;
}

export function firstNonEmptyString(
  ...values: string[]
): string | null {
  for (const value of values) {
    if (clean(value)) return clean(value);
  }
  return null;
}

/**
 * Generate a log-entry identifier. Uses crypto.randomUUID() when available,
 * falls back to a Date+Math.random seed for older environments.
 */
export function createLogId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
