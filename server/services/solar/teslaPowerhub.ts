import {
  toNonEmptyString,
  toIdString,
  toFiniteNumber,
  asRecord,
} from "./teslaPowerhubUtils";
import { normalizeBaseUrl as normalizeUrlOrFallback } from "./helpers";

export const TESLA_POWERHUB_DEFAULT_TOKEN_URL =
  "https://gridlogic-api.sn.tesla.services/v1/auth/token";
export const TESLA_POWERHUB_DEFAULT_API_BASE_URL =
  "https://gridlogic-api.sn.tesla.services/v2";
export const TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL =
  "https://powerhub.energy.tesla.com";

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

export type TeslaPowerhubGroupDescriptor = {
  groupId: string;
  groupName: string | null;
};

type TeslaPowerhubTokenResponse = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

type TeslaPowerhubWindowKey =
  | "daily"
  | "weekly"
  | "monthly"
  | "yearly"
  | "lifetime";

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

export type TeslaPowerhubSiteDescriptor = SiteDescriptor;

export type TeslaPowerhubSiteInventoryResult = {
  sites: TeslaPowerhubSiteDescriptor[];
  requestedGroupId: string | null;
  groups: TeslaPowerhubGroupDescriptor[];
  resolvedSitesEndpointUrl: string | null;
  token: {
    tokenType: string;
    expiresIn: number | null;
    scope: string | null;
  };
  debug: unknown;
};

export type TeslaPowerhubSiteSnapshotResult = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  siteName: string | null;
  siteExternalId: string | null;
  dailyKwh: number | null;
  weeklyKwh: number | null;
  monthlyKwh: number | null;
  yearlyKwh: number | null;
  lifetimeKwh: number | null;
  dataSource: "rgm" | "inverter" | null;
  error: string | null;
};

export type TeslaPowerhubProductionMetricsResult = {
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
    perSiteGapFill?: TeslaPowerhubPerSiteGapFillDebug;
    windows: Record<
      TeslaPowerhubWindowKey,
      { startDatetime: string; endDatetime: string }
    >;
  };
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

export type TeslaPowerhubPerSiteGapFillMode = "deep" | "group-only";

type TeslaPowerhubPerSiteGapFillWindowDebug = {
  missingSiteCount: number;
  queriedSiteCount: number;
  ok: number;
  empty: number;
  errors: number;
  skipped: boolean;
  skippedReason: string | null;
  firstError: string | null;
};

export type TeslaPowerhubPerSiteGapFillDebug = {
  mode: TeslaPowerhubPerSiteGapFillMode;
  windows: Record<
    TeslaPowerhubWindowKey,
    TeslaPowerhubPerSiteGapFillWindowDebug
  >;
};

export type TeslaPowerhubMetricsProgress = {
  currentStep: number;
  totalSteps: number;
  message: string;
  windowKey?: TeslaPowerhubWindowKey;
};

const MAX_WALK_DEPTH = 10;
const GLOBAL_TIMEOUT_MS = 5 * 60 * 1000;
const INVENTORY_GLOBAL_TIMEOUT_MS = 25_000;
const DISCOVERY_REQUEST_TIMEOUT_MS = 5_000;
const SITE_SNAPSHOT_GLOBAL_TIMEOUT_MS = 60_000;
const TESLA_POWERHUB_WINDOW_KEYS: TeslaPowerhubWindowKey[] = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
  "lifetime",
];

function createPerSiteGapFillWindowDebug(): TeslaPowerhubPerSiteGapFillWindowDebug {
  return {
    missingSiteCount: 0,
    queriedSiteCount: 0,
    ok: 0,
    empty: 0,
    errors: 0,
    skipped: false,
    skippedReason: null,
    firstError: null,
  };
}

function createPerSiteGapFillDebug(
  mode: TeslaPowerhubPerSiteGapFillMode
): TeslaPowerhubPerSiteGapFillDebug {
  return {
    mode,
    windows: Object.fromEntries(
      TESLA_POWERHUB_WINDOW_KEYS.map(key => [
        key,
        createPerSiteGapFillWindowDebug(),
      ])
    ) as Record<TeslaPowerhubWindowKey, TeslaPowerhubPerSiteGapFillWindowDebug>,
  };
}

function normalizeTimeoutMs(
  timeoutMs: number | null | undefined,
  fallbackMs: number
): number {
  return typeof timeoutMs === "number" &&
    Number.isFinite(timeoutMs) &&
    timeoutMs > 0
    ? timeoutMs
    : fallbackMs;
}

function createGlobalSignal(
  abortSignal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  return abortSignal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), abortSignal])
    : AbortSignal.timeout(timeoutMs);
}

function isAbortOrTimeoutError(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message = error instanceof Error ? error.message : "";
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /aborted due to timeout/i.test(message)
  );
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException("Operation aborted", "AbortError");
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

function parseTokenPayload(
  payload: unknown,
  rawBody: string
): TeslaPowerhubTokenResponse {
  const record = asRecord(payload);
  const dataRecord = asRecord(record.data);
  const accessToken =
    toNonEmptyString(record.access_token) ??
    toNonEmptyString(dataRecord.access_token);
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
      ? scopeRaw
          .map(value => toNonEmptyString(value))
          .filter((value): value is string => Boolean(value))
          .join(" ")
      : null);

  const expiresInRaw = record.expires_in ?? dataRecord.expires_in;
  const expiresIn =
    typeof expiresInRaw === "number" && Number.isFinite(expiresInRaw)
      ? expiresInRaw
      : undefined;

  return {
    access_token: accessToken,
    token_type: tokenType ?? undefined,
    expires_in: expiresIn,
    scope: scope ?? undefined,
  };
}

async function requestClientCredentialsToken(
  context: TeslaPowerhubApiContext,
  fetchOptions?: { signal?: AbortSignal }
): Promise<TeslaPowerhubTokenResponse> {
  const tokenUrl = normalizeUrlOrFallback(
    context.tokenUrl,
    TESLA_POWERHUB_DEFAULT_TOKEN_URL
  );
  const signals: AbortSignal[] = [AbortSignal.timeout(20_000)];
  if (fetchOptions?.signal) signals.push(fetchOptions.signal);
  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Authorization: buildBasicAuth(context.clientId, context.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      throw new Error(
        "Tesla Powerhub token request timed out after 20 seconds. Confirm Tesla has allowlisted this server egress IP and that the token URL is correct."
      );
    }
    throw error;
  }

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
  if (/^[A-Za-z0-9_-]{6,}$/.test(normalized) && /\d/.test(normalized))
    return true;
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
    .map(row => {
      const value = asRecord(row);
      const id =
        toNonEmptyString(value.id) ??
        toNonEmptyString(value.user_id) ??
        toNonEmptyString(value.uuid);
      if (!id) return null;
      return {
        id,
        name:
          toNonEmptyString(value.name) ??
          toNonEmptyString(value.full_name) ??
          `User ${id}`,
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

  const apiBase = normalizeUrlOrFallback(
    context.apiBaseUrl,
    TESLA_POWERHUB_DEFAULT_API_BASE_URL
  );
  const portalBase = normalizeUrlOrFallback(
    context.portalBaseUrl,
    TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL
  );
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

  const apiBase = normalizeUrlOrFallback(
    context.apiBaseUrl,
    TESLA_POWERHUB_DEFAULT_API_BASE_URL
  );
  const portalBase = normalizeUrlOrFallback(
    context.portalBaseUrl,
    TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL
  );
  const encodedGroupId = encodeURIComponent(groupId);

  // Try dedicated sites sub-resource first, then group detail endpoints
  // (which may embed the site list in their response).
  add(`${apiBase}/asset/groups/${encodedGroupId}/sites`);
  add(`${apiBase}/asset/group/${encodedGroupId}/sites`);
  add(`${apiBase}/asset/groups/${encodedGroupId}/assets`);
  add(`${apiBase}/asset/groups/${encodedGroupId}`);
  add(`${apiBase}/asset/group/${encodedGroupId}`);
  add(`${apiBase}/groups/${encodedGroupId}`);
  add(`${apiBase}/group/${encodedGroupId}`);
  add(`${portalBase}/group/${encodedGroupId}`);

  return candidates;
}

function buildGroupDiscoveryCandidateUrls(
  context: TeslaPowerhubApiContext,
  endpointOverride: string | null
): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = toNonEmptyString(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  const override = toNonEmptyString(endpointOverride);
  if (override && !/\/telemetry\//i.test(override)) {
    add(override);
  }

  const apiBase = normalizeUrlOrFallback(
    context.apiBaseUrl,
    TESLA_POWERHUB_DEFAULT_API_BASE_URL
  );
  const portalBase = normalizeUrlOrFallback(
    context.portalBaseUrl,
    TESLA_POWERHUB_DEFAULT_PORTAL_BASE_URL
  );

  add(`${apiBase}/asset/groups`);
  add(`${apiBase}/asset/group`);
  add(`${apiBase}/groups`);
  add(`${apiBase}/group`);
  add(`${apiBase}/asset/portfolios`);
  add(`${apiBase}/portfolios`);
  add(`${apiBase}/asset/sites`);
  add(`${apiBase}/sites`);
  add(`${apiBase}/assets`);
  add(`${portalBase}/groups`);

  return candidates;
}

function buildSiteDiscoveryCandidateUrls(
  context: TeslaPowerhubApiContext,
  endpointOverride: string | null
): string[] {
  const candidates: string[] = [];
  const add = (value: string | null | undefined) => {
    const normalized = toNonEmptyString(value);
    if (!normalized) return;
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };

  const override = toNonEmptyString(endpointOverride);
  if (override && !/\/telemetry\//i.test(override)) {
    add(override);
  }

  const apiBase = normalizeUrlOrFallback(
    context.apiBaseUrl,
    TESLA_POWERHUB_DEFAULT_API_BASE_URL
  );
  add(`${apiBase}/asset/sites`);
  add(`${apiBase}/sites`);
  add(`${apiBase}/assets`);

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

  const apiBase = normalizeUrlOrFallback(
    context.apiBaseUrl,
    TESLA_POWERHUB_DEFAULT_API_BASE_URL
  );
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

  // Try multiple group_rollup strategies:
  // 1. History endpoint WITHOUT group_rollup — may return per-site breakdowns
  // 2. History endpoint WITH group_rollup=sum — required by some API versions
  // 3. Aggregate endpoint WITH group_rollup=sum — returns group-level totals
  const historyUrls: string[] = [];
  const aggregateUrls: string[] = [];
  candidateUrls.forEach(baseUrl => {
    if (/\/telemetry\/history\/operational\/aggregate\/?$/i.test(baseUrl)) {
      aggregateUrls.push(baseUrl);
    } else {
      historyUrls.push(baseUrl);
    }
  });

  // Priority 1: history without group_rollup — may return per-site data
  historyUrls.forEach(baseUrl => {
    addAttempt({ baseUrl, groupRollup: null });
  });

  // Priority 2: history with group_rollup=sum
  historyUrls.forEach(baseUrl => {
    addAttempt({ baseUrl, groupRollup: "sum" });
  });

  // Priority 3: aggregate endpoint (always aggregated, last resort)
  aggregateUrls.forEach(baseUrl => {
    addAttempt({ baseUrl, groupRollup: "sum" });
  });

  return attempts;
}

async function fetchJsonWithBearerToken(
  url: string,
  accessToken: string,
  options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }
): Promise<unknown> {
  const timeoutMs =
    typeof options?.timeoutMs === "number" && options.timeoutMs > 0
      ? options.timeoutMs
      : null;
  const signals: AbortSignal[] = [];
  if (timeoutMs) signals.push(AbortSignal.timeout(timeoutMs));
  if (options?.signal) signals.push(options.signal);
  const signal =
    signals.length > 1
      ? AbortSignal.any(signals)
      : signals.length === 1
        ? signals[0]
        : undefined;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal,
    });
  } catch (error) {
    if (isAbortOrTimeoutError(error)) {
      if (options?.signal?.aborted) throw error;
      if (timeoutMs)
        throw new Error(`(Request timed out after ${timeoutMs} ms)`);
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `(${response.status} ${response.statusText})${text ? `: ${text}` : ""}`
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `(Unexpected content type: ${contentType || "unknown"})${text ? `: ${text.slice(0, 200)}` : ""}`
    );
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

  const targetType =
    `${toNonEmptyString(record.target_type) ?? ""} ${toNonEmptyString(record.targetType) ?? ""} ${
      toNonEmptyString(record.type) ?? ""
    } ${toNonEmptyString(record.asset_type) ?? ""}`.toLowerCase();
  const targetId = toIdString(record.target_id) ?? toIdString(record.targetId);
  if (targetId && targetId !== groupId && /site/.test(targetType))
    return targetId;

  const fallbackId = toIdString(record.id) ?? toIdString(record.uuid);
  const hasSiteField =
    "site_name" in record ||
    "siteName" in record ||
    "energy_site_id" in record ||
    "site_id" in record ||
    "siteId" in record;
  if (
    fallbackId &&
    fallbackId !== groupId &&
    (hasSiteField || /site/.test(targetType))
  ) {
    return fallbackId;
  }

  return inheritedSiteId;
}

function detectGroupId(record: Record<string, unknown>): string | null {
  const direct =
    toIdString(record.group_id) ??
    toIdString(record.groupId) ??
    toIdString(record.group_uuid) ??
    toIdString(record.groupUuid) ??
    toIdString(record.asset_group_id) ??
    toIdString(record.assetGroupId) ??
    toIdString(record.portfolio_id) ??
    toIdString(record.portfolioId);
  if (direct) return direct;

  const type = `${toNonEmptyString(record.type) ?? ""} ${
    toNonEmptyString(record.asset_type) ?? ""
  } ${toNonEmptyString(record.assetType) ?? ""} ${
    toNonEmptyString(record.kind) ?? ""
  }`.toLowerCase();
  const id = toIdString(record.id) ?? toIdString(record.uuid);
  if (id && /(group|portfolio)/i.test(type)) return id;

  const href =
    toNonEmptyString(record.href) ??
    toNonEmptyString(record.url) ??
    toNonEmptyString(record.self) ??
    "";
  const match = href.match(/\/(?:asset\/)?groups?\/([a-zA-Z0-9-]+)/i);
  return match?.[1]?.trim() ?? null;
}

function detectGroupName(record: Record<string, unknown>): string | null {
  return (
    toNonEmptyString(record.name) ??
    toNonEmptyString(record.group_name) ??
    toNonEmptyString(record.groupName) ??
    toNonEmptyString(record.display_name) ??
    toNonEmptyString(record.displayName) ??
    toNonEmptyString(record.site_name) ??
    null
  );
}

function collectGroupsFromUnknown(
  payload: unknown
): TeslaPowerhubGroupDescriptor[] {
  const groupsById = new Map<string, TeslaPowerhubGroupDescriptor>();
  const visited = new Set<unknown>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = asRecord(value);
    const groupId = detectGroupId(record);
    if (groupId && !groupsById.has(groupId)) {
      groupsById.set(groupId, {
        groupId,
        groupName: detectGroupName(record),
      });
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === "object") {
        visit(child);
      } else if (typeof child === "string") {
        const match = child.match(/\/(?:asset\/)?groups?\/([a-zA-Z0-9-]+)/i);
        const childGroupId = match?.[1]?.trim();
        if (childGroupId && !groupsById.has(childGroupId)) {
          groupsById.set(childGroupId, {
            groupId: childGroupId,
            groupName: null,
          });
        }
      }
    }
  };

  visit(payload);
  return Array.from(groupsById.values());
}

function detectSiteName(
  record: Record<string, unknown>,
  inheritedSiteName: string | null
): string | null {
  return (
    toNonEmptyString(record.site_name) ??
    toNonEmptyString(record.siteName) ??
    toNonEmptyString(record.name) ??
    toNonEmptyString(record.display_name) ??
    toNonEmptyString(record.target_name) ??
    inheritedSiteName
  );
}

function detectSiteExternalId(
  record: Record<string, unknown>,
  inheritedExternalId: string | null
): string | null {
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

function collectSitesFromUnknown(
  payload: unknown,
  groupId: string
): SiteDescriptor[] {
  const siteMap = new Map<string, SiteDescriptor>();
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Helper: add a site ID if it looks valid and isn't the group itself.
  const addSiteId = (
    id: string,
    name: string | null,
    extId: string | null
  ): void => {
    if (!id || id === groupId) return;
    if (!siteMap.has(id)) {
      siteMap.set(id, { siteId: id, siteExternalId: extId, siteName: name });
    }
  };

  // Phase 1: handle arrays of UUID strings (e.g. { sites: ["uuid1", "uuid2"] })
  const extractUuidArrays = (value: unknown, depth = 0): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      // If the entire payload is an array of UUID strings
      if (
        value.length > 0 &&
        value.every(v => typeof v === "string" && UUID_RE.test(v))
      ) {
        for (const uuid of value) {
          addSiteId(uuid as string, null, null);
        }
      }
      for (const row of value) extractUuidArrays(row, depth + 1);
      return;
    }
    const record = asRecord(value);
    // Check known field names that may contain arrays of site IDs
    const siteListKeys = [
      "sites",
      "site_ids",
      "siteIds",
      "assets",
      "asset_ids",
      "assetIds",
      "children",
      "members",
      "member_ids",
      "items",
      "energy_sites",
    ];
    for (const key of siteListKeys) {
      const child = record[key];
      if (Array.isArray(child)) {
        for (const item of child) {
          if (
            typeof item === "string" &&
            UUID_RE.test(item) &&
            item !== groupId
          ) {
            addSiteId(item, null, null);
          } else if (item && typeof item === "object") {
            const itemRecord = asRecord(item);
            const id =
              toIdString(itemRecord.site_id) ??
              toIdString(itemRecord.siteId) ??
              toIdString(itemRecord.id) ??
              toIdString(itemRecord.uuid) ??
              toIdString(itemRecord.energy_site_id) ??
              toIdString(itemRecord.asset_id);
            if (id && id !== groupId) {
              addSiteId(
                id,
                detectSiteName(itemRecord, null),
                detectSiteExternalId(itemRecord, null)
              );
            }
          }
        }
      }
    }
    // Recurse into data, results, etc.
    for (const key of ["data", "results", "response", "payload", "content"]) {
      if (record[key] !== undefined) extractUuidArrays(record[key], depth + 1);
    }
  };
  extractUuidArrays(payload);

  // Phase 2: recursive walk for deeply nested structures with site_id fields.
  const walk = (
    value: unknown,
    inheritedSiteId: string | null,
    inheritedSiteName: string | null,
    inheritedExternalId: string | null,
    depth = 0
  ): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      for (const row of value) {
        walk(
          row,
          inheritedSiteId,
          inheritedSiteName,
          inheritedExternalId,
          depth + 1
        );
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
      walk(
        child,
        siteId ?? inheritedSiteId,
        siteName ?? inheritedSiteName,
        externalId ?? inheritedExternalId,
        depth + 1
      );
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
  const accumulators = new Map<
    string,
    {
      siteId: string;
      siteName: string | null;
      minWh: number;
      maxWh: number;
    }
  >();
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
      siteId && siteId !== groupId ? siteId : (unattributedSiteId ?? siteId);
    if (
      !effectiveSiteId ||
      (effectiveSiteId === groupId && !unattributedSiteId)
    )
      return;
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
    path: string,
    depth = 0
  ): void => {
    if (depth > MAX_WALK_DEPTH) return;
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
            record.value ??
              record.kwh ??
              record.energy_kwh ??
              record.sum ??
              record.total,
            record.timestamp ?? record.ts ?? record.datetime ?? record.time,
            entryPath
          );
          parseNumericContainer(
            record.values,
            siteId,
            siteName,
            `${entryPath}.values`,
            depth + 1
          );
          parseNumericContainer(
            record.data,
            siteId,
            siteName,
            `${entryPath}.data`,
            depth + 1
          );
          parseNumericContainer(
            record.points,
            siteId,
            siteName,
            `${entryPath}.points`,
            depth + 1
          );
          parseNumericContainer(
            record.series,
            siteId,
            siteName,
            `${entryPath}.series`,
            depth + 1
          );
          parseNumericContainer(
            record.data_points,
            siteId,
            siteName,
            `${entryPath}.data_points`,
            depth + 1
          );
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
        parseNumericContainer(
          rowValue,
          key,
          siteName,
          `${path}.${key}`,
          depth + 1
        );
      });
      return;
    }

    const isTimestampMap =
      entries.length > 0 &&
      entries.every(
        ([key, rowValue]) =>
          parseTimestampMs(key) !== null && toFiniteNumber(rowValue) !== null
      );
    if (isTimestampMap) {
      for (const [key, rowValue] of entries) {
        addValue(siteId, siteName, rowValue, key, `${path}.${key}`);
      }
      return;
    }

    addValue(
      siteId,
      siteName,
      record.value ??
        record.kwh ??
        record.energy_kwh ??
        record.sum ??
        record.total,
      record.timestamp ?? record.ts ?? record.datetime ?? record.time,
      path
    );

    parseNumericContainer(
      record.values,
      siteId,
      siteName,
      `${path}.values`,
      depth + 1
    );
    parseNumericContainer(
      record.data,
      siteId,
      siteName,
      `${path}.data`,
      depth + 1
    );
    parseNumericContainer(
      record.points,
      siteId,
      siteName,
      `${path}.points`,
      depth + 1
    );
    parseNumericContainer(
      record.series,
      siteId,
      siteName,
      `${path}.series`,
      depth + 1
    );
    parseNumericContainer(
      record.data_points,
      siteId,
      siteName,
      `${path}.data_points`,
      depth + 1
    );
  };

  const walk = (
    value: unknown,
    inheritedSiteId: string | null,
    inheritedSiteName: string | null,
    path: string,
    depth = 0
  ): void => {
    if (depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(value)) {
      value.forEach((row, index) =>
        walk(
          row,
          inheritedSiteId,
          inheritedSiteName,
          `${path}[${index}]`,
          depth + 1
        )
      );
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
      parseNumericContainer(
        signalEntry,
        siteId,
        siteName,
        `${path}.${signalKey}`,
        depth + 1
      );
      if (record[signalKey] !== undefined) handledKeys.add(signalKey);
      if (record.signals !== undefined) handledKeys.add("signals");
    }

    parseNumericContainer(
      record.values,
      siteId,
      siteName,
      `${path}.values`,
      depth + 1
    );
    parseNumericContainer(
      record.data,
      siteId,
      siteName,
      `${path}.data`,
      depth + 1
    );
    parseNumericContainer(
      record.points,
      siteId,
      siteName,
      `${path}.points`,
      depth + 1
    );
    parseNumericContainer(
      record.series,
      siteId,
      siteName,
      `${path}.series`,
      depth + 1
    );
    parseNumericContainer(
      record.data_points,
      siteId,
      siteName,
      `${path}.data_points`,
      depth + 1
    );
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
      record.value ??
        record.kwh ??
        record.energy_kwh ??
        record.sum ??
        record.total,
      record.timestamp ?? record.ts ?? record.datetime ?? record.time,
      `${path}.value`
    );

    for (const [key, child] of Object.entries(record)) {
      if (handledKeys.has(key)) continue;
      walk(child, siteId, siteName, `${path}.${key}`, depth + 1);
    }
  };

  walk(payload, null, null, "root");

  // Compute delta (max − min) for each site.  Cumulative meter readings
  // only increase, so max is the latest reading and min is the earliest.
  // Convert Wh → kWh.
  const totals = new Map<string, SiteTotal>();
  accumulators.forEach(acc => {
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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
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
      () => new Promise<void>(resolve => setTimeout(resolve, intervalMs))
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
  onProgress?: (fetched: number, total: number) => void,
  abortSignal?: AbortSignal
): Promise<Map<string, string>> {
  const apiBase = normalizeUrlOrFallback(
    context.apiBaseUrl,
    TESLA_POWERHUB_DEFAULT_API_BASE_URL
  );
  const externalIds = new Map<string, string>();
  const throttle = createApiThrottle(4); // stay under 5 req/s limit
  let fetched = 0;

  await mapConcurrent(siteIds, 4, async siteId => {
    if (abortSignal?.aborted) return;
    await throttle();
    const url = `${apiBase}/asset/sites/${encodeURIComponent(siteId)}`;
    try {
      const raw = await fetchJsonWithBearerToken(url, accessToken, {
        timeoutMs: 30_000,
        signal: abortSignal,
      });
      const record = asRecord(raw);
      const dataRecord = asRecord(record.data);

      // The STE identifier (e.g. STE20250403-01158) is stored in the
      // site_name field for many Tesla sites.  Also check nested data
      // and common alternative fields.
      const candidates = [
        record.site_name,
        record.name,
        record.display_name,
        record.display_id,
        record.external_id,
        record.ste_id,
        record.site_code,
        record.identifier,
        record.reference_id,
        record.project_number,
        record.customer_site_id,
        record.asset_name,
        dataRecord.site_name,
        dataRecord.name,
        dataRecord.display_name,
        dataRecord.display_id,
        dataRecord.external_id,
        dataRecord.ste_id,
      ];

      // Priority 1: field with STE pattern (e.g. STE20250403-01158)
      for (const candidate of candidates) {
        const str = toNonEmptyString(candidate);
        if (str && /^STE\d/i.test(str)) {
          externalIds.set(siteId, str);
          return;
        }
      }

      // Priority 2: scan all top-level and data-level string values for STE pattern
      for (const value of [
        ...Object.values(record),
        ...Object.values(dataRecord),
      ]) {
        const str = toNonEmptyString(value);
        if (str && /^STE\d/i.test(str)) {
          externalIds.set(siteId, str);
          return;
        }
      }

      // Priority 3: use site_name as the external identifier
      const siteName =
        toNonEmptyString(record.site_name) ??
        toNonEmptyString(dataRecord.site_name);
      if (siteName) {
        externalIds.set(siteId, siteName);
        return;
      }
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
    abortSignal?: AbortSignal;
  }
): Promise<{
  totalKwh: number;
  rawPreview: unknown;
  usedSignal: string;
} | null> {
  const trySignal = async (
    sig: string
  ): Promise<{
    totalKwh: number;
    rawPreview: unknown;
    usedSignal: string;
  } | null> => {
    const apiBase = normalizeUrlOrFallback(
      context.apiBaseUrl,
      TESLA_POWERHUB_DEFAULT_API_BASE_URL
    );
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
        signal: options.abortSignal,
      });
      const totals = computeSiteDeltasByTelemetryPayload(raw, "", sig, {
        unattributedSiteId: options.siteId,
      });
      const entry = totals.get(options.siteId);
      if (entry && entry.totalKwh !== 0) {
        return {
          totalKwh: entry.totalKwh,
          rawPreview: createPreview(raw),
          usedSignal: sig,
        };
      }
      return null;
    } catch (error) {
      throwIfSignalAborted(options.abortSignal);
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
    {
      key: "daily",
      period: "15m",
      startDatetime: new Date(now.getTime() - DAY_MS).toISOString(),
      endDatetime,
    },
    {
      key: "weekly",
      period: "1h",
      startDatetime: new Date(now.getTime() - 7 * DAY_MS).toISOString(),
      endDatetime,
    },
    {
      key: "monthly",
      period: "6h",
      startDatetime: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
      endDatetime,
    },
    {
      key: "yearly",
      period: "1d",
      startDatetime: new Date(now.getTime() - 365 * DAY_MS).toISOString(),
      endDatetime,
    },
    {
      key: "lifetime",
      period: "7d",
      startDatetime: "2010-01-01T00:00:00.000Z",
      endDatetime,
    },
  ];
}

function buildTelemetryRequestUrl(
  baseUrl: string,
  options: {
    groupId: string;
    signal: string;
    startDatetime: string;
    endDatetime: string;
    period?: string;
    groupRollup?: string | null;
  }
): string {
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

function createPreview(value: unknown, depth = 0, maxDepth = 5): unknown {
  if (depth >= maxDepth) return "[truncated]";
  if (Array.isArray(value)) {
    const limit = depth <= 1 ? 5 : 3;
    const limited = value
      .slice(0, limit)
      .map(entry => createPreview(entry, depth + 1, maxDepth));
    if (value.length > limit) {
      limited.push(`... ${value.length - limit} more item(s)`);
    }
    return limited;
  }
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(asRecord(value));
  const preview: Record<string, unknown> = {};
  const keyLimit = depth <= 1 ? 20 : 10;
  for (let index = 0; index < entries.length; index += 1) {
    const [key, rowValue] = entries[index];
    if (index >= keyLimit) {
      preview.__truncatedKeys = entries.length - keyLimit;
      break;
    }
    preview[key] = createPreview(rowValue, depth + 1, maxDepth);
  }
  return preview;
}

async function fetchGroupSites(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  options: {
    groupId: string;
    endpointUrl?: string | null;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  }
): Promise<{
  sites: SiteDescriptor[];
  resolvedEndpointUrl: string | null;
  rawPreview: unknown;
}> {
  const groupId = options.groupId.trim();
  const candidateUrls = buildAssetGroupCandidateUrls(
    context,
    groupId,
    toNonEmptyString(options.endpointUrl)
  );
  const diagnostics: { url: string; status: string; preview?: unknown }[] = [];

  for (const url of candidateUrls) {
    throwIfSignalAborted(options.signal);
    try {
      const raw = await fetchJsonWithBearerToken(url, accessToken, {
        signal: options.signal,
        timeoutMs: options.requestTimeoutMs,
      });
      const sites = collectSitesFromUnknown(raw, groupId);
      if (sites.length > 0) {
        return {
          sites,
          resolvedEndpointUrl: url,
          rawPreview: createPreview(raw),
        };
      }
      // Deeper preview (depth 5) to help diagnose the response structure
      diagnostics.push({
        url,
        status: `200 OK but 0 sites parsed`,
        preview: createPreview(raw, 0),
      });
    } catch (error) {
      throwIfSignalAborted(options.signal);
      diagnostics.push({
        url,
        status: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  throwIfSignalAborted(options.signal);
  return {
    sites: [],
    resolvedEndpointUrl: null,
    rawPreview: {
      error: `No sites found in ${candidateUrls.length} URL candidate(s).`,
      attempts: diagnostics,
    },
  };
}

async function fetchAccessibleGroups(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  options: {
    endpointUrl?: string | null;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  }
): Promise<{
  groups: TeslaPowerhubGroupDescriptor[];
  resolvedEndpointUrl: string | null;
  rawPreview: unknown;
}> {
  const endpointUrl = toNonEmptyString(options.endpointUrl);
  const endpointGroupId = endpointUrl?.match(
    /\/(?:asset\/)?groups?\/([a-zA-Z0-9-]+)/i
  )?.[1];
  if (endpointGroupId) {
    return {
      groups: [{ groupId: endpointGroupId, groupName: null }],
      resolvedEndpointUrl: endpointUrl,
      rawPreview: { source: "endpointUrl", groupId: endpointGroupId },
    };
  }

  const candidateUrls = buildGroupDiscoveryCandidateUrls(context, endpointUrl);
  const diagnostics: { url: string; status: string; preview?: unknown }[] = [];

  for (const url of candidateUrls) {
    throwIfSignalAborted(options.signal);
    try {
      const raw = await fetchJsonWithBearerToken(url, accessToken, {
        signal: options.signal,
        timeoutMs: options.requestTimeoutMs,
      });
      const groups = collectGroupsFromUnknown(raw);
      if (groups.length > 0) {
        return {
          groups,
          resolvedEndpointUrl: url,
          rawPreview: createPreview(raw),
        };
      }
      diagnostics.push({
        url,
        status: "200 OK but 0 groups parsed",
        preview: createPreview(raw, 0),
      });
    } catch (error) {
      throwIfSignalAborted(options.signal);
      diagnostics.push({
        url,
        status: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  throwIfSignalAborted(options.signal);
  return {
    groups: [],
    resolvedEndpointUrl: null,
    rawPreview: {
      error: `No groups found in ${candidateUrls.length} URL candidate(s).`,
      attempts: diagnostics,
    },
  };
}

async function fetchAccessibleSites(
  context: TeslaPowerhubApiContext,
  accessToken: string,
  options: {
    endpointUrl?: string | null;
    signal?: AbortSignal;
    requestTimeoutMs?: number;
  }
): Promise<{
  sites: SiteDescriptor[];
  resolvedEndpointUrl: string | null;
  rawPreview: unknown;
}> {
  const candidateUrls = buildSiteDiscoveryCandidateUrls(
    context,
    toNonEmptyString(options.endpointUrl)
  );
  const diagnostics: { url: string; status: string; preview?: unknown }[] = [];

  for (const url of candidateUrls) {
    throwIfSignalAborted(options.signal);
    try {
      const raw = await fetchJsonWithBearerToken(url, accessToken, {
        signal: options.signal,
        timeoutMs: options.requestTimeoutMs,
      });
      const sites = collectSitesFromUnknown(raw, "");
      if (sites.length > 0) {
        return {
          sites,
          resolvedEndpointUrl: url,
          rawPreview: createPreview(raw),
        };
      }
      diagnostics.push({
        url,
        status: "200 OK but 0 sites parsed",
        preview: createPreview(raw, 0),
      });
    } catch (error) {
      throwIfSignalAborted(options.signal);
      diagnostics.push({
        url,
        status: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  throwIfSignalAborted(options.signal);
  return {
    sites: [],
    resolvedEndpointUrl: null,
    rawPreview: {
      error: `No sites found in ${candidateUrls.length} URL candidate(s).`,
      attempts: diagnostics,
    },
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
    abortSignal?: AbortSignal;
  }
): Promise<{
  totals: Map<string, SiteTotal>;
  resolvedEndpointUrl: string;
  rawPreview: unknown;
  attemptUsed: TelemetryAttempt;
}> {
  const candidateUrls = buildTelemetryCandidateUrls(
    context,
    toNonEmptyString(options.endpointUrl)
  );
  const attempts = buildTelemetryAttempts(
    candidateUrls,
    options.preferredAttempt
  );
  let lastError: string | null = null;
  let lastRawPreview: unknown = null;

  for (const attempt of attempts) {
    throwIfSignalAborted(options.abortSignal);
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
        signal: options.abortSignal,
      });
      const totals = computeSiteDeltasByTelemetryPayload(
        raw,
        options.groupId,
        options.signal
      );
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
      throwIfSignalAborted(options.abortSignal);
      lastError =
        error instanceof Error ? error.message : "Unknown request error.";
    }
  }

  const previewSnippet =
    lastRawPreview === null
      ? ""
      : (() => {
          try {
            const serialized = JSON.stringify(lastRawPreview);
            return serialized.length > 700
              ? `${serialized.slice(0, 700)}...`
              : serialized;
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

export async function getTeslaPowerhubGroupProductionMetrics(
  context: TeslaPowerhubApiContext,
  options: {
    groupId: string;
    endpointUrl?: string | null;
    signal?: string | null;
    onProgress?: (progress: TeslaPowerhubMetricsProgress) => void;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
    fetchExternalIds?: boolean;
    includeDebugPreviews?: boolean;
    perSiteGapFillMode?: TeslaPowerhubPerSiteGapFillMode;
  }
): Promise<TeslaPowerhubProductionMetricsResult> {
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

  const globalSignal = createGlobalSignal(
    options.abortSignal,
    normalizeTimeoutMs(options.globalTimeoutMs, GLOBAL_TIMEOUT_MS)
  );
  const shouldPreview = options.includeDebugPreviews !== false;
  const shouldFetchExternalIds = options.fetchExternalIds !== false;
  const perSiteGapFillMode = options.perSiteGapFillMode ?? "deep";
  const perSiteGapFill = createPerSiteGapFillDebug(perSiteGapFillMode);
  const checkAborted = () => {
    if (globalSignal.aborted) {
      throw globalSignal.reason instanceof Error
        ? globalSignal.reason
        : new DOMException("Global timeout exceeded", "AbortError");
    }
  };

  emitProgress({
    currentStep: 0,
    totalSteps,
    message: "Starting Tesla Powerhub production request.",
  });
  // Always try both signals.  RGM (revenue-grade meter) is preferred for
  // accuracy; inverter AC meter is the fallback for sites without RGM data.
  const RGM_SIGNAL = "solar_energy_exported_rgm";
  const INV_SIGNAL = "solar_energy_exported";
  const primarySignal = toNonEmptyString(options.signal) ?? RGM_SIGNAL;
  const fallbackSignal = primarySignal === RGM_SIGNAL ? INV_SIGNAL : RGM_SIGNAL;
  const signal = primarySignal;
  emitProgress({
    currentStep: 1,
    totalSteps,
    message: "Requesting Tesla access token.",
  });
  checkAborted();
  const token = await requestClientCredentialsToken(context, {
    signal: globalSignal,
  });
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
  checkAborted();
  const siteResult = await fetchGroupSites(context, token.access_token, {
    groupId,
    endpointUrl: options.endpointUrl,
    signal: globalSignal,
  });
  emitProgress({
    currentStep: 2,
    totalSteps,
    message: `Group site inventory loaded (${siteResult.sites.length} sites discovered).`,
  });

  const now = new Date();
  const windows = buildWindowConfigs(now);
  const resolvedTelemetryEndpoints: Record<
    TeslaPowerhubWindowKey,
    string | null
  > = {
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
  const telemetryErrorsByWindow: Record<TeslaPowerhubWindowKey, string | null> =
    {
      daily: null,
      weekly: null,
      monthly: null,
      yearly: null,
      lifetime: null,
    };
  const totalsByWindow = new Map<
    TeslaPowerhubWindowKey,
    Map<string, SiteTotal>
  >();
  const siteSignalUsed = new Map<string, string>();

  // ---- Phase 1: Group-level query attempt (PARALLEL) -------------------------
  // All 5 time windows are queried concurrently.  Each window independently
  // discovers the working telemetry endpoint.
  const stepByWindow: Record<TeslaPowerhubWindowKey, number> = {
    daily: 3,
    weekly: 4,
    monthly: 5,
    yearly: 6,
    lifetime: 7,
  };

  checkAborted();
  await Promise.allSettled(
    windows.map(async window => {
      const step = stepByWindow[window.key];
      emitProgress({
        currentStep: step,
        totalSteps,
        windowKey: window.key,
        message: `Loading ${window.key} telemetry (RGM + inverter signals).`,
      });

      let primaryTotals = new Map<string, SiteTotal>();
      try {
        const primaryResult = await fetchTelemetryWindowTotals(
          context,
          token.access_token,
          {
            groupId,
            signal: primarySignal,
            startDatetime: window.startDatetime,
            endDatetime: window.endDatetime,
            period: window.period,
            endpointUrl: options.endpointUrl,
            abortSignal: globalSignal,
          }
        );
        primaryTotals = primaryResult.totals;
        resolvedTelemetryEndpoints[window.key] =
          primaryResult.resolvedEndpointUrl;
        telemetryPreviewByWindow[window.key] = primaryResult.rawPreview;
      } catch (error) {
        telemetryErrorsByWindow[window.key] =
          `Primary (${primarySignal}): ${error instanceof Error ? error.message : "Unknown error."}`;
      }

      let fallbackTotals = new Map<string, SiteTotal>();
      try {
        const fallbackResult = await fetchTelemetryWindowTotals(
          context,
          token.access_token,
          {
            groupId,
            signal: fallbackSignal,
            startDatetime: window.startDatetime,
            endDatetime: window.endDatetime,
            period: window.period,
            endpointUrl: options.endpointUrl,
            abortSignal: globalSignal,
          }
        );
        fallbackTotals = fallbackResult.totals;
        if (!resolvedTelemetryEndpoints[window.key]) {
          resolvedTelemetryEndpoints[window.key] =
            fallbackResult.resolvedEndpointUrl;
        }
      } catch (error) {
        const existing = telemetryErrorsByWindow[window.key];
        telemetryErrorsByWindow[window.key] =
          `${existing ? `${existing} | ` : ""}Fallback (${fallbackSignal}): ${error instanceof Error ? error.message : "Unknown error."}`;
      }

      // Merge: always prefer RGM data over inverter for revenue-grade accuracy.
      const merged = new Map<string, SiteTotal>();
      const actualRgmTotals =
        primarySignal === RGM_SIGNAL ? primaryTotals : fallbackTotals;
      const actualInvTotals =
        primarySignal === RGM_SIGNAL ? fallbackTotals : primaryTotals;
      const windowSiteIds = new Set([
        ...Array.from(primaryTotals.keys()),
        ...Array.from(fallbackTotals.keys()),
      ]);
      for (const siteId of Array.from(windowSiteIds)) {
        const rgmEntry = actualRgmTotals.get(siteId);
        const invEntry = actualInvTotals.get(siteId);
        if (rgmEntry && rgmEntry.totalKwh > 0) {
          merged.set(siteId, rgmEntry);
          if (!siteSignalUsed.has(siteId))
            siteSignalUsed.set(siteId, RGM_SIGNAL);
        } else if (invEntry && invEntry.totalKwh > 0) {
          merged.set(siteId, invEntry);
          if (!siteSignalUsed.has(siteId))
            siteSignalUsed.set(siteId, INV_SIGNAL);
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
        message: `${window.key} telemetry loaded (${merged.size} sites: ${actualRgmTotals.size} RGM, ${actualInvTotals.size} inverter).`,
      });
    })
  );

  // ---- Build combined site list from inventory + Phase 1 telemetry --------
  // The site inventory endpoint may return 0 sites if the group detail
  // endpoint doesn't embed a site list.  In that case, Phase 1 telemetry
  // data (from the /telemetry/history endpoint) may have discovered
  // individual site IDs.  Merge both sources so Phase 2 has sites to query.
  const combinedSiteMap = new Map<string, SiteDescriptor>();
  for (const site of siteResult.sites) {
    combinedSiteMap.set(site.siteId, site);
  }
  totalsByWindow.forEach(totals => {
    totals.forEach((total, siteId) => {
      if (siteId !== groupId && !combinedSiteMap.has(siteId)) {
        combinedSiteMap.set(siteId, {
          siteId,
          siteExternalId: null,
          siteName: total.siteName ?? null,
        });
      }
    });
  });
  const combinedSiteList = Array.from(combinedSiteMap.values());

  emitProgress({
    currentStep: 7,
    totalSteps,
    message: `Site list: ${siteResult.sites.length} from inventory + ${combinedSiteList.length - siteResult.sites.length} from telemetry = ${combinedSiteList.length} total.`,
  });

  // ---- Phase 2: Per-site gap-fill -----------------------------------------
  // Phase 1 group-level queries may return per-site data for MOST sites but
  // not all. Deep mode fills the gaps by querying individual sites; standard
  // mode records the missing coverage and returns only what the group query
  // actually provided so large portfolios do not fan out indefinitely.
  if (
    combinedSiteList.length > 0 &&
    !globalSignal.aborted &&
    perSiteGapFillMode === "group-only"
  ) {
    let skippedMissingCount = 0;
    for (const window of windows) {
      const existingTotals =
        totalsByWindow.get(window.key) ?? new Map<string, SiteTotal>();
      const missingSites = combinedSiteList.filter(
        site =>
          !existingTotals.has(site.siteId) ||
          existingTotals.get(site.siteId)!.totalKwh === 0
      );
      skippedMissingCount += missingSites.length;
      perSiteGapFill.windows[window.key] = {
        ...createPerSiteGapFillWindowDebug(),
        missingSiteCount: missingSites.length,
        skipped: missingSites.length > 0,
        skippedReason:
          missingSites.length > 0
            ? "Standard scan skips individual site telemetry fallback."
            : null,
      };
    }
    emitProgress({
      currentStep: 7,
      totalSteps,
      message:
        skippedMissingCount > 0
          ? `Per-site gap-fill skipped in standard scan (${skippedMissingCount} missing site-window checks avoided).`
          : "Per-site gap-fill not needed; group telemetry covered all discovered sites.",
    });
  } else if (combinedSiteList.length > 0 && !globalSignal.aborted) {
    const perSiteThrottle = createApiThrottle(4);

    // Single token refresh before the entire per-site phase.
    let perSiteToken = token.access_token;
    try {
      const refreshed = await requestClientCredentialsToken(context, {
        signal: globalSignal,
      });
      perSiteToken = refreshed.access_token;
    } catch {
      /* use previous token */
    }

    for (const window of windows) {
      if (globalSignal.aborted) break;
      const existingTotals =
        totalsByWindow.get(window.key) ?? new Map<string, SiteTotal>();
      const missingSites = combinedSiteList.filter(
        site =>
          !existingTotals.has(site.siteId) ||
          existingTotals.get(site.siteId)!.totalKwh === 0
      );
      if (missingSites.length === 0) continue;

      let perSiteOk = 0;
      let perSiteEmpty = 0;
      let perSiteErr = 0;
      let lastPerSiteError = "";

      perSiteGapFill.windows[window.key] = {
        ...createPerSiteGapFillWindowDebug(),
        missingSiteCount: missingSites.length,
        queriedSiteCount: missingSites.length,
      };

      emitProgress({
        currentStep: 7,
        totalSteps,
        windowKey: window.key,
        message: `Per-site ${window.key} gap-fill for ${missingSites.length} site(s) missing from group query.`,
      });

      const batchToken = perSiteToken;

      await mapConcurrent(missingSites, 4, async site => {
        if (globalSignal.aborted) return;
        await perSiteThrottle();
        try {
          const result = await fetchSingleSiteTelemetryTotal(
            context,
            batchToken,
            {
              siteId: site.siteId,
              signal: primarySignal,
              startDatetime: window.startDatetime,
              endDatetime: window.endDatetime,
              period: window.period,
              fallbackSignal,
              abortSignal: globalSignal,
            }
          );
          if (result) {
            perSiteOk++;
            existingTotals.set(site.siteId, {
              siteId: site.siteId,
              siteName: site.siteName ?? null,
              totalKwh: roundToFourDecimals(result.totalKwh),
            });
            if (!siteSignalUsed.has(site.siteId))
              siteSignalUsed.set(site.siteId, result.usedSignal);
          } else {
            perSiteEmpty++;
          }
        } catch (error) {
          perSiteErr++;
          if (!lastPerSiteError) {
            lastPerSiteError =
              error instanceof Error ? error.message : "Unknown error";
          }
        }

        const processed = perSiteOk + perSiteEmpty + perSiteErr;
        if (processed % 200 === 0) {
          emitProgress({
            currentStep: 7,
            totalSteps,
            windowKey: window.key,
            message: `Per-site ${window.key}: ${processed}/${missingSites.length} queried (${perSiteOk} OK, ${perSiteEmpty} empty, ${perSiteErr} errors).`,
          });
        }
      });

      perSiteGapFill.windows[window.key] = {
        ...perSiteGapFill.windows[window.key],
        ok: perSiteOk,
        empty: perSiteEmpty,
        errors: perSiteErr,
        firstError: lastPerSiteError || null,
      };
      totalsByWindow.set(window.key, existingTotals);
      if (perSiteOk > 0) telemetryErrorsByWindow[window.key] = null;

      emitProgress({
        currentStep: 7,
        totalSteps,
        windowKey: window.key,
        message: `Per-site ${window.key} gap-fill done: ${perSiteOk} OK, ${perSiteEmpty} empty, ${perSiteErr} errors (of ${missingSites.length} missing).${lastPerSiteError ? ` First error: ${lastPerSiteError.slice(0, 200)}` : ""}`,
      });
    }
  } else {
    emitProgress({
      currentStep: 7,
      totalSteps,
      message: `WARNING: No sites discovered from inventory or telemetry — cannot run per-site queries.`,
    });
  }
  // ---- End per-site gap-fill -----------------------------------------------

  // ---- Phase 3: Fetch STE external identifiers (opt-in) --------------------
  // The STE identifier (e.g. STE20250403-01158) lives in the individual
  // /asset/sites/{site_id} response.  Skipped when fetchExternalIds is false
  // (the adapter path does not need STE IDs for snapshot reads).
  let siteExternalIds = new Map<string, string>();

  if (shouldFetchExternalIds && !globalSignal.aborted) {
    const allDiscoveredSiteIds = new Set<string>();
    siteResult.sites.forEach(s => allDiscoveredSiteIds.add(s.siteId));
    totalsByWindow.forEach(totals => {
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
      const refreshed = await requestClientCredentialsToken(context, {
        signal: globalSignal,
      });
      steToken = refreshed.access_token;
    } catch {
      // Use original token if refresh fails.
    }

    siteExternalIds = await fetchSiteExternalIds(
      context,
      steToken,
      Array.from(allDiscoveredSiteIds),
      (fetched, total) => {
        emitProgress({
          currentStep: 8,
          totalSteps,
          message: `Fetching STE identifiers (${fetched}/${total}).`,
        });
      },
      globalSignal
    );

    emitProgress({
      currentStep: 8,
      totalSteps,
      message: `STE identifiers fetched (${siteExternalIds.size} found).`,
    });
  }
  // ---- End STE ID fetch --------------------------------------------------

  const successfulWindowCount = windows.filter(window => {
    const totals = totalsByWindow.get(window.key);
    if (!totals) return false;
    return Array.from(totals.keys()).some(siteId => siteId !== groupId);
  }).length;
  if (successfulWindowCount === 0 && !globalSignal.aborted) {
    const allErrors = Object.entries(telemetryErrorsByWindow)
      .filter(([, error]) => error)
      .map(([key, error]) => `${key}: ${error}`)
      .join(" | ");
    const groupOnlyHint =
      perSiteGapFillMode === "group-only"
        ? " Standard scan did not run individual site fallback; use deep per-site fallback only when a full slow sweep is acceptable."
        : "";
    throw new Error(
      `Unable to fetch per-site telemetry for group ${groupId}. Sites from inventory: ${siteResult.sites.length}, from telemetry: ${combinedSiteList.length - siteResult.sites.length}, total: ${combinedSiteList.length}. ${allErrors || "No per-site telemetry data returned for any window."}${groupOnlyHint}`.trim()
    );
  }

  // Use the combined site map (inventory + telemetry) as the base.
  // Also add any new site IDs discovered in Phase 2 per-site results.
  const siteMap = new Map<string, SiteDescriptor>(combinedSiteMap);
  Array.from(totalsByWindow.values()).forEach(totals => {
    Array.from(totals.values()).forEach(total => {
      if (!siteMap.has(total.siteId) && total.siteId !== groupId) {
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
  const hasTelemetryForSite = (siteId: string): boolean =>
    windows.some(window => totalsByWindow.get(window.key)?.has(siteId));

  const rows: TeslaPowerhubSiteProductionMetrics[] = Array.from(
    siteMap.values()
  )
    .filter(
      site =>
        site.siteId !== groupId &&
        (perSiteGapFillMode !== "group-only" ||
          hasTelemetryForSite(site.siteId))
    )
    .map(site => {
      const dailyRaw =
        totalsByWindow.get("daily")?.get(site.siteId)?.totalKwh ?? 0;
      const weeklyRaw =
        totalsByWindow.get("weekly")?.get(site.siteId)?.totalKwh ?? 0;
      const monthlyRaw =
        totalsByWindow.get("monthly")?.get(site.siteId)?.totalKwh ?? 0;
      const yearlyRaw =
        totalsByWindow.get("yearly")?.get(site.siteId)?.totalKwh ?? 0;
      const lifetimeRaw =
        totalsByWindow.get("lifetime")?.get(site.siteId)?.totalKwh ?? 0;
      // Clamp: longer windows must be >= shorter windows.  Different API
      // period granularities (15m / 1h / 6h / 1d / 7d) can cause the
      // max−min delta to be slightly lower for coarser periods.
      const daily = dailyRaw;
      const weekly = Math.max(weeklyRaw, daily);
      const monthly = Math.max(monthlyRaw, weekly);
      const yearly = Math.max(yearlyRaw, monthly);
      const lifetime = Math.max(lifetimeRaw, yearly);
      const usedSignal = siteSignalUsed.get(site.siteId) ?? primarySignal;
      return {
        siteId: site.siteId,
        siteExternalId:
          siteExternalIds.get(site.siteId) ?? site.siteExternalId ?? null,
        siteName:
          site.siteName ??
          totalsByWindow.get("lifetime")?.get(site.siteId)?.siteName ??
          null,
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
      siteSourcePreview: shouldPreview ? siteResult.rawPreview : null,
      telemetryPreviewByWindow: shouldPreview
        ? telemetryPreviewByWindow
        : {
            daily: null,
            weekly: null,
            monthly: null,
            yearly: null,
            lifetime: null,
          },
      telemetryErrorsByWindow,
      perSiteGapFill,
      windows: {
        daily: {
          startDatetime:
            windows.find(window => window.key === "daily")?.startDatetime ?? "",
          endDatetime:
            windows.find(window => window.key === "daily")?.endDatetime ?? "",
        },
        weekly: {
          startDatetime:
            windows.find(window => window.key === "weekly")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "weekly")?.endDatetime ?? "",
        },
        monthly: {
          startDatetime:
            windows.find(window => window.key === "monthly")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "monthly")?.endDatetime ?? "",
        },
        yearly: {
          startDatetime:
            windows.find(window => window.key === "yearly")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "yearly")?.endDatetime ?? "",
        },
        lifetime: {
          startDatetime:
            windows.find(window => window.key === "lifetime")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "lifetime")?.endDatetime ??
            "",
        },
      },
    },
  };
}

export async function getTeslaPowerhubAccessibleGroups(
  context: TeslaPowerhubApiContext,
  options?: {
    endpointUrl?: string | null;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
  }
): Promise<{
  groups: TeslaPowerhubGroupDescriptor[];
  resolvedEndpointUrl: string | null;
  debug: unknown;
}> {
  const globalSignal = createGlobalSignal(
    options?.abortSignal,
    normalizeTimeoutMs(options?.globalTimeoutMs, INVENTORY_GLOBAL_TIMEOUT_MS)
  );
  const token = await requestClientCredentialsToken(context, {
    signal: globalSignal,
  });
  const result = await fetchAccessibleGroups(context, token.access_token, {
    endpointUrl: options?.endpointUrl ?? null,
    signal: globalSignal,
    requestTimeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
  });
  return {
    groups: result.groups,
    resolvedEndpointUrl: result.resolvedEndpointUrl,
    debug: result.rawPreview,
  };
}

function dedupeSiteDescriptors(
  sites: TeslaPowerhubSiteDescriptor[]
): TeslaPowerhubSiteDescriptor[] {
  const sitesById = new Map<string, TeslaPowerhubSiteDescriptor>();
  for (const site of sites) {
    const existing = sitesById.get(site.siteId);
    if (
      !existing ||
      (!existing.siteName && site.siteName) ||
      (!existing.siteExternalId && site.siteExternalId)
    ) {
      sitesById.set(site.siteId, {
        siteId: site.siteId,
        siteName: site.siteName ?? existing?.siteName ?? null,
        siteExternalId: site.siteExternalId ?? existing?.siteExternalId ?? null,
      });
    }
  }
  return Array.from(sitesById.values()).sort((a, b) => {
    const nameA = (a.siteName ?? "").toLowerCase();
    const nameB = (b.siteName ?? "").toLowerCase();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    return a.siteId.localeCompare(b.siteId);
  });
}

function buildTokenInfo(token: TeslaPowerhubTokenResponse) {
  return {
    tokenType: token.token_type ?? "Bearer",
    expiresIn: typeof token.expires_in === "number" ? token.expires_in : null,
    scope: token.scope ?? null,
  };
}

async function listTeslaPowerhubSitesWithToken(
  context: TeslaPowerhubApiContext,
  token: TeslaPowerhubTokenResponse,
  options?: {
    groupId?: string | null;
    endpointUrl?: string | null;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
  }
): Promise<TeslaPowerhubSiteInventoryResult> {
  const globalSignal = createGlobalSignal(
    options?.abortSignal,
    normalizeTimeoutMs(options?.globalTimeoutMs, INVENTORY_GLOBAL_TIMEOUT_MS)
  );
  const groupId = toNonEmptyString(options?.groupId);
  const endpointUrl = toNonEmptyString(options?.endpointUrl);
  const tokenInfo = buildTokenInfo(token);

  if (groupId) {
    const result = await fetchGroupSites(context, token.access_token, {
      groupId,
      endpointUrl,
      signal: globalSignal,
      requestTimeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    });
    throwIfSignalAborted(globalSignal);
    return {
      sites: dedupeSiteDescriptors(result.sites),
      requestedGroupId: groupId,
      groups: [{ groupId, groupName: null }],
      resolvedSitesEndpointUrl: result.resolvedEndpointUrl,
      token: tokenInfo,
      debug: {
        mode: "group",
        groupId,
        siteInventory: result.rawPreview,
      },
    };
  }

  const groupDiscovery = await fetchAccessibleGroups(
    context,
    token.access_token,
    {
      endpointUrl,
      signal: globalSignal,
      requestTimeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    }
  );

  if (groupDiscovery.groups.length > 0) {
    const sites: TeslaPowerhubSiteDescriptor[] = [];
    const groupAttempts: Array<{
      groupId: string;
      groupName: string | null;
      siteCount: number;
      resolvedEndpointUrl: string | null;
      preview: unknown;
    }> = [];

    for (const group of groupDiscovery.groups) {
      if (globalSignal.aborted) break;
      const result = await fetchGroupSites(context, token.access_token, {
        groupId: group.groupId,
        endpointUrl,
        signal: globalSignal,
        requestTimeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
      });
      sites.push(...result.sites);
      groupAttempts.push({
        groupId: group.groupId,
        groupName: group.groupName,
        siteCount: result.sites.length,
        resolvedEndpointUrl: result.resolvedEndpointUrl,
        preview: result.rawPreview,
      });
    }

    throwIfSignalAborted(globalSignal);
    return {
      sites: dedupeSiteDescriptors(sites),
      requestedGroupId: "auto",
      groups: groupDiscovery.groups,
      resolvedSitesEndpointUrl:
        groupAttempts.find(attempt => attempt.resolvedEndpointUrl)
          ?.resolvedEndpointUrl ?? groupDiscovery.resolvedEndpointUrl,
      token: tokenInfo,
      debug: {
        mode: "group-discovery",
        groupDiscovery: groupDiscovery.rawPreview,
        groupAttempts,
      },
    };
  }

  const siteDiscovery = await fetchAccessibleSites(
    context,
    token.access_token,
    {
      endpointUrl,
      signal: globalSignal,
      requestTimeoutMs: DISCOVERY_REQUEST_TIMEOUT_MS,
    }
  );

  throwIfSignalAborted(globalSignal);
  return {
    sites: dedupeSiteDescriptors(siteDiscovery.sites),
    requestedGroupId: null,
    groups: [],
    resolvedSitesEndpointUrl: siteDiscovery.resolvedEndpointUrl,
    token: tokenInfo,
    debug: {
      mode: "site-discovery",
      groupDiscovery: groupDiscovery.rawPreview,
      siteDiscovery: siteDiscovery.rawPreview,
    },
  };
}

export async function listTeslaPowerhubSites(
  context: TeslaPowerhubApiContext,
  options?: {
    groupId?: string | null;
    endpointUrl?: string | null;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
  }
): Promise<TeslaPowerhubSiteInventoryResult> {
  const globalSignal = createGlobalSignal(
    options?.abortSignal,
    normalizeTimeoutMs(options?.globalTimeoutMs, INVENTORY_GLOBAL_TIMEOUT_MS)
  );
  const token = await requestClientCredentialsToken(context, {
    signal: globalSignal,
  });
  return listTeslaPowerhubSitesWithToken(context, token, {
    ...options,
    abortSignal: globalSignal,
  });
}

function matchesSiteDescriptor(
  site: TeslaPowerhubSiteDescriptor,
  requestedSiteId: string
): boolean {
  const normalized = requestedSiteId.trim();
  return (
    site.siteId === normalized ||
    site.siteExternalId === normalized ||
    site.siteName === normalized
  );
}

function dataSourceFromSignal(
  signal: string | null
): "rgm" | "inverter" | null {
  if (signal === "solar_energy_exported_rgm") return "rgm";
  if (signal === "solar_energy_exported") return "inverter";
  return null;
}

export async function getTeslaPowerhubSiteSnapshot(
  context: TeslaPowerhubApiContext,
  options: {
    siteId: string;
    groupId?: string | null;
    endpointUrl?: string | null;
    signal?: string | null;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
  }
): Promise<TeslaPowerhubSiteSnapshotResult> {
  const requestedSiteId = options.siteId.trim();
  if (!requestedSiteId) {
    throw new Error("siteId is required.");
  }

  const globalSignal = createGlobalSignal(
    options.abortSignal,
    normalizeTimeoutMs(options.globalTimeoutMs, SITE_SNAPSHOT_GLOBAL_TIMEOUT_MS)
  );
  const token = await requestClientCredentialsToken(context, {
    signal: globalSignal,
  });

  let siteDescriptor: TeslaPowerhubSiteDescriptor | null = null;
  let inventoryError: string | null = null;
  try {
    const inventory = await listTeslaPowerhubSitesWithToken(context, token, {
      groupId: options.groupId ?? null,
      endpointUrl: options.endpointUrl ?? null,
      abortSignal: globalSignal,
      globalTimeoutMs: INVENTORY_GLOBAL_TIMEOUT_MS,
    });
    siteDescriptor =
      inventory.sites.find(site =>
        matchesSiteDescriptor(site, requestedSiteId)
      ) ?? null;
  } catch (error) {
    throwIfSignalAborted(globalSignal);
    inventoryError = error instanceof Error ? error.message : String(error);
  }

  const telemetrySiteId = siteDescriptor?.siteId ?? requestedSiteId;
  const RGM_SIGNAL = "solar_energy_exported_rgm";
  const INV_SIGNAL = "solar_energy_exported";
  const primarySignal = toNonEmptyString(options.signal) ?? RGM_SIGNAL;
  const fallbackSignal = primarySignal === RGM_SIGNAL ? INV_SIGNAL : RGM_SIGNAL;
  const windows = buildWindowConfigs(new Date());

  const windowResults = await Promise.all(
    windows.map(async window => {
      throwIfSignalAborted(globalSignal);
      try {
        const result = await fetchSingleSiteTelemetryTotal(
          context,
          token.access_token,
          {
            siteId: telemetrySiteId,
            signal: primarySignal,
            startDatetime: window.startDatetime,
            endDatetime: window.endDatetime,
            period: window.period,
            fallbackSignal,
            abortSignal: globalSignal,
          }
        );
        return {
          key: window.key,
          result,
          error: null as string | null,
        };
      } catch (error) {
        throwIfSignalAborted(globalSignal);
        return {
          key: window.key,
          result: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );

  const totalsByWindow = new Map<
    TeslaPowerhubWindowKey,
    { totalKwh: number; usedSignal: string }
  >();
  const errorsByWindow = new Map<TeslaPowerhubWindowKey, string>();
  for (const entry of windowResults) {
    if (entry.result) {
      totalsByWindow.set(entry.key, {
        totalKwh: entry.result.totalKwh,
        usedSignal: entry.result.usedSignal,
      });
    } else if (entry.error) {
      errorsByWindow.set(entry.key, entry.error);
    }
  }

  const hasTelemetry = totalsByWindow.size > 0;
  if (!hasTelemetry) {
    const errorDetails = Array.from(errorsByWindow.entries())
      .map(([key, error]) => `${key}: ${error}`)
      .join(" | ");
    return {
      siteId: telemetrySiteId,
      status: "Not Found",
      siteName: siteDescriptor?.siteName ?? null,
      siteExternalId: siteDescriptor?.siteExternalId ?? null,
      dailyKwh: null,
      weeklyKwh: null,
      monthlyKwh: null,
      yearlyKwh: null,
      lifetimeKwh: null,
      dataSource: null,
      error:
        errorDetails ||
        inventoryError ||
        "No Tesla Powerhub telemetry returned for this site.",
    };
  }

  const dailyRaw = totalsByWindow.get("daily")?.totalKwh ?? 0;
  const weeklyRaw = totalsByWindow.get("weekly")?.totalKwh ?? 0;
  const monthlyRaw = totalsByWindow.get("monthly")?.totalKwh ?? 0;
  const yearlyRaw = totalsByWindow.get("yearly")?.totalKwh ?? 0;
  const lifetimeRaw = totalsByWindow.get("lifetime")?.totalKwh ?? 0;
  const daily = dailyRaw;
  const weekly = Math.max(weeklyRaw, daily);
  const monthly = Math.max(monthlyRaw, weekly);
  const yearly = Math.max(yearlyRaw, monthly);
  const lifetime = Math.max(lifetimeRaw, yearly);
  const usedSignal =
    totalsByWindow.get("lifetime")?.usedSignal ??
    totalsByWindow.get("yearly")?.usedSignal ??
    totalsByWindow.get("monthly")?.usedSignal ??
    totalsByWindow.get("weekly")?.usedSignal ??
    totalsByWindow.get("daily")?.usedSignal ??
    primarySignal;

  return {
    siteId: telemetrySiteId,
    status: "Found",
    siteName: siteDescriptor?.siteName ?? null,
    siteExternalId: siteDescriptor?.siteExternalId ?? null,
    dailyKwh: roundToFourDecimals(daily),
    weeklyKwh: roundToFourDecimals(weekly),
    monthlyKwh: roundToFourDecimals(monthly),
    yearlyKwh: roundToFourDecimals(yearly),
    lifetimeKwh: roundToFourDecimals(lifetime),
    dataSource: dataSourceFromSignal(usedSignal),
    error: null,
  };
}

async function getTeslaPowerhubSiteInventoryProductionMetrics(
  context: TeslaPowerhubApiContext,
  token: TeslaPowerhubTokenResponse,
  siteResult: {
    sites: SiteDescriptor[];
    resolvedEndpointUrl: string | null;
    rawPreview: unknown;
  },
  options: {
    endpointUrl?: string | null;
    signal?: string | null;
    onProgress?: (progress: TeslaPowerhubMetricsProgress) => void;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
    fetchExternalIds?: boolean;
    includeDebugPreviews?: boolean;
  }
): Promise<TeslaPowerhubProductionMetricsResult> {
  const sites = siteResult.sites;
  const totalSteps = 8;
  const shouldPreview = options.includeDebugPreviews !== false;
  const globalSignal = createGlobalSignal(
    options.abortSignal,
    normalizeTimeoutMs(options.globalTimeoutMs, GLOBAL_TIMEOUT_MS)
  );
  const RGM_SIGNAL = "solar_energy_exported_rgm";
  const INV_SIGNAL = "solar_energy_exported";
  const primarySignal = toNonEmptyString(options.signal) ?? RGM_SIGNAL;
  const fallbackSignal = primarySignal === RGM_SIGNAL ? INV_SIGNAL : RGM_SIGNAL;
  const windows = buildWindowConfigs(new Date());
  const totalsByWindow = new Map<
    TeslaPowerhubWindowKey,
    Map<string, SiteTotal>
  >();
  const telemetryPreviewByWindow: Record<TeslaPowerhubWindowKey, unknown> = {
    daily: null,
    weekly: null,
    monthly: null,
    yearly: null,
    lifetime: null,
  };
  const telemetryErrorsByWindow: Record<TeslaPowerhubWindowKey, string | null> =
    {
      daily: null,
      weekly: null,
      monthly: null,
      yearly: null,
      lifetime: null,
    };
  const resolvedTelemetryEndpoints: Record<
    TeslaPowerhubWindowKey,
    string | null
  > = {
    daily: null,
    weekly: null,
    monthly: null,
    yearly: null,
    lifetime: null,
  };
  const siteSignalUsed = new Map<string, string>();
  const throttle = createApiThrottle(4);

  options.onProgress?.({
    currentStep: 2,
    totalSteps,
    message: `Loaded Tesla site inventory without a group ID (${sites.length} sites).`,
  });

  for (const window of windows) {
    const totals = new Map<string, SiteTotal>();
    let ok = 0;
    let empty = 0;
    let errors = 0;
    let firstError: string | null = null;

    options.onProgress?.({
      currentStep:
        window.key === "daily"
          ? 3
          : window.key === "weekly"
            ? 4
            : window.key === "monthly"
              ? 5
              : window.key === "yearly"
                ? 6
                : 7,
      totalSteps,
      windowKey: window.key,
      message: `Loading ${window.key} telemetry for ${sites.length} sites without a group ID.`,
    });

    await mapConcurrent(sites, 4, async site => {
      if (globalSignal.aborted) return;
      await throttle();
      try {
        const result = await fetchSingleSiteTelemetryTotal(
          context,
          token.access_token,
          {
            siteId: site.siteId,
            signal: primarySignal,
            startDatetime: window.startDatetime,
            endDatetime: window.endDatetime,
            period: window.period,
            fallbackSignal,
            abortSignal: globalSignal,
          }
        );
        if (result) {
          ok += 1;
          totals.set(site.siteId, {
            siteId: site.siteId,
            siteName: site.siteName,
            totalKwh: roundToFourDecimals(result.totalKwh),
          });
          if (!siteSignalUsed.has(site.siteId)) {
            siteSignalUsed.set(site.siteId, result.usedSignal);
          }
          if (!telemetryPreviewByWindow[window.key]) {
            telemetryPreviewByWindow[window.key] = result.rawPreview;
          }
        } else {
          empty += 1;
        }
      } catch (error) {
        errors += 1;
        firstError ??= error instanceof Error ? error.message : "Unknown error";
      }
    });

    totalsByWindow.set(window.key, totals);
    telemetryErrorsByWindow[window.key] =
      ok > 0
        ? null
        : (firstError ??
          `No ${window.key} telemetry returned for ${sites.length} discovered sites.`);
    options.onProgress?.({
      currentStep:
        window.key === "daily"
          ? 3
          : window.key === "weekly"
            ? 4
            : window.key === "monthly"
              ? 5
              : window.key === "yearly"
                ? 6
                : 7,
      totalSteps,
      windowKey: window.key,
      message: `${window.key} telemetry loaded (${ok} OK, ${empty} empty, ${errors} errors).`,
    });
  }

  let siteExternalIds = new Map<string, string>();
  if (options.fetchExternalIds !== false) {
    siteExternalIds = await fetchSiteExternalIds(
      context,
      token.access_token,
      sites.map(site => site.siteId),
      undefined,
      globalSignal
    );
  }

  const successfulWindowCount = windows.filter(
    window => (totalsByWindow.get(window.key)?.size ?? 0) > 0
  ).length;
  if (successfulWindowCount === 0 && !globalSignal.aborted) {
    const allErrors = Object.entries(telemetryErrorsByWindow)
      .filter(([, error]) => error)
      .map(([key, error]) => `${key}: ${error}`)
      .join(" | ");
    throw new Error(
      `Unable to fetch Tesla Powerhub telemetry without a group ID. Sites discovered: ${sites.length}. ${allErrors}`.trim()
    );
  }

  const rows: TeslaPowerhubSiteProductionMetrics[] = sites.map(site => {
    const dailyRaw =
      totalsByWindow.get("daily")?.get(site.siteId)?.totalKwh ?? 0;
    const weeklyRaw =
      totalsByWindow.get("weekly")?.get(site.siteId)?.totalKwh ?? 0;
    const monthlyRaw =
      totalsByWindow.get("monthly")?.get(site.siteId)?.totalKwh ?? 0;
    const yearlyRaw =
      totalsByWindow.get("yearly")?.get(site.siteId)?.totalKwh ?? 0;
    const lifetimeRaw =
      totalsByWindow.get("lifetime")?.get(site.siteId)?.totalKwh ?? 0;
    const daily = dailyRaw;
    const weekly = Math.max(weeklyRaw, daily);
    const monthly = Math.max(monthlyRaw, weekly);
    const yearly = Math.max(yearlyRaw, monthly);
    const lifetime = Math.max(lifetimeRaw, yearly);
    const usedSignal = siteSignalUsed.get(site.siteId) ?? primarySignal;
    return {
      siteId: site.siteId,
      siteExternalId:
        siteExternalIds.get(site.siteId) ?? site.siteExternalId ?? null,
      siteName: site.siteName,
      dailyKwh: roundToFourDecimals(daily),
      weeklyKwh: roundToFourDecimals(weekly),
      monthlyKwh: roundToFourDecimals(monthly),
      yearlyKwh: roundToFourDecimals(yearly),
      lifetimeKwh: roundToFourDecimals(lifetime),
      dataSource:
        usedSignal === RGM_SIGNAL
          ? "rgm"
          : usedSignal === INV_SIGNAL
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

  options.onProgress?.({
    currentStep: totalSteps,
    totalSteps,
    message: `Production metrics ready (${rows.length} sites, no group ID required).`,
  });

  return {
    sites: rows,
    requestedGroupId: "site-inventory",
    signal: primarySignal,
    resolvedSitesEndpointUrl: siteResult.resolvedEndpointUrl,
    resolvedTelemetryEndpoints,
    token: {
      tokenType: token.token_type ?? "Bearer",
      expiresIn: typeof token.expires_in === "number" ? token.expires_in : null,
      scope: token.scope ?? null,
    },
    debug: {
      siteSourcePreview: shouldPreview ? siteResult.rawPreview : null,
      telemetryPreviewByWindow: shouldPreview
        ? telemetryPreviewByWindow
        : {
            daily: null,
            weekly: null,
            monthly: null,
            yearly: null,
            lifetime: null,
          },
      telemetryErrorsByWindow,
      windows: {
        daily: {
          startDatetime:
            windows.find(window => window.key === "daily")?.startDatetime ?? "",
          endDatetime:
            windows.find(window => window.key === "daily")?.endDatetime ?? "",
        },
        weekly: {
          startDatetime:
            windows.find(window => window.key === "weekly")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "weekly")?.endDatetime ?? "",
        },
        monthly: {
          startDatetime:
            windows.find(window => window.key === "monthly")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "monthly")?.endDatetime ?? "",
        },
        yearly: {
          startDatetime:
            windows.find(window => window.key === "yearly")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "yearly")?.endDatetime ?? "",
        },
        lifetime: {
          startDatetime:
            windows.find(window => window.key === "lifetime")?.startDatetime ??
            "",
          endDatetime:
            windows.find(window => window.key === "lifetime")?.endDatetime ??
            "",
        },
      },
    },
  };
}

export async function getTeslaPowerhubProductionMetrics(
  context: TeslaPowerhubApiContext,
  options: {
    groupId?: string | null;
    endpointUrl?: string | null;
    signal?: string | null;
    onProgress?: (progress: TeslaPowerhubMetricsProgress) => void;
    abortSignal?: AbortSignal;
    globalTimeoutMs?: number;
    fetchExternalIds?: boolean;
    includeDebugPreviews?: boolean;
    perSiteGapFillMode?: TeslaPowerhubPerSiteGapFillMode;
  }
): Promise<TeslaPowerhubProductionMetricsResult> {
  const groupId = toNonEmptyString(options.groupId);
  if (groupId) {
    return getTeslaPowerhubGroupProductionMetrics(context, {
      ...options,
      groupId,
    });
  }

  const globalSignal = createGlobalSignal(
    options.abortSignal,
    normalizeTimeoutMs(options.globalTimeoutMs, GLOBAL_TIMEOUT_MS)
  );
  const shouldPreview = options.includeDebugPreviews !== false;
  const token = await requestClientCredentialsToken(context, {
    signal: globalSignal,
  });
  const groupsResult = await fetchAccessibleGroups(
    context,
    token.access_token,
    {
      endpointUrl: options.endpointUrl ?? null,
      signal: globalSignal,
    }
  );
  const groups = groupsResult.groups;

  if (groups.length === 0) {
    const siteResult = await fetchAccessibleSites(context, token.access_token, {
      endpointUrl: options.endpointUrl ?? null,
      signal: globalSignal,
    });
    if (siteResult.sites.length > 0) {
      return getTeslaPowerhubSiteInventoryProductionMetrics(
        context,
        token,
        siteResult,
        {
          ...options,
          abortSignal: globalSignal,
        }
      );
    }
    throw new Error(
      "Tesla Powerhub group ID was not provided, and the credential did not expose discoverable groups or sites."
    );
  }

  options.onProgress?.({
    currentStep: 0,
    totalSteps: Math.max(1, groups.length * 8),
    message: `Discovered ${groups.length} Tesla Powerhub group${
      groups.length === 1 ? "" : "s"
    }.`,
  });

  const results: TeslaPowerhubProductionMetricsResult[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    options.onProgress?.({
      currentStep: index * 8,
      totalSteps: groups.length * 8,
      message: `Loading Tesla Powerhub group ${index + 1}/${groups.length}${
        group.groupName ? ` (${group.groupName})` : ""
      }.`,
    });
    const result = await getTeslaPowerhubGroupProductionMetrics(context, {
      ...options,
      groupId: group.groupId,
      abortSignal: globalSignal,
      onProgress: progress => {
        options.onProgress?.({
          ...progress,
          currentStep: index * 8 + progress.currentStep,
          totalSteps: groups.length * 8,
          message: `Group ${index + 1}/${groups.length}: ${progress.message}`,
        });
      },
    });
    results.push(result);
  }

  const first = results[0];
  const sitesById = new Map<string, TeslaPowerhubSiteProductionMetrics>();
  for (const result of results) {
    for (const site of result.sites) {
      const existing = sitesById.get(site.siteId);
      if (
        !existing ||
        site.lifetimeKwh > existing.lifetimeKwh ||
        (!existing.siteName && site.siteName)
      ) {
        sitesById.set(site.siteId, site);
      }
    }
  }

  const sites = Array.from(sitesById.values()).sort((a, b) => {
    const nameA = (a.siteName ?? "").toLowerCase();
    const nameB = (b.siteName ?? "").toLowerCase();
    if (nameA !== nameB) return nameA.localeCompare(nameB);
    return a.siteId.localeCompare(b.siteId);
  });

  const windows = first.debug.windows;
  const resolvedTelemetryEndpoints = {
    ...first.resolvedTelemetryEndpoints,
  };
  const telemetryErrorsByWindow = {
    ...first.debug.telemetryErrorsByWindow,
  };
  const telemetryPreviewByWindow = {
    ...first.debug.telemetryPreviewByWindow,
  };

  for (const result of results.slice(1)) {
    for (const key of Object.keys(
      resolvedTelemetryEndpoints
    ) as TeslaPowerhubWindowKey[]) {
      resolvedTelemetryEndpoints[key] =
        resolvedTelemetryEndpoints[key] ??
        result.resolvedTelemetryEndpoints[key];
      telemetryErrorsByWindow[key] =
        telemetryErrorsByWindow[key] ??
        result.debug.telemetryErrorsByWindow[key];
      telemetryPreviewByWindow[key] =
        telemetryPreviewByWindow[key] ??
        result.debug.telemetryPreviewByWindow[key];
    }
  }

  options.onProgress?.({
    currentStep: groups.length * 8,
    totalSteps: groups.length * 8,
    message: `Production metrics ready (${sites.length} sites across ${groups.length} groups).`,
  });

  return {
    sites,
    requestedGroupId: "auto",
    signal: first.signal,
    resolvedSitesEndpointUrl: groupsResult.resolvedEndpointUrl,
    resolvedTelemetryEndpoints,
    token: first.token,
    debug: {
      siteSourcePreview: shouldPreview
        ? {
            groupDiscovery: groupsResult.rawPreview,
            groups,
            groupResults: results.map(result => ({
              requestedGroupId: result.requestedGroupId,
              siteCount: result.sites.length,
              resolvedSitesEndpointUrl: result.resolvedSitesEndpointUrl,
            })),
          }
        : null,
      telemetryPreviewByWindow: shouldPreview
        ? telemetryPreviewByWindow
        : {
            daily: null,
            weekly: null,
            monthly: null,
            yearly: null,
            lifetime: null,
          },
      telemetryErrorsByWindow,
      windows,
    },
  };
}

export function normalizeTeslaPowerhubUrl(
  raw: string | null | undefined
): string | null {
  const normalized = toNonEmptyString(raw);
  if (!normalized) return null;
  return normalized.replace(/\/+$/, "");
}

/*
 * In-memory group-metrics cache. A single Tesla Powerhub group
 * snapshot spans *all* sites in that group (each
 * `getTeslaPowerhubGroupProductionMetrics` call fetches the group
 * wholesale). The shared MeterReadsPage loops mutations one site at a
 * time; without memoization, N sites in the same group trigger N
 * redundant full-group fetches. This cache holds each (userId+groupId)
 * result for 5 minutes so the bulk loop amortizes to a single upstream
 * hit per group, per run.
 */
type CachedGroupMetrics = TeslaPowerhubProductionMetricsResult;
const TESLA_POWERHUB_GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const teslaPowerhubGroupCache = new Map<
  string,
  { expiresAt: number; value: CachedGroupMetrics }
>();

export async function getTeslaPowerhubGroupProductionMetricsCached(
  context: TeslaPowerhubApiContext,
  options: {
    groupId?: string | null;
    cacheKey: string;
    endpointUrl?: string | null;
    signal?: string | null;
  }
): Promise<CachedGroupMetrics> {
  const now = Date.now();
  const cached = teslaPowerhubGroupCache.get(options.cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  const result = await getTeslaPowerhubProductionMetrics(context, {
    groupId: options.groupId ?? null,
    endpointUrl: options.endpointUrl ?? null,
    signal: options.signal ?? null,
  });
  teslaPowerhubGroupCache.set(options.cacheKey, {
    expiresAt: now + TESLA_POWERHUB_GROUP_CACHE_TTL_MS,
    value: result,
  });
  return result;
}

// ────────────────────────────────────────────────────────────────────
// Test surface — internal pure helpers + ONE network-bound integration
// path exported for unit-test access without polluting the production
// import surface. Concern #1 from the PRs 366-383 review: vendor-
// restoration PRs (#368, #371, #373) shipped without adapter-level
// vitest specs. Tests against this surface form the first slices of
// that coverage gap.
//
// Slice 1 (#389): pure helpers below the divider.
// Slice 3 (this PR): adds `requestClientCredentialsToken` — the
//   token-fetch path. It's the simplest network-bound entry (single
//   fetch, 4 distinct outcomes: 200 / non-2xx / timeout / network
//   error), so it's the natural place to establish the fetch-mock
//   pattern (`vi.stubGlobal("fetch", ...)`) for solar adapters
//   before tackling the multi-fetch site-discovery + telemetry paths.
//
// Slice 4a (#401): adds `fetchJsonWithBearerToken` — the
//   foundational helper EVERY multi-fetch path uses. A regression
//   here breaks every downstream path. Outcomes: 200+JSON / non-OK /
//   wrong content-type / timeout / external abort / network error.
//
// Slice 4b (#402): adds the 3 URL-candidate iterators that wrap
//   `fetchJsonWithBearerToken` — `fetchAccessibleSites`,
//   `fetchAccessibleGroups`, `fetchGroupSites`. Shared shape: build
//   N candidate URLs, try each, return first non-empty success,
//   accumulate diagnostics, return empty result if all fail.
//   `fetchAccessibleGroups` also has an early-return for endpointUrl
//   that already encodes a group ID.
//
// Slice 4c PR-A (#403): adds `fetchSingleSiteTelemetryTotal` — the
//   simplest telemetry entry. Single fetch (or two, fallback) against
//   `/telemetry/history`; builds canonical query params; parses
//   cumulative-meter payload via `computeSiteDeltasByTelemetryPayload`
//   to derive max-min delta in kWh; primary→fallback signal logic
//   for RGM-meter → inverter graceful degradation.
//
// Slice 4c PR-B (#404): adds `fetchSiteExternalIds` — STE ID
//   extraction across N sites with concurrency + rate-limiting. 3-
//   priority scan (candidate fields → any-string → site_name).
//   Per-site errors tolerated.
//
// Slice 4c PR-C (this PR): adds `fetchTelemetryWindowTotals` — the
//   group-level telemetry orchestrator. Builds candidate URLs (1-3
//   based on override) × group-rollup variants (null / "sum") →
//   ordered TelemetryAttempt list. Iterates: history-without-rollup
//   first (may return per-site breakdowns), history-with-rollup-sum
//   second (group-aggregated), aggregate endpoint last. Returns the
//   first attempt that yields per-site totals — UNLESS
//   `allowEmptyTotals` is set, in which case the first 200 wins
//   even if totals are empty (used for the lifetime/zero-window
//   path). Throws with last-error + payload preview if all attempts
//   fail.
//
// Still to come: top-level `getTeslaPowerhubProductionMetrics`.
// ────────────────────────────────────────────────────────────────────
export const __TEST_ONLY__ = {
  normalizeTimeoutMs,
  isAbortOrTimeoutError,
  buildBasicAuth,
  parseJsonBody,
  formatPayloadPreview,
  parseTokenPayload,
  parseTimestampMs,
  isLikelySiteIdKey,
  requestClientCredentialsToken,
  fetchJsonWithBearerToken,
  fetchAccessibleSites,
  fetchAccessibleGroups,
  fetchGroupSites,
  fetchSingleSiteTelemetryTotal,
  fetchSiteExternalIds,
  fetchTelemetryWindowTotals,
};
