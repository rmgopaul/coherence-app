import { fetchJson } from "../core/httpClient";
import {
  toNullableString,
  toNullableNumber,
  asRecord,
  asRecordArray,
  normalizeBaseUrl,
  parseIsoDate,
  formatIsoDate,
  shiftIsoDate,
  shiftIsoDateByYears,
  safeRound,
  isNotFoundError,
} from "./helpers";

export const EKM_DEFAULT_BASE_URL = "https://io.ekmpush.com";

export type EkmApiContext = {
  apiKey: string;
  baseUrl?: string | null;
};

export type EkmMeter = {
  meterNumber: string;
  name: string;
  address: string | null;
  status: string | null;
};

export type EkmProductionSnapshot = {
  meterNumber: string;
  name: string | null;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  lifetimeKwh: number | null;
  hourlyProductionKwh: number | null;
  monthlyProductionKwh: number | null;
  mtdProductionKwh: number | null;
  previousCalendarMonthProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  weeklyProductionKwh: number | null;
  dailyProductionKwh: number | null;
  anchorDate: string;
  monthlyStartDate: string;
  weeklyStartDate: string;
  mtdStartDate: string;
  previousCalendarMonthStartDate: string;
  previousCalendarMonthEndDate: string;
  last12MonthsStartDate: string;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function firstDayOfMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  return formatIsoDate(new Date(parsed.year, parsed.month - 1, 1));
}

function firstDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  return formatIsoDate(new Date(parsed.year, parsed.month - 2, 1));
}

function lastDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  return formatIsoDate(new Date(parsed.year, parsed.month - 1, 0));
}

// ---------------------------------------------------------------------------
// HTTP layer — API key in query param
// ---------------------------------------------------------------------------

async function getEkmJson(
  path: string,
  context: EkmApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(context.baseUrl, EKM_DEFAULT_BASE_URL);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  url.searchParams.set("key", context.apiKey);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  const { data } = await fetchJson(url.toString(), {
    service: "EKM",
    timeoutMs: 20_000,
  });

  return data;
}

// ---------------------------------------------------------------------------
// API: Read current meter data
// ---------------------------------------------------------------------------

export async function readMeter(
  context: EkmApiContext,
  meterNumber: string
): Promise<unknown> {
  return getEkmJson(
    `/readMeter/v5/${encodeURIComponent(meterNumber)}`,
    context,
    { format: "json" }
  );
}

// ---------------------------------------------------------------------------
// API: Read historical meter data
// ---------------------------------------------------------------------------

async function readMeterHistory(
  context: EkmApiContext,
  meterNumber: string,
  startDate: string,
  endDate: string
): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await getEkmJson(
      `/readMeter/v5/${encodeURIComponent(meterNumber)}/count/0`,
      context,
      {
        format: "json",
        start: startDate.replace(/-/g, ""),
        end: endDate.replace(/-/g, ""),
      }
    );

    const root = asRecord(raw);
    const readSets = asRecordArray(root.readMeter ?? root.readSets ?? root.data ?? root.readings);
    if (readSets.length > 0) {
      const firstSet = asRecord(readSets[0]);
      const readings = asRecordArray(firstSet.ReadSet ?? firstSet.readings ?? firstSet.data);
      if (readings.length > 0) return readings;
      return readSets;
    }

    return Array.isArray(raw) ? asRecordArray(raw) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Extract kWh from EKM meter read
// ---------------------------------------------------------------------------

function extractTotalKwh(reading: Record<string, unknown>): number | null {
  // EKM meters provide cumulative kWh in kWh_Tot or similar fields
  return (
    toNullableNumber(reading.kWh_Tot) ??
    toNullableNumber(reading["kWh_Tot"]) ??
    toNullableNumber(reading.kwh_total) ??
    toNullableNumber(reading.kWh_Tariff_1) ??
    toNullableNumber(reading.totalKwh) ??
    toNullableNumber(reading.total_kwh) ??
    null
  );
}

function extractReadingTimestamp(reading: Record<string, unknown>): string | null {
  const ts = toNullableString(
    reading.Time_Stamp ?? reading.timestamp ?? reading.time_stamp ?? reading.readTime
  );
  if (!ts) return null;

  // Try parsing YYYYMMDDHHMMSS or ISO format
  if (/^\d{14}$/.test(ts)) {
    return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(ts)) {
    return ts.slice(0, 10);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract meters from account summary
// ---------------------------------------------------------------------------

export function extractMeters(payload: unknown): EkmMeter[] {
  const root = asRecord(payload);
  const readSets = asRecordArray(root.readMeter ?? root.readSets ?? root.meters ?? root.data);
  const output: EkmMeter[] = [];

  for (const row of readSets) {
    const readings = asRecordArray(row.ReadSet ?? row.readings ?? [row]);
    for (const reading of readings) {
      const meterNumber = toNullableString(
        reading.Meter ?? reading.meter ?? reading.meterNumber ?? reading.meter_number
      );
      if (!meterNumber) continue;
      if (output.some((m) => m.meterNumber === meterNumber)) continue;

      output.push({
        meterNumber,
        name: toNullableString(reading.Name ?? reading.name ?? reading.meterName) ?? `Meter ${meterNumber}`,
        address: toNullableString(reading.Address ?? reading.address),
        status: toNullableString(reading.Status ?? reading.status),
      });
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getMeterProductionSnapshot(
  context: EkmApiContext,
  meterNumberRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<EkmProductionSnapshot> {
  const meterNumber = meterNumberRaw.trim();
  const name = nameOverride ?? null;
  const anchorDate = (anchorDateRaw ?? "").trim() || formatIsoDate(new Date());
  if (!parseIsoDate(anchorDate)) {
    throw new Error("Anchor date must be in YYYY-MM-DD format.");
  }

  const monthlyStartDate = shiftIsoDate(anchorDate, -29);
  const weeklyStartDate = shiftIsoDate(anchorDate, -6);
  const mtdStartDate = firstDayOfMonth(anchorDate);
  const previousCalendarMonthStartDate = firstDayOfPreviousMonth(anchorDate);
  const previousCalendarMonthEndDate = lastDayOfPreviousMonth(anchorDate);
  const last12MonthsStartDate = shiftIsoDateByYears(anchorDate, -1);

  try {
    // Get current reading for lifetime kWh
    const currentPayload = await readMeter(context, meterNumber);
    const root = asRecord(currentPayload);
    const readSets = asRecordArray(root.readMeter ?? root.readSets ?? root.data ?? [root]);
    const firstSet = asRecord(readSets[0] ?? {});
    const readings = asRecordArray(firstSet.ReadSet ?? firstSet.readings ?? readSets);
    const latestReading = readings.length > 0 ? readings[readings.length - 1] : asRecord(currentPayload);

    const lifetimeKwh = safeRound(extractTotalKwh(latestReading));

    // Get historical readings for date-range computations
    // EKM provides cumulative readings — compute daily production as difference
    const historicalReadings = await readMeterHistory(
      context,
      meterNumber,
      previousCalendarMonthStartDate,
      anchorDate
    );

    // Build daily kWh from cumulative readings
    type DateReading = { dateKey: string; kwh: number };
    const dailyMap = new Map<string, { first: number; last: number }>();
    for (const reading of historicalReadings) {
      const dateKey = extractReadingTimestamp(reading);
      const totalKwh = extractTotalKwh(reading);
      if (!dateKey || totalKwh === null) continue;

      const existing = dailyMap.get(dateKey);
      if (existing) {
        existing.first = Math.min(existing.first, totalKwh);
        existing.last = Math.max(existing.last, totalKwh);
      } else {
        dailyMap.set(dateKey, { first: totalKwh, last: totalKwh });
      }
    }

    // Convert cumulative pairs to daily production
    const sortedDates = Array.from(dailyMap.keys()).sort();
    const dailySeries: DateReading[] = [];
    for (let i = 0; i < sortedDates.length; i++) {
      const dateKey = sortedDates[i];
      const current = dailyMap.get(dateKey)!;

      // Use within-day difference if available, otherwise diff from previous day
      let dayKwh = current.last - current.first;
      if (dayKwh <= 0 && i > 0) {
        const prevDate = sortedDates[i - 1];
        const prev = dailyMap.get(prevDate)!;
        dayKwh = current.last - prev.last;
      }

      if (dayKwh > 0) {
        dailySeries.push({ dateKey, kwh: safeRound(dayKwh)! });
      }
    }

    const sumValues = (points: DateReading[]): number | null => {
      if (points.length === 0) return null;
      return safeRound(points.reduce((sum, p) => sum + p.kwh, 0));
    };

    const hourlyProductionKwh: number | null = null;
    const dailyProductionKwh = sumValues(dailySeries.filter((p) => p.dateKey === anchorDate));
    const weeklyProductionKwh = sumValues(
      dailySeries.filter((p) => p.dateKey >= weeklyStartDate && p.dateKey <= anchorDate)
    );
    const monthlyProductionKwh = sumValues(
      dailySeries.filter((p) => p.dateKey >= monthlyStartDate && p.dateKey <= anchorDate)
    );
    const mtdProductionKwh = sumValues(
      dailySeries.filter((p) => p.dateKey >= mtdStartDate && p.dateKey <= anchorDate)
    );
    const previousCalendarMonthProductionKwh = sumValues(
      dailySeries.filter(
        (p) => p.dateKey >= previousCalendarMonthStartDate && p.dateKey <= previousCalendarMonthEndDate
      )
    );
    const last12MonthsProductionKwh: number | null = null;

    return {
      meterNumber,
      name,
      status: "Found",
      found: true,
      lifetimeKwh,
      hourlyProductionKwh,
      monthlyProductionKwh,
      mtdProductionKwh,
      previousCalendarMonthProductionKwh,
      last12MonthsProductionKwh,
      weeklyProductionKwh,
      dailyProductionKwh,
      anchorDate,
      monthlyStartDate,
      weeklyStartDate,
      mtdStartDate,
      previousCalendarMonthStartDate,
      previousCalendarMonthEndDate,
      last12MonthsStartDate,
      error: null,
    };
  } catch (error) {
    const isNf = isNotFoundError(error);
    return {
      meterNumber,
      name,
      status: isNf ? "Not Found" : "Error",
      found: false,
      lifetimeKwh: null,
      hourlyProductionKwh: null,
      monthlyProductionKwh: null,
      mtdProductionKwh: null,
      previousCalendarMonthProductionKwh: null,
      last12MonthsProductionKwh: null,
      weeklyProductionKwh: null,
      dailyProductionKwh: null,
      anchorDate,
      monthlyStartDate,
      weeklyStartDate,
      mtdStartDate,
      previousCalendarMonthStartDate,
      previousCalendarMonthEndDate,
      last12MonthsStartDate,
      error: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}
