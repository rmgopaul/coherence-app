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
