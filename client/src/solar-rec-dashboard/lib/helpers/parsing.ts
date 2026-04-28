/**
 * Raw-string parsing helpers.
 *
 * Turns CSV-sourced strings into numbers, dates, and energy-unit-normalized
 * values. All functions are pure and deal with loose input formats
 * (Excel serials, US dates, ISO dates, "kWh" vs "Wh" suffixes, etc.).
 */

import { clean } from "@/lib/helpers";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";
import {
  DAY_MS,
  GENERATOR_DETAILS_AC_SIZE_HEADERS,
} from "@/solar-rec-dashboard/lib/constants";
import { getCsvValueByHeader } from "./csvIdentity";

// `parseNumber`, `parseDate`, and `parseEnergyToWh` live in
// `@shared/solarRecPerformanceRatio` so the server aggregator and
// this tab share one implementation. Re-exported here so existing
// call sites don't change.
import {
  parseNumber,
  parseDate,
  parseEnergyToWh,
} from "@shared/solarRecPerformanceRatio";
export { parseNumber, parseDate, parseEnergyToWh };

export function parsePart2VerificationDate(
  value: string | undefined,
): Date | null {
  const raw = clean(value);
  if (!raw || raw.toLowerCase() === "null") return null;

  const excelSerial = raw.match(/^\d{5}(?:\.\d+)?$/);
  if (excelSerial) {
    const serial = Number(raw);
    if (Number.isFinite(serial) && serial >= 20_000 && serial <= 80_000) {
      const excelEpoch = new Date(Date.UTC(1899, 11, 30));
      const utcDate = new Date(
        excelEpoch.getTime() + Math.round(serial * DAY_MS),
      );
      const converted = new Date(
        utcDate.getUTCFullYear(),
        utcDate.getUTCMonth(),
        utcDate.getUTCDate(),
      );
      const year = converted.getFullYear();
      if (year >= 2009 && year <= 2100) return converted;
    }
    return null;
  }

  const looksLikeCalendarDate =
    /(?:19|20)\d{2}/.test(raw) &&
    (raw.includes("/") ||
      raw.includes("-") ||
      /[A-Za-z]{3,9}/.test(raw));
  if (!looksLikeCalendarDate) return null;

  const parsed = parseDate(raw);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  if (year < 2009 || year > 2100) return null;
  return parsed;
}

export function parseDateOnlineAsMidMonth(
  value: string | undefined,
): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const slashMonthYear = raw.match(/^(\d{1,2})[\/-](\d{4})$/);
  if (slashMonthYear) {
    const month = Number(slashMonthYear[1]) - 1;
    const year = Number(slashMonthYear[2]);
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoMonthYear = raw.match(/^(\d{4})[\/-](\d{1,2})$/);
  if (isoMonthYear) {
    const year = Number(isoMonthYear[1]);
    const month = Number(isoMonthYear[2]) - 1;
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const parsed = parseDate(raw);
  if (!parsed) return null;
  return new Date(parsed.getFullYear(), parsed.getMonth(), 15);
}

export function parseAbpAcSizeKw(row: CsvRow): number | null {
  return parseNumber(
    row.Inverter_Size_kW_AC_Part_2 ||
      getCsvValueByHeader(row, "Inverter_Size_kW_AC_Part_2"),
  );
}

export function parseGeneratorDetailsAcSizeKw(
  row: CsvRow,
): number | null {
  for (const header of GENERATOR_DETAILS_AC_SIZE_HEADERS) {
    const parsed = parseNumber(
      row[header] || getCsvValueByHeader(row, header),
    );
    if (parsed !== null) return parsed;
  }

  for (const [header, value] of Object.entries(row)) {
    const normalizedHeader = clean(header).toLowerCase();
    if (!normalizedHeader.includes("kw")) continue;
    if (normalizedHeader.includes("dc")) continue;
    if (
      normalizedHeader.includes("ac") ||
      normalizedHeader.includes("capacity") ||
      normalizedHeader.includes("nameplate") ||
      normalizedHeader.includes("inverter")
    ) {
      const parsed = parseNumber(value);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

export function splitRawCandidates(value: string): string[] {
  return clean(value)
    .split(/[|;,/\n\r]+/)
    .map((part) => clean(part))
    .filter(Boolean);
}

export function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  values.forEach((value) => {
    const normalized = clean(value);
    if (!normalized) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    output.push(normalized);
  });
  return output;
}
