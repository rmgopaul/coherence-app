export const SOLAR_EDGE_DEFAULT_BASE_URL = "https://monitoringapi.solaredge.com/v2";

export type SolarEdgeApiContext = {
  apiKey: string;
  baseUrl?: string | null;
};

export type SolarEdgeSite = {
  siteId: string;
  siteName: string;
  status: string | null;
  peakPowerW: number | null;
  timezone: string | null;
  location: string | null;
};

export type SolarEdgeProductionSnapshot = {
  siteId: string;
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

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return SOLAR_EDGE_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

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
  const date = new Date(parsed.year, parsed.month - 1, 1);
  return formatIsoDate(date);
}

function firstDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 2, 1);
  return formatIsoDate(date);
}

function lastDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 1, 0);
  return formatIsoDate(date);
}

function asDateKey(value: string | null | undefined): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const leading = normalized.slice(0, 10);
  return parseIsoDate(leading) ? leading : null;
}

function toKwh(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  const normalizedUnit = (unit ?? "").trim().toLowerCase();
  if (normalizedUnit.includes("kwh")) return value;
  if (normalizedUnit.includes("wh")) return value / 1000;
  return value / 1000;
}

function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function sumKwh(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, current) => sum + current, 0);
  return safeRound(total);
}

function extractOverviewLifetimeKwh(payload: unknown): number | null {
  const root = asRecord(payload);
  const overview = asRecord(root.overview);
  const lifeTimeData = asRecord(
    overview.lifeTimeData ?? overview.lifetimeData ?? overview.lifeTime ?? overview.life_time_data
  );
  const energy = toNullableNumber(lifeTimeData.energy ?? overview.lifeTimeEnergy ?? overview.lifetimeEnergy);
  return safeRound(toKwh(energy, "Wh"));
}

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

type HourlyEnergyPoint = {
  timestamp: string;
  kwh: number;
};

function extractDailyEnergySeriesKwh(payload: unknown): DailyEnergyPoint[] {
  const root = asRecord(payload);
  const energy = asRecord(root.energy);
  const values = Array.isArray(energy.values)
    ? energy.values
    : Array.isArray(root.values)
      ? root.values
      : [];
  const unit = toNullableString(energy.unit) ?? toNullableString(root.unit);
  const output: DailyEnergyPoint[] = [];

  for (const row of values) {
    const record = asRecord(row);
    const dateKey = asDateKey(
      toNullableString(record.date) ??
        toNullableString(record.dateTime) ??
        toNullableString(record.endTime) ??
        toNullableString(record.startTime)
    );
    const value = toNullableNumber(record.value ?? record.energy ?? record.production);
    const kwh = toKwh(value, unit);
    if (!dateKey || kwh === null) continue;
    output.push({
      dateKey,
      kwh,
    });
  }

  return output;
}

function extractHourlyEnergySeriesKwh(payload: unknown): HourlyEnergyPoint[] {
  const root = asRecord(payload);
  const energy = asRecord(root.energy);
  const values = Array.isArray(energy.values)
    ? energy.values
    : Array.isArray(root.values)
      ? root.values
      : [];
  const unit = toNullableString(energy.unit) ?? toNullableString(root.unit);
  const output: HourlyEnergyPoint[] = [];

  for (const row of values) {
    const record = asRecord(row);
    const timestamp =
      toNullableString(record.dateTime) ??
      toNullableString(record.endTime) ??
      toNullableString(record.startTime) ??
      toNullableString(record.date);
    const value = toNullableNumber(record.value ?? record.energy ?? record.production);
    const kwh = toKwh(value, unit);
    if (!timestamp || kwh === null) continue;
    output.push({
      timestamp,
      kwh,
    });
  }

  output.sort((a, b) => {
    const aMs = new Date(a.timestamp).getTime();
    const bMs = new Date(b.timestamp).getTime();
    const safeA = Number.isFinite(aMs) ? aMs : 0;
    const safeB = Number.isFinite(bMs) ? bMs : 0;
    return safeA - safeB;
  });

  return output;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found");
}

function toSolarEdgeDateTime(dateIso: string, endOfDay: boolean): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) {
    throw new Error("Dates must be in YYYY-MM-DD format.");
  }

  const hh = endOfDay ? "23" : "00";
  const mm = endOfDay ? "59" : "00";
  const ss = endOfDay ? "59" : "00";
  const month = String(parsed.month).padStart(2, "0");
  const day = String(parsed.day).padStart(2, "0");
  return `${parsed.year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

function buildApiUrl(
  path: string,
  context: SolarEdgeApiContext,
  query?: Record<string, string | number | null | undefined>,
  options?: {
    includeApiKeyQuery?: boolean;
  }
): string {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  if (options?.includeApiKeyQuery !== false) {
    url.searchParams.set("api_key", context.apiKey);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  return url.toString();
}

type SolarEdgeAuthMode = "query-only" | "bearer-plus-query";

function buildApiHeaders(context: SolarEdgeApiContext, authMode: SolarEdgeAuthMode): HeadersInit {
  const apiKey = context.apiKey.trim();
  if (authMode === "query-only") {
    return {
      Accept: "application/json",
    };
  }
  return {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
  };
}

function stripV2Suffix(rawBaseUrl: string | null | undefined): string | null {
  const base = normalizeBaseUrl(rawBaseUrl);
  if (!base.toLowerCase().endsWith("/v2")) return null;
  return base.slice(0, -3).replace(/\/+$/, "");
}

async function getSolarEdgeJson(
  path: string,
  context: SolarEdgeApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const primaryBase = normalizeBaseUrl(context.baseUrl);
  const fallbackBase = stripV2Suffix(context.baseUrl);

  const attempted = new Set<string>();
  const attempts: Array<{ baseUrl: string; authMode: SolarEdgeAuthMode }> = [];

  const addAttempt = (baseUrl: string | null | undefined, authMode: SolarEdgeAuthMode) => {
    if (!baseUrl) return;
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const signature = `${authMode}:${normalizedBase}`;
    if (attempted.has(signature)) return;
    attempted.add(signature);
    attempts.push({ baseUrl: normalizedBase, authMode });
  };

  // Most SolarEdge monitoring keys are valid with query-string api_key only.
  addAttempt(primaryBase, "query-only");
  addAttempt(fallbackBase, "query-only");
  // Some endpoint variants require bearer-style auth.
  addAttempt(primaryBase, "bearer-plus-query");
  addAttempt(fallbackBase, "bearer-plus-query");

  let lastFailureMessage = "SolarEdge request failed.";
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const attemptContext: SolarEdgeApiContext = {
      ...context,
      baseUrl: attempt.baseUrl,
    };

    const url = buildApiUrl(path, attemptContext, query, {
      includeApiKeyQuery: true,
    });
    const response = await fetch(url, {
      headers: buildApiHeaders(attemptContext, attempt.authMode),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      return response.json();
    }

    const errorText = await response.text().catch(() => "");
    lastFailureMessage = `SolarEdge request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`;

    // Retry auth permutations only for auth failures.
    const isAuthFailure = response.status === 401 || response.status === 403;
    if (isAuthFailure && index < attempts.length - 1) {
      continue;
    }

    throw new Error(lastFailureMessage);
  }

  throw new Error(lastFailureMessage);
}

export function extractSites(payload: unknown): SolarEdgeSite[] {
  const record = asRecord(payload);
  const sitesRecord = asRecord(record.sites);
  const rows = Array.isArray(sitesRecord.site)
    ? sitesRecord.site
    : Array.isArray(record.sites)
      ? (record.sites as unknown[])
      : Array.isArray(payload)
        ? payload
        : [];

  const output: SolarEdgeSite[] = [];
  for (const row of rows) {
    const value = asRecord(row);
    const id = toNullableString(value.id ?? value.siteId);
    if (!id) continue;

    const city = toNullableString(value.city);
    const country = toNullableString(value.country);
    const location = [city, country].filter(Boolean).join(", ") || null;

    output.push({
      siteId: id,
      siteName: toNullableString(value.name) ?? `Site ${id}`,
      status: toNullableString(value.status),
      peakPowerW: toNullableNumber(value.peakPower ?? value.peakPowerW),
      timezone: toNullableString(value.timeZone ?? value.timezone),
      location,
    });
  }

  return output;
}

export async function listSites(context: SolarEdgeApiContext): Promise<{
  sites: SolarEdgeSite[];
  raw: unknown;
}> {
  const raw = await getSolarEdgeJson("/sites/list", context);
  return {
    sites: extractSites(raw),
    raw,
  };
}

export async function getSiteOverview(context: SolarEdgeApiContext, siteId: string): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/overview`, context);
}

export async function getSiteDetails(context: SolarEdgeApiContext, siteId: string): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/details`, context);
}

export async function getSiteEnergy(
  context: SolarEdgeApiContext,
  siteId: string,
  startDate?: string | null,
  endDate?: string | null,
  timeUnit?: string | null
): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/energy`, context, {
    startDate: startDate ?? undefined,
    endDate: endDate ?? undefined,
    timeUnit: timeUnit ?? undefined,
  });
}

export async function getSiteEnergyDetails(
  context: SolarEdgeApiContext,
  siteId: string,
  startDate?: string | null,
  endDate?: string | null,
  timeUnit?: string | null,
  meters?: string | null
): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/energyDetails`, context, {
    startTime: startDate ? toSolarEdgeDateTime(startDate, false) : undefined,
    endTime: endDate ? toSolarEdgeDateTime(endDate, true) : undefined,
    timeUnit: timeUnit ?? undefined,
    meters: meters ?? "PRODUCTION",
  });
}

export async function getSiteMeters(
  context: SolarEdgeApiContext,
  siteId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/meters`, context, {
    startTime: startDate ? toSolarEdgeDateTime(startDate, false) : undefined,
    endTime: endDate ? toSolarEdgeDateTime(endDate, true) : undefined,
  });
}

export async function getSiteProductionSnapshot(
  context: SolarEdgeApiContext,
  siteIdRaw: string,
  anchorDateRaw?: string | null
): Promise<SolarEdgeProductionSnapshot> {
  const siteId = siteIdRaw.trim();
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
    const [overviewPayload, periodEnergyPayload, last12MonthsEnergyPayload, hourlyPayload] = await Promise.all([
      getSiteOverview(context, siteId),
      getSiteEnergy(context, siteId, previousCalendarMonthStartDate, anchorDate, "DAY"),
      getSiteEnergy(context, siteId, last12MonthsStartDate, anchorDate, "MONTH"),
      getSiteEnergy(context, siteId, anchorDate, anchorDate, "HOUR"),
    ]);

    const lifetimeKwh = extractOverviewLifetimeKwh(overviewPayload);
    const periodSeries = extractDailyEnergySeriesKwh(periodEnergyPayload);
    const last12MonthsSeries = extractDailyEnergySeriesKwh(last12MonthsEnergyPayload);
    const hourlySeries = extractHourlyEnergySeriesKwh(hourlyPayload);
    const hourlyProductionKwh = safeRound(hourlySeries.length > 0 ? hourlySeries[hourlySeries.length - 1].kwh : null);
    const monthlyProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey >= monthlyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );
    const weeklyProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey >= weeklyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );
    const dailyProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey === anchorDate)
        .map((point) => point.kwh)
    );
    const mtdProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey >= mtdStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );
    const previousCalendarMonthProductionKwh = sumKwh(
      periodSeries
        .filter(
          (point) =>
            point.dateKey >= previousCalendarMonthStartDate &&
            point.dateKey <= previousCalendarMonthEndDate
        )
        .map((point) => point.kwh)
    );
    const last12MonthsProductionKwh = sumKwh(last12MonthsSeries.map((point) => point.kwh));

    return {
      siteId,
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
    if (isNotFoundError(error)) {
      return {
        siteId,
        status: "Not Found",
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
        error: error instanceof Error ? error.message : "Site not found.",
      };
    }

    return {
      siteId,
      status: "Error",
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
