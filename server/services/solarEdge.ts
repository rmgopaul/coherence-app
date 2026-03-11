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
  query?: Record<string, string | number | null | undefined>
): string {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  url.searchParams.set("api_key", context.apiKey);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  return url.toString();
}

async function getSolarEdgeJson(
  path: string,
  context: SolarEdgeApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const url = buildApiUrl(path, context, query);
  const response = await fetch(url);

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `SolarEdge request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
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
