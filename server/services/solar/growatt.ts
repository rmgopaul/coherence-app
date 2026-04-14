import {
  toNullableString,
  toNullableNumber,
  asRecord,
  asRecordArray,
  parseIsoDate,
  normalizeBaseUrl as normalizeBaseUrlShared,
} from "./helpers";

export const GROWATT_DEFAULT_BASE_URL = "https://openapi.growatt.com";

export type GrowattApiContext = {
  username: string;
  password: string;
  baseUrl?: string | null;
};

export type GrowattPlant = {
  plantId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  status: string | null;
};

export type GrowattProductionSnapshot = {
  plantId: string;
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

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found");
}

// ---------------------------------------------------------------------------
// HTTP layer — session-based auth with in-memory caching
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  return normalizeBaseUrlShared(raw, GROWATT_DEFAULT_BASE_URL);
}

type GrowattSessionState = {
  cookie: string;
  expiresAt: number;
};

const growattSessionCache = new Map<string, GrowattSessionState>();

function getSessionCacheKey(context: GrowattApiContext): string {
  return `${context.username.trim()}::${normalizeBaseUrl(context.baseUrl)}`;
}

async function getGrowattSession(context: GrowattApiContext): Promise<string> {
  const cacheKey = getSessionCacheKey(context);
  const cached = growattSessionCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.cookie;
  }

  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const loginUrl = `${baseUrl}/login`;

  const body = new URLSearchParams({
    account: context.username.trim(),
    password: context.password,
    validateCode: "",
    isReadPact: "0",
  });

  const response = await fetch(loginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
    redirect: "manual",
  });

  // Extract session cookie from Set-Cookie header
  const setCookieHeaders = response.headers.getSetCookie?.() ?? [];
  const cookies: string[] = [];
  for (const header of setCookieHeaders) {
    const cookiePart = header.split(";")[0]?.trim();
    if (cookiePart) cookies.push(cookiePart);
  }

  // Also handle single Set-Cookie header
  if (cookies.length === 0) {
    const singleCookie = response.headers.get("set-cookie");
    if (singleCookie) {
      const cookiePart = singleCookie.split(";")[0]?.trim();
      if (cookiePart) cookies.push(cookiePart);
    }
  }

  const cookieStr = cookies.join("; ");

  if (!cookieStr) {
    // Try parsing as JSON response with token
    if (response.ok) {
      const json = asRecord(await response.json().catch(() => ({})));
      const result = asRecord(json.result ?? json.data ?? json);
      if (toNullableString(result.error) || json.error_code) {
        throw new Error(
          `Growatt login failed: ${toNullableString(result.error) ?? toNullableString(json.error_msg) ?? "Invalid credentials"}`
        );
      }
    }
    throw new Error("Growatt login succeeded but no session cookie was returned.");
  }

  growattSessionCache.set(cacheKey, {
    cookie: cookieStr,
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 minute cache
  });

  return cookieStr;
}

async function getGrowattJson(
  path: string,
  context: GrowattApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const cookie = await getGrowattSession(context);
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Cookie: cookie,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      growattSessionCache.delete(getSessionCacheKey(context));
      throw new Error(
        `Growatt authentication failed (${response.status})${errorText ? `: ${errorText}` : ""}`
      );
    }
    throw new Error(
      `Growatt request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Extraction: Plants
// ---------------------------------------------------------------------------

export function extractPlants(payload: unknown): GrowattPlant[] {
  const root = asRecord(payload);
  const dataArr = asRecordArray(root.data ?? root.datas ?? root);
  const backArr = asRecordArray(root.back ?? root.result);
  const rows = dataArr.length > 0 ? dataArr : backArr;
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: GrowattPlant[] = [];
  for (const row of items) {
    const plantId = toNullableString(
      row.plantId ?? row.id ?? row.plant_id ?? row.plantid
    );
    if (!plantId) continue;

    output.push({
      plantId,
      name: toNullableString(row.plantName ?? row.name ?? row.plant_name) ?? `Plant ${plantId}`,
      capacity: toNullableNumber(row.nominalPower ?? row.capacity ?? row.peakPower),
      address: toNullableString(row.plant_address ?? row.address ?? row.city),
      status: toNullableString(row.status ?? row.plantStatus),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List Plants
// ---------------------------------------------------------------------------

export async function listPlants(context: GrowattApiContext): Promise<{
  plants: GrowattPlant[];
  raw: unknown;
}> {
  const raw = await getGrowattJson("/index/getPlantList", context);
  return {
    plants: extractPlants(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// API: Plant Data (daily snapshot)
// ---------------------------------------------------------------------------

export async function getPlantData(
  context: GrowattApiContext,
  plantId: string,
  date: string
): Promise<unknown> {
  return getGrowattJson("/newTwoPlantAPI.do", context, {
    op: "getPlantData",
    plantId,
    date,
  });
}

// ---------------------------------------------------------------------------
// Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getDailyEnergyHistory(
  context: GrowattApiContext,
  plantId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    // Try the energy production history endpoint first
    const raw = await getGrowattJson("/newTwoPlantAPI.do", context, {
      op: "getEnergyProdHist",
      plantId,
      type: "2", // daily
      startDate,
      endDate,
    });

    const root = asRecord(raw);
    const records = asRecordArray(root.data ?? root.datas ?? root.obj ?? root);

    for (const record of records) {
      const dateKey = asDateKey(
        toNullableString(record.date) ??
          toNullableString(record.time) ??
          toNullableString(record.dataDate)
      );
      const kwh = toNullableNumber(
        record.energy ?? record.todayEnergy ?? record.value ?? record.production
      );
      if (dateKey && kwh !== null && dateKey >= startDate && dateKey <= endDate) {
        points.push({ dateKey, kwh: safeRound(kwh)! });
      }
    }
  } catch {
    // Fallback: fetch individual days from plant data
    // Only try for short ranges to avoid excessive API calls
    const startParsed = parseIsoDate(startDate);
    const endParsed = parseIsoDate(endDate);
    if (startParsed && endParsed) {
      const startMs = new Date(startParsed.year, startParsed.month - 1, startParsed.day).getTime();
      const endMs = new Date(endParsed.year, endParsed.month - 1, endParsed.day).getTime();
      const dayCount = Math.floor((endMs - startMs) / 86_400_000) + 1;

      if (dayCount <= 31) {
        for (let i = 0; i < dayCount; i++) {
          const dateKey = shiftIsoDate(startDate, i);
          try {
            const dayData = await getPlantData(context, plantId, dateKey);
            const day = asRecord(dayData);
            const data = asRecord(day.data ?? day);
            const kwh = toNullableNumber(
              data.todayEnergy ?? data.eToday ?? data.energy
            );
            if (kwh !== null) {
              points.push({ dateKey, kwh: safeRound(kwh)! });
            }
          } catch {
            // Skip individual day failures
          }
        }
      }
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getPlantProductionSnapshot(
  context: GrowattApiContext,
  plantIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<GrowattProductionSnapshot> {
  const plantId = plantIdRaw.trim();
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
    const [plantDataPayload, dailySeries] = await Promise.all([
      getPlantData(context, plantId, anchorDate),
      getDailyEnergyHistory(context, plantId, previousCalendarMonthStartDate, anchorDate),
    ]);

    const plantData = asRecord(plantDataPayload);
    const data = asRecord(plantData.data ?? plantData);

    const lifetimeKwh = safeRound(
      toNullableNumber(data.totalEnergy ?? data.eTotal ?? data.allEnergy)
    );

    const hourlyProductionKwh: number | null = null;

    const dailyProductionKwh =
      safeRound(toNullableNumber(data.todayEnergy ?? data.eToday)) ??
      sumKwh(dailySeries.filter((p) => p.dateKey === anchorDate).map((p) => p.kwh));

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

    const last12MonthsProductionKwh: number | null = null;

    return {
      plantId,
      name: name ?? toNullableString(data.plantName ?? data.name),
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
      plantId,
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
