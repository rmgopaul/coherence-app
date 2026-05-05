import { fetchJson } from "../core/httpClient";
import {
  toNullableString,
  toNullableNumber,
  asRecord,
  asRecordArray,
  parseIsoDate,
  normalizeBaseUrl as normalizeBaseUrlShared,
  formatIsoDate,
  shiftIsoDate,
  shiftIsoDateByYears,
  firstDayOfMonth,
  firstDayOfPreviousMonth,
  lastDayOfPreviousMonth,
  safeRound,
  sumKwh,
  isNotFoundError,
} from "./helpers";

export const GENERAC_DEFAULT_BASE_URL = "https://pwrfleet.generac.com/api/v1";

export type GeneracApiContext = {
  apiKey: string;
  baseUrl?: string | null;
};

export type GeneracSystem = {
  systemId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  status: string | null;
};

export type GeneracProductionSnapshot = {
  systemId: string;
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

function asDateKey(value: string | null | undefined): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const leading = normalized.slice(0, 10);
  return parseIsoDate(leading) ? leading : null;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function toKwh(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  const normalizedUnit = (unit ?? "").trim().toLowerCase();
  if (normalizedUnit.includes("kwh")) return value;
  if (normalizedUnit.includes("wh")) return value / 1000;
  return value;
}

// ---------------------------------------------------------------------------
// HTTP layer — Bearer token
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  return normalizeBaseUrlShared(raw, GENERAC_DEFAULT_BASE_URL);
}

async function getGeneracJson(
  path: string,
  context: GeneracApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  const { data } = await fetchJson(url.toString(), {
    service: "Generac",
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
    },
    timeoutMs: 20_000,
  });

  return data;
}

// ---------------------------------------------------------------------------
// Extraction: Systems
// ---------------------------------------------------------------------------

export function extractSystems(payload: unknown): GeneracSystem[] {
  const root = asRecord(payload);
  const rows = asRecordArray(
    root.systems ?? root.data ?? root.results ?? root.items
  );
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: GeneracSystem[] = [];
  for (const row of items) {
    const systemId = toNullableString(
      row.systemId ?? row.id ?? row.system_id
    );
    if (!systemId) continue;

    output.push({
      systemId,
      name: toNullableString(row.name ?? row.systemName ?? row.siteName) ?? `System ${systemId}`,
      capacity: toNullableNumber(row.capacity ?? row.systemSize ?? row.ratedPower),
      address: toNullableString(row.address ?? row.location ?? row.siteAddress),
      status: toNullableString(row.status ?? row.systemStatus),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List Systems
// ---------------------------------------------------------------------------

export async function listSystems(context: GeneracApiContext): Promise<{
  systems: GeneracSystem[];
  raw: unknown;
}> {
  const raw = await getGeneracJson("/systems", context);
  return {
    systems: extractSystems(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// API: System Detail
// ---------------------------------------------------------------------------

export async function getSystemDetail(
  context: GeneracApiContext,
  systemId: string
): Promise<unknown> {
  return getGeneracJson(`/systems/${encodeURIComponent(systemId)}`, context);
}

// ---------------------------------------------------------------------------
// Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getDailyEnergyHistory(
  context: GeneracApiContext,
  systemId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    const raw = await getGeneracJson(
      `/systems/${encodeURIComponent(systemId)}/energy`,
      context,
      { startDate, endDate, granularity: "day" }
    );

    const root = asRecord(raw);
    const records = asRecordArray(
      root.data ?? root.energy ?? root.values ?? root.readings
    );
    const items = records.length > 0 ? records : Array.isArray(raw) ? asRecordArray(raw) : [];

    const unit = toNullableString(root.unit ?? root.units);

    for (const record of items) {
      const dateKey = asDateKey(
        toNullableString(record.date) ??
          toNullableString(record.timestamp) ??
          toNullableString(record.time) ??
          toNullableString(record.startDate)
      );
      const rawValue = toNullableNumber(record.energy ?? record.value ?? record.production ?? record.kwh);
      const kwh = toKwh(rawValue, unit);
      if (dateKey && kwh !== null && dateKey >= startDate && dateKey <= endDate) {
        points.push({ dateKey, kwh: safeRound(kwh)! });
      }
    }
  } catch {
    // Non-critical — return empty
  }

  return points;
}

// ---------------------------------------------------------------------------
// Lifetime energy
// ---------------------------------------------------------------------------

async function getLifetimeEnergy(
  context: GeneracApiContext,
  systemId: string
): Promise<number | null> {
  try {
    const raw = await getGeneracJson(
      `/systems/${encodeURIComponent(systemId)}/energy`,
      context,
      { granularity: "lifetime" }
    );

    const root = asRecord(raw);
    const unit = toNullableString(root.unit ?? root.units);
    const records = asRecordArray(root.data ?? root.energy ?? root.values);
    if (records.length > 0) {
      const val = toNullableNumber(records[0].energy ?? records[0].value ?? records[0].total);
      return safeRound(toKwh(val, unit));
    }

    const directVal = toNullableNumber(root.lifetimeEnergy ?? root.totalEnergy ?? root.energy);
    return safeRound(toKwh(directVal, unit));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getSystemProductionSnapshot(
  context: GeneracApiContext,
  systemIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<GeneracProductionSnapshot> {
  const systemId = systemIdRaw.trim();
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
    const [lifetimeKwh, dailySeries, last12MonthsSeries] = await Promise.all([
      getLifetimeEnergy(context, systemId),
      getDailyEnergyHistory(context, systemId, previousCalendarMonthStartDate, anchorDate),
      getDailyEnergyHistory(context, systemId, last12MonthsStartDate, anchorDate),
    ]);

    const hourlyProductionKwh: number | null = null;

    const dailyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey === anchorDate).map((p) => p.kwh)
    );

    const weeklyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= weeklyStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const monthlyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= monthlyStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const mtdProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= mtdStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const previousCalendarMonthProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= previousCalendarMonthStartDate && p.dateKey <= previousCalendarMonthEndDate)
        .map((p) => p.kwh)
    );

    const last12MonthsProductionKwh = sumKwh(
      last12MonthsSeries.map((p) => p.kwh)
    );

    return {
      systemId,
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
      systemId,
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
