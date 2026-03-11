export const ENPHASE_V4_DEFAULT_BASE_URL = "https://api.enphaseenergy.com/api/v4";
export const ENPHASE_V4_DEFAULT_REDIRECT_URI = "https://api.enphaseenergy.com/oauth/redirect_uri";
const ENPHASE_OAUTH_TOKEN_URL = "https://api.enphaseenergy.com/oauth/token";

export type EnphaseV4TokenExchangeInput = {
  clientId: string;
  clientSecret: string;
  authorizationCode: string;
  redirectUri?: string | null;
};

export type EnphaseV4RefreshInput = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

export type EnphaseV4Tokens = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in: number;
  scope?: string;
};

export type EnphaseV4ApiContext = {
  accessToken: string;
  apiKey: string;
  baseUrl?: string | null;
};

export type EnphaseV4System = {
  systemId: string;
  systemName: string;
  status: string | null;
  sizeW: number | null;
  timezone: string | null;
};

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toIdString(value: unknown): string | null {
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

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return ENPHASE_V4_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function normalizeRedirectUri(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return ENPHASE_V4_DEFAULT_REDIRECT_URI;
  return trimmed;
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

function toUtcEpochSeconds(dateIso: string, endOfDay: boolean): number {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) {
    throw new Error("Dates must be in YYYY-MM-DD format.");
  }

  const utcMillis = endOfDay
    ? Date.UTC(parsed.year, parsed.month - 1, parsed.day, 23, 59, 59, 999)
    : Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0, 0);
  return Math.floor(utcMillis / 1000);
}

function buildBasicAuth(clientId: string, clientSecret: string): string {
  const encoded = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  return `Basic ${encoded}`;
}

async function parseTokenResponse(response: Response): Promise<EnphaseV4Tokens> {
  const payload = await response.json().catch(() => ({}));
  const record = asRecord(payload);
  const accessToken = toNullableString(record.access_token);
  const expiresIn = toNullableNumber(record.expires_in);

  if (!accessToken || expiresIn === null) {
    throw new Error("Enphase OAuth token response is missing access_token or expires_in.");
  }

  return {
    access_token: accessToken,
    refresh_token: toNullableString(record.refresh_token) ?? undefined,
    token_type: toNullableString(record.token_type) ?? undefined,
    expires_in: expiresIn,
    scope: toNullableString(record.scope) ?? undefined,
  };
}

async function requestToken(
  query: Record<string, string>,
  clientId: string,
  clientSecret: string
): Promise<EnphaseV4Tokens> {
  const url = new URL(ENPHASE_OAUTH_TOKEN_URL);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: buildBasicAuth(clientId, clientSecret),
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Enphase OAuth request failed (${response.status} ${response.statusText})${text ? `: ${text}` : ""}`
    );
  }

  return parseTokenResponse(response);
}

export async function exchangeEnphaseV4AuthorizationCode(
  input: EnphaseV4TokenExchangeInput
): Promise<EnphaseV4Tokens> {
  return requestToken(
    {
      grant_type: "authorization_code",
      code: input.authorizationCode.trim(),
      redirect_uri: normalizeRedirectUri(input.redirectUri),
    },
    input.clientId.trim(),
    input.clientSecret.trim()
  );
}

export async function refreshEnphaseV4AccessToken(
  input: EnphaseV4RefreshInput
): Promise<EnphaseV4Tokens> {
  return requestToken(
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken.trim(),
    },
    input.clientId.trim(),
    input.clientSecret.trim()
  );
}

function buildApiUrl(
  path: string,
  context: EnphaseV4ApiContext,
  query?: Record<string, string | number | null | undefined>
): string {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  // Keep API key in query and header for compatibility across endpoint groups.
  url.searchParams.set("key", context.apiKey);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  return url.toString();
}

async function getEnphaseV4Json(
  path: string,
  context: EnphaseV4ApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const url = buildApiUrl(path, context, query);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      key: context.apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Enphase v4 request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
}

export function extractSystems(payload: unknown): EnphaseV4System[] {
  const record = asRecord(payload);
  const dataRecord = asRecord(record.data);
  const rows = Array.isArray(record.systems)
    ? record.systems
    : Array.isArray(record.results)
      ? record.results
      : Array.isArray(dataRecord.systems)
        ? dataRecord.systems
        : Array.isArray(dataRecord.results)
          ? dataRecord.results
          : Array.isArray(payload)
            ? payload
            : [];
  const output: EnphaseV4System[] = [];

  for (const row of rows) {
    const value = asRecord(row);
    const nestedSystem = asRecord(value.system);
    const source = Object.keys(nestedSystem).length > 0 ? nestedSystem : value;

    const id = toIdString(
      source.system_id ??
      source.systemId ??
      source.id ??
      source.site_id ??
      source.siteId
    );
    if (!id) continue;

    output.push({
      systemId: id,
      systemName:
        toNullableString(
          source.system_name ??
          source.systemName ??
          source.site_name ??
          source.siteName ??
          source.name
        ) ?? `System ${id}`,
      status: toNullableString(source.status),
      sizeW: toNullableNumber(source.size_w ?? source.system_size ?? source.sizeW ?? source.size),
      timezone: toNullableString(source.timezone),
    });
  }

  return output;
}

export async function listSystems(context: EnphaseV4ApiContext): Promise<{
  systems: EnphaseV4System[];
  raw: unknown;
}> {
  const raw = await getEnphaseV4Json("/systems", context);
  return {
    systems: extractSystems(raw),
    raw,
  };
}

export async function getSystemSummary(
  context: EnphaseV4ApiContext,
  systemId: string
): Promise<unknown> {
  return getEnphaseV4Json(`/systems/${encodeURIComponent(systemId)}/summary`, context);
}

export async function getSystemEnergyLifetime(
  context: EnphaseV4ApiContext,
  systemId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getEnphaseV4Json(`/systems/${encodeURIComponent(systemId)}/energy_lifetime`, context, {
    start_date: startDate ?? undefined,
    end_date: endDate ?? undefined,
  });
}

export async function getSystemRgmStats(
  context: EnphaseV4ApiContext,
  systemId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getEnphaseV4Json(`/systems/${encodeURIComponent(systemId)}/rgm_stats`, context, {
    start_at: startDate ? toUtcEpochSeconds(startDate, false) : undefined,
    end_at: endDate ? toUtcEpochSeconds(endDate, true) : undefined,
  });
}

export async function getSystemProductionMeterTelemetry(
  context: EnphaseV4ApiContext,
  systemId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getEnphaseV4Json(`/systems/${encodeURIComponent(systemId)}/telemetry/production_meter`, context, {
    start_at: startDate ? toUtcEpochSeconds(startDate, false) : undefined,
    end_at: endDate ? toUtcEpochSeconds(endDate, true) : undefined,
  });
}
