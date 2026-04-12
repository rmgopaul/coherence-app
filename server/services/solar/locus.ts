import { fetchJson } from "../core/httpClient";

export const LOCUS_DEFAULT_BASE_URL = "https://api.locusenergy.com/v3";

export type LocusApiContext = {
  clientId: string;
  clientSecret: string;
  partnerId: string;
  baseUrl?: string | null;
};

export type LocusSite = {
  siteId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  timeZone: string | null;
  status: string | null;
};

export type LocusProductionSnapshot = {
  siteId: string;
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
  const total = values.reduce((sum, current) => sum + current, 0);
  return safeRound(total);
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
// HTTP layer — OAuth2 client credentials
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return LOCUS_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

type LocusTokenState = {
  accessToken: string;
  expiresAt: number;
};

const locusTokenCache = new Map<string, LocusTokenState>();

function getTokenCacheKey(context: LocusApiContext): string {
  return `${context.clientId.trim()}::${normalizeBaseUrl(context.baseUrl)}`;
}

async function getLocusAccessToken(context: LocusApiContext): Promise<string> {
  const cacheKey = getTokenCacheKey(context);
  const cached = locusTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.accessToken;
  }

  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const tokenUrl = `${baseUrl}/oauth/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: context.clientId.trim(),
    client_secret: context.clientSecret,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Locus OAuth2 token request failed (${response.status})${errorText ? `: ${errorText}` : ""}`
    );
  }

  const json = asRecord(await response.json());
  const accessToken = toNullableString(json.access_token);
  const expiresIn = toNullableNumber(json.expires_in) ?? 3600;

  if (!accessToken) {
    throw new Error("Locus OAuth2 token request succeeded but no access_token was returned.");
  }

  locusTokenCache.set(cacheKey, {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  return accessToken;
}

async function getLocusJson(
  path: string,
  context: LocusApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const accessToken = await getLocusAccessToken(context);
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
    service: "Locus",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    timeoutMs: 20_000,
  });

  return data;
}

// ---------------------------------------------------------------------------
// Extraction: Sites
// ---------------------------------------------------------------------------

export function extractSites(payload: unknown): LocusSite[] {
  const root = asRecord(payload);
  const rows = asRecordArray(
    root.sites ?? root.data ?? root.results ?? root.items
  );
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: LocusSite[] = [];
  for (const row of items) {
    const siteId = toNullableString(
      row.id ?? row.siteId ?? row.site_id
    );
    if (!siteId) continue;

    output.push({
      siteId,
      name: toNullableString(row.name ?? row.siteName) ?? `Site ${siteId}`,
      capacity: toNullableNumber(row.nameplate ?? row.capacity ?? row.systemSize),
      address: toNullableString(row.address ?? row.location),
      timeZone: toNullableString(row.timezone ?? row.timeZone),
      status: toNullableString(row.status ?? row.statusCode),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List Sites
// ---------------------------------------------------------------------------

export async function listSites(context: LocusApiContext): Promise<{
  sites: LocusSite[];
  raw: unknown;
}> {
  const raw = await getLocusJson(
    `/partners/${encodeURIComponent(context.partnerId)}/sites`,
    context
  );
  return {
    sites: extractSites(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// API: Site Detail
// ---------------------------------------------------------------------------

export async function getSiteDetail(
  context: LocusApiContext,
  siteId: string
): Promise<unknown> {
  return getLocusJson(`/sites/${encodeURIComponent(siteId)}`, context);
}

// ---------------------------------------------------------------------------
// Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getDailyEnergyHistory(
  context: LocusApiContext,
  siteId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    const raw = await getLocusJson(
      `/sites/${encodeURIComponent(siteId)}/data`,
      context,
      {
        startDate: `${startDate}T00:00:00`,
        endDate: `${endDate}T23:59:59`,
        gran: "daily",
        fields: "Wh_sum",
      }
    );

    const root = asRecord(raw);
    const records = asRecordArray(
      root.data ?? root.values ?? root.readings ?? root.results
    );

    for (const record of records) {
      const dateKey = asDateKey(
        toNullableString(record.timestamp) ??
          toNullableString(record.date) ??
          toNullableString(record.ts)
      );
      const fields = asRecord(record.fields ?? record);
      const rawWh = toNullableNumber(fields.Wh_sum ?? fields.Wh ?? fields.energy ?? record.Wh_sum ?? record.value);
      const kwh = toKwh(rawWh, "Wh");
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
  context: LocusApiContext,
  siteId: string
): Promise<number | null> {
  try {
    const raw = await getLocusJson(
      `/sites/${encodeURIComponent(siteId)}/data`,
      context,
      { gran: "lifetime", fields: "Wh_sum" }
    );

    const root = asRecord(raw);
    const records = asRecordArray(root.data ?? root.values ?? root.readings);
    if (records.length > 0) {
      const fields = asRecord(records[0].fields ?? records[0]);
      const rawWh = toNullableNumber(fields.Wh_sum ?? fields.Wh ?? records[0].Wh_sum ?? records[0].value);
      return safeRound(toKwh(rawWh, "Wh"));
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getSiteProductionSnapshot(
  context: LocusApiContext,
  siteIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<LocusProductionSnapshot> {
  const siteId = siteIdRaw.trim();
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
      getLifetimeEnergy(context, siteId),
      getDailyEnergyHistory(context, siteId, previousCalendarMonthStartDate, anchorDate),
      getDailyEnergyHistory(context, siteId, last12MonthsStartDate, anchorDate),
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
      siteId,
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
      siteId,
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
