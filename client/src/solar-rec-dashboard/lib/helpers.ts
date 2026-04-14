/**
 * Pure helper functions extracted from SolarRecDashboard.tsx.
 *
 * Every function here is stateless — no React hooks, no component state,
 * no browser globals.  They depend only on their arguments and on the
 * `clean` helper re-exported from `@/lib/helpers`.
 */

import { clean } from "@/lib/helpers";
import type { CsvRow } from "@/solar-rec-dashboard/state/types";
import {
  AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY,
  DAY_MS,
  GENERATOR_DETAILS_AC_SIZE_HEADERS,
  IL_ABP_TRANSFERRED_CONTRACT_TYPE,
  IL_ABP_TERMINATED_CONTRACT_TYPE,
  NUMBER_FORMATTER,
  STALE_UPLOAD_DAYS,
  TEN_KW_COMPLIANT_SOURCE,
} from "@/solar-rec-dashboard/lib/constants";

// ---------------------------------------------------------------------------
// Type re-used by callers but defined in the component file — duplicated
// here as a narrow alias so helpers can reference it without importing the
// full component module.  The component's own DashboardTabId is an opaque
// string literal union that this set-check narrows into.
// ---------------------------------------------------------------------------
export type { CsvRow };

// ---------------------------------------------------------------------------
// CSV / identity helpers
// ---------------------------------------------------------------------------

export function resolvePart2ProjectIdentity(row: CsvRow, index: number) {
  const applicationId =
    clean(row.Application_ID) || clean(row.application_id);
  const portalSystemId = clean(row.system_id);
  const trackingId =
    clean(row.PJM_GATS_or_MRETS_Unit_ID_Part_2) ||
    clean(row.tracking_system_ref_id);
  const projectName = clean(row.Project_Name) || clean(row.system_name);
  const projectNameKey = projectName.toLowerCase();
  const dedupeKey = portalSystemId
    ? `system:${portalSystemId}`
    : trackingId
      ? `tracking:${trackingId}`
      : applicationId
        ? `application:${applicationId}`
        : projectName
          ? `name:${projectNameKey}`
          : `row:${index}`;

  return {
    applicationId,
    portalSystemId,
    trackingId,
    projectName,
    projectNameKey,
    dedupeKey,
  };
}

export function getCsvValueByHeader(
  row: CsvRow,
  headerName: string,
): string {
  const target = clean(headerName).toLowerCase();
  for (const [header, value] of Object.entries(row)) {
    if (clean(header).toLowerCase() === target) return clean(value);
  }
  return "";
}

export function resolveLastMeterReadRawValue(row: CsvRow): string {
  const direct =
    clean(row["Last Meter Read (kWh)"]) ||
    clean(row["Last Meter Read (kW)"]) ||
    clean(row["Last Meter Read"]);
  if (direct) return direct;

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = clean(key).toLowerCase();
    if (
      normalizedKey.includes("last meter read") &&
      !normalizedKey.includes("date")
    ) {
      const candidate = clean(value);
      if (candidate) return candidate;
    }
  }

  return "";
}

export function resolveStateApplicationRefId(
  row: CsvRow,
): string | null {
  const exact = clean(row.state_certification_number);
  return exact || null;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

export function parseNumber(
  value: string | undefined,
): number | null {
  const cleaned = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDate(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]) - 1;
    const day = Number(iso[3]);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const usDateTime = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/,
  );
  if (usDateTime) {
    const month = Number(usDateTime[1]) - 1;
    const day = Number(usDateTime[2]);
    const year =
      Number(usDateTime[3]) < 100
        ? 2000 + Number(usDateTime[3])
        : Number(usDateTime[3]);
    let hours = usDateTime[4] ? Number(usDateTime[4]) : 0;
    const minutes = usDateTime[5] ? Number(usDateTime[5]) : 0;
    const meridiem = usDateTime[6]?.toUpperCase();

    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;

    const date = new Date(year, month, day, hours, minutes);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

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

export function isPart2VerifiedAbpRow(row: CsvRow): boolean {
  const part2VerifiedDateRaw =
    clean(row.Part_2_App_Verification_Date) ||
    clean(row.part_2_app_verification_date);
  return parsePart2VerificationDate(part2VerifiedDateRaw) !== null;
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

export function parseEnergyToWh(
  value: string | undefined,
  headerLabel: string,
  defaultUnit: "kwh" | "wh" = "kwh",
): number | null {
  const parsed = parseNumber(value);
  if (parsed === null) return null;
  const header = clean(headerLabel).toLowerCase();
  if (header.includes("mwh")) return Math.round(parsed * 1_000_000);
  if (header.includes("kwh")) return Math.round(parsed * 1_000);
  if (header.includes("wh")) return Math.round(parsed);
  if (defaultUnit === "kwh") return Math.round(parsed * 1_000);
  return Math.round(parsed);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function isValidCompliantSourceText(value: string): boolean {
  if (!value || value.length > 100) return false;
  if (!/[A-Za-z0-9]/.test(value)) return false;
  return /^[A-Za-z0-9 _,-]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Date & formatting helpers
// ---------------------------------------------------------------------------

export function toStartOfDay(value: Date): Date {
  return new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate(),
  );
}

export function calculateExpectedWhForRange(
  monthlyKwh: number[],
  startDate: Date,
  endDate: Date,
): number | null {
  if (monthlyKwh.length !== 12) return null;
  const start = toStartOfDay(startDate);
  const end = toStartOfDay(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return null;
  if (end <= start) return 0;

  let cursor = start;
  let expectedWh = 0;

  while (cursor < end) {
    const monthStart = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      1,
    );
    const monthEnd = new Date(
      cursor.getFullYear(),
      cursor.getMonth() + 1,
      1,
    );
    const segmentEnd = monthEnd < end ? monthEnd : end;
    const dayCount =
      (segmentEnd.getTime() - cursor.getTime()) / DAY_MS;
    const daysInMonth =
      (monthEnd.getTime() - monthStart.getTime()) / DAY_MS;
    const monthlyValueKwh = monthlyKwh[cursor.getMonth()] ?? 0;
    expectedWh +=
      (monthlyValueKwh * 1_000 * dayCount) / daysInMonth;
    cursor = segmentEnd;
  }

  return Number.isFinite(expectedWh) ? expectedWh : null;
}

export function formatDate(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatMonthYear(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });
}

export function toReadWindowMonthStart(value: Date): Date {
  if (value.getDate() <= 15) {
    return new Date(
      value.getFullYear(),
      value.getMonth() - 1,
      1,
    );
  }
  return new Date(value.getFullYear(), value.getMonth(), 1);
}

export function formatNumber(
  value: number | null,
  digits = 0,
): string {
  if (value === null) return "N/A";
  if (digits > 0) return value.toFixed(digits);
  return NUMBER_FORMATTER.format(value);
}

export function formatKwh(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function formatCapacityKw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 3,
  });
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toPercentValue(
  numerator: number,
  denominator: number,
): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return null;
  return (numerator / denominator) * 100;
}

export function isStaleUpload(
  uploadedAt: Date | null | undefined,
  thresholdDays = STALE_UPLOAD_DAYS,
): boolean {
  if (!uploadedAt) return true;
  const ageMs = Date.now() - uploadedAt.getTime();
  return ageMs > thresholdDays * DAY_MS;
}

export function formatSignedNumber(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (value > 0) return `+${NUMBER_FORMATTER.format(value)}`;
  if (value < 0) return `-${NUMBER_FORMATTER.format(Math.abs(value))}`;
  return "0";
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

export function normalizeMonitoringMatch(
  value: string | null | undefined,
): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeSystemIdMatch(
  value: string | null | undefined,
): string {
  const compact = clean(value).replaceAll(",", "").replace(/\s+/g, "");
  if (!compact) return "";
  if (/^-?\d+(?:\.\d+)?$/.test(compact)) {
    const parsed = Number(compact);
    if (Number.isFinite(parsed)) return String(Math.trunc(parsed));
  }
  return compact.toUpperCase();
}

export function normalizeSystemNameMatch(
  value: string | null | undefined,
): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeContractType(
  value: string | null | undefined,
): string {
  return clean(value).toLowerCase().replace(/\s+/g, " ");
}

export function isTransferredContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_TRANSFERRED_CONTRACT_TYPE;
}

export function isTerminatedContractType(
  value: string | null | undefined,
): boolean {
  return normalizeContractType(value) === IL_ABP_TERMINATED_CONTRACT_TYPE;
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

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

export function maxDate(
  current: Date | null,
  candidate: Date | null,
): Date | null {
  if (!current) return candidate;
  if (!candidate) return current;
  return candidate > current ? candidate : current;
}

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

// ---------------------------------------------------------------------------
// Compliant source / monitoring helpers
// ---------------------------------------------------------------------------

export function resolveMonitoringPlatformCompliantSource(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeMonitoringMatch(value);
  if (!normalized) return null;
  return AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY[normalized] ?? null;
}

export function getAutoCompliantSourcePriority(value: string): number {
  return value === TEN_KW_COMPLIANT_SOURCE ? 1 : 2;
}

export function isTenKwAcOrLess(
  portalAcSizeKw: number | null,
  abpAcSizeKw: number | null,
): boolean {
  const hasAnySize = portalAcSizeKw !== null || abpAcSizeKw !== null;
  if (!hasAnySize) return false;
  const portalOk = portalAcSizeKw === null || portalAcSizeKw <= 10;
  const abpOk = abpAcSizeKw === null || abpAcSizeKw <= 10;
  return portalOk && abpOk;
}
