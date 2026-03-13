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
  siteExternalId: string | null;
  siteName: string | null;
  dailyKwh: number;
  weeklyKwh: number;
  monthlyKwh: number;
  yearlyKwh: number;
  lifetimeKwh: number;
  dataSource: "rgm" | "inverter" | null;
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
  period: string;
  startDatetime: string;
  endDatetime: string;
};

type SiteDescriptor = {
  siteId: string;
  siteExternalId: string | null;
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

  // History endpoint first — may return per-site breakdowns when used with
  // group_rollup.  Aggregate endpoint as fallback (returns group-level
  // aggregated totals only, NOT per-site data).
  add(`${apiBase}/telemetry/history`);
  add(`${apiBase}/telemetry/history/operational/aggregate`);

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

  // The Tesla API requires `group_rollup` when target_id is a group UUID.
  // History endpoint first (may return per-site breakdowns), aggregate
  // endpoint as fallback (returns group-level totals only).
  const historyUrls: string[] = [];
  const aggregateUrls: string[] = [];
  candidateUrls.forEach((baseUrl) => {
    if (/\/telemetry\/history\/operational\/aggregate\/?$/i.test(baseUrl)) {
      aggregateUrls.push(baseUrl);
    } else {
      historyUrls.push(baseUrl);
    }
  });

  historyUrls.forEach((baseUrl) => {
    addAttempt({ baseUrl, groupRollup: "sum" });
  });

  aggregateUrls.forEach((baseUrl) => {
    addAttempt({ baseUrl, groupRollup: "sum" });
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

function detectSiteExternalId(record: Record<string, unknown>, inheritedExternalId: string | null): string | null {
  // Look for Tesla STE-style identifiers (e.g. STE20250403-01158) and other
  // common external / display ID field names.
  const candidates = [
    record.display_id,
    record.displayId,
    record.external_id,
    record.externalId,
    record.ste_id,
    record.steId,
    record.site_code,
    record.siteCode,
    record.identifier,
    record.reference_id,
    record.referenceId,
    record.project_number,
    record.customer_site_id,
    record.asset_name,
  ];
  for (const candidate of candidates) {
    const value = toNonEmptyString(candidate);
    if (value) return value;
  }

  // Scan all string values for STE pattern as a last resort.
  for (const value of Object.values(record)) {
    const str = toNonEmptyString(value);
    if (str && /^STE\d/i.test(str)) return str;
  }

  return inheritedExternalId;
}

function collectSitesFromUnknown(payload: unknown, groupId: string): SiteDescriptor[] {
  const siteMap = new Map<string, SiteDescriptor>();

  const walk = (
    value: unknown,
    inheritedSiteId: string | null,
    inheritedSiteName: string | null,
    inheritedExternalId: string | null
  ): void => {
    if (Array.isArray(value)) {
      for (const row of value) {
        walk(row, inheritedSiteId, inheritedSiteName, inheritedExternalId);
      }
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = asRecord(value);
    const siteId = detectSiteId(record, groupId, inheritedSiteId);
    const siteName = detectSiteName(record, inheritedSiteName);
    const externalId = detectSiteExternalId(record, inheritedExternalId);
    if (siteId && siteId !== groupId && !siteMap.has(siteId)) {
      siteMap.set(siteId, {
        siteId,
        siteExternalId: externalId,
        siteName: siteName ?? null,
      });
    } else if (siteId && siteMap.has(siteId)) {
      const existing = siteMap.get(siteId);
      if (existing && (!existing.siteName || !existing.siteExternalId)) {
        siteMap.set(siteId, {
          ...existing,
          siteName: existing.siteName ?? siteName ?? null,
          siteExternalId: existing.siteExternalId ?? externalId,
        });
      }
    }

    for (const child of Object.values(record)) {
      walk(child, siteId ?? inheritedSiteId, siteName ?? inheritedSiteName, externalId ?? inheritedExternalId);
    }
  };

  walk(payload, null, null, null);
  return Array.from(siteMap.values());
}

function roundToFourDecimals(value: number): number {
  return Number(value.toFixed(4));
}

function computeSiteDeltasByTelemetryPayload(
  payload: unknown,
  groupId: string,
  signal: string,
  options?: { unattributedSiteId?: string }
): Map<string, SiteTotal> {
  // Tesla energy signals (solar_energy_exported, solar_energy_exported_rgm)
  // are CUMULATIVE meter readings in Wh.  To derive production for a time
  // window we must compute (max_reading − min_reading) rather than summing
  // individual readings.
  const accumulators = new Map<string, {
    siteId: string;
    siteName: string | null;
    minWh: number;
    maxWh: number;
  }>();
  const dedupe = new Set<string>();
  const signalKey = signal.trim();
  const unattributedSiteId = options?.unattributedSiteId ?? null;

  const addValue = (
    siteId: string | null,
    siteName: string | null,
    value: unknown,
    timestamp: unknown,
    path: string
  ): void => {
    const effectiveSiteId =
      siteId && siteId !== groupId ? siteId : unattributedSiteId ?? siteId;
    if (!effectiveSiteId || (effectiveSiteId === groupId && !unattributedSiteId)) return;
    const numeric = toFiniteNumber(value);
    if (numeric === null) return;
    const timestampMs = parseTimestampMs(timestamp);
    const dedupeKey = `${effectiveSiteId}|${timestampMs ?? "na"}|${numeric}|${path}`;
    if (dedupe.has(dedupeKey)) return;
    dedupe.add(dedupeKey);

    const existing = accumulators.get(effectiveSiteId);
    if (!existing) {
      accumulators.set(effectiveSiteId, {
        siteId: effectiveSiteId,
        siteName: siteName ?? null,
        minWh: numeric,
        maxWh: numeric,
      });
      return;
    }

    accumulators.set(effectiveSiteId, {
      siteId: effectiveSiteId,
      siteName: existing.siteName ?? siteName ?? null,
      minWh: Math.min(existing.minWh, numeric),
      maxWh: Math.max(existing.maxWh, numeric),
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
          parseNumericContainer(record.data_points, siteId, siteName, `${entryPath}.data_points`);
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
    parseNumericContainer(record.data_points, siteId, siteName, `${path}.data_points`);
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
    parseNumericContainer(record.data_points, siteId, siteName, `${path}.data_points`);
    handledKeys.add("values");
    // NOTE: "data" is intentionally NOT in handledKeys — the recursive walk
    // must also process `data` entries so detectSiteId can extract `site_id`
    // from each row (Tesla response format: data[].{site_id, data_points}).
    handledKeys.add("points");
    handledKeys.add("series");
    handledKeys.add("data_points");

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

  // Compute delta (max − min) for each site.  Cumulative meter readings
  // only increase, so max is the latest reading and min is the earliest.
  // Convert Wh → kWh.
  const totals = new Map<string, SiteTotal>();
  accumulators.forEach((acc) => {
    const deltaWh = acc.maxWh - acc.minWh;
    totals.set(acc.siteId, {
      siteId: acc.siteId,
      siteName: acc.siteName,
      totalKwh: roundToFourDecimals(deltaWh / 1000),
    });
  });

  return totals;
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Creates a throttle that serialises callers to at most `maxPerSecond`
 * requests per second.  Safe for use with concurrent workers.
 */
function createApiThrottle(maxPerSecond: number): () => Promise<void> {
  const intervalMs = Math.ceil(1000 / maxPerSecond);
  let tail = Promise.resolve();
  return () => {
    const next = tail.then(
      () => new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
    );
    tail = next;
    return next;
  };
}

/**
 * Fetch the STE identifier (site_name field) for each site via the
 * individual /asset/sites/{site_id} endpoint.  Rate-limited to stay
 * within the Tesla API's 5 req/s cap.
 */
async function fetchSiteExternalIds(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  siteIds: string[],
  onProgress?: (fetched: number, total: number) => void
): Promise<Map<string, string>> {
  const apiBase = normalizeUrlOrFallback(context.apiBaseUrl, TESLA_POWERHUB_DEFAULT_API_BASE_URL);
  const externalIds = new Map<string, string>();
  const throttle = createApiThrottle(4); // stay under 5 req/s limit
  let fetched = 0;

  await mapConcurrent(siteIds, 4, async (siteId) => {
    await throttle();
    const url = `${apiBase}/asset/sites/${encodeURIComponent(siteId)}`;
    try {
      const raw = await fetchJsonWithBearerToken(url, accessToken, {
        timeoutMs: 30_000,
      });
      const record = asRecord(raw);
      const dataRecord = asRecord(record.data);

      // The STE identifier (e.g. STE20250403-01158) is stored in the
      // site_name field for many Tesla sites.  Also check nested data
      // and common alternative fields.
      const candidates = [
        record.site_name, record.name, record.display_name,
        record.display_id, record.external_id, record.ste_id,
        record.site_code, record.identifier, record.reference_id,
        record.project_number, record.customer_site_id, record.asset_name,
        dataRecord.site_name, dataRecord.name, dataRecord.display_name,
        dataRecord.display_id, dataRecord.external_id, dataRecord.ste_id,
      ];

      // Priority 1: field with STE pattern (e.g. STE20250403-01158)
      for (const candidate of candidates) {
        const str = toNonEmptyString(candidate);
        if (str && /^STE\d/i.test(str)) { externalIds.set(siteId, str); return; }
      }

      // Priority 2: scan all top-level and data-level string values for STE pattern
      for (const value of [...Object.values(record), ...Object.values(dataRecord)]) {
        const str = toNonEmptyString(value);
        if (str && /^STE\d/i.test(str)) { externalIds.set(siteId, str); return; }
      }

      // Priority 3: use site_name as the external identifier
      const siteName = toNonEmptyString(record.site_name) ?? toNonEmptyString(dataRecord.site_name);
      if (siteName) { externalIds.set(siteId, siteName); return; }
    } catch {
      // Non-critical — STE ID just won't appear for this site.
    } finally {
      fetched++;
      if (onProgress && fetched % 100 === 0) {
        onProgress(fetched, siteIds.length);
      }
    }
  });

  return externalIds;
}

/**
 * Fetch telemetry for a single site using /telemetry/history.
 * Returns the total kWh for the window, or null on failure.
 * When fallbackSignal is provided and the primary signal returns no data,
 * automatically retries with the fallback signal.
 */
async function fetchSingleSiteTelemetryTotal(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  options: {
    siteId: string;
    signal: string;
    startDatetime: string;
    endDatetime: string;
    period?: string;
    fallbackSignal?: string;
  }
): Promise<{ totalKwh: number; rawPreview: unknown; usedSignal: string } | null> {
  const trySignal = async (
    sig: string
  ): Promise<{ totalKwh: number; rawPreview: unknown; usedSignal: string } | null> => {
    const apiBase = normalizeUrlOrFallback(context.apiBaseUrl, TESLA_POWERHUB_DEFAULT_API_BASE_URL);
    const url = new URL(`${apiBase}/telemetry/history`);
    url.searchParams.set("target_id", options.siteId);
    url.searchParams.set("signals", sig);
    url.searchParams.set("start_datetime", options.startDatetime);
    url.searchParams.set("end_datetime", options.endDatetime);
    url.searchParams.set("period", options.period || "1d");
    url.searchParams.set("rollup", "last");
    url.searchParams.set("fill", "none");

    try {
      const raw = await fetchJsonWithBearerToken(url.toString(), accessToken, {
        timeoutMs: 120_000,
      });
      const totals = computeSiteDeltasByTelemetryPayload(raw, "", sig, {
        unattributedSiteId: options.siteId,
      });
      const entry = totals.get(options.siteId);
      if (entry && entry.totalKwh !== 0) {
        return { totalKwh: entry.totalKwh, rawPreview: createPreview(raw), usedSignal: sig };
      }
      return null;
    } catch {
      return null;
    }
  };

  const primary = await trySignal(options.signal);
  if (primary) return primary;

  if (options.fallbackSignal && options.fallbackSignal !== options.signal) {
    return trySignal(options.fallbackSignal);
  }

  return null;
}

function buildWindowConfigs(now: Date): TeslaPowerhubWindowConfig[] {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const endDatetime = now.toISOString();
  // Periods chosen to give enough data points for an accurate max−min delta
  // while keeping response sizes manageable.
  return [
    { key: "daily", period: "15m", startDatetime: new Date(now.getTime() - DAY_MS).toISOString(), endDatetime },
    { key: "weekly", period: "1h", startDatetime: new Date(now.getTime() - 7 * DAY_MS).toISOString(), endDatetime },
    { key: "monthly", period: "6h", startDatetime: new Date(now.getTime() - 30 * DAY_MS).toISOString(), endDatetime },
    { key: "yearly", period: "1d", startDatetime: new Date(now.getTime() - 365 * DAY_MS).toISOString(), endDatetime },
    { key: "lifetime", period: "7d", startDatetime: "2010-01-01T00:00:00.000Z", endDatetime },
  ];
}

function buildTelemetryRequestUrl(baseUrl: string, options: {
  groupId: string;
  signal: string;
  startDatetime: string;
  endDatetime: string;
  period?: string;
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
  url.searchParams.set("period", options.period || "1d");
  url.searchParams.set("rollup", "last");
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
    period?: string;
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
  let lastRawPreview: unknown = null;

  for (const attempt of attempts) {
    const requestUrl = buildTelemetryRequestUrl(attempt.baseUrl, {
      groupId: options.groupId,
      signal: options.signal,
      startDatetime: options.startDatetime,
      endDatetime: options.endDatetime,
      period: options.period,
      groupRollup: attempt.groupRollup,
    });
    try {
      const raw = await fetchJsonWithBearerToken(requestUrl, accessToken, {
        timeoutMs: 120_000,
      });
      const totals = computeSiteDeltasByTelemetryPayload(raw, options.groupId, options.signal);
      if (totals.size > 0 || options.allowEmptyTotals) {
        return {
          totals,
          resolvedEndpointUrl: requestUrl,
          rawPreview: createPreview(raw),
          attemptUsed: attempt,
        };
      }

      // Group-level endpoints (aggregate and history with group_rollup)
      // return aggregated totals without per-site breakdown.  Do NOT
      // attribute these values to the group UUID — they are not useful
      // for per-site reporting.  Fall through so the per-site fallback
      // phase can query individual sites.
      lastRawPreview = createPreview(raw);
      lastError = `No per-site telemetry values parsed from ${requestUrl} (likely group-aggregated data only).`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown request error.";
    }
  }

  const previewSnippet =
    lastRawPreview === null
      ? ""
      : (() => {
          try {
            const serialized = JSON.stringify(lastRawPreview);
            return serialized.length > 700 ? `${serialized.slice(0, 700)}...` : serialized;
          } catch {
            return "";
          }
        })();

  throw new Error(
    `Tesla Powerhub telemetry request failed for all endpoint candidates.${lastError ? ` Last error ${lastError}` : ""}${
      previewSnippet ? ` Preview ${previewSnippet}` : ""
    }`
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
  const totalSteps = 8;
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
  // Primary signal: Revenue Grade Meter (RGM).  Fallback: inverter AC meter.
  // Sites without RGM data are automatically retried with the inverter signal.
  const primarySignal = toNonEmptyString(options.signal) ?? "solar_energy_exported_rgm";
  const fallbackSignal = primarySignal === "solar_energy_exported_rgm" ? "solar_energy_exported" : null;
  const signal = primarySignal;
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
  const siteSignalUsed = new Map<string, string>();

  // ---- Phase 1: Group-level query attempt ------------------------------------
  // Try group-level endpoints first to see if the API returns per-site
  // breakdowns.  In practice, group-level endpoints usually return only
  // aggregated totals (NOT per-site data).  When that happens, the results
  // are empty and Phase 2 per-site fallback handles the actual site queries.
  const stepByWindow: Record<TeslaPowerhubWindowKey, number> = {
    daily: 3,
    weekly: 4,
    monthly: 5,
    yearly: 6,
    lifetime: 7,
  };

  for (const window of windows) {
    const step = stepByWindow[window.key];
    emitProgress({
      currentStep: step,
      totalSteps,
      windowKey: window.key,
      message: `Loading ${window.key} telemetry (RGM + inverter signals).`,
    });

    // Query RGM signal at group level — returns empty when endpoint only
    // has group-aggregated data (no per-site breakdown).  Per-site fallback
    // (Phase 2) handles the actual site-level queries.
    let rgmTotals = new Map<string, SiteTotal>();
    try {
      const rgmResult = await fetchTelemetryWindowTotals(context, token.access_token, {
        groupId,
        signal: primarySignal,
        startDatetime: window.startDatetime,
        endDatetime: window.endDatetime,
        period: window.period,
        endpointUrl: options.endpointUrl,
        preferredAttempt: preferredTelemetryAttempt,
        allowEmptyTotals: true,
      });
      preferredTelemetryAttempt = rgmResult.attemptUsed;
      rgmTotals = rgmResult.totals;
      resolvedTelemetryEndpoints[window.key] = rgmResult.resolvedEndpointUrl;
      telemetryPreviewByWindow[window.key] = rgmResult.rawPreview;
    } catch (error) {
      telemetryErrorsByWindow[window.key] = `RGM: ${error instanceof Error ? error.message : "Unknown error."}`;
    }

    // Query inverter signal at group level
    let invTotals = new Map<string, SiteTotal>();
    if (fallbackSignal) {
      try {
        const invResult = await fetchTelemetryWindowTotals(context, token.access_token, {
          groupId,
          signal: fallbackSignal,
          startDatetime: window.startDatetime,
          endDatetime: window.endDatetime,
          period: window.period,
          endpointUrl: options.endpointUrl,
          preferredAttempt: preferredTelemetryAttempt,
          allowEmptyTotals: true,
        });
        preferredTelemetryAttempt = invResult.attemptUsed;
        invTotals = invResult.totals;
        if (!resolvedTelemetryEndpoints[window.key]) {
          resolvedTelemetryEndpoints[window.key] = invResult.resolvedEndpointUrl;
        }
      } catch (error) {
        const existing = telemetryErrorsByWindow[window.key];
        telemetryErrorsByWindow[window.key] = `${existing ? `${existing} | ` : ""}Inverter: ${error instanceof Error ? error.message : "Unknown error."}`;
      }
    }

    // Merge: prefer RGM data (totalKwh > 0), else fall back to inverter.
    const merged = new Map<string, SiteTotal>();
    const windowSiteIds = new Set([...Array.from(rgmTotals.keys()), ...Array.from(invTotals.keys())]);
    for (const siteId of Array.from(windowSiteIds)) {
      const rgmEntry = rgmTotals.get(siteId);
      const invEntry = invTotals.get(siteId);
      if (rgmEntry && rgmEntry.totalKwh > 0) {
        merged.set(siteId, rgmEntry);
        if (!siteSignalUsed.has(siteId)) siteSignalUsed.set(siteId, primarySignal);
      } else if (invEntry && invEntry.totalKwh > 0) {
        merged.set(siteId, invEntry);
        if (!siteSignalUsed.has(siteId) && fallbackSignal) siteSignalUsed.set(siteId, fallbackSignal);
      } else if (rgmEntry) {
        merged.set(siteId, rgmEntry);
      } else if (invEntry) {
        merged.set(siteId, invEntry);
      }
    }

    totalsByWindow.set(window.key, merged);

    emitProgress({
      currentStep: step,
      totalSteps,
      windowKey: window.key,
      message: `${window.key} telemetry loaded (${merged.size} sites: ${rgmTotals.size} RGM, ${invTotals.size} inverter).`,
    });
  }

  // ---- Phase 2: Per-site queries ------------------------------------------
  // Group-level endpoints typically return aggregated totals without per-site
  // breakdown.  For any window lacking real per-site data, query each site
  // individually.  Rate-limited to 4 req/s with token refresh per window.
  const windowsNeedingPerSite = windows.filter((w) => {
    const existing = totalsByWindow.get(w.key);
    return !(
      existing &&
      existing.size > 0 &&
      Array.from(existing.keys()).some((siteId) => siteId !== groupId)
    );
  });

  if (windowsNeedingPerSite.length > 0 && siteResult.sites.length > 0) {
    const perSiteThrottle = createApiThrottle(4);
    let perSiteToken = token.access_token;

    for (const window of windowsNeedingPerSite) {
      // Refresh token before each window batch to prevent expiration
      // during long-running per-site queries (~12 min per window for ~3k sites).
      try {
        const refreshed = await requestClientCredentialsToken(context);
        perSiteToken = refreshed.access_token;
      } catch {
        // Use previous token if refresh fails.
      }

      let perSiteOk = 0;
      let perSiteEmpty = 0;
      let perSiteErr = 0;
      let lastPerSiteError = "";

      emitProgress({
        currentStep: 7,
        totalSteps,
        windowKey: window.key,
        message: `Per-site ${window.key} telemetry for ${siteResult.sites.length} site(s) — starting.`,
      });

      const windowTotals = new Map<string, SiteTotal>();
      const batchToken = perSiteToken; // capture for this window batch

      await mapConcurrent(siteResult.sites, 4, async (site) => {
        await perSiteThrottle();
        try {
          const result = await fetchSingleSiteTelemetryTotal(context, batchToken, {
            siteId: site.siteId,
            signal: primarySignal,
            startDatetime: window.startDatetime,
            endDatetime: window.endDatetime,
            period: window.period,
            fallbackSignal: fallbackSignal ?? undefined,
          });
          if (result) {
            perSiteOk++;
            windowTotals.set(site.siteId, {
              siteId: site.siteId,
              siteName: site.siteName ?? null,
              totalKwh: roundToFourDecimals(result.totalKwh),
            });
            if (!siteSignalUsed.has(site.siteId)) siteSignalUsed.set(site.siteId, result.usedSignal);
          } else {
            perSiteEmpty++;
          }
        } catch (error) {
          perSiteErr++;
          if (!lastPerSiteError) {
            lastPerSiteError = error instanceof Error ? error.message : "Unknown error";
          }
        }

        // Periodic progress updates
        const processed = perSiteOk + perSiteEmpty + perSiteErr;
        if (processed % 200 === 0) {
          emitProgress({
            currentStep: 7,
            totalSteps,
            windowKey: window.key,
            message: `Per-site ${window.key}: ${processed}/${siteResult.sites.length} queried (${perSiteOk} OK, ${perSiteEmpty} empty, ${perSiteErr} errors).`,
          });
        }
      });

      emitProgress({
        currentStep: 7,
        totalSteps,
        windowKey: window.key,
        message: `Per-site ${window.key} done: ${perSiteOk} OK, ${perSiteEmpty} empty, ${perSiteErr} errors.${lastPerSiteError ? ` First error: ${lastPerSiteError.slice(0, 200)}` : ""}`,
      });

      if (windowTotals.size > 0) {
        totalsByWindow.set(window.key, windowTotals);
        telemetryErrorsByWindow[window.key] = null;
      } else if (perSiteErr > 0) {
        telemetryErrorsByWindow[window.key] =
          `All ${siteResult.sites.length} per-site queries failed for ${window.key}. First error: ${lastPerSiteError.slice(0, 300)}`;
      }
    }
  } else if (windowsNeedingPerSite.length > 0 && siteResult.sites.length === 0) {
    emitProgress({
      currentStep: 7,
      totalSteps,
      message: `WARNING: Site inventory is empty — cannot run per-site telemetry queries. Only group-level data available.`,
    });
  }
  // ---- End per-site queries -----------------------------------------------

  // ---- Phase 3: Fetch STE external identifiers -----------------------------
  // The STE identifier (e.g. STE20250403-01158) lives in the individual
  // /asset/sites/{site_id} response — it is NOT included in the group
  // endpoint.  Rate-limited to 4 req/s.
  const allDiscoveredSiteIds = new Set<string>();
  siteResult.sites.forEach((s) => allDiscoveredSiteIds.add(s.siteId));
  totalsByWindow.forEach((totals) => {
    totals.forEach((_, siteId) => {
      if (siteId !== groupId) allDiscoveredSiteIds.add(siteId);
    });
  });

  emitProgress({
    currentStep: 8,
    totalSteps,
    message: `Fetching STE identifiers for ${allDiscoveredSiteIds.size} site(s).`,
  });

  let steToken = token.access_token;
  try {
    const refreshed = await requestClientCredentialsToken(context);
    steToken = refreshed.access_token;
  } catch {
    // Use original token if refresh fails.
  }

  const siteExternalIds = await fetchSiteExternalIds(
    context,
    steToken,
    Array.from(allDiscoveredSiteIds),
    (fetched, total) => {
      emitProgress({
        currentStep: 8,
        totalSteps,
        message: `Fetching STE identifiers (${fetched}/${total}).`,
      });
    }
  );

  emitProgress({
    currentStep: 8,
    totalSteps,
    message: `STE identifiers fetched (${siteExternalIds.size} found).`,
  });
  // ---- End STE ID fetch --------------------------------------------------

  const successfulWindowCount = windows.filter((window) => (totalsByWindow.get(window.key)?.size ?? 0) > 0).length;
  if (successfulWindowCount === 0) {
    const allErrors = Object.entries(telemetryErrorsByWindow)
      .filter(([, error]) => error)
      .map(([key, error]) => `${key}: ${error}`)
      .join(" | ");
    throw new Error(
      `Unable to fetch telemetry for group ${groupId}. Sites discovered: ${siteResult.sites.length}. ${allErrors || "No telemetry data returned for any window."}`.trim()
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
          siteExternalId: null,
          siteName: total.siteName ?? null,
        });
      }
    });
  });

  // Filter out the group UUID itself — it is NOT an individual site.
  // Group-level endpoints may insert aggregated data keyed by the group ID;
  // it must never appear as an output row.
  const rows: TeslaPowerhubSiteProductionMetrics[] = Array.from(siteMap.values())
    .filter((site) => site.siteId !== groupId)
    .map((site) => {
    const daily = totalsByWindow.get("daily")?.get(site.siteId)?.totalKwh ?? 0;
    const weekly = totalsByWindow.get("weekly")?.get(site.siteId)?.totalKwh ?? 0;
    const monthly = totalsByWindow.get("monthly")?.get(site.siteId)?.totalKwh ?? 0;
    const yearly = totalsByWindow.get("yearly")?.get(site.siteId)?.totalKwh ?? 0;
    const lifetime = totalsByWindow.get("lifetime")?.get(site.siteId)?.totalKwh ?? 0;
    const usedSignal = siteSignalUsed.get(site.siteId) ?? primarySignal;
    return {
      siteId: site.siteId,
      siteExternalId: siteExternalIds.get(site.siteId) ?? site.siteExternalId ?? null,
      siteName: site.siteName ?? totalsByWindow.get("lifetime")?.get(site.siteId)?.siteName ?? null,
      dailyKwh: roundToFourDecimals(daily),
      weeklyKwh: roundToFourDecimals(weekly),
      monthlyKwh: roundToFourDecimals(monthly),
      yearlyKwh: roundToFourDecimals(yearly),
      lifetimeKwh: roundToFourDecimals(lifetime),
      dataSource:
        usedSignal === "solar_energy_exported_rgm"
          ? "rgm"
          : usedSignal === "solar_energy_exported"
            ? "inverter"
            : null,
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
