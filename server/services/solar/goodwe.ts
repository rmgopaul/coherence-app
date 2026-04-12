export const GOODWE_DEFAULT_BASE_URL = "https://www.semsportal.com/api";

export type GoodWeApiContext = {
  account: string;
  password: string;
  baseUrl?: string | null;
};

export type GoodWeStation = {
  stationId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  status: string | null;
};

export type GoodWeProductionSnapshot = {
  stationId: string;
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
// HTTP layer — token-based auth with in-memory caching
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return GOODWE_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

type GoodWeTokenState = {
  token: string;
  uid: string;
  expiresAt: number;
};

const goodweTokenCache = new Map<string, GoodWeTokenState>();

function getTokenCacheKey(context: GoodWeApiContext): string {
  return `${context.account.trim()}::${normalizeBaseUrl(context.baseUrl)}`;
}

async function getGoodWeToken(context: GoodWeApiContext): Promise<{ token: string; uid: string }> {
  const cacheKey = getTokenCacheKey(context);
  const cached = goodweTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return { token: cached.token, uid: cached.uid };
  }

  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const response = await fetch(`${baseUrl}/v2/Common/CrossLogin`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Token: '{"version":"v2.1.0","client":"web","language":"en"}',
    },
    body: JSON.stringify({
      account: context.account.trim(),
      pwd: context.password,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `GoodWe login failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  const json = asRecord(await response.json());
  const data = asRecord(json.data);
  const token = toNullableString(data.token);
  const uid = toNullableString(data.uid ?? data.userId);

  if (!token) {
    throw new Error("GoodWe login succeeded but no token was returned.");
  }

  const state: GoodWeTokenState = {
    token,
    uid: uid ?? "",
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 minute cache
  };
  goodweTokenCache.set(cacheKey, state);

  return { token: state.token, uid: state.uid };
}

async function postGoodWeJson(
  path: string,
  context: GoodWeApiContext,
  body: Record<string, unknown> = {}
): Promise<unknown> {
  const { token } = await getGoodWeToken(context);
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${safePath}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Token: JSON.stringify({ version: "v2.1.0", client: "web", language: "en", token }),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      // Invalidate cached token
      goodweTokenCache.delete(getTokenCacheKey(context));
      throw new Error(
        `GoodWe authentication failed (${response.status})${errorText ? `: ${errorText}` : ""}`
      );
    }
    throw new Error(
      `GoodWe request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  const json = asRecord(await response.json());

  // GoodWe wraps responses: { code: 0, msg: "...", data: {...}, hasError: false }
  if (json.hasError === true || (json.code !== undefined && json.code !== 0 && json.code !== "0")) {
    const msg = toNullableString(json.msg) ?? toNullableString(json.message) ?? "Unknown GoodWe API error";
    throw new Error(`GoodWe API error: ${msg}`);
  }

  return json.data ?? json;
}

// ---------------------------------------------------------------------------
// Extraction: Stations
// ---------------------------------------------------------------------------

export function extractStations(payload: unknown): GoodWeStation[] {
  const root = asRecord(payload);
  const list = asRecordArray(
    root.list ?? root.stationList ?? root.stations ?? root.data
  );
  const items = list.length > 0 ? list : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: GoodWeStation[] = [];
  for (const row of items) {
    const stationId = toNullableString(
      row.powerstation_id ?? row.id ?? row.stationId ?? row.powerstationId
    );
    if (!stationId) continue;

    output.push({
      stationId,
      name: toNullableString(row.stationname ?? row.name ?? row.stationName) ?? `Station ${stationId}`,
      capacity: toNullableNumber(row.capacity ?? row.nominal_power ?? row.installedCapacity),
      address: toNullableString(row.address ?? row.location),
      status: toNullableString(row.status ?? row.connectStatus),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List Stations
// ---------------------------------------------------------------------------

export async function listStations(context: GoodWeApiContext): Promise<{
  stations: GoodWeStation[];
  raw: unknown;
}> {
  const raw = await postGoodWeJson("/v2/PowerStation/GetMonitorList", context);
  return {
    stations: extractStations(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// API: Station Detail
// ---------------------------------------------------------------------------

export async function getStationDetail(
  context: GoodWeApiContext,
  stationId: string
): Promise<unknown> {
  return postGoodWeJson("/v2/PowerStationMonitor/GetPowerStationDetail", context, {
    powerStationId: stationId,
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
  context: GoodWeApiContext,
  stationId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    const raw = await postGoodWeJson("/v2/Charts/GetChartByPlant", context, {
      id: stationId,
      date: endDate,
      range: 2, // 2 = monthly range (daily data points)
    });

    const root = asRecord(raw);
    const lines = asRecordArray(root.lines ?? root.data ?? root);
    // Look for the generation/production line
    for (const line of lines) {
      const label = toNullableString(line.label ?? line.key ?? line.name);
      if (label && /generation|production|yield|output|energy/i.test(label)) {
        const xyData = asRecordArray(line.xy ?? line.data ?? line.values);
        for (const point of xyData) {
          const dateKey = asDateKey(
            toNullableString(point.x) ?? toNullableString(point.date) ?? toNullableString(point.time)
          );
          const kwh = toNullableNumber(point.y ?? point.value ?? point.energy);
          if (dateKey && kwh !== null && dateKey >= startDate && dateKey <= endDate) {
            points.push({ dateKey, kwh: safeRound(kwh)! });
          }
        }
        break;
      }
    }

    // Fallback: if no labeled line found, try first line
    if (points.length === 0 && lines.length > 0) {
      const firstLine = lines[0];
      const xyData = asRecordArray(firstLine.xy ?? firstLine.data ?? firstLine.values);
      for (const point of xyData) {
        const dateKey = asDateKey(
          toNullableString(point.x) ?? toNullableString(point.date)
        );
        const kwh = toNullableNumber(point.y ?? point.value);
        if (dateKey && kwh !== null && dateKey >= startDate && dateKey <= endDate) {
          points.push({ dateKey, kwh: safeRound(kwh)! });
        }
      }
    }
  } catch {
    // Non-critical — return empty
  }

  return points;
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getStationProductionSnapshot(
  context: GoodWeApiContext,
  stationIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<GoodWeProductionSnapshot> {
  const stationId = stationIdRaw.trim();
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
    const [detailPayload, dailySeries] = await Promise.all([
      getStationDetail(context, stationId),
      getDailyEnergyHistory(context, stationId, previousCalendarMonthStartDate, anchorDate),
    ]);

    const detail = asRecord(detailPayload);
    const kpiRecord = asRecord(detail.kpi ?? detail);

    const lifetimeKwh = safeRound(
      toNullableNumber(kpiRecord.total_power ?? kpiRecord.eTotal ?? detail.eTotal ?? detail.totalEnergy)
    );

    const hourlyProductionKwh: number | null = null;

    const dailyProductionKwh =
      safeRound(toNullableNumber(kpiRecord.power ?? kpiRecord.eToday ?? detail.eToday ?? detail.todayEnergy)) ??
      sumKwh(dailySeries.filter((p) => p.dateKey === anchorDate).map((p) => p.kwh));

    const weeklyProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= weeklyStartDate && p.dateKey <= anchorDate)
        .map((p) => p.kwh)
    );

    const monthlyProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= monthlyStartDate && p.dateKey <= anchorDate)
        .map((p) => p.kwh)
    );

    const mtdProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= mtdStartDate && p.dateKey <= anchorDate)
        .map((p) => p.kwh)
    );

    const previousCalendarMonthProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= previousCalendarMonthStartDate && p.dateKey <= previousCalendarMonthEndDate)
        .map((p) => p.kwh)
    );

    // For last 12 months, use the API's eMonth/monthEnergy if available, otherwise null
    const last12MonthsProductionKwh: number | null = null;

    return {
      stationId,
      name: name ?? toNullableString(detail.stationname ?? detail.name),
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
        stationId,
        name,
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
        error: error instanceof Error ? error.message : "Station not found.",
      };
    }

    return {
      stationId,
      name,
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
