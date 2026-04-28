/**
 * Shared types + pure helpers for the Performance Ratio computation.
 * Imported by both the dashboard's PerformanceRatioTab (client) and
 * the server-side aggregator (`buildPerformanceRatioAggregates`).
 *
 * Until this file existed, both sides duplicated three normalizers,
 * a `parseEnergyToWh`, a `parseDate`, and `calculateExpectedWhForRange`.
 * The first server-side port (#227) drifted from the client on every
 * one of those — the divergences were subtle (space vs empty
 * separator on normalizer; UTC vs local-time on parseDate; rounding
 * vs raw on parseEnergyToWh; UTC-month vs local-month on the
 * range-prorating loop) but every divergence broke matching or
 * arithmetic. This file is the single source of truth so future
 * client edits and server-aggregator usage stay in lockstep by
 * construction.
 *
 * The client's existing entry points (`client/src/solar-rec-dashboard
 * /lib/helpers/{monitoring,parsing,dates}.ts`) re-export from here
 * so call sites don't change.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Trim / null-safe string conversion
// ---------------------------------------------------------------------------

export function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

// ---------------------------------------------------------------------------
// Match-key normalizers
// ---------------------------------------------------------------------------

export function normalizeMonitoringMatch(
  value: string | null | undefined
): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeSystemIdMatch(
  value: string | null | undefined
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
  value: string | null | undefined
): string {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Date / number parsing
// ---------------------------------------------------------------------------

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
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
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

export function parseNumber(value: string | undefined): number | null {
  const cleaned = clean(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseEnergyToWh(
  value: string | undefined,
  headerLabel: string,
  defaultUnit: "kwh" | "wh" = "kwh"
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
// Date math used by Performance Ratio + Forecast tabs
// ---------------------------------------------------------------------------

export function toStartOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/**
 * Prorated expected-Wh for a (startDate, endDate) range against a
 * 12-element monthly-kWh profile. Walks day-by-month, contributing
 * `monthlyKwh[m] * 1000 * dayCount / daysInMonth` per overlapping
 * segment. Local-time month boundaries — TZ-aware so a row's date
 * falls in the same calendar month the user sees.
 *
 * Returns 0 for an empty/inverted window (matches the client's
 * historical behavior). Returns null when the profile is malformed
 * or arithmetic produces a non-finite total.
 */
export function calculateExpectedWhForRange(
  monthlyKwh: number[],
  startDate: Date,
  endDate: Date
): number | null {
  if (monthlyKwh.length !== 12) return null;
  const start = toStartOfDay(startDate);
  const end = toStartOfDay(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end <= start) return 0;

  let cursor = start;
  let expectedWh = 0;

  while (cursor < end) {
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const segmentEnd = monthEnd < end ? monthEnd : end;
    const dayCount = (segmentEnd.getTime() - cursor.getTime()) / DAY_MS;
    const daysInMonth = (monthEnd.getTime() - monthStart.getTime()) / DAY_MS;
    const monthlyValueKwh = monthlyKwh[cursor.getMonth()] ?? 0;
    expectedWh += (monthlyValueKwh * 1_000 * dayCount) / daysInMonth;
    cursor = segmentEnd;
  }

  return Number.isFinite(expectedWh) ? expectedWh : null;
}

// ---------------------------------------------------------------------------
// Shared types — server aggregator output and client presentation share
// these so the wire shape and the rendered row shape never drift.
// ---------------------------------------------------------------------------

export type PerformanceRatioMatchType =
  | "Monitoring + System ID + System Name"
  | "Monitoring + System ID"
  | "Monitoring + System Name";

export type PerformanceRatioAnnualProductionProfile = {
  monthlyKwh: number[];
};

export type PerformanceRatioGenerationBaseline = {
  date: Date;
  valueWh: number;
  source: string;
};

export type PerformanceRatioInputSystem = {
  key: string;
  trackingSystemRefId: string | null;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  installedKwAc: number | null;
  /** Resolved via `resolveContractValueAmount` on the client. */
  contractValue: number;
  /** Pre-tokenized normalized monitoring identifiers. */
  monitoringTokens: string[];
  /** Pre-tokenized normalized system IDs. */
  idTokens: string[];
  /** Pre-tokenized normalized system names. */
  nameTokens: string[];
};

export type PerformanceRatioRow = {
  key: string;
  convertedReadKey: string;
  matchType: PerformanceRatioMatchType;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  readDate: Date | null;
  readDateRaw: string;
  lifetimeReadWh: number;
  trackingSystemRefId: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  portalAcSizeKw: number | null;
  abpAcSizeKw: number | null;
  part2VerificationDate: Date | null;
  baselineReadWh: number | null;
  baselineDate: Date | null;
  baselineSource: string | null;
  productionDeltaWh: number | null;
  expectedProductionWh: number | null;
  performanceRatioPercent: number | null;
  contractValue: number;
};

export type PerformanceRatioConvertedReadRow = {
  monitoring: string;
  monitoring_system_id: string;
  monitoring_system_name: string;
  lifetime_meter_read_wh: string;
  read_date: string;
};

export type PerformanceRatioInput = {
  convertedReadsRows: readonly PerformanceRatioConvertedReadRow[];
  systems: readonly PerformanceRatioInputSystem[];
  abpAcSizeKwByApplicationId: ReadonlyMap<string, number>;
  abpPart2VerificationDateByApplicationId: ReadonlyMap<string, Date>;
  annualProductionByTrackingId: ReadonlyMap<
    string,
    PerformanceRatioAnnualProductionProfile
  >;
  generationBaselineByTrackingId: ReadonlyMap<
    string,
    PerformanceRatioGenerationBaseline
  >;
  generatorDateOnlineByTrackingId: ReadonlyMap<string, Date>;
};

export type PerformanceRatioAggregates = {
  rows: PerformanceRatioRow[];
  convertedReadCount: number;
  matchedConvertedReads: number;
  unmatchedConvertedReads: number;
  invalidConvertedReads: number;
};
