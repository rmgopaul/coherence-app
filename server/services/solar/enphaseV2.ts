import {
  toNullableString,
  toNullableNumber,
  asRecord,
  parseIsoDate,
  toUtcEpochSeconds,
  normalizeBaseUrl,
} from "./helpers";

export const ENPHASE_V2_DEFAULT_BASE_URL = "https://api.enphaseenergy.com/api/v2";

export type EnphaseV2Credentials = {
  apiKey: string;
  userId: string;
  baseUrl?: string | null;
};

export type EnphaseV2System = {
  systemId: string;
  systemName: string;
  status: string | null;
  sizeW: number | null;
  timezone: string | null;
};

const normalize = (raw: string | null | undefined) =>
  normalizeBaseUrl(raw, ENPHASE_V2_DEFAULT_BASE_URL);

function buildUrl(
  path: string,
  credentials: EnphaseV2Credentials,
  query?: Record<string, string | number | null | undefined>
): string {
  const baseUrl = normalize(credentials.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const baseEndsWithSystems = /\/systems$/i.test(baseUrl);
  let normalizedPath = safePath;

  // Allow either base style:
  // - https://api.enphaseenergy.com/api/v2
  // - https://api.enphaseenergy.com/api/v2/systems
  if (baseEndsWithSystems && normalizedPath === "/systems") {
    normalizedPath = "";
  } else if (baseEndsWithSystems && normalizedPath.startsWith("/systems/")) {
    normalizedPath = normalizedPath.slice("/systems".length);
  }

  const url = new URL(`${baseUrl}${normalizedPath}`);

  url.searchParams.set("key", credentials.apiKey);
  url.searchParams.set("user_id", credentials.userId);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  return url.toString();
}

async function getEnphaseV2Json(
  path: string,
  credentials: EnphaseV2Credentials,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const url = buildUrl(path, credentials, query);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Enphase v2 request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
}

export function extractSystems(payload: unknown): EnphaseV2System[] {
  const record = asRecord(payload);
  const rows = Array.isArray(record.systems)
    ? record.systems
    : Array.isArray(payload)
      ? payload
      : [];

  const systems: EnphaseV2System[] = [];
  for (const row of rows) {
    const value = asRecord(row);
    const idRaw = value.system_id ?? value.systemId ?? value.id;
    const nameRaw = value.system_name ?? value.systemName ?? value.name;
    const id = toNullableString(idRaw);
    if (!id) continue;

    systems.push({
      systemId: id,
      systemName: toNullableString(nameRaw) ?? `System ${id}`,
      status: toNullableString(value.status),
      sizeW: toNullableNumber(value.size_w ?? value.sizeW),
      timezone: toNullableString(value.timezone),
    });
  }

  return systems;
}

export async function listSystems(credentials: EnphaseV2Credentials): Promise<{
  systems: EnphaseV2System[];
  raw: unknown;
}> {
  const raw = await getEnphaseV2Json("/systems", credentials);
  return {
    systems: extractSystems(raw),
    raw,
  };
}

export async function getSystemSummary(
  credentials: EnphaseV2Credentials,
  systemId: string
): Promise<unknown> {
  return getEnphaseV2Json(`/systems/${encodeURIComponent(systemId)}/summary`, credentials);
}

export async function getSystemEnergyLifetime(
  credentials: EnphaseV2Credentials,
  systemId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getEnphaseV2Json(`/systems/${encodeURIComponent(systemId)}/energy_lifetime`, credentials, {
    start_date: startDate ?? undefined,
    end_date: endDate ?? undefined,
  });
}

export async function getSystemRgmStats(
  credentials: EnphaseV2Credentials,
  systemId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getEnphaseV2Json(`/systems/${encodeURIComponent(systemId)}/rgm_stats`, credentials, {
    start_at: startDate ? toUtcEpochSeconds(startDate, false) : undefined,
    end_at: endDate ? toUtcEpochSeconds(endDate, true) : undefined,
  });
}

export async function getSystemProductionMeterReadings(
  credentials: EnphaseV2Credentials,
  systemId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getEnphaseV2Json(
    `/systems/${encodeURIComponent(systemId)}/production_meter_readings`,
    credentials,
    {
      start_at: startDate ? toUtcEpochSeconds(startDate, false) : undefined,
      end_at: endDate ? toUtcEpochSeconds(endDate, true) : undefined,
    }
  );
}
