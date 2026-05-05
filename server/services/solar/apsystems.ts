import crypto from "crypto";
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
  firstDayOfMonth,
  firstDayOfPreviousMonth,
  lastDayOfPreviousMonth,
  safeRound,
  sumKwh,
  isNotFoundError,
} from "./helpers";
import { mapWithConcurrency } from "../core/concurrency";

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
  return value / 1000; // Default: assume Wh
}

// ---------------------------------------------------------------------------
// Collection helpers
// ---------------------------------------------------------------------------

function deduplicateById<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// HTTP layer — HMAC-SHA256 signature auth
// ---------------------------------------------------------------------------

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
  const baseUrl = normalizeBaseUrl(context.baseUrl, APSYSTEMS_DEFAULT_BASE_URL);
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
  const baseUrl = normalizeBaseUrl(context.baseUrl, APSYSTEMS_DEFAULT_BASE_URL);
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
// API: Paginated system fetcher (shared by /systems and /partnerSystems)
// ---------------------------------------------------------------------------

async function fetchSystemsFromEndpoint(
  context: APsystemsApiContext,
  endpointPath: string
): Promise<{ systems: APsystemsSystem[]; total: number; error: string | null }> {
  const allSystems: APsystemsSystem[] = [];
  let page = 1;
  let pageSize = 50; // requested size; may be capped by API on first response
  let totalPages = 1;
  let totalCount = 0;
  let lastError: string | null = null;

  while (page <= totalPages) {
    let raw: unknown;
    try {
      raw = await postAPsystemsJson(endpointPath, context, {
        page,
        size: pageSize,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (page === 1) return { systems: [], total: 0, error: lastError };
      break;
    }

    const root = asRecord(raw);
    const code = toNullableNumber(root.code);
    if (code === 1001) {
      return { systems: [], total: 0, error: null };
    }
    if (code !== 0) {
      lastError = `API returned code ${code}`;
      if (page === 1) return { systems: [], total: 0, error: lastError };
      break;
    }

    const data = asRecord(root.data);
    const total = toNullableNumber(data.total) ?? 0;
    totalCount = total;
    const returnedSize = toNullableNumber(data.size);
    const systemsList = asRecordArray(data.systems);

    // On the first page, detect if the API capped our requested page size.
    // Use the API's actual size for ALL subsequent requests so page offsets
    // align with what the server expects. Without this, requesting page=2
    // with size=50 when the API uses size=10 skips items 10–49.
    if (page === 1 && returnedSize && returnedSize < pageSize) {
      pageSize = returnedSize;
    }
    totalPages = Math.ceil(total / (returnedSize || pageSize));

    for (const row of systemsList) {
      const sid = toNullableString(row.sid);
      if (!sid) continue;

      const systemType = toNullableNumber(row.type);

      allSystems.push({
        systemId: sid,
        name: sid,
        capacity: toNullableNumber(row.capacity),
        address: toNullableString(row.timezone),
        status:
          systemType === 2
            ? "Storage"
            : systemType === 3
              ? "PV & Storage"
              : "PV",
      });
    }

    // Stop if page returned no items (even if total says more exist)
    if (systemsList.length === 0) break;

    page++;
    if (page > 200) break;
  }

  return { systems: allSystems, total: totalCount, error: lastError };
}

// ---------------------------------------------------------------------------
// API: List Systems (own + partner — returns real SIDs, deduplicated)
// ---------------------------------------------------------------------------

export async function listSystems(context: APsystemsApiContext): Promise<{
  systems: APsystemsSystem[];
  raw: unknown;
}> {
  // Fetch own systems and partner systems concurrently
  const [own, partner] = await Promise.all([
    fetchSystemsFromEndpoint(context, "/installer/api/v2/systems"),
    fetchSystemsFromEndpoint(context, "/installer/api/v2/partnerSystems"),
  ]);

  // Count unique SIDs per source before cross-dedup
  const uniqueOwnSids = new Set(own.systems.map((s) => s.systemId)).size;
  const uniquePartnerSids = new Set(partner.systems.map((s) => s.systemId)).size;

  // Deduplicate by SID (own systems take priority)
  const deduped = deduplicateById(
    [...own.systems, ...partner.systems],
    (s) => s.systemId
  );

  const parts: string[] = [];
  parts.push(`${uniqueOwnSids} own`);
  if (own.error) parts.push(`own error: ${own.error}`);
  parts.push(`${uniquePartnerSids} unique partner from ${partner.systems.length} entries`);
  if (partner.error) parts.push(`partner error: ${partner.error}`);

  return {
    systems: deduped,
    raw: {
      ownSystems: own.total,
      ownError: own.error,
      partnerSystems: partner.total,
      partnerError: partner.error,
      fetchedOwn: own.systems.length,
      uniqueOwnSids,
      fetchedPartner: partner.systems.length,
      uniquePartnerSids,
      totalDeduped: deduped.length,
      message:
        deduped.length > 0
          ? `Found ${deduped.length} unique SID(s) (${parts.join(", ")}).`
          : `No systems found.${own.error || partner.error ? ` Errors: ${[own.error, partner.error].filter(Boolean).join("; ")}` : ""} Upload a CSV with System IDs instead.`,
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
