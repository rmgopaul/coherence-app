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
// Compliant-source classification
//
// 2026-05-09 (Option C — server-side filter/sort/paginate) — the
// PerformanceRatioTab classifies each fact row's auto-compliant source
// for the bottom-of-tab "Compliant Sources" table. Pre-fix the
// classification ran client-side over the full ~225k row set; under
// Option C the server pre-aggregates `Map<systemId, source>` while
// streaming rows during the build, caches the result alongside the
// summary, and the client receives only the small per-systemId map.
// Hoisting these constants + helpers to shared keeps client + server
// in lockstep — divergence in the lookup table or priority scheme
// would silently produce wrong "Compliant Source" cell values without
// surfacing a test failure.
// ---------------------------------------------------------------------------

export const TEN_KW_COMPLIANT_SOURCE = "10kW AC or Less";

export const AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY: Record<
  string,
  string
> = {
  enphase: "Enphase",
  alsoenergy: "AlsoEnergy",
  "solar log": "Solar-Log",
  "sdsi arraymeter": "SDSI Arraymeter",
  "locus energy": "Locus Energy",
  "vision metering": "Vision Metering",
  sensergm: "SenseRGM",
  "ekm encompass io": "EKM Encompass.io",
};

export function resolveMonitoringPlatformCompliantSource(
  value: string | null | undefined
): string | null {
  const normalized = normalizeMonitoringMatch(value);
  if (!normalized) return null;
  return AUTO_MONITORING_PLATFORM_COMPLIANT_SOURCE_BY_KEY[normalized] ?? null;
}

/**
 * Priority ordering for auto-compliant-source resolution. When a
 * single systemId resolves to multiple candidate sources across its
 * fact rows, the highest-priority value wins.
 * `TEN_KW_COMPLIANT_SOURCE` is priority 1 (lowest); explicit-platform
 * sources are priority 2.
 */
export function getAutoCompliantSourcePriority(value: string): number {
  return value === TEN_KW_COMPLIANT_SOURCE ? 1 : 2;
}

/**
 * `true` iff the system is ≤ 10 kW AC. Considered compliant under
 * the small-system rule when no explicit-platform compliant source
 * applies. Returns `false` when both portal AC size and ABP AC size
 * are unknown (no signal either way).
 */
export function isTenKwAcOrLess(
  portalAcSizeKw: number | null,
  abpAcSizeKw: number | null
): boolean {
  const hasAnySize = portalAcSizeKw !== null || abpAcSizeKw !== null;
  if (!hasAnySize) return false;
  const portalOk = portalAcSizeKw === null || portalAcSizeKw <= 10;
  const abpOk = abpAcSizeKw === null || abpAcSizeKw <= 10;
  return portalOk && abpOk;
}

/**
 * Resolve a row's auto-compliant source by combining the platform-
 * lookup with the 10kW-or-less rule. Platform-match wins. Returns
 * `null` if neither rule applies. Used by the server-side aggregator
 * during build streaming AND by the client memo for the visible
 * page rows (kept in lockstep via this shared helper).
 */
export function resolveAutoCompliantSourceForRow(args: {
  monitoringPlatform: string | null;
  portalAcSizeKw: number | null;
  abpAcSizeKw: number | null;
}): string | null {
  const platformSource = resolveMonitoringPlatformCompliantSource(
    args.monitoringPlatform
  );
  if (platformSource) return platformSource;
  if (isTenKwAcOrLess(args.portalAcSizeKw, args.abpAcSizeKw)) {
    return TEN_KW_COMPLIANT_SOURCE;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Wire shapes for the Option C Performance-Ratio procs.
//
// 2026-05-09 review fixup — types live here so the client tab can
// import them without resorting to runtime `typeof row.foo === "..."`
// checks. Both shapes mirror DB columns from
// `solarRecDashboardPerformanceRatioFacts` minus `scopeId` /
// `buildId` / `createdAt` / `updatedAt` (stripped at the wire
// boundary in the page proc + the build runner's best-per-system
// payload).
// ---------------------------------------------------------------------------

/**
 * Wire shape for `getDashboardPerformanceRatioPage` rows.
 * `scopeId` / `buildId` / `createdAt` / `updatedAt` are STRIPPED;
 * date columns ship as ISO strings (revived client-side via
 * `reviveNullableDate`); decimal columns ship as MySQL string
 * representations (revived via `parsePerfRatioDecimal`).
 */
export interface PerformanceRatioPageRow {
  key: string;
  convertedReadKey: string;
  matchType: string;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  readDate: string | null;
  readDateRaw: string;
  lifetimeReadWh: string;
  trackingSystemRefId: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  systemName: string;
  installerName: string;
  monitoringPlatform: string;
  portalAcSizeKw: string | null;
  abpAcSizeKw: string | null;
  part2VerificationDate: string | null;
  baselineReadWh: string | null;
  baselineDate: string | null;
  baselineSource: string | null;
  productionDeltaWh: string | null;
  expectedProductionWh: string | null;
  performanceRatioPercent: string | null;
  contractValue: string;
}

/**
 * Wire shape for one row of the paginated
 * `getDashboardPerformanceRatioCompliantBestPage` response (PR-CB-3).
 * Sole compliant-row wire contract after PR-CB-6 retired the
 * legacy artifact-JSON `bestPerSystem` field.
 *
 * `systemKey` is the PK of the
 * `solarRecDashboardPerformanceRatioCompliantFacts` table —
 * load-bearing for client-side dedup + future drill-in queries.
 * Decimal columns serialize as strings (Drizzle's MySQL driver
 * preserves precision via `string`); the client revives via
 * `parsePerfRatioDecimal` per column at render time.
 */
export interface PerformanceRatioCompliantPageRow {
  systemKey: string;
  key: string;
  systemId: string | null;
  stateApplicationRefId: string | null;
  trackingSystemRefId: string;
  systemName: string;
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  monitoringPlatform: string;
  matchType: string;
  installerName: string;
  portalAcSizeKw: string | null;
  abpAcSizeKw: string | null;
  part2VerificationDate: string | null;
  readDate: string | null;
  readDateRaw: string;
  performanceRatioPercent: string | null;
  productionDeltaWh: string | null;
  expectedProductionWh: string | null;
  contractValue: string;
  baselineReadWh: string | null;
  baselineDate: string | null;
  baselineSource: string | null;
  lifetimeReadWh: string;
  compliantSource: string | null;
}

// 2026-05-09 — PR-CB-6 — `PerformanceRatioCompliantBestRowWire`
// retired. The legacy artifact-JSON wire shape that this
// interface described is gone; the consolidated
// `getDashboardPerformanceRatioCompliantContext` proc no longer
// returns a `bestPerSystem` field. All compliant-row reads now
// flow through `PerformanceRatioCompliantPageRow` above.

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
// Salvage PR A (2026-04-29) — hoisted helpers + builders + types from
// `client/src/solar-rec-dashboard/lib/helpers/{system,recPerformance}.ts`,
// `server/services/solar/loadPerformanceRatioInput.ts`, and
// `server/services/solar/buildForecastAggregates.ts`.
//
// Pure code-motion. No behavior change. Server aggregators import
// from here in the same PR; client helpers will re-export from here
// in a follow-up to keep this PR's blast radius contained.
//
// Re-uses PR #267's content (which was correct in isolation; the
// revert was for unrelated Schedule B + UX issues, not the hoist).
// ---------------------------------------------------------------------------

/**
 * Mid-month parser for "MM/YYYY" date-online strings used by the
 * Generator Details dataset. Snaps to the 15th of the parsed month
 * so generator-online dates align with mid-month meter-read
 * baselines for the performance-ratio fallback path. Falls through
 * to `parseDate` for any other format.
 */
export function parseDateOnlineAsMidMonth(value: string | undefined): Date | null {
  const raw = clean(value);
  if (!raw) return null;
  const monthYear = raw.match(/^(\d{1,2})\/(\d{4})$/);
  if (monthYear) {
    const month = Number(monthYear[1]) - 1;
    const year = Number(monthYear[2]);
    const date = new Date(year, month, 15);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return parseDate(raw);
}

export type SolarRecCsvRow = Record<string, string | undefined>;

export type AnnualProductionProfile = {
  trackingSystemRefId: string;
  facilityName: string;
  monthlyKwh: number[];
};

export type GenerationBaseline = {
  valueWh: number;
  date: Date | null;
  source: "Generation Entry" | "Account Solar Generation";
};

export type ScheduleYearEntry = {
  yearIndex: number;
  required: number;
  delivered: number;
  startDate: Date | null;
  endDate: Date | null;
  startRaw: string;
  endRaw: string;
  key: string;
};

export type PerformanceSourceRow = {
  key: string;
  contractId: string;
  systemId: string | null;
  trackingSystemRefId: string;
  systemName: string;
  batchId: string | null;
  recPrice: number | null;
  years: ScheduleYearEntry[];
  firstTransferEnergyYear: number | null;
};

export type RecPerformanceThreeYearValues = {
  scheduleYearNumber: number;
  deliveryYearOne: number;
  deliveryYearTwo: number;
  deliveryYearThree: number;
  deliveryYearOneSource: "Actual" | "Expected";
  deliveryYearTwoSource: "Actual" | "Expected";
  deliveryYearThreeSource: "Actual" | "Expected";
  rollingAverage: number;
  expectedRecs: number;
};

const MONTH_HEADERS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const GENERATION_BASELINE_VALUE_HEADERS = [
  "Last Meter Read (kWh)",
  "Last Meter Read (kW)",
  "Last Meter Read",
  "Most Recent Production (kWh)",
  "Most Recent Production",
  "Generation (kWh)",
  "Production (kWh)",
];

const GENERATION_BASELINE_DATE_HEADERS = [
  "Last Meter Read Date",
  "Last Month of Gen",
  "Effective Date",
  "Month of Generation",
];

export function resolveLastMeterReadRawValue(row: SolarRecCsvRow): string {
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

export function buildAnnualProductionByTrackingId(
  rows: SolarRecCsvRow[]
): Map<string, AnnualProductionProfile> {
  const mapping = new Map<string, AnnualProductionProfile>();

  rows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]) || clean(row.unit_id);
    if (!trackingSystemRefId) return;

    const monthlyKwh = MONTH_HEADERS.map(
      (month) => parseNumber(row[month] ?? row[month.toLowerCase()]) ?? 0
    );
    const current = mapping.get(trackingSystemRefId);
    if (!current) {
      mapping.set(trackingSystemRefId, {
        trackingSystemRefId,
        facilityName: clean(row.Facility) || clean(row["Facility Name"]),
        monthlyKwh,
      });
      return;
    }

    const mergedMonthly = current.monthlyKwh.map((value, index) => {
      const candidate = monthlyKwh[index] ?? 0;
      return candidate > 0 ? candidate : value;
    });
    mapping.set(trackingSystemRefId, {
      trackingSystemRefId,
      facilityName:
        current.facilityName ||
        clean(row.Facility) ||
        clean(row["Facility Name"]),
      monthlyKwh: mergedMonthly,
    });
  });

  return mapping;
}

export function buildGenerationBaselineByTrackingId(
  generationEntryRows: SolarRecCsvRow[],
  accountSolarGenerationRows: SolarRecCsvRow[]
): Map<string, GenerationBaseline> {
  const mapping = new Map<string, GenerationBaseline>();

  const updateBaseline = (
    trackingSystemRefId: string,
    candidate: GenerationBaseline
  ) => {
    const existing = mapping.get(trackingSystemRefId);
    if (!existing) {
      mapping.set(trackingSystemRefId, candidate);
      return;
    }

    const existingTime = existing.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const candidateTime = candidate.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (candidateTime > existingTime) {
      mapping.set(trackingSystemRefId, candidate);
      return;
    }
    if (candidateTime === existingTime) {
      const existingRank = existing.source === "Generation Entry" ? 2 : 1;
      const candidateRank = candidate.source === "Generation Entry" ? 2 : 1;
      if (candidateRank > existingRank) {
        mapping.set(trackingSystemRefId, candidate);
      }
    }
  };

  generationEntryRows.forEach((row) => {
    const trackingSystemRefId = clean(row["Unit ID"]);
    if (!trackingSystemRefId) return;

    let valueWh: number | null = null;
    for (const header of GENERATION_BASELINE_VALUE_HEADERS) {
      valueWh = parseEnergyToWh(row[header], header, "kwh");
      if (valueWh !== null) break;
    }
    if (valueWh === null) return;

    let date: Date | null = null;
    for (const header of GENERATION_BASELINE_DATE_HEADERS) {
      date = parseDate(row[header]);
      if (date) break;
    }

    updateBaseline(trackingSystemRefId, {
      valueWh,
      date,
      source: "Generation Entry",
    });
  });

  accountSolarGenerationRows.forEach((row) => {
    const trackingSystemRefId = clean(row["GATS Gen ID"]);
    if (!trackingSystemRefId) return;

    const valueWh = parseEnergyToWh(
      resolveLastMeterReadRawValue(row),
      "Last Meter Read (kWh)",
      "kwh"
    );
    if (valueWh === null) return;

    const date =
      parseDate(row["Last Meter Read Date"]) ??
      parseDate(row["Month of Generation"]);
    updateBaseline(trackingSystemRefId, {
      valueWh,
      date,
      source: "Account Solar Generation",
    });
  });

  return mapping;
}

export function buildGeneratorDateOnlineByTrackingId(
  rows: SolarRecCsvRow[]
): Map<string, Date> {
  const mapping = new Map<string, Date>();

  rows.forEach((row) => {
    const trackingSystemRefId =
      clean(row["GATS Unit ID"]) ||
      clean(row.gats_unit_id) ||
      clean(row["Unit ID"]);
    if (!trackingSystemRefId) return;
    const dateOnline = parseDateOnlineAsMidMonth(
      row["Date Online"] ??
        row["Date online"] ??
        row.date_online ??
        row.date_online_month_year
    );
    if (!dateOnline) return;

    const existing = mapping.get(trackingSystemRefId);
    if (!existing || dateOnline < existing) {
      mapping.set(trackingSystemRefId, dateOnline);
    }
  });

  return mapping;
}

export function buildDeliveryYearLabel(
  start: Date | null,
  end: Date | null,
  startRaw: string,
  endRaw: string
): string {
  if (start && end) {
    return `${start.getFullYear()}-${end.getFullYear()}`;
  }
  if (startRaw && endRaw) return `${startRaw} to ${endRaw}`;
  if (startRaw) return startRaw;
  if (start) return start.toISOString().slice(0, 10);
  return "Unknown";
}

export function buildRecReviewDeliveryYearLabel(
  start: Date | null,
  end: Date | null,
  startRaw: string,
  endRaw: string
): string {
  return buildDeliveryYearLabel(start, end, startRaw, endRaw);
}

export function deriveRecPerformanceThreeYearValues(
  sourceRow: PerformanceSourceRow,
  targetYearIndex: number
): RecPerformanceThreeYearValues | null {
  if (targetYearIndex < 2) return null;

  const dyOneYear = sourceRow.years[targetYearIndex - 2];
  const dyTwoYear = sourceRow.years[targetYearIndex - 1];
  const dyThreeYear = sourceRow.years[targetYearIndex];
  if (!dyOneYear || !dyTwoYear || !dyThreeYear) return null;

  if (sourceRow.firstTransferEnergyYear === null || !dyThreeYear.startDate) {
    return null;
  }

  const firstDeliveryYear = sourceRow.firstTransferEnergyYear + 1;
  const targetEnergyYear = dyThreeYear.startDate.getFullYear();
  const actualDeliveryYearNumber = targetEnergyYear - firstDeliveryYear + 1;

  if (actualDeliveryYearNumber < 3) return null;

  const isThirdDeliveryYear = actualDeliveryYearNumber === 3;
  const values: Array<{ value: number; source: "Actual" | "Expected" }> =
    isThirdDeliveryYear
      ? [
          { value: dyOneYear.delivered, source: "Actual" },
          { value: dyTwoYear.delivered, source: "Actual" },
          { value: dyThreeYear.delivered, source: "Actual" },
        ]
      : [
          { value: dyOneYear.required, source: "Expected" },
          { value: dyTwoYear.required, source: "Expected" },
          { value: dyThreeYear.delivered, source: "Actual" },
        ];

  return {
    scheduleYearNumber: dyThreeYear.yearIndex,
    deliveryYearOne: values[0]!.value,
    deliveryYearTwo: values[1]!.value,
    deliveryYearThree: values[2]!.value,
    deliveryYearOneSource: values[0]!.source,
    deliveryYearTwoSource: values[1]!.source,
    deliveryYearThreeSource: values[2]!.source,
    rollingAverage: Math.floor(
      (values[0]!.value + values[1]!.value + values[2]!.value) / 3
    ),
    expectedRecs: dyThreeYear.required,
  };
}

export function buildScheduleYearEntries(row: SolarRecCsvRow): ScheduleYearEntry[] {
  const entries: ScheduleYearEntry[] = [];

  for (let yearIndex = 1; yearIndex <= 15; yearIndex += 1) {
    const requiredRaw = row[`year${yearIndex}_quantity_required`];
    const deliveredRaw = row[`year${yearIndex}_quantity_delivered`];
    const startRaw = clean(row[`year${yearIndex}_start_date`]);
    const endRaw = clean(row[`year${yearIndex}_end_date`]);

    const required = parseNumber(requiredRaw) ?? 0;
    const delivered = parseNumber(deliveredRaw) ?? 0;
    const startDate = parseDate(startRaw);
    const endDate = parseDate(endRaw);

    if (!startRaw && !endRaw && required === 0 && delivered === 0) continue;

    const key = startDate
      ? startDate.toISOString().slice(0, 10)
      : `${startRaw}-${yearIndex}`;

    entries.push({
      yearIndex,
      required,
      delivered,
      startDate,
      endDate,
      startRaw,
      endRaw,
      key,
    });
  }

  return entries.sort((a, b) => {
    const aTime = a.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bTime = b.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aTime !== bTime) return aTime - bTime;
    return a.yearIndex - b.yearIndex;
  });
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
