import crypto from "crypto";
import { fetchJson } from "./httpClient";

export const APSYSTEMS_DEFAULT_BASE_URL = "https://api.apsystemsema.com:9282";

export type APsystemsApiContext = {
  appId: string;
  appSecret: string;
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
// HTTP layer — HMAC-SHA256 signature auth
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return APSYSTEMS_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function buildSignatureHeaders(
  context: APsystemsApiContext,
  requestPath: string,
  httpMethod: string
): Record<string, string> {
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString("hex");
  const signatureMethod = "HmacSHA256";

  // APsystems requires only the LAST segment of the path for signature
  const segments = requestPath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? "";

  const stringToSign = [
    timestamp,
    nonce,
    context.appId,
    lastSegment,
    httpMethod,
    signatureMethod,
  ].join("/");

  const hmac = crypto.createHmac("sha256", context.appSecret);
  hmac.update(stringToSign, "utf8");
  const signature = hmac.digest("base64");

  return {
    "X-CA-AppId": context.appId,
    "X-CA-Timestamp": timestamp,
    "X-CA-Nonce": nonce,
    "X-CA-Signature-Method": signatureMethod,
    "X-CA-Signature": signature,
  };
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

  const signatureHeaders = buildSignatureHeaders(context, safePath, "GET");

  const { data } = await fetchJson(url.toString(), {
    service: "APsystems",
    headers: signatureHeaders,
    timeoutMs: 20_000,
  });

  return data;
}

async function postAPsystemsJson(
  path: string,
  context: APsystemsApiContext,
  body?: Record<string, unknown>
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${safePath}`;

  const signatureHeaders = buildSignatureHeaders(context, safePath, "POST");

  const { data } = await fetchJson(url, {
    service: "APsystems",
    method: "POST",
    headers: {
      ...signatureHeaders,
      "Content-Type": "application/json",
    },
    body,
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
// API: List ECUs (paginated POST endpoint)
// ---------------------------------------------------------------------------

export async function listSystems(context: APsystemsApiContext): Promise<{
  systems: APsystemsSystem[];
  raw: unknown;
}> {
  const allEcuIds: string[] = [];
  let page = 1;
  const size = 50; // max page size per API docs
  let totalPages = 1;

  try {
    while (page <= totalPages) {
      const raw = await postAPsystemsJson(
        "/installer/api/v2/systems/ecus",
        context,
        { page, size }
      );

      const root = asRecord(raw);
      const code = toNullableNumber(root.code);
      if (code !== 0) break;

      const data = asRecord(root.data);
      const total = toNullableNumber(data.total) ?? 0;
      const ecuList = Array.isArray(data.data) ? data.data : [];

      for (const id of ecuList) {
        const ecuId = toNullableString(id);
        if (ecuId) allEcuIds.push(ecuId);
      }

      totalPages = Math.ceil(total / size);
      page++;

      // Safety cap to avoid runaway pagination
      if (page > 200) break;
    }
  } catch {
    // Endpoint may not exist for this account type
  }

  // ECU IDs aren't System IDs, but they can be used for ECU-level queries.
  // Convert to system format for the UI.
  const systems: APsystemsSystem[] = allEcuIds.map((ecuId) => ({
    systemId: ecuId,
    name: `ECU ${ecuId}`,
    capacity: null,
    address: null,
    status: null,
  }));

  return {
    systems,
    raw: {
      totalEcus: allEcuIds.length,
      ecuIds: allEcuIds,
      message: allEcuIds.length > 0
        ? `Found ${allEcuIds.length} ECU(s). Note: these are ECU IDs, not System IDs (SIDs).`
        : "No ECUs found. Upload a CSV with System IDs instead.",
    },
  };
}

// ---------------------------------------------------------------------------
// API: System Detail
// ---------------------------------------------------------------------------

export async function getSystemDetail(
  context: APsystemsApiContext,
  systemId: string
): Promise<unknown> {
  return getAPsystemsJson(
    `/installer/api/v2/systems/details/${encodeURIComponent(systemId)}`,
    context
  );
}

// ---------------------------------------------------------------------------
// Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

/**
 * Fetch daily energy for a single month via `/energy/{sid}?energy_level=daily&date_range=YYYY-MM`.
 * The API returns an array of numbers (one per day in the month), values in kWh.
 */
async function getDailyEnergyForMonth(
  context: APsystemsApiContext,
  systemId: string,
  yearMonth: string // "YYYY-MM"
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    const raw = await getAPsystemsJson(
      `/installer/api/v2/systems/energy/${encodeURIComponent(systemId)}`,
      context,
      { energy_level: "daily", date_range: yearMonth }
    );

    const root = asRecord(raw);
    // API returns { data: [0.5, 1.2, ...], code: 0 } — one value per day
    const dataArray = Array.isArray(root.data) ? root.data : [];
    const [yearStr, monthStr] = yearMonth.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);

    for (let i = 0; i < dataArray.length; i++) {
      const kwh = toNullableNumber(dataArray[i]);
      if (kwh === null) continue;
      const day = String(i + 1).padStart(2, "0");
      const dateKey = `${yearStr}-${monthStr}-${day}`;
      // Validate it's a real date
      const d = new Date(year, month - 1, i + 1);
      if (d.getMonth() !== month - 1) continue;
      points.push({ dateKey, kwh: safeRound(kwh)! });
    }
  } catch {
    // Non-critical
  }

  return points;
}

/**
 * Fetch daily energy across a date range by calling the API once per month spanned.
 */
async function getDailyEnergyHistory(
  context: APsystemsApiContext,
  systemId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const startParsed = parseIsoDate(startDate);
  const endParsed = parseIsoDate(endDate);
  if (!startParsed || !endParsed) return [];

  // Collect the set of YYYY-MM months that span the range
  const months: string[] = [];
  let cursor = new Date(startParsed.year, startParsed.month - 1, 1);
  const endMonth = new Date(endParsed.year, endParsed.month - 1, 1);
  while (cursor <= endMonth) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    months.push(`${y}-${m}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  // Fetch each month (with concurrency limit to conserve API calls)
  const allPoints: DailyEnergyPoint[] = [];
  const results = await mapWithConcurrency(months, 3, (ym) =>
    getDailyEnergyForMonth(context, systemId, ym)
  );
  for (const batch of results) {
    for (const p of batch) {
      if (p.dateKey >= startDate && p.dateKey <= endDate) {
        allPoints.push(p);
      }
    }
  }

  return allPoints;
}

// ---------------------------------------------------------------------------
// Lifetime energy
// ---------------------------------------------------------------------------

export type APsystemsSummary = {
  todayKwh: number | null;
  monthKwh: number | null;
  yearKwh: number | null;
  lifetimeKwh: number | null;
};

export async function getSystemSummary(
  context: APsystemsApiContext,
  systemId: string
): Promise<APsystemsSummary> {
  const raw = await getAPsystemsJson(
    `/installer/api/v2/systems/summary/${encodeURIComponent(systemId)}`,
    context
  );

  const root = asRecord(raw);
  const data = asRecord(root.data ?? root);
  return {
    todayKwh: safeRound(toNullableNumber(data.today)),
    monthKwh: safeRound(toNullableNumber(data.month)),
    yearKwh: safeRound(toNullableNumber(data.year)),
    lifetimeKwh: safeRound(toNullableNumber(data.lifetime)),
  };
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
    // Step 1: Validate the SID via the details endpoint (most widely confirmed)
    const details = await getSystemDetail(context, systemId).catch(() => null);

    // Step 2: Try summary (may 404 depending on account tier)
    const summary = await getSystemSummary(context, systemId).catch(
      () => ({ todayKwh: null, monthKwh: null, yearKwh: null, lifetimeKwh: null } as APsystemsSummary)
    );

    // Step 3: Try daily energy history (may 404 depending on account tier)
    const [dailySeries, last12MonthsSeries] = await Promise.all([
      getDailyEnergyHistory(context, systemId, previousCalendarMonthStartDate, anchorDate),
      getDailyEnergyHistory(context, systemId, last12MonthsStartDate, anchorDate),
    ]);

    // Use summary data first; fall back to details if available
    const detailsData = asRecord(asRecord(details).data ?? details ?? {});
    const lifetimeKwh = summary.lifetimeKwh;

    const hourlyProductionKwh: number | null = null;

    // Use summary.todayKwh if available, otherwise compute from daily series
    const dailyProductionKwh = summary.todayKwh ?? sumKwh(
      dailySeries.filter((p) => p.dateKey === anchorDate).map((p) => p.kwh)
    );

    const weeklyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= weeklyStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    // Use summary.monthKwh for MTD if available
    const monthlyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= monthlyStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const mtdProductionKwh = summary.monthKwh ?? sumKwh(
      dailySeries.filter((p) => p.dateKey >= mtdStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const previousCalendarMonthProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= previousCalendarMonthStartDate && p.dateKey <= previousCalendarMonthEndDate)
        .map((p) => p.kwh)
    );

    const last12MonthsProductionKwh = summary.yearKwh ?? sumKwh(
      last12MonthsSeries.map((p) => p.kwh)
    );

    // If nothing worked at all, check if even the details endpoint failed
    if (!details && !summary.lifetimeKwh && dailySeries.length === 0) {
      throw new Error("All APsystems API endpoints returned errors for this System ID. Verify the SID is correct.");
    }

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
