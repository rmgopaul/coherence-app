export const HOYMILES_DEFAULT_BASE_URL = "https://neapi.hoymiles.com";

export type HoymilesApiContext = {
  username: string;
  password: string;
  baseUrl?: string | null;
};

export type HoymilesStation = {
  stationId: string;
  name: string;
  capacity: number | null;
  address: string | null;
  status: string | null;
};

export type HoymilesProductionSnapshot = {
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
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
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
// HTTP layer — token-based auth with in-memory caching
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return HOYMILES_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

type HoymilesTokenState = {
  token: string;
  expiresAt: number;
};

const hoymilesTokenCache = new Map<string, HoymilesTokenState>();

function getTokenCacheKey(context: HoymilesApiContext): string {
  return `${context.username.trim()}::${normalizeBaseUrl(context.baseUrl)}`;
}

function extractHoymilesToken(json: Record<string, unknown>): string | null {
  const data = asRecord(json.data ?? json);
  return toNullableString(data.token ?? data.access_token ?? json.token);
}

function hoymilesLoginError(json: Record<string, unknown>, fallbackMsg: string): Error {
  const status = toNullableNumber(json.status ?? json.code);
  const msg = toNullableString(json.message ?? json.msg);
  return new Error(
    `Hoymiles login failed${status ? ` (code ${status})` : ""}${msg ? `: ${msg}` : `: ${fallbackMsg}`}`
  );
}

/**
 * Authenticate with the Hoymiles S-Miles Cloud API.
 *
 * The API updated its auth flow. We try in order:
 * 1) MD5-based login (legacy endpoint /iam/pub/0/auth/login) — widely compatible
 * 2) Original plaintext login (/iam/auth_login) — oldest format
 */
async function getHoymilesToken(context: HoymilesApiContext): Promise<string> {
  const cacheKey = getTokenCacheKey(context);
  const cached = hoymilesTokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  const { createHash } = await import("crypto");
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const username = context.username.trim();
  const password = context.password;
  const passwordMd5 = createHash("md5").update(password).digest("hex");
  const headers = { "Content-Type": "application/json" };

  // Strategy 1: MD5-based login (current Hoymiles API)
  try {
    const response = await fetch(`${baseUrl}/iam/pub/0/auth/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_name: username,
        password: passwordMd5,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const responseText = await response.text();
    console.log(`[Hoymiles] MD5 login response (${response.status}): ${responseText.slice(0, 300)}`);

    if (response.ok) {
      const json = asRecord(JSON.parse(responseText));
      const token = extractHoymilesToken(json);
      if (token) {
        console.log(`[Hoymiles] MD5 login succeeded for ${username}, token: ${token.slice(0, 20)}...`);
        hoymilesTokenCache.set(cacheKey, { token, expiresAt: Date.now() + 30 * 60 * 1000 });
        return token;
      }
      console.log(`[Hoymiles] MD5 login response OK but no token found. Keys: ${Object.keys(json).join(", ")}`);
      // Token not in response — fall through to next strategy
    }
  } catch {
    // Network/timeout error — fall through
  }

  // Strategy 2: Legacy plaintext login (oldest format)
  try {
    const response = await fetch(`${baseUrl}/iam/auth_login`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        user_name: username,
        password,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Hoymiles login failed (${response.status})${errorText ? `: ${errorText}` : ""}`);
    }

    const json = asRecord(await response.json());
    const token = extractHoymilesToken(json);
    if (token) {
      hoymilesTokenCache.set(cacheKey, { token, expiresAt: Date.now() + 30 * 60 * 1000 });
      return token;
    }

    throw hoymilesLoginError(json, "no token returned");
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error("Hoymiles login failed: unknown error");
  }
}

async function postHoymilesJson(
  path: string,
  context: HoymilesApiContext,
  body: Record<string, unknown> = {}
): Promise<unknown> {
  const token = await getHoymilesToken(context);
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = `${baseUrl}${safePath}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      hoymilesTokenCache.delete(getTokenCacheKey(context));
      throw new Error(
        `Hoymiles authentication failed (${response.status})${errorText ? `: ${errorText}` : ""}`
      );
    }
    throw new Error(
      `Hoymiles request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  const responseText = await response.text();
  console.log(`[Hoymiles] ${path} response (${responseText.length} chars): ${responseText.slice(0, 500)}`);

  let json: Record<string, unknown>;
  try {
    json = asRecord(JSON.parse(responseText));
  } catch {
    throw new Error(`Hoymiles request to ${path} returned invalid JSON`);
  }

  // Hoymiles wraps responses: { status: "0", message: "...", data: {...} }
  // Status can be "0", 0, "success", or missing — all are OK
  const statusVal = json.status;
  const isErrorStatus = statusVal !== undefined
    && statusVal !== "0" && statusVal !== 0
    && statusVal !== "success" && statusVal !== "ok"
    && statusVal !== true;
  if (isErrorStatus) {
    const msg = toNullableString(json.message ?? json.msg) ?? "Unknown Hoymiles API error";
    console.log(`[Hoymiles] API error status for ${path}: status=${JSON.stringify(statusVal)}, msg=${msg}`);
    throw new Error(`Hoymiles API error (${path}): ${msg}`);
  }

  const result = json.data ?? json;
  console.log(`[Hoymiles] ${path} returning data type: ${typeof result}, keys: ${result && typeof result === "object" ? Object.keys(result as Record<string, unknown>).join(", ") : "N/A"}`);
  return result;
}

// ---------------------------------------------------------------------------
// Extraction: Stations
// ---------------------------------------------------------------------------

export function extractStations(payload: unknown): HoymilesStation[] {
  const root = asRecord(payload);

  // root.page can be a number (e.g. 1) — only treat it as a record if it's actually an object
  const pageValue = root.page;
  const page = (pageValue && typeof pageValue === "object") ? asRecord(pageValue) : null;

  // Try multiple paths to find the station array
  const candidateArray =
    page?.records ??
    root.records ??
    root.list ??
    root.stations ??
    root.data ??
    (page?.list) ??
    (page?.data);

  const rows = asRecordArray(candidateArray);
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  console.log(`[Hoymiles extractStations] root keys: ${Object.keys(root).join(", ")}, page type: ${typeof pageValue}, rows found: ${rows.length}, items: ${items.length}`);

  if (items.length > 0 && items.length <= 3) {
    // Log a sample for debugging
    console.log(`[Hoymiles extractStations] sample row keys: ${Object.keys(items[0]).join(", ")}`);
    console.log(`[Hoymiles extractStations] sample row.id: ${JSON.stringify(items[0].id)} (type: ${typeof items[0].id})`);
  }

  const output: HoymilesStation[] = [];
  let skippedNoId = 0;
  for (const row of items) {
    const rawId = row.id ?? row.station_id ?? row.stationId ?? row.sid;
    const stationId = rawId != null ? String(rawId).trim() : null;
    if (!stationId) {
      skippedNoId += 1;
      continue;
    }

    output.push({
      stationId,
      name: toNullableString(row.station_name ?? row.name ?? row.stationName) ?? `Station ${stationId}`,
      capacity: toNullableNumber(row.capacity ?? row.capacitor ?? row.installed_capacity ?? row.plant_power),
      address: toNullableString(row.address ?? row.location),
      status: toNullableString(row.status ?? row.connect_status),
    });
  }

  if (skippedNoId > 0) {
    console.log(`[Hoymiles extractStations] WARNING: skipped ${skippedNoId} rows with no id`);
  }
  console.log(`[Hoymiles extractStations] → ${output.length} stations extracted`);

  return output;
}

// ---------------------------------------------------------------------------
// API: List Stations
// ---------------------------------------------------------------------------

export async function listStations(context: HoymilesApiContext): Promise<{
  stations: HoymilesStation[];
  raw: unknown;
}> {
  console.log(`[Hoymiles] listStations called for user: ${context.username}`);
  const PAGE_SIZE = 100;
  const MAX_PAGES = 50; // safety limit
  const allStations: HoymilesStation[] = [];
  const allRaw: unknown[] = [];
  let page = 1;
  let lastError: Error | null = null;

  while (page <= MAX_PAGES) {
    try {
      const raw = await postHoymilesJson(
        "/pvm/api/0/station/select_by_page",
        context,
        { page, page_size: PAGE_SIZE }
      );
      allRaw.push(raw);
      const pageStations = extractStations(raw);
      console.log(`[Hoymiles] select_by_page (page ${page}) → ${pageStations.length} stations`);
      allStations.push(...pageStations);

      // Check if there are more pages
      const root = asRecord(raw);
      const total = typeof root.total === "number" ? root.total : null;
      if (total !== null && allStations.length >= total) break;
      if (pageStations.length < PAGE_SIZE) break;
      page += 1;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.log(`[Hoymiles] select_by_page failed on page ${page}: ${lastError.message}`);

      // If first page fails with auth error, clear cache and retry once
      if (page === 1 && allRaw.length === 0) {
        const isAuthError = lastError.message.includes("401") || lastError.message.includes("403") || lastError.message.includes("authentication");
        if (isAuthError) {
          console.log(`[Hoymiles] Auth error on first page, clearing token cache and retrying...`);
          hoymilesTokenCache.delete(getTokenCacheKey(context));
          try {
            const retryRaw = await postHoymilesJson(
              "/pvm/api/0/station/select_by_page",
              context,
              { page: 1, page_size: PAGE_SIZE }
            );
            allRaw.push(retryRaw);
            const retryStations = extractStations(retryRaw);
            console.log(`[Hoymiles] Retry succeeded → ${retryStations.length} stations`);
            allStations.push(...retryStations);
          } catch (retryErr) {
            console.log(`[Hoymiles] Retry also failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
          }
        }
      }
      break; // Stop pagination on error
    }
  }

  // Deduplicate by stationId
  const seen = new Set<string>();
  const deduped = allStations.filter((s) => {
    if (seen.has(s.stationId)) return false;
    seen.add(s.stationId);
    return true;
  });

  console.log(`[Hoymiles] Total: ${deduped.length} unique stations across ${page} page(s)`);

  // Always return raw data for diagnostics, even if 0 stations were extracted
  const rawResult = allRaw.length === 0 ? null : allRaw.length === 1 ? allRaw[0] : allRaw;

  // If we got 0 stations but also had an error AND no raw data, throw
  if (deduped.length === 0 && lastError && allRaw.length === 0) {
    throw lastError;
  }

  return { stations: deduped, raw: rawResult };
}

// ---------------------------------------------------------------------------
// API: Station Detail
// ---------------------------------------------------------------------------

export async function getStationDetail(
  context: HoymilesApiContext,
  stationId: string
): Promise<unknown> {
  // Try /pvm/api/0/station/find first (confirmed working in HA integrations).
  // Send id as both string and number to maximize compatibility.
  try {
    return await postHoymilesJson("/pvm/api/0/station/find", context, {
      id: Number(stationId) || stationId,
    });
  } catch {
    // Fallback: fetch real-time data which also includes lifetime totals.
    return postHoymilesJson("/pvm-data/api/0/station/data/count_station_real_data", context, {
      sid: Number(stationId) || stationId,
    });
  }
}

// ---------------------------------------------------------------------------
// Daily energy history
// ---------------------------------------------------------------------------

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

async function getDailyEnergyHistory(
  context: HoymilesApiContext,
  stationId: string,
  startDate: string,
  endDate: string
): Promise<DailyEnergyPoint[]> {
  const points: DailyEnergyPoint[] = [];

  try {
    // Try multiple known endpoint patterns for daily energy history.
    let raw: unknown = null;
    const historyBody = {
      sid: Number(stationId) || stationId,
      start_date: startDate,
      end_date: endDate,
      type: 1, // daily
    };
    const historyEndpoints = [
      "/pvm/api/0/station/find_history_data_of_station",
      "/pvm-data/api/0/station/data/count_station_real_data",
    ];
    for (const endpoint of historyEndpoints) {
      try {
        raw = await postHoymilesJson(endpoint, context, historyBody);
        break;
      } catch {
        continue;
      }
    }
    if (!raw) return points;

    const root = asRecord(raw);
    const records = asRecordArray(
      root.data ?? root.list ?? root.records ?? root.values
    );

    for (const record of records) {
      const dateKey = asDateKey(
        toNullableString(record.date) ??
          toNullableString(record.time) ??
          toNullableString(record.data_time)
      );
      const rawValue = toNullableNumber(
        record.energy ?? record.eq_total ?? record.production ?? record.value
      );
      const kwh = toKwh(rawValue, "Wh");
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
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getStationProductionSnapshot(
  context: HoymilesApiContext,
  stationIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<HoymilesProductionSnapshot> {
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
    const [detailPayload, dailySeries, last12MonthsSeries] = await Promise.all([
      getStationDetail(context, stationId),
      getDailyEnergyHistory(context, stationId, previousCalendarMonthStartDate, anchorDate),
      getDailyEnergyHistory(context, stationId, last12MonthsStartDate, anchorDate),
    ]);

    const detail = asRecord(detailPayload);
    // Try multiple field names for lifetime energy — response shape varies by endpoint.
    const lifetimeRaw = toNullableNumber(
      detail.total_eq ?? detail.lifetime_energy ?? detail.all_energy ?? detail.eq_total ??
      detail.capacitor ?? detail.co2_emission_reduction ?? null
    );
    // Also check for kWh-native fields (some responses give kWh directly).
    const lifetimeKwhDirect = toNullableNumber(
      detail.total_eq_kwh ?? detail.lifetime_kwh ?? detail.all_energy_kwh ?? null
    );
    const lifetimeKwh = lifetimeKwhDirect !== null
      ? safeRound(lifetimeKwhDirect)
      : safeRound(toKwh(lifetimeRaw, "Wh"));

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
      stationId,
      name: name ?? toNullableString(detail.station_name ?? detail.name),
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
      stationId,
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
