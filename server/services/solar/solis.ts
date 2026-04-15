import { createHmac, createHash } from "crypto";
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
  safeRound,
  sumKwh,
  isNotFoundError,
} from "./helpers";

export const SOLIS_DEFAULT_BASE_URL = "https://www.soliscloud.com:13333";

export type SolisApiContext = {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string | null;
};

export type SolisStation = {
  stationId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  timeZone: string | null;
  status: string | null;
};

export type SolisProductionSnapshot = {
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
// Date helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP layer — HMAC-SHA1 signed requests
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  return normalizeBaseUrlShared(raw, SOLIS_DEFAULT_BASE_URL);
}

function buildSolisSignature(
  apiSecret: string,
  verb: string,
  contentMd5: string,
  contentType: string,
  dateStr: string,
  path: string
): string {
  const stringToSign = `${verb}\n${contentMd5}\n${contentType}\n${dateStr}\n${path}`;
  return createHmac("sha1", apiSecret).update(stringToSign).digest("base64");
}

async function postSolisJson(
  path: string,
  context: SolisApiContext,
  body: Record<string, unknown>
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${safePath}`;

  const bodyStr = JSON.stringify(body);
  const contentType = "application/json";
  const contentMd5 = createHash("md5").update(bodyStr).digest("base64");
  const dateStr = new Date().toUTCString();
  const signature = buildSolisSignature(
    context.apiSecret,
    "POST",
    contentMd5,
    contentType,
    dateStr,
    safePath
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "Content-MD5": contentMd5,
      Date: dateStr,
      Authorization: `API ${context.apiKey}:${signature}`,
      Accept: "application/json",
    },
    body: bodyStr,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new Error(`Solis request failed (404 Not Found)${errorText ? `: ${errorText}` : ""}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Solis authentication failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
      );
    }
    throw new Error(
      `Solis request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  const json = (await response.json()) as Record<string, unknown>;

  // Solis wraps responses: { success: true, code: "0", data: { ... } }
  if (json.success === false || (json.code !== undefined && json.code !== "0" && json.code !== 0)) {
    const msg = toNullableString(json.msg) ?? toNullableString(json.message) ?? "Unknown Solis API error";
    throw new Error(`Solis API error: ${msg}`);
  }

  return json.data ?? json;
}

// ---------------------------------------------------------------------------
// Extraction: Stations
// ---------------------------------------------------------------------------

export function extractStations(payload: unknown): SolisStation[] {
  const root = asRecord(payload);
  const page = asRecord(root.page ?? root);
  const rows = asRecordArray(
    page.records ?? root.records ?? root.stationList ?? root.stations
  );
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: SolisStation[] = [];
  for (const row of items) {
    const stationId = toNullableString(
      row.id ?? row.stationId ?? row.sno
    );
    if (!stationId) continue;

    output.push({
      stationId,
      name: toNullableString(row.sno ?? row.stationName ?? row.name) ?? `Station ${stationId}`,
      capacity: toNullableNumber(row.capacity ?? row.installedCapacity),
      address: toNullableString(row.addr ?? row.address ?? row.location),
      timeZone: toNullableString(row.timeZone ?? row.timezone),
      status: toNullableString(row.connectStatus ?? row.status),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List Stations (with pagination)
// ---------------------------------------------------------------------------

export async function listStations(context: SolisApiContext): Promise<{
  stations: SolisStation[];
  raw: unknown;
}> {
  const allStations: SolisStation[] = [];
  const allRawPages: unknown[] = [];
  let pageNo = 1;
  const pageSize = 100;
  const maxPages = 100;

  while (pageNo <= maxPages) {
    const raw = await postSolisJson("/v1/api/userStationList", context, {
      pageNo,
      pageSize,
    });
    allRawPages.push(raw);

    const stations = extractStations(raw);
    allStations.push(...stations);

    if (stations.length < pageSize) break;
    pageNo += 1;
  }

  return {
    stations: allStations,
    raw: allRawPages.length === 1 ? allRawPages[0] : allRawPages,
  };
}

// ---------------------------------------------------------------------------
// API: Station Detail
// ---------------------------------------------------------------------------

export async function getStationDetail(
  context: SolisApiContext,
  stationId: string
): Promise<unknown> {
  return postSolisJson("/v1/api/stationDetail", context, { id: stationId });
}

// ---------------------------------------------------------------------------
// API: Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getDailyEnergyHistory(
  context: SolisApiContext,
  stationId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];
  const startParsed = parseIsoDate(startDate);
  const endParsed = parseIsoDate(endDate);
  if (!startParsed || !endParsed) return points;

  // Solis daily energy endpoint works per-month; iterate months in range
  let cursor = new Date(startParsed.year, startParsed.month - 1, 1);
  const endTime = new Date(endParsed.year, endParsed.month - 1, endParsed.day);

  while (cursor <= endTime) {
    const timeStr = formatIsoDate(cursor);
    try {
      const raw = await postSolisJson("/v1/api/stationDayEnergyList", context, {
        id: stationId,
        money: "USD",
        time: timeStr,
        timezone: 0,
      });

      const root = asRecord(raw);
      const records = asRecordArray(root.records ?? root.data ?? root);
      for (const record of records) {
        const dateKey = asDateKey(
          toNullableString(record.date) ??
            toNullableString(record.dataTimestamp) ??
            toNullableString(record.time)
        );
        const kwh = toNullableNumber(record.energy ?? record.dayEnergy ?? record.value);
        if (dateKey && kwh !== null && dateKey >= startDate && dateKey <= endDate) {
          points.push({ dateKey, kwh: safeRound(kwh)! });
        }
      }
    } catch {
      // Skip months that fail
    }

    // Advance to next month
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return points;
}

// ---------------------------------------------------------------------------
// API: Monthly energy history
// ---------------------------------------------------------------------------

type MonthlyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getMonthlyEnergyHistory(
  context: SolisApiContext,
  stationId: string,
  startDate: string,
  endDate: string
): Promise<MonthlyEnergyPoint[]> {
  const points: MonthlyEnergyPoint[] = [];
  const startParsed = parseIsoDate(startDate);
  const endParsed = parseIsoDate(endDate);
  if (!startParsed || !endParsed) return points;

  // Solis monthly energy endpoint works per-year; iterate years in range
  for (let year = startParsed.year; year <= endParsed.year; year++) {
    const timeStr = `${year}-01-01`;
    try {
      const raw = await postSolisJson("/v1/api/stationMonthEnergyList", context, {
        id: stationId,
        money: "USD",
        time: timeStr,
      });

      const root = asRecord(raw);
      const records = asRecordArray(root.records ?? root.data ?? root);
      for (const record of records) {
        const dateKey = asDateKey(
          toNullableString(record.date) ??
            toNullableString(record.month) ??
            toNullableString(record.time)
        );
        const kwh = toNullableNumber(record.energy ?? record.monthEnergy ?? record.value);
        if (dateKey && kwh !== null) {
          points.push({ dateKey, kwh: safeRound(kwh)! });
        }
      }
    } catch {
      // Skip years that fail
    }
  }

  return points;
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getStationProductionSnapshot(
  context: SolisApiContext,
  stationIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<SolisProductionSnapshot> {
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
    const [detailPayload, dailySeries, monthlySeries] = await Promise.all([
      getStationDetail(context, stationId),
      getDailyEnergyHistory(context, stationId, previousCalendarMonthStartDate, anchorDate),
      getMonthlyEnergyHistory(context, stationId, last12MonthsStartDate, anchorDate),
    ]);

    const detail = asRecord(detailPayload);
    const lifetimeKwh = safeRound(toNullableNumber(detail.allEnergy ?? detail.allEnergyStr ?? detail.totalEnergy));

    const hourlyProductionKwh: number | null = null;

    const dailyProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey === anchorDate)
        .map((point) => point.kwh)
    );

    const weeklyProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= weeklyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const monthlyProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= monthlyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const mtdProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= mtdStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const previousCalendarMonthProductionKwh = sumKwh(
      dailySeries
        .filter(
          (point) =>
            point.dateKey >= previousCalendarMonthStartDate &&
            point.dateKey <= previousCalendarMonthEndDate
        )
        .map((point) => point.kwh)
    );

    const last12MonthsProductionKwh = sumKwh(
      monthlySeries.map((point) => point.kwh)
    );

    return {
      stationId,
      name: name ?? toNullableString(detail.sno ?? detail.stationName ?? detail.name),
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
