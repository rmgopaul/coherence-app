import { fetchJson } from "./httpClient";

export const APSYSTEMS_DEFAULT_BASE_URL = "https://api.apsystemsema.com/api/v1";

export type APsystemsApiContext = {
  apiKey: string;
  baseUrl?: string | null;
};

export type APsystemsSystem = {
  systemId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  status: string | null;
};

export type APsystemsProductionSnapshot = {
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
// Internal helpers
// ---------------------------------------------------------------------------

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toNullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => asRecord(row));
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function parseIsoDate(input: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(dateIso: string, deltaDays: number): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 1, parsed.day);
  date.setDate(date.getDate() + deltaDays);
  return formatIsoDate(date);
}

function shiftIsoDateByYears(dateIso: string, deltaYears: number): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 1, parsed.day);
  date.setFullYear(date.getFullYear() + deltaYears);
  return formatIsoDate(date);
}

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

function asDateKey(value: string | null | undefined): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const leading = normalized.slice(0, 10);
  return parseIsoDate(leading) ? leading : null;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function sumKwh(values: number[]): number | null {
  if (values.length === 0) return null;
  return safeRound(values.reduce((sum, current) => sum + current, 0));
}

function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function toKwh(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  const normalizedUnit = (unit ?? "").trim().toLowerCase();
  if (normalizedUnit.includes("kwh")) return value;
  if (normalizedUnit.includes("wh")) return value / 1000;
  return value / 1000; // Default: assume Wh
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found");
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  const output = new Array<TOutput>(items.length);
  let cursor = 0;

  const run = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => run());
  await Promise.all(workers);
  return output;
}

// ---------------------------------------------------------------------------
// HTTP layer — API key auth
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return APSYSTEMS_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

async function getAPsystemsJson(
  path: string,
  context: APsystemsApiContext,
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
    service: "APsystems",
    headers: {
      Authorization: `Bearer ${context.apiKey}`,
      "X-API-Key": context.apiKey,
    },
    timeoutMs: 20_000,
  });

  return data;
}

// ---------------------------------------------------------------------------
// Extraction: Systems
// ---------------------------------------------------------------------------

export function extractSystems(payload: unknown): APsystemsSystem[] {
  const root = asRecord(payload);
  const rows = asRecordArray(
    root.systems ?? root.data ?? root.results ?? root.items
  );
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: APsystemsSystem[] = [];
  for (const row of items) {
    const systemId = toNullableString(
      row.systemId ?? row.id ?? row.system_id ?? row.ecu_id
    );
    if (!systemId) continue;

    output.push({
      systemId,
      name: toNullableString(row.name ?? row.systemName ?? row.siteName) ?? `System ${systemId}`,
      capacity: toNullableNumber(row.capacity ?? row.systemSize ?? row.totalPower),
      address: toNullableString(row.address ?? row.location),
      status: toNullableString(row.status ?? row.systemStatus),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List Systems
// ---------------------------------------------------------------------------

export async function listSystems(context: APsystemsApiContext): Promise<{
  systems: APsystemsSystem[];
  raw: unknown;
}> {
  const raw = await getAPsystemsJson("/systems", context);
  return {
    systems: extractSystems(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// API: System Detail
// ---------------------------------------------------------------------------

export async function getSystemDetail(
  context: APsystemsApiContext,
  systemId: string
): Promise<unknown> {
  return getAPsystemsJson(`/systems/${encodeURIComponent(systemId)}`, context);
}

// ---------------------------------------------------------------------------
// Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getDailyEnergyHistory(
  context: APsystemsApiContext,
  systemId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    const raw = await getAPsystemsJson(
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
          toNullableString(record.time)
      );
      const rawValue = toNullableNumber(record.energy ?? record.value ?? record.production);
      const kwh = toKwh(rawValue, unit ?? "Wh");
      if (dateKey && kwh !== null && dateKey >= startDate && dateKey <= endDate) {
        points.push({ dateKey, kwh: safeRound(kwh)! });
      }
    }
  } catch {
    // Non-critical
  }

  return points;
}

// ---------------------------------------------------------------------------
// Lifetime energy
// ---------------------------------------------------------------------------

async function getLifetimeEnergy(
  context: APsystemsApiContext,
  systemId: string
): Promise<number | null> {
  try {
    const raw = await getAPsystemsJson(
      `/systems/${encodeURIComponent(systemId)}`,
      context
    );

    const root = asRecord(raw);
    const data = asRecord(root.data ?? root);
    const rawValue = toNullableNumber(
      data.lifetimeEnergy ?? data.totalEnergy ?? data.lifetime_energy ?? data.allEnergy
    );
    return safeRound(toKwh(rawValue, "Wh"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getSystemProductionSnapshot(
  context: APsystemsApiContext,
  systemIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<APsystemsProductionSnapshot> {
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
