import {
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
  monthlyProductionKwh: number | null;
  last12MonthsProductionKwh: number | null;
  dailyProductionKwh: number | null;
  anchorDate: string;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Internal helpers (not in shared module — Hoymiles-specific coercion)
// ---------------------------------------------------------------------------

function toNullableString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

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
// HTTP layer — token-based auth with in-memory caching
// ---------------------------------------------------------------------------

type HoymilesTokenState = {
  token: string;
  expiresAt: number;
};

const hoymilesTokenCache = new Map<string, HoymilesTokenState>();
const HOYMILES_DEBUG = process.env.HOYMILES_DEBUG === "1";

function debugHoymiles(message: string, meta?: Record<string, unknown>): void {
  if (!HOYMILES_DEBUG) return;
  if (meta) {
    console.debug(`[Hoymiles] ${message}`, meta);
    return;
  }
  console.debug(`[Hoymiles] ${message}`);
}

function getTokenCacheKey(context: HoymilesApiContext): string {
  return `${context.username.trim()}::${normalizeBaseUrl(context.baseUrl, HOYMILES_DEFAULT_BASE_URL)}`;
}

function extractHoymilesToken(json: Record<string, unknown>): string | null {
  const data = asRecord(json.data ?? json);
  return toNullableString(data.token ?? data.access_token ?? json.token);
}

function hoymilesLoginError(
  json: Record<string, unknown>,
  fallbackMsg: string
): Error {
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
  const baseUrl = normalizeBaseUrl(context.baseUrl, HOYMILES_DEFAULT_BASE_URL);
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
    debugHoymiles("MD5 login response received", {
      status: response.status,
      responseLength: responseText.length,
    });

    if (response.ok) {
      const json = asRecord(JSON.parse(responseText));
      const token = extractHoymilesToken(json);
      if (token) {
        debugHoymiles("MD5 login succeeded");
        hoymilesTokenCache.set(cacheKey, {
          token,
          expiresAt: Date.now() + 30 * 60 * 1000,
        });
        return token;
      }
      debugHoymiles("MD5 login response OK but no token found", {
        keys: Object.keys(json),
      });
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
      throw new Error(
        `Hoymiles login failed (${response.status})${errorText ? `: ${errorText}` : ""}`
      );
    }

    const json = asRecord(await response.json());
    const token = extractHoymilesToken(json);
    if (token) {
      hoymilesTokenCache.set(cacheKey, {
        token,
        expiresAt: Date.now() + 30 * 60 * 1000,
      });
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
  const baseUrl = normalizeBaseUrl(context.baseUrl, HOYMILES_DEFAULT_BASE_URL);
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
  debugHoymiles("API response received", {
    path,
    responseLength: responseText.length,
  });

  let json: Record<string, unknown>;
  try {
    json = asRecord(JSON.parse(responseText));
  } catch {
    throw new Error(`Hoymiles request to ${path} returned invalid JSON`);
  }

  // Hoymiles wraps responses: { status: "0", message: "...", data: {...} }
  // Status can be "0", 0, "success", or missing — all are OK
  const statusVal = json.status;
  const isErrorStatus =
    statusVal !== undefined &&
    statusVal !== "0" &&
    statusVal !== 0 &&
    statusVal !== "success" &&
    statusVal !== "ok" &&
    statusVal !== true;
  if (isErrorStatus) {
    const msg =
      toNullableString(json.message ?? json.msg) ??
      "Unknown Hoymiles API error";
    debugHoymiles("API response reported error status", {
      path,
      status: statusVal,
      message: msg,
    });
    throw new Error(`Hoymiles API error (${path}): ${msg}`);
  }

  const result = json.data ?? json;
  debugHoymiles("API response parsed", {
    path,
    resultType: typeof result,
    keys:
      result && typeof result === "object"
        ? Object.keys(result as Record<string, unknown>)
        : [],
  });
  return result;
}

// ---------------------------------------------------------------------------
// Extraction: Stations
// ---------------------------------------------------------------------------

export function extractStations(payload: unknown): HoymilesStation[] {
  const root = asRecord(payload);

  // root.page can be a number (e.g. 1) — only treat it as a record if it's actually an object
  const pageValue = root.page;
  const page =
    pageValue && typeof pageValue === "object" ? asRecord(pageValue) : null;

  // Try multiple paths to find the station array
  const candidateArray =
    page?.records ??
    root.records ??
    root.list ??
    root.stations ??
    root.data ??
    page?.list ??
    page?.data;

  const rows = asRecordArray(candidateArray);
  const items =
    rows.length > 0
      ? rows
      : Array.isArray(payload)
        ? asRecordArray(payload)
        : [];

  debugHoymiles("extractStations candidates", {
    rootKeys: Object.keys(root),
    pageType: typeof pageValue,
    rowsFound: rows.length,
    items: items.length,
  });

  if (items.length > 0 && items.length <= 3) {
    debugHoymiles("extractStations sample row", {
      keys: Object.keys(items[0]),
      idType: typeof items[0].id,
    });
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
      name:
        toNullableString(row.station_name ?? row.name ?? row.stationName) ??
        `Station ${stationId}`,
      capacity: toNullableNumber(
        row.capacity ??
          row.capacitor ??
          row.installed_capacity ??
          row.plant_power
      ),
      address: toNullableString(row.address ?? row.location),
      status: toNullableString(row.status ?? row.connect_status),
    });
  }

  if (skippedNoId > 0) {
    debugHoymiles("extractStations skipped rows with no id", { skippedNoId });
  }
  debugHoymiles("extractStations completed", { stationCount: output.length });

  return output;
}

// ---------------------------------------------------------------------------
// API: List Stations
// ---------------------------------------------------------------------------

export async function listStations(context: HoymilesApiContext): Promise<{
  stations: HoymilesStation[];
  raw: unknown;
}> {
  debugHoymiles("listStations called");
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
      debugHoymiles("select_by_page succeeded", {
        page,
        stationCount: pageStations.length,
      });
      allStations.push(...pageStations);

      // Check if there are more pages
      const root = asRecord(raw);
      const total = typeof root.total === "number" ? root.total : null;
      if (total !== null && allStations.length >= total) break;
      if (pageStations.length < PAGE_SIZE) break;
      page += 1;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      debugHoymiles("select_by_page failed", {
        page,
        error: lastError.message,
      });

      // If first page fails with auth error, clear cache and retry once
      if (page === 1 && allRaw.length === 0) {
        const isAuthError =
          lastError.message.includes("401") ||
          lastError.message.includes("403") ||
          lastError.message.includes("authentication");
        if (isAuthError) {
          debugHoymiles(
            "Auth error on first page; clearing token cache and retrying"
          );
          hoymilesTokenCache.delete(getTokenCacheKey(context));
          try {
            const retryRaw = await postHoymilesJson(
              "/pvm/api/0/station/select_by_page",
              context,
              { page: 1, page_size: PAGE_SIZE }
            );
            allRaw.push(retryRaw);
            const retryStations = extractStations(retryRaw);
            debugHoymiles("Retry succeeded", {
              stationCount: retryStations.length,
            });
            allStations.push(...retryStations);
          } catch (retryErr) {
            debugHoymiles("Retry failed", {
              error:
                retryErr instanceof Error ? retryErr.message : String(retryErr),
            });
          }
        }
      }
      break; // Stop pagination on error
    }
  }

  // Deduplicate by stationId
  const seen = new Set<string>();
  const deduped = allStations.filter(s => {
    if (seen.has(s.stationId)) return false;
    seen.add(s.stationId);
    return true;
  });

  debugHoymiles("listStations completed", {
    stationCount: deduped.length,
    pagesChecked: page,
  });

  // Always return raw data for diagnostics, even if 0 stations were extracted
  const rawResult =
    allRaw.length === 0 ? null : allRaw.length === 1 ? allRaw[0] : allRaw;

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
  return postHoymilesJson("/pvm/api/0/station/find", context, {
    id: Number(stationId) || stationId,
  });
}

export async function getStationRealData(
  context: HoymilesApiContext,
  stationId: string
): Promise<unknown> {
  return postHoymilesJson(
    "/pvm-data/api/0/station/data/count_station_real_data",
    context,
    {
      sid: Number(stationId) || stationId,
    }
  );
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
      if (
        dateKey &&
        kwh !== null &&
        dateKey >= startDate &&
        dateKey <= endDate
      ) {
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

  try {
    // Fetch station metadata (for name) and real-time energy data in parallel.
    // The real-time endpoint returns: today_eq, month_eq, year_eq, total_eq (all in Wh).
    const [detailPayload, realDataPayload] = await Promise.all([
      getStationDetail(context, stationId).catch(() => null),
      getStationRealData(context, stationId),
    ]);

    const detail = asRecord(detailPayload);
    const realData = asRecord(realDataPayload);

    // Energy values from count_station_real_data are in Wh.
    const lifetimeKwh = safeRound(
      toKwh(toNullableNumber(realData.total_eq), "Wh")
    );
    const dailyProductionKwh = safeRound(
      toKwh(toNullableNumber(realData.today_eq), "Wh")
    );
    const monthlyProductionKwh = safeRound(
      toKwh(toNullableNumber(realData.month_eq), "Wh")
    );
    const last12MonthsProductionKwh = safeRound(
      toKwh(toNullableNumber(realData.year_eq), "Wh")
    );

    return {
      stationId,
      name: name ?? toNullableString(detail.station_name ?? detail.name),
      status: "Found",
      found: true,
      lifetimeKwh,
      monthlyProductionKwh,
      last12MonthsProductionKwh,
      dailyProductionKwh,
      anchorDate,
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
      monthlyProductionKwh: null,
      last12MonthsProductionKwh: null,
      dailyProductionKwh: null,
      anchorDate,
      error: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}
