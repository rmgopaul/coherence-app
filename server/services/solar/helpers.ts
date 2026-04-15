/**
 * Shared helper functions for solar vendor API services.
 *
 * Previously duplicated across 15+ solar service files.
 */

export function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

export function asRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      item != null && typeof item === "object"
  );
}

export function normalizeBaseUrl(
  raw: string | null | undefined,
  defaultBaseUrl: string
): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return defaultBaseUrl;
  return trimmed.replace(/\/+$/, "");
}

export function parseIsoDate(
  input: string
): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day))
    return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

export function toUtcEpochSeconds(dateIso: string, endOfDay: boolean): number {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) {
    throw new Error("Dates must be in YYYY-MM-DD format.");
  }
  const date = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0)
  );
  return Math.floor(date.getTime() / 1000);
}

// ---------------------------------------------------------------------------
// Date formatting & arithmetic
// ---------------------------------------------------------------------------

export function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function shiftIsoDate(dateIso: string, deltaDays: number): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 1, parsed.day);
  date.setDate(date.getDate() + deltaDays);
  return formatIsoDate(date);
}

export function shiftIsoDateByYears(dateIso: string, deltaYears: number): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 1, parsed.day);
  date.setFullYear(date.getFullYear() + deltaYears);
  return formatIsoDate(date);
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

export function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

export function sumKwh(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, current) => sum + current, 0);
  return safeRound(total);
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found");
}
