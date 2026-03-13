export const TESLA_POWERHUB_DEFAULT_TOKEN_URL = "https://gridlogic-api.sn.tesla.services/v1/auth/token";
export const TESLA_POWERHUB_DEFAULT_API_BASE_URL = "https://gridlogic-api.sn.tesla.services/v2";
export const TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL = "https://powerhub.energy.tesla.com";

export type TeslaPowerhubApiContext = {
  clientId: string;
  clientSecret: string;
  tokenUrl?: string | null;
  apiBaseUrl?: string | null;
  portalBaseUrl?: string | null;
};

export type TeslaPowerhubUser = {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
  status: string | null;
};

export type TeslaPowerhubSiteProductionMetrics = {
  siteId: string;
  siteName: string | null;
  dailyKwh: number;
  weeklyKwh: number;
  monthlyKwh: number;
  yearlyKwh: number;
  lifetimeKwh: number;
};

type TeslaPowerhubTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type TeslaPowerhubWindowKey = "daily" | "weekly" | "monthly" | "yearly" | "lifetime";

type TeslaPowerhubWindowConfig = {
  key: TeslaPowerhubWindowKey;
  startDatetime: string;
  endDatetime: string;
};

type SiteDescriptor = {
  siteId: string;
  siteName: string | null;
};

type SiteTotal = {
  siteId: string;
  siteName: string | null;
  totalKwh: number;
};

type TelemetryAttempt = {
  baseUrl: string;
  groupRollup: string | null;
};

export type TeslaPowerhubMetricsProgress = {
  currentStep: number;
  totalSteps: number;
  message: string;
  windowKey?: TeslaPowerhubWindowKey;
};

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toIdString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function normalizeUrlOrFallback(raw: string | null | undefined, fallback: string): string {
  const normalized = (raw ?? "").trim();
  if (!normalized) return fallback;
  return normalized.replace(/\/+$/, "");
}

function buildBasicAuth(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
}

function parseJsonBody(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatPayloadPreview(payload: unknown, raw: string): string {
  if (raw.trim()) {
    return raw.trim().slice(0, 400);
  }
  try {
    return JSON.stringify(payload).slice(0, 400);
  } catch {
    return "";
  }
}

function parseTokenPayload(payload: unknown, rawBody: string): TeslaPowerhubTokenResponse {
  const record = asRecord(payload);
  const dataRecord = asRecord(record.data);
  const accessToken = toNonEmptyString(record.access_token) ?? toNonEmptyString(dataRecord.access_token);
  if (!accessToken) {
    const errorDescription =
      toNonEmptyString(record.error_description) ??
      toNonEmptyString(dataRecord.error_description) ??
      toNonEmptyString(asRecord(record.error).error_description) ??
      toNonEmptyString(asRecord(record.error).message);
    const requestId =
      toNonEmptyString(record.request_id) ??
      toNonEmptyString(asRecord(record.meta).request_id) ??
      toNonEmptyString(dataRecord.request_id) ??
      toNonEmptyString(asRecord(record.error).request_id);
    const preview = formatPayloadPreview(payload, rawBody);
    throw new Error(
      `Tesla Powerhub token response missing access_token.${
        errorDescription ? ` ${errorDescription}` : ""
      }${requestId ? ` request_id=${requestId}` : ""}${preview ? ` payload=${preview}` : ""}`
    );
  }
  const tokenType =
    toNonEmptyString(record.token_type) ??
    toNonEmptyString(dataRecord.token_type) ??
    toNonEmptyString(record.tokenType) ??
    toNonEmptyString(dataRecord.tokenType);
  const scopeRaw = record.scope ?? dataRecord.scope;
  const scope =
    toNonEmptyString(scopeRaw) ??
    (Array.isArray(scopeRaw)
      ? scopeRaw.map((value) => toNonEmptyString(value)).filter((value): value is string => Boolean(value)).join(" ")
      : null);

  const expiresInRaw = record.expires_in ?? dataRecord.expires_in;
  const expiresIn =
    typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw) ? expiresInRaw : undefined;

  return {
    access_token: accessToken,
    token_type: tokenType ?? undefined,
    expires_in: expiresIn,
    scope: scope ?? undefined,
  };
}

async function requestClientCredentialsToken(
  context: TeslaPowerhubApiContext
): Promise<TeslaPowerhubTokenResponse> {
  const tokenUrl = normalizeUrlOrFallback(context.tokenUrl, TESLA_POWERHUB_DEFAULT_TOKEN_URL);
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: buildBasicAuth(context.clientId, context.clientSecret),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Tesla Powerhub token request failed (${response.status} ${response.statusText})${text ? `: ${text}` : ""}`
    );
  }

  const rawBody = await response.text().catch(() => "");
  const payload = parseJsonBody(rawBody);
  return parseTokenPayload(payload, rawBody);
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) return value;
    if (value > 1_000_000_000) return value * 1000;
    return null;
  }
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000_000) return numeric;
    if (numeric > 1_000_000_000) return numeric * 1000;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isLikelySiteIdKey(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (/^\d{4,}$/.test(normalized)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{12,}$/i.test(normalized)) return true;
  if (/^[A-Za-z0-9_-]{6,}$/.test(normalized) && /\d/.test(normalized)) return true;
  return false;
}

function extractUsers(payload: unknown): TeslaPowerhubUser[] {
  const root = asRecord(payload);
  const rows = Array.isArray(root.users)
    ? root.users
    : Array.isArray(root.response)
      ? root.response
      : Array.isArray(payload)
        ? payload
        : [];

  return rows
    .map((row) => {
      const value = asRecord(row);
      const id =
        toNonEmptyString(value.id) ??
        toNonEmptyString(value.user_id) ??
        toNonEmptyString(value.uuid);
      if (!id) return null;
      return {
        id,
        name: toNonEmptyString(value.name) ?? toNonEmptyString(value.full_name) ?? `User ${id}`,
        email: toNonEmptyString(value.email),
        role: toNonEmptyString(value.role),
        status: toNonEmptyString(value.status),
      } satisfies TeslaPowerhubUser;
    })
    .filter((value): value is TeslaPowerhubUser => value !== null);
}

function buildCandidateUrls(
  context: TeslaPowerhubApiContext,
  groupId: string,
  endpointOverride: string | null
): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = toNonEmptyString(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  add(endpointOverride);

  const apiBase = normalizeUrlOrFallback(context.apiBaseUrl, TESLA_POWERHUB_DEFAULT_API_BASE_URL);
  const portalBase = normalizeUrlOrFallback(context.portalBaseUrl, TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL);
  const encodedGroupId = encodeURIComponent(groupId);

  add(`${apiBase}/group/${encodedGroupId}/users`);
  add(`${apiBase}/groups/${encodedGroupId}/users`);
  add(`${portalBase}/group/${encodedGroupId}/users`);
  add(`${portalBase}/groups/${encodedGroupId}/users`);

  return candidates;
}

function buildAssetGroupCandidateUrls(
  context: TeslaPowerhubApiContext,
  groupId: string,
  endpointOverride: string | null
): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = toNonEmptyString(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  add(endpointOverride);

  const apiBase = normalizeUrlOrFallback(context.apiBaseUrl, TESLA_POWERHUB_DEFAULT_API_BASE_URL);
  const portalBase = normalizeUrlOrFallback(context.portalBaseUrl, TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL);
  const encodedGroupId = encodeURIComponent(groupId);

  add(`${apiBase}/asset/groups/${encodedGroupId}`);
  add(`${apiBase}/asset/group/${encodedGroupId}`);
  add(`${apiBase}/groups/${encodedGroupId}`);
  add(`${apiBase}/group/${encodedGroupId}`);
  add(`${portalBase}/group/${encodedGroupId}`);

  return candidates;
}

function buildTelemetryCandidateUrls(
  context: TeslaPowerhubApiContext,
  endpointOverride: string | null
): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = toNonEmptyString(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  const apiBase = normalizeUrlOrFallback(context.apiBaseUrl, TESLA_POWERHUB_DEFAULT_API_BASE_URL);
  const override = toNonEmptyString(endpointOverride);
  if (override && override.includes("/telemetry/")) {
    add(override);
  }

  // Aggregate endpoint first — it's designed for group-level queries.
  add(`${apiBase}/telemetry/history/operational/aggregate`);
  add(`${apiBase}/telemetry/history`);

  return candidates;
}

function buildTelemetryAttempts(
  candidateUrls: string[],
  preferredAttempt?: TelemetryAttempt | null
): TelemetryAttempt[] {
  const attempts: TelemetryAttempt[] = [];
  const seen = new Set<string>();

  const addAttempt = (attempt: TelemetryAttempt) => {
    const key = `${attempt.baseUrl}||${attempt.groupRollup ?? "__none__"}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push(attempt);
  };

  if (preferredAttempt && candidateUrls.includes(preferredAttempt.baseUrl)) {
    addAttempt(preferredAttempt);
  }

  // Prefer the aggregate endpoint (designed for group-level queries) without
  // group_rollup — aggregation is implicit in the endpoint itself.  Fall back
  // to the plain history endpoint (site-level) with common group_rollup values
  // in case the caller is targeting a site or the aggregate endpoint is unavailable.
  const aggregateUrls: string[] = [];
  const historyUrls: string[] = [];
  candidateUrls.forEach((baseUrl) => {
    if (/\/telemetry\/history\/operational\/aggregate\/?$/i.test(baseUrl)) {
      aggregateUrls.push(baseUrl);
    } else {
      historyUrls.push(baseUrl);
    }
  });

  // 1. Aggregate endpoint — no group_rollup parameter (it's inherent).
  aggregateUrls.forEach((baseUrl) => {
    addAttempt({ baseUrl, groupRollup: null });
  });

  // 2. Plain history endpoint — try without, then with common rollup values.
  historyUrls.forEach((baseUrl) => {
    [null, "sum", "mean"].forEach((groupRollup) => {
      addAttempt({ baseUrl, groupRollup });
    });
  });

  return attempts;
}

async function fetchJsonWithBearerToken(
  url: string,
  accessToken: string,
  options?: {
    timeoutMs?: number;
  }
): Promise<unknown> {
  const timeoutMs = typeof options?.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : null;
  const controller = timeoutMs ? new AbortController() : null;
  const timeoutHandle =
    timeoutMs && controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: controller?.signal,
    });
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError" && timeoutMs) {
      throw new Error(`(Request timed out after ${timeoutMs} ms)`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`(${response.status} ${response.statusText})${text ? `: ${text}` : ""}`);
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    throw new Error(`(Unexpected content type: ${contentType || "unknown"})${text ? `: ${text.slice(0, 200)}` : ""}`);
  }

  return response.json();
}

function detectSiteId(
  record: Record<string, unknown>,
  groupId: string,
  inheritedSiteId: string | null
): string | null {
  const directSiteId =
    toIdString(record.site_id) ??
    toIdString(record.siteId) ??
    toIdString(record.site_uuid) ??
    toIdString(record.siteUuid) ??
    toIdString(record.energy_site_id);
  if (directSiteId) return directSiteId;

  const targetType = `${toNonEmptyString(record.target_type) ?? ""} ${toNonEmptyString(record.targetType) ?? ""} ${
    toNonEmptyString(record.type) ?? ""
  } ${toNonEmptyString(record.asset_type) ?? ""}`.toLowerCase();
  const targetId = toIdString(record.target_id) ?? toIdString(record.targetId);
  if (targetId && targetId !== groupId && /site/.test(targetType)) return targetId;

  const fallbackId = toIdString(record.id) ?? toIdString(record.uuid);
  const hasSiteField =
    "site_name" in record ||
    "siteName" in record ||
    "energy_site_id" in record ||
    "site_id" in record ||
    "siteId" in record;
  if (fallbackId && fallbackId !== groupId && (hasSiteField || /site/.test(targetType))) {
    return fallbackId;
  }

  return inheritedSiteId;
}

function detectSiteName(record: Record<string, unknown>, inheritedSiteName: string | null): string | null {
  return (
    toNonEmptyString(record.site_name) ??
    toNonEmptyString(record.siteName) ??
    toNonEmptyString(record.name) ??
    toNonEmptyString(record.display_name) ??
    toNonEmptyString(record.target_name) ??
    inheritedSiteName
  );
}

function collectSitesFromUnknown(payload: unknown, groupId: string): SiteDescriptor[] {
  const siteMap = new Map<string, SiteDescriptor>();

  const walk = (value: unknown, inheritedSiteId: string | null, inheritedSiteName: string | null): void => {
    if (Array.isArray(value)) {
      for (const row of value) {
        walk(row, inheritedSiteId, inheritedSiteName);
      }
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = asRecord(value);
    const siteId = detectSiteId(record, groupId, inheritedSiteId);
    const siteName = detectSiteName(record, inheritedSiteName);
    if (siteId && siteId !== groupId && !siteMap.has(siteId)) {
      siteMap.set(siteId, {
        siteId,
        siteName: siteName ?? null,
      });
    } else if (siteId && siteMap.has(siteId) && siteName) {
      const existing = siteMap.get(siteId);
      if (existing && !existing.siteName) {
        siteMap.set(siteId, { ...existing, siteName });
      }
    }

    for (const child of Object.values(record)) {
      walk(child, siteId ?? inheritedSiteId, siteName ?? inheritedSiteName);
    }
  };

  walk(payload, null, null);
  return Array.from(siteMap.values());
}

function roundToFourDecimals(value: number): number {
  return Number(value.toFixed(4));
}

function sumSiteTotalsByTelemetryPayload(
  payload: unknown,
  groupId: string,
  signal: string
): Map<string, SiteTotal> {
  const totals = new Map<string, SiteTotal>();
  const dedupe = new Set<string>();
  const signalKey = signal.trim();

  const addValue = (
    siteId: string | null,
    siteName: string | null,
    value: unknown,
    timestamp: unknown,
    path: string
  ): void => {
    if (!siteId || siteId === groupId) return;
    const numeric = toFiniteNumber(value);
    if (numeric === null) return;
    const timestampMs = parseTimestampMs(timestamp);
    const dedupeKey = `${siteId}|${timestampMs ?? "na"}|${numeric}|${path}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);

    const existing = totals.get(siteId);
    if (!existing) {
      totals.set(siteId, {
        siteId,
        siteName: siteName ?? null,
        totalKwh: numeric,
      });
      return;
    }

    totals.set(siteId, {
      siteId,
      siteName: existing.siteName ?? siteName ?? null,
      totalKwh: existing.totalKwh + numeric,
    });
  };

  const parseNumericContainer = (
    value: unknown,
    siteId: string | null,
    siteName: string | null,
    path: string
  ): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const entryPath = `${path}[${index}]`;
        if (Array.isArray(entry)) {
          if (entry.length >= 2) {
            addValue(siteId, siteName, entry[1], entry[0], entryPath);
          }
          return;
        }
        if (entry && typeof entry === "object") {
          const record = asRecord(entry);
          addValue(
            siteId,
            siteName,
            record.value ?? record.kwh ?? record.energy_kwh ?? record.sum ?? record.total,
            record.timestamp ?? record.ts ?? record.datetime ?? record.time,
            entryPath
          );
          parseNumericContainer(record.values, siteId, siteName, `${entryPath}.values`);
          parseNumericContainer(record.data, siteId, siteName, `${entryPath}.data`);
          parseNumericContainer(record.points, siteId, siteName, `${entryPath}.points`);
          parseNumericContainer(record.series, siteId, siteName, `${entryPath}.series`);
          return;
        }
        addValue(siteId, siteName, entry, null, entryPath);
      });
      return;
    }

    if (!value || typeof value !== "object") {
      addValue(siteId, siteName, value, null, path);
      return;
    }

    const record = asRecord(value);
    const entries = Object.entries(record);

    const looksLikeSiteIdMap =
      entries.length > 0 &&
      entries.every(([key, rowValue]) => {
        if (!isLikelySiteIdKey(key)) return false;
        if (!rowValue || typeof rowValue !== "object") return false;
        return true;
      });
    if (looksLikeSiteIdMap) {
      entries.forEach(([key, rowValue]) => {
        parseNumericContainer(rowValue, key, siteName, `${path}.${key}`);
      });
      return;
    }

    const isTimestampMap =
      entries.length > 0 &&
      entries.every(([key, rowValue]) => parseTimestampMs(key) !== null && toFiniteNumber(rowValue) !== null);
    if (isTimestampMap) {
      for (const [key, rowValue] of entries) {
        addValue(siteId, siteName, rowValue, key, `${path}.${key}`);
      }
      return;
    }

    addValue(
      siteId,
      siteName,
      record.value ?? record.kwh ?? record.energy_kwh ?? record.sum ?? record.total,
      record.timestamp ?? record.ts ?? record.datetime ?? record.time,
      path
    );

    parseNumericContainer(record.values, siteId, siteName, `${path}.values`);
    parseNumericContainer(record.data, siteId, siteName, `${path}.data`);
    parseNumericContainer(record.points, siteId, siteName, `${path}.points`);
    parseNumericContainer(record.series, siteId, siteName, `${path}.series`);
  };

  const walk = (value: unknown, inheritedSiteId: string | null, inheritedSiteName: string | null, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((row, index) => walk(row, inheritedSiteId, inheritedSiteName, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = asRecord(value);
    const siteId = detectSiteId(record, groupId, inheritedSiteId);
    const siteName = detectSiteName(record, inheritedSiteName);
    const handledKeys = new Set<string>();

    const signalObject = asRecord(record.signals);
    const signalEntry =
      record[signalKey] ??
      signalObject[signalKey] ??
      signalObject[signalKey.toLowerCase()] ??
      signalObject[signalKey.toUpperCase()];
    if (signalEntry !== undefined) {
      parseNumericContainer(signalEntry, siteId, siteName, `${path}.${signalKey}`);
      if (record[signalKey] !== undefined) handledKeys.add(signalKey);
      if (record.signals !== undefined) handledKeys.add("signals");
    }

    parseNumericContainer(record.values, siteId, siteName, `${path}.values`);
    parseNumericContainer(record.data, siteId, siteName, `${path}.data`);
    parseNumericContainer(record.points, siteId, siteName, `${path}.points`);
    parseNumericContainer(record.series, siteId, siteName, `${path}.series`);
    handledKeys.add("values");
    handledKeys.add("data");
    handledKeys.add("points");
    handledKeys.add("series");

    addValue(
      siteId,
      siteName,
      record.value ?? record.kwh ?? record.energy_kwh ?? record.sum ?? record.total,
      record.timestamp ?? record.ts ?? record.datetime ?? record.time,
      `${path}.value`
    );

    for (const [key, child] of Object.entries(record)) {
      if (handledKeys.has(key)) continue;
      walk(child, siteId, siteName, `${path}.${key}`);
    }
  };

  walk(payload, null, null, "root");

  Array.from(totals.entries()).forEach(([siteId, row]) => {
    totals.set(siteId, {
      ...row,
      totalKwh: roundToFourDecimals(row.totalKwh),
    });
  });

  return totals;
}

function buildWindowConfigs(now: Date): TeslaPowerhubWindowConfig[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const endDatetime = now.toISOString();
  return [
    { key: "daily", startDatetime: new Date(now.getTime() - DAY_MS).toISOString(), endDatetime },
    { key: "weekly", startDatetime: new Date(now.getTime() - 7 * DAY_MS).toISOString(), endDatetime },
    { key: "monthly", startDatetime: new Date(now.getTime() - 30 * DAY_MS).toISOString(), endDatetime },
    { key: "yearly", startDatetime: new Date(now.getTime() - 365 * DAY_MS).toISOString(), endDatetime },
    { key: "lifetime", startDatetime: "2010-01-01T00:00:00.000Z", endDatetime },
  ];
}

function buildTelemetryRequestUrl(baseUrl: string, options: {
  groupId: string;
  signal: string;
  startDatetime: string;
  endDatetime: string;
  groupRollup?: string | null;
}): string {
  const url = new URL(baseUrl);
  url.searchParams.set("target_id", options.groupId);
  url.searchParams.set("signals", options.signal);
  url.searchParams.set("start_datetime", options.startDatetime);
  url.searchParams.set("end_datetime", options.endDatetime);
  const groupRollup = toNonEmptyString(options.groupRollup);
  if (groupRollup) {
    url.searchParams.set("group_rollup", groupRollup);
  }
  url.searchParams.set("period", "1d");
  url.searchParams.set("rollup", "sum");
  url.searchParams.set("fill", "none");
  return url.toString();
}

function createPreview(value: unknown, depth = 0): unknown {
  if (depth >= 3) return "[truncated]";
  if (Array.isArray(value)) {
    const limited = value.slice(0, 5).map((entry) => createPreview(entry, depth + 1));
    if (value.length > 5) {
      limited.push(`... ${value.length - 5} more item(s)`);
    }
    return limited;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(asRecord(value));
  const preview: Record<string, unknown> = {};
  for (let index = 0; index < entries.length; index += 1) {
    const [key, rowValue] = entries[index];
    if (index >= 20) {
      preview.__truncatedKeys = entries.length - 20;
      break;
    }
    preview[key] = createPreview(rowValue, depth + 1);
  }
  return preview;
}

async function fetchGroupSites(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  options: {
    groupId: string;
    endpointUrl?: string | null;
  }
): Promise<{
  sites: SiteDescriptor[];
  resolvedEndpointUrl: string | null;
  rawPreview: unknown;
}> {
  const groupId = options.groupId.trim();
  const candidateUrls = buildAssetGroupCandidateUrls(context, groupId, toNonEmptyString(options.endpointUrl));
  let lastError: string | null = null;

  for (const url of candidateUrls) {
    try {
      const raw = await fetchJsonWithBearerToken(url, accessToken);
      const sites = collectSitesFromUnknown(raw, groupId);
      if (sites.length > 0) {
        return {
          sites,
          resolvedEndpointUrl: url,
          rawPreview: createPreview(raw),
        };
      }
      lastError = "Endpoint returned no recognizable site rows.";
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown request error.";
    }
  }

  return {
    sites: [],
    resolvedEndpointUrl: null,
    rawPreview: lastError ? { error: lastError } : null,
  };
}

async function fetchTelemetryWindowTotals(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  options: {
    groupId: string;
    signal: string;
    startDatetime: string;
    endDatetime: string;
    endpointUrl?: string | null;
    preferredAttempt?: TelemetryAttempt | null;
    allowEmptyTotals?: boolean;
  }
): Promise<{
  totals: Map<string, SiteTotal>;
  resolvedEndpointUrl: string;
  rawPreview: unknown;
  attemptUsed: TelemetryAttempt;
}> {
  const candidateUrls = buildTelemetryCandidateUrls(context, toNonEmptyString(options.endpointUrl));
  const attempts = buildTelemetryAttempts(candidateUrls, options.preferredAttempt);
  let lastError: string | null = null;

  for (const attempt of attempts) {
    const requestUrl = buildTelemetryRequestUrl(attempt.baseUrl, {
      groupId: options.groupId,
      signal: options.signal,
      startDatetime: options.startDatetime,
      endDatetime: options.endDatetime,
      groupRollup: attempt.groupRollup,
    });
    try {
      const raw = await fetchJsonWithBearerToken(requestUrl, accessToken, {
        timeoutMs: 120_000,
      });
      const totals = sumSiteTotalsByTelemetryPayload(raw, options.groupId, options.signal);
      if (totals.size > 0 || options.allowEmptyTotals) {
        return {
          totals,
          resolvedEndpointUrl: requestUrl,
          rawPreview: createPreview(raw),
          attemptUsed: attempt,
        };
      }
      lastError = `No site telemetry values parsed from ${requestUrl}.`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown request error.";
    }
  }

  throw new Error(
    `Tesla Powerhub telemetry request failed for all endpoint candidates.${lastError ? ` Last error ${lastError}` : ""}`
  );
}

export async function getTeslaPowerhubGroupUsers(
  context: TeslaPowerhubApiContext,
  options: {
    groupId: string;
    endpointUrl?: string | null;
  }
): Promise<{
  users: TeslaPowerhubUser[];
  requestedGroupId: string;
  resolvedEndpointUrl: string;
  token: {
    tokenType: string;
    expiresIn: number | null;
    scope: string | null;
  };
  raw: unknown;
}> {
  const groupId = options.groupId.trim();
  if (!groupId) {
    throw new Error("groupId is required.");
  }

  const token = await requestClientCredentialsToken(context);
  const candidateUrls = buildCandidateUrls(context, groupId, toNonEmptyString(options.endpointUrl));
  if (candidateUrls.length === 0) {
    throw new Error("No endpoint URL candidates are available.");
  }

  let lastError: string | null = null;
  for (const url of candidateUrls) {
    try {
      const raw = await fetchJsonWithBearerToken(url, token.access_token);
      return {
        users: extractUsers(raw),
        requestedGroupId: groupId,
        resolvedEndpointUrl: url,
        token: {
          tokenType: token.token_type ?? "Bearer",
          expiresIn: typeof token.expires_in === "number" ? token.expires_in : null,
          scope: token.scope ?? null,
        },
        raw,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown request error.";
    }
  }

  throw new Error(`Tesla Powerhub users request failed for all endpoint candidates.${lastError ? ` Last error ${lastError}` : ""}`);
}

export async function getTeslaPowerhubGroupProductionMetrics(
  context: TeslaPowerhubApiContext,
  options: {
    groupId: string;
    endpointUrl?: string | null;
    signal?: string | null;
    onProgress?: (progress: TeslaPowerhubMetricsProgress) => void;
  }
): Promise<{
  sites: TeslaPowerhubSiteProductionMetrics[];
  requestedGroupId: string;
  signal: string;
  resolvedSitesEndpointUrl: string | null;
  resolvedTelemetryEndpoints: Record<TeslaPowerhubWindowKey, string | null>;
  token: {
    tokenType: string;
    expiresIn: number | null;
    scope: string | null;
  };
  debug: {
    siteSourcePreview: unknown;
    telemetryPreviewByWindow: Record<TeslaPowerhubWindowKey, unknown>;
    telemetryErrorsByWindow: Record<TeslaPowerhubWindowKey, string | null>;
    windows: Record<TeslaPowerhubWindowKey, { startDatetime: string; endDatetime: string }>;
  };
}> {
  const totalSteps = 7;
  const emitProgress = (progress: TeslaPowerhubMetricsProgress): void => {
    try {
      options.onProgress?.(progress);
    } catch {
      // Progress callbacks should never break primary request flow.
    }
  };

  const groupId = options.groupId.trim();
  if (!groupId) {
    throw new Error("groupId is required.");
  }
  emitProgress({
    currentStep: 0,
    totalSteps,
    message: "Starting Tesla Powerhub production request.",
  });
  const signal = toNonEmptyString(options.signal) ?? "solar_energy_exported";
  emitProgress({
    currentStep: 1,
    totalSteps,
    message: "Requesting Tesla access token.",
  });
  const token = await requestClientCredentialsToken(context);
  emitProgress({
    currentStep: 1,
    totalSteps,
    message: "Access token received.",
  });

  emitProgress({
    currentStep: 2,
    totalSteps,
    message: "Loading group site inventory.",
  });
  const siteResult = await fetchGroupSites(context, token.access_token, {
    groupId,
    endpointUrl: options.endpointUrl,
  });
  emitProgress({
    currentStep: 2,
    totalSteps,
    message: `Group site inventory loaded (${siteResult.sites.length} sites discovered).`,
  });

  const now = new Date();
  const windows = buildWindowConfigs(now);
  const resolvedTelemetryEndpoints: Record<TeslaPowerhubWindowKey, string | null> = {
    daily: null,
    weekly: null,
    monthly: null,
    yearly: null,
    lifetime: null,
  };
  const telemetryPreviewByWindow: Record<TeslaPowerhubWindowKey, unknown> = {
    daily: null,
    weekly: null,
    monthly: null,
    yearly: null,
    lifetime: null,
  };
  const telemetryErrorsByWindow: Record<TeslaPowerhubWindowKey, string | null> = {
    daily: null,
    weekly: null,
    monthly: null,
    yearly: null,
    lifetime: null,
  };
  const totalsByWindow = new Map<TeslaPowerhubWindowKey, Map<string, SiteTotal>>();
  let preferredTelemetryAttempt: TelemetryAttempt | null = null;

  for (const window of windows) {
    const stepByWindow: Record<TeslaPowerhubWindowKey, number> = {
      daily: 3,
      weekly: 4,
      monthly: 5,
      yearly: 6,
      lifetime: 7,
    };
    const step = stepByWindow[window.key];
    emitProgress({
      currentStep: step,
      totalSteps,
      windowKey: window.key,
      message: `Loading ${window.key} telemetry window.`,
    });
    try {
      const telemetryResult = await fetchTelemetryWindowTotals(context, token.access_token, {
        groupId,
        signal,
        startDatetime: window.startDatetime,
        endDatetime: window.endDatetime,
        endpointUrl: options.endpointUrl,
        preferredAttempt: preferredTelemetryAttempt,
        allowEmptyTotals: Boolean(preferredTelemetryAttempt),
      });
      preferredTelemetryAttempt = telemetryResult.attemptUsed;
      resolvedTelemetryEndpoints[window.key] = telemetryResult.resolvedEndpointUrl;
      telemetryPreviewByWindow[window.key] = telemetryResult.rawPreview;
      totalsByWindow.set(window.key, telemetryResult.totals);
      emitProgress({
        currentStep: step,
        totalSteps,
        windowKey: window.key,
        message: `${window.key} telemetry loaded (${telemetryResult.totals.size} sites with values).`,
      });
    } catch (error) {
      telemetryErrorsByWindow[window.key] = error instanceof Error ? error.message : "Unknown error.";
      totalsByWindow.set(window.key, new Map<string, SiteTotal>());
      emitProgress({
        currentStep: step,
        totalSteps,
        windowKey: window.key,
        message: `${window.key} telemetry failed; continuing with remaining windows.`,
      });
    }
  }

  const successfulWindowCount = windows.filter((window) => (totalsByWindow.get(window.key)?.size ?? 0) > 0).length;
  if (successfulWindowCount === 0) {
    throw new Error(
      `Unable to fetch telemetry for group ${groupId}. ${telemetryErrorsByWindow.daily ?? telemetryErrorsByWindow.weekly ?? ""}`.trim()
    );
  }

  const siteMap = new Map<string, SiteDescriptor>();
  for (const site of siteResult.sites) {
    siteMap.set(site.siteId, site);
  }
  Array.from(totalsByWindow.values()).forEach((totals) => {
    Array.from(totals.values()).forEach((total) => {
      if (!siteMap.has(total.siteId)) {
        siteMap.set(total.siteId, {
          siteId: total.siteId,
          siteName: total.siteName ?? null,
        });
      }
    });
  });

  const rows: TeslaPowerhubSiteProductionMetrics[] = Array.from(siteMap.values()).map((site) => {
    const daily = totalsByWindow.get("daily")?.get(site.siteId)?.totalKwh ?? 0;
    const weekly = totalsByWindow.get("weekly")?.get(site.siteId)?.totalKwh ?? 0;
    const monthly = totalsByWindow.get("monthly")?.get(site.siteId)?.totalKwh ?? 0;
    const yearly = totalsByWindow.get("yearly")?.get(site.siteId)?.totalKwh ?? 0;
    const lifetime = totalsByWindow.get("lifetime")?.get(site.siteId)?.totalKwh ?? 0;
    return {
      siteId: site.siteId,
      siteName: site.siteName ?? totalsByWindow.get("lifetime")?.get(site.siteId)?.siteName ?? null,
      dailyKwh: roundToFourDecimals(daily),
      weeklyKwh: roundToFourDecimals(weekly),
      monthlyKwh: roundToFourDecimals(monthly),
      yearlyKwh: roundToFourDecimals(yearly),
      lifetimeKwh: roundToFourDecimals(lifetime),
    };
  });

  rows.sort((a, b) => {
    const nameA = (a.siteName ?? "").toLowerCase();
    const nameB = (b.siteName ?? "").toLowerCase();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    return a.siteId.localeCompare(b.siteId);
  });
  emitProgress({
    currentStep: totalSteps,
    totalSteps,
    message: `Production metrics ready (${rows.length} sites).`,
  });

  return {
    sites: rows,
    requestedGroupId: groupId,
    signal,
    resolvedSitesEndpointUrl: siteResult.resolvedEndpointUrl,
    resolvedTelemetryEndpoints,
    token: {
      tokenType: token.token_type ?? "Bearer",
      expiresIn: typeof token.expires_in === "number" ? token.expires_in : null,
      scope: token.scope ?? null,
    },
    debug: {
      siteSourcePreview: siteResult.rawPreview,
      telemetryPreviewByWindow,
      telemetryErrorsByWindow,
      windows: {
        daily: {
          startDatetime: windows.find((window) => window.key === "daily")?.startDatetime ?? "",
          endDatetime: windows.find((window) => window.key === "daily")?.endDatetime ?? "",
        },
        weekly: {
          startDatetime: windows.find((window) => window.key === "weekly")?.startDatetime ?? "",
          endDatetime: windows.find((window) => window.key === "weekly")?.endDatetime ?? "",
        },
        monthly: {
          startDatetime: windows.find((window) => window.key === "monthly")?.startDatetime ?? "",
          endDatetime: windows.find((window) => window.key === "monthly")?.endDatetime ?? "",
        },
        yearly: {
          startDatetime: windows.find((window) => window.key === "yearly")?.startDatetime ?? "",
          endDatetime: windows.find((window) => window.key === "yearly")?.endDatetime ?? "",
        },
        lifetime: {
          startDatetime: windows.find((window) => window.key === "lifetime")?.startDatetime ?? "",
          endDatetime: windows.find((window) => window.key === "lifetime")?.endDatetime ?? "",
        },
      },
    },
  };
}

export function normalizeTeslaPowerhubUrl(raw: string | null | undefined): string | null {
  const normalized = toNonEmptyString(raw);
  if (!normalized) return null;
  return normalized.replace(/\/+$/, "");
}
