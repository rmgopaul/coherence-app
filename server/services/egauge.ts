import { createHash, randomBytes } from "node:crypto";

export const EGAUGE_DEFAULT_BASE_URL = "https://YOUR-METER.d.egauge.net";
export const EGAUGE_PORTFOLIO_BASE_URL = "https://www.egauge.net";

export type EgaugeAccessType = "public" | "user_login" | "site_login" | "portfolio_login";

export type EgaugeApiContext = {
  baseUrl?: string | null;
  accessType?: EgaugeAccessType | null;
  username?: string | null;
  password?: string | null;
};

const EGAUGE_REQUEST_TIMEOUT_MS = 20_000;

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function truncate(value: string, maxLength = 300): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}…`;
}

function withHttpsIfMissing(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function isEgaugePortalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "egauge.net" || normalized === "www.egauge.net";
}

function tryConvertPortalDevicesUrlToMeterBase(parsed: URL): string | null {
  if (!isEgaugePortalHost(parsed.hostname)) return null;

  const segments = parsed.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length < 2) return null;
  if (segments[0].toLowerCase() !== "devices") return null;
  if (!/^[A-Za-z0-9._-]+$/.test(segments[1])) return null;

  return `https://${segments[1]}.d.egauge.net`;
}

export function normalizeEgaugeBaseUrl(value: string | null | undefined): string {
  const raw = toNonEmptyString(value);
  if (!raw) {
    throw new Error(
      `eGauge URL is required. Use a meter URL such as ${EGAUGE_DEFAULT_BASE_URL}.`
    );
  }

  const normalizedInput = withHttpsIfMissing(raw);

  let parsed: URL;
  try {
    parsed = new URL(normalizedInput);
  } catch {
    throw new Error("eGauge base URL is invalid.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("eGauge URL must start with http:// or https://.");
  }

  const convertedPortalUrl = tryConvertPortalDevicesUrlToMeterBase(parsed);
  if (convertedPortalUrl) {
    return convertedPortalUrl;
  }

  if (isEgaugePortalHost(parsed.hostname)) {
    throw new Error(
      `The URL points to the eGauge portal, not a meter API host. Use a meter URL such as ${EGAUGE_DEFAULT_BASE_URL}.`
    );
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  const apiMarker = path.toLowerCase().indexOf("/api");
  if (apiMarker >= 0) {
    path = path.slice(0, apiMarker);
  }

  return `${parsed.origin}${path}`.replace(/\/+$/, "");
}

function isCredentialAccess(accessType: EgaugeAccessType): boolean {
  return accessType === "user_login" || accessType === "site_login" || accessType === "portfolio_login";
}

function normalizeEgaugeAccessType(value: unknown): EgaugeAccessType {
  if (value === "user_login" || value === "site_login" || value === "portfolio_login" || value === "public") return value;
  return "public";
}

export function normalizeEgaugePortfolioBaseUrl(value: string | null | undefined): string {
  const raw = toNonEmptyString(value) ?? EGAUGE_PORTFOLIO_BASE_URL;
  const normalizedInput = withHttpsIfMissing(raw);

  let parsed: URL;
  try {
    parsed = new URL(normalizedInput);
  } catch {
    throw new Error("eGauge portfolio URL is invalid.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("eGauge portfolio URL must start with http:// or https://.");
  }

  if (!/(^|\.)egauge\.net$/i.test(parsed.hostname)) {
    throw new Error(`Portfolio URL must be on egauge.net (example: ${EGAUGE_PORTFOLIO_BASE_URL}).`);
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  const eguardMarker = path.toLowerCase().indexOf("/eguard");
  if (eguardMarker >= 0) {
    path = path.slice(0, eguardMarker);
  }

  const host = parsed.hostname.toLowerCase() === "egauge.net" ? "www.egauge.net" : parsed.hostname;
  return `${parsed.protocol}//${host}${path}`.replace(/\/+$/, "");
}

function getSetCookieValues(headers: Headers): string[] {
  const anyHeaders = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };

  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }

  const raw = typeof anyHeaders.raw === "function" ? anyHeaders.raw() : null;
  if (raw?.["set-cookie"]?.length) {
    return raw["set-cookie"];
  }

  const single = headers.get("set-cookie");
  if (!single) return [];

  return single
    .split(/,(?=\s*[A-Za-z0-9_.-]+=)/g)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseCookiePair(setCookieHeader: string): { name: string; value: string } | null {
  const firstPart = setCookieHeader.split(";")[0];
  const separatorIndex = firstPart.indexOf("=");
  if (separatorIndex < 1) return null;
  const name = firstPart.slice(0, separatorIndex).trim();
  const value = firstPart.slice(separatorIndex + 1).trim();
  if (!name) return null;
  return { name, value };
}

function md5Hex(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function parseIsoDateToUnixStart(dateValue: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error("Dates must be YYYY-MM-DD.");
  }
  const epoch = Date.parse(`${dateValue}T00:00:00Z`);
  if (!Number.isFinite(epoch)) {
    throw new Error("Dates must be YYYY-MM-DD.");
  }
  return Math.floor(epoch / 1000);
}

function parseIsoDateToUnixEnd(dateValue: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    throw new Error("Dates must be YYYY-MM-DD.");
  }
  const epoch = Date.parse(`${dateValue}T23:59:59Z`);
  if (!Number.isFinite(epoch)) {
    throw new Error("Dates must be YYYY-MM-DD.");
  }
  return Math.floor(epoch / 1000);
}

function extractJwtToken(payload: unknown): string | null {
  const root = asRecord(payload);
  const direct =
    toNonEmptyString(root.jwt) ??
    toNonEmptyString(root.token) ??
    toNonEmptyString(root.access_token) ??
    toNonEmptyString(root.accessToken);
  if (direct) return direct;

  const response = asRecord(root.response);
  return (
    toNonEmptyString(response.jwt) ??
    toNonEmptyString(response.token) ??
    toNonEmptyString(response.access_token) ??
    toNonEmptyString(response.accessToken)
  );
}

function extractSummaryString(payload: unknown, keys: string[]): string | null {
  const root = asRecord(payload);
  for (const key of keys) {
    const value = toNonEmptyString(root[key]);
    if (value) return value;
  }

  const nested = asRecord(root.system ?? root.info ?? root.device ?? root.data ?? root.response);
  for (const key of keys) {
    const value = toNonEmptyString(nested[key]);
    if (value) return value;
  }

  return null;
}

function extractRegisterCount(payload: unknown): number | null {
  if (Array.isArray(payload)) return payload.length;
  const root = asRecord(payload);
  if (Array.isArray(root.registers)) return root.registers.length;
  if (Array.isArray(root.regs)) return root.regs.length;
  if (Array.isArray(root.values)) return root.values.length;
  const grouped = asRecord(root.data ?? root.response);
  if (Array.isArray(grouped.registers)) return grouped.registers.length;
  if (Array.isArray(grouped.regs)) return grouped.regs.length;
  if (Array.isArray(grouped.values)) return grouped.values.length;
  return null;
}

function extractLocalValueCount(payload: unknown): number | null {
  const root = asRecord(payload);
  if (Array.isArray(root.values)) return root.values.length;
  const data = asRecord(root.data ?? root.response);
  if (Array.isArray(data.values)) return data.values.length;
  if (Array.isArray(data.readings)) return data.readings.length;
  return null;
}

function normalizeErrorPayload(errorText: string): string {
  const trimmed = errorText.trim();
  if (!trimmed) return "";

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const detail = toNonEmptyString(parsed.detail) ?? toNonEmptyString(parsed.error) ?? toNonEmptyString(parsed.message);
    return detail ?? truncate(trimmed);
  } catch {
    return truncate(trimmed);
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseLooseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

class EgaugeClient {
  private readonly baseUrl: string;
  private readonly accessType: EgaugeAccessType;
  private readonly username: string | null;
  private readonly password: string | null;
  private jwtToken: string | null = null;
  private readonly cookies = new Map<string, string>();
  private authenticated = false;

  constructor(context: EgaugeApiContext) {
    this.baseUrl = normalizeEgaugeBaseUrl(context.baseUrl);
    this.accessType = normalizeEgaugeAccessType(context.accessType);
    this.username = toNonEmptyString(context.username);
    this.password = toNonEmptyString(context.password);
  }

  private buildApiUrl(path: string, query?: Record<string, string | null | undefined>): string {
    const safePath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${safePath}`);

    Object.entries(query ?? {}).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      const normalized = value.trim();
      if (!normalized) return;
      url.searchParams.set(key, normalized);
    });

    return url.toString();
  }

  private buildCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private storeCookies(response: Response): void {
    getSetCookieValues(response.headers).forEach((setCookieValue) => {
      const parsed = parseCookiePair(setCookieValue);
      if (!parsed) return;
      this.cookies.set(parsed.name, parsed.value);
    });
  }

  private async requestJson(
    path: string,
    options?: {
      method?: "GET" | "POST";
      authRequired?: boolean;
      body?: Record<string, unknown>;
      query?: Record<string, string | null | undefined>;
    }
  ): Promise<unknown> {
    const authRequired = options?.authRequired ?? isCredentialAccess(this.accessType);
    const url = this.buildApiUrl(path, options?.query);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    if (authRequired && this.jwtToken) {
      headers.Authorization = `Bearer ${this.jwtToken}`;
    }

    if (options?.body) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers,
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(EGAUGE_REQUEST_TIMEOUT_MS),
    });

    this.storeCookies(response);

    const responseText = await response.text().catch(() => "");

    if (!response.ok) {
      const detail = normalizeErrorPayload(responseText);

      if (path === "/api/auth/login" && (response.status === 401 || response.status === 403)) {
        throw new Error("eGauge login failed. Please verify username/password.");
      }

      if (response.status === 404 && /^\s*<!doctype html/i.test(responseText)) {
        throw new Error(
          `eGauge endpoint not found at ${url}. This usually means the saved URL is a portal page, not a meter API host. Use a meter URL such as ${EGAUGE_DEFAULT_BASE_URL}.`
        );
      }

      throw new Error(
        `eGauge request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
    }

    const trimmed = responseText.trim();
    if (!trimmed) return {};

    try {
      return JSON.parse(trimmed);
    } catch {
      return {
        rawText: trimmed,
      };
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!isCredentialAccess(this.accessType)) return;
    if (this.authenticated && (this.jwtToken || this.cookies.size > 0)) return;

    if (!this.username || !this.password) {
      throw new Error("Username and password are required for this eGauge access type.");
    }

    const challengePayload = await this.requestJson("/api/auth/unauthorized", {
      authRequired: false,
      method: "GET",
    });

    const challenge = asRecord(challengePayload);
    const realm = toNonEmptyString(challenge.rlm) ?? toNonEmptyString(challenge.realm);
    const nonce = toNonEmptyString(challenge.nnc) ?? toNonEmptyString(challenge.nonce);

    if (!realm || !nonce) {
      throw new Error("eGauge login challenge failed. Missing realm/nonce response values.");
    }

    const clientNonce = randomBytes(16).toString("hex");
    const userHash = md5Hex(`${this.username}:${realm}:${this.password}`);
    const digestHash = md5Hex(`${userHash}:${nonce}:${clientNonce}`);

    const loginPayload = await this.requestJson("/api/auth/login", {
      authRequired: false,
      method: "POST",
      body: {
        rlm: realm,
        usr: this.username,
        nnc: nonce,
        cnnc: clientNonce,
        hash: digestHash,
      },
    });

    const token = extractJwtToken(loginPayload);
    if (token) {
      this.jwtToken = token;
    }

    if (!this.jwtToken && this.cookies.size === 0) {
      throw new Error("eGauge login succeeded but no JWT/session cookie was returned.");
    }

    this.authenticated = true;
  }

  async getSystemInfo(): Promise<unknown> {
    await this.ensureAuthenticated();
    return this.requestJson("/api/sys", {
      authRequired: isCredentialAccess(this.accessType),
      method: "GET",
    });
  }

  async getLocalData(): Promise<unknown> {
    await this.ensureAuthenticated();
    return this.requestJson("/api/local", {
      authRequired: isCredentialAccess(this.accessType),
      method: "GET",
    });
  }

  async getRegisterData(options?: {
    register?: string | null;
    includeRate?: boolean;
    timeExpression?: string | null;
  }): Promise<unknown> {
    await this.ensureAuthenticated();

    const query: Record<string, string | null | undefined> = {
      reg: toNonEmptyString(options?.register),
      time: toNonEmptyString(options?.timeExpression),
    };

    if (options?.includeRate) {
      query.rate = "1";
    }

    return this.requestJson("/api/register", {
      authRequired: isCredentialAccess(this.accessType),
      method: "GET",
      query,
    });
  }
}

export type EgaugePortfolioSystem = {
  systemId: string | null;
  name: string;
  group: string | null;
  job: string | null;
  owner: string | null;
  proxyHost: string | null;
  siteName: string | null;
  model: string | null;
  firmware: string | null;
  status: string | null;
  online: boolean | null;
  availabilityPercent: number | null;
  temperatureC: number | null;
  map: string | null;
  mapLink: string | null;
  devicePagePath: string | null;
  groupEditPath: string | null;
};

type EgaugePortfolioFetchOptions = {
  filter?: string | null;
  groupId?: string | null;
};

class EgaugePortfolioClient {
  private readonly baseUrl: string;
  private readonly username: string | null;
  private readonly password: string | null;
  private readonly cookies = new Map<string, string>();
  private authenticated = false;

  constructor(context: EgaugeApiContext) {
    this.baseUrl = normalizeEgaugePortfolioBaseUrl(context.baseUrl);
    this.username = toNonEmptyString(context.username);
    this.password = toNonEmptyString(context.password);
  }

  private buildUrl(path: string, query?: Record<string, string | null | undefined>): string {
    const safePath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${safePath}`);

    Object.entries(query ?? {}).forEach(([key, value]) => {
      if (value === null || value === undefined) return;
      const normalized = value.trim();
      if (!normalized) return;
      url.searchParams.set(key, normalized);
    });

    return url.toString();
  }

  private buildCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private storeCookies(response: Response): void {
    getSetCookieValues(response.headers).forEach((setCookieValue) => {
      const parsed = parseCookiePair(setCookieValue);
      if (!parsed) return;
      this.cookies.set(parsed.name, parsed.value);
    });
  }

  private async request(
    path: string,
    options?: {
      method?: "GET" | "POST";
      query?: Record<string, string | null | undefined>;
      formBody?: URLSearchParams;
      accept?: string;
      referer?: string;
      xhr?: boolean;
    }
  ): Promise<{ url: string; text: string; contentType: string | null }> {
    const url = this.buildUrl(path, options?.query);

    const headers: Record<string, string> = {
      Accept: options?.accept ?? "*/*",
    };

    const cookieHeader = this.buildCookieHeader();
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    }

    if (options?.formBody) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    if (options?.referer) {
      headers.Referer = options.referer;
    }

    if (options?.xhr) {
      headers["X-Requested-With"] = "XMLHttpRequest";
    }

    const response = await fetch(url, {
      method: options?.method ?? "GET",
      headers,
      body: options?.formBody ? options.formBody.toString() : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(EGAUGE_REQUEST_TIMEOUT_MS),
    });

    this.storeCookies(response);

    const responseText = await response.text().catch(() => "");
    if (!response.ok) {
      const detail = normalizeErrorPayload(responseText);
      throw new Error(
        `eGauge portfolio request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`
      );
    }

    return {
      url: response.url || url,
      text: responseText,
      contentType: response.headers.get("content-type"),
    };
  }

  private extractCsrfToken(html: string): string | null {
    const forwardMatch = html.match(/name=["']csrfmiddlewaretoken["'][^>]*value=["']([^"']+)["']/i)?.[1];
    if (forwardMatch) return toNonEmptyString(forwardMatch);

    const reverseMatch = html.match(/value=["']([^"']+)["'][^>]*name=["']csrfmiddlewaretoken["']/i)?.[1];
    return toNonEmptyString(reverseMatch);
  }

  private extractLoginError(html: string): string | null {
    const alertHtml = html.match(/<div[^>]*class=["'][^"']*alert[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1];
    if (!alertHtml) return null;

    const listErrors = Array.from(alertHtml.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi))
      .map((match) => stripHtml(match[1] ?? ""))
      .filter(Boolean);

    if (listErrors.length > 0) {
      return listErrors.join(" ");
    }

    return stripHtml(alertHtml);
  }

  private async ensureAuthenticated(): Promise<void> {
    if (this.authenticated) return;

    if (!this.username || !this.password) {
      throw new Error("Username and password are required for portfolio login.");
    }

    const loginPath = "/account/login/";
    const loginUrl = this.buildUrl(loginPath);
    const loginPage = await this.request(loginPath, {
      method: "GET",
      accept: "text/html,application/xhtml+xml",
    });

    const csrfToken = this.extractCsrfToken(loginPage.text);
    if (!csrfToken) {
      throw new Error("eGauge portfolio login page did not return a CSRF token.");
    }

    const formBody = new URLSearchParams();
    formBody.set("csrfmiddlewaretoken", csrfToken);
    formBody.set("login_view-current_step", "auth");
    formBody.set("auth-username", this.username);
    formBody.set("auth-password", this.password);

    const loginResponse = await this.request(loginPath, {
      method: "POST",
      formBody,
      accept: "text/html,application/xhtml+xml",
      referer: loginUrl,
    });

    const stillAtPasswordForm =
      /name=["']auth-username["']/i.test(loginResponse.text) &&
      /name=["']auth-password["']/i.test(loginResponse.text);
    if (stillAtPasswordForm) {
      const detail = this.extractLoginError(loginResponse.text);
      if (detail && /correct login and password/i.test(detail)) {
        throw new Error("eGauge portfolio login failed. Please verify username/password.");
      }
      throw new Error(detail ? `eGauge portfolio login failed: ${detail}` : "eGauge portfolio login failed.");
    }

    if (/one-time|verification code|multi-factor|two-factor|2fa|mfa/i.test(loginResponse.text)) {
      throw new Error(
        "eGauge portfolio login requires an additional verification step (2FA), which this flow does not yet support."
      );
    }

    this.authenticated = true;
  }

  async fetchSystems(options?: EgaugePortfolioFetchOptions): Promise<unknown[]> {
    await this.ensureAuthenticated();

    const response = await this.request("/eguard/data/", {
      method: "GET",
      accept: "application/json,text/plain,*/*",
      referer: this.buildUrl("/eguard/"),
      xhr: true,
      query: {
        filter: toNonEmptyString(options?.filter),
        group_id: toNonEmptyString(options?.groupId),
      },
    });

    const trimmed = response.text.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        throw new Error("Expected an array.");
      }
      return parsed as unknown[];
    } catch {
      if (/<html/i.test(response.text) || /name=["']auth-username["']/i.test(response.text)) {
        throw new Error("Portfolio request returned HTML instead of JSON. Verify portfolio URL and login credentials.");
      }
      throw new Error("Portfolio request returned invalid JSON.");
    }
  }
}

function mapPortfolioSystem(row: unknown): EgaugePortfolioSystem {
  const record = asRecord(row);
  const extra = asRecord(record.extra_context);

  const name = toNonEmptyString(record.Name) ?? toNonEmptyString(extra.label) ?? "Unknown";
  const status = toNonEmptyString(record.Status);

  return {
    systemId: toNonEmptyString(extra.label) ?? toNonEmptyString(record.Name),
    name,
    group: toNonEmptyString(record.Group),
    job: toNonEmptyString(record.Job),
    owner: toNonEmptyString(record.Owner),
    proxyHost: toNonEmptyString(extra.proxy_url),
    siteName: toNonEmptyString(extra.site_name),
    model: toNonEmptyString(record.Model),
    firmware: toNonEmptyString(record.Firmware),
    status,
    online: status === "1" ? true : status === "0" ? false : null,
    availabilityPercent: parseLooseNumber(record.Availability),
    temperatureC: parseLooseNumber(record.Temp),
    map: toNonEmptyString(record.Map),
    mapLink: toNonEmptyString(record.Map_Link),
    devicePagePath: toNonEmptyString(record.Name_Edit),
    groupEditPath: toNonEmptyString(record.Group_Edit),
  };
}

export function buildEgaugeRegisterTimeExpression(input: {
  startDate: string;
  endDate: string;
  intervalMinutes: number;
}): string {
  const startUnix = parseIsoDateToUnixStart(input.startDate.trim());
  const endUnix = parseIsoDateToUnixEnd(input.endDate.trim());

  if (endUnix < startUnix) {
    throw new Error("End date must be on or after start date.");
  }

  const safeMinutes = Number.isFinite(input.intervalMinutes)
    ? Math.max(1, Math.floor(input.intervalMinutes))
    : 15;

  return `${startUnix}:${safeMinutes * 60}:${endUnix}`;
}

export async function getEgaugeSystemInfo(context: EgaugeApiContext): Promise<{
  baseUrl: string;
  accessType: EgaugeAccessType;
  systemName: string | null;
  serialNumber: string | null;
  raw: unknown;
}> {
  const client = new EgaugeClient(context);
  const raw = await client.getSystemInfo();

  return {
    baseUrl: normalizeEgaugeBaseUrl(context.baseUrl),
    accessType: normalizeEgaugeAccessType(context.accessType),
    systemName: extractSummaryString(raw, ["name", "system_name", "title"]),
    serialNumber: extractSummaryString(raw, ["serial", "serial_number", "serialNumber", "device_id"]),
    raw,
  };
}

export async function getEgaugeLocalData(context: EgaugeApiContext): Promise<{
  baseUrl: string;
  accessType: EgaugeAccessType;
  localTimestamp: string | null;
  valueCount: number | null;
  raw: unknown;
}> {
  const client = new EgaugeClient(context);
  const raw = await client.getLocalData();

  return {
    baseUrl: normalizeEgaugeBaseUrl(context.baseUrl),
    accessType: normalizeEgaugeAccessType(context.accessType),
    localTimestamp: extractSummaryString(raw, ["ts", "timestamp", "time"]),
    valueCount: extractLocalValueCount(raw),
    raw,
  };
}

export async function getEgaugeRegisterLatest(context: EgaugeApiContext, options?: {
  register?: string | null;
  includeRate?: boolean;
}): Promise<{
  baseUrl: string;
  accessType: EgaugeAccessType;
  register: string | null;
  includeRate: boolean;
  registerCount: number | null;
  raw: unknown;
}> {
  const client = new EgaugeClient(context);
  const raw = await client.getRegisterData(options);

  return {
    baseUrl: normalizeEgaugeBaseUrl(context.baseUrl),
    accessType: normalizeEgaugeAccessType(context.accessType),
    register: toNonEmptyString(options?.register),
    includeRate: Boolean(options?.includeRate),
    registerCount: extractRegisterCount(raw),
    raw,
  };
}

export async function getEgaugeRegisterHistory(
  context: EgaugeApiContext,
  options: {
    startDate: string;
    endDate: string;
    intervalMinutes: number;
    register?: string | null;
    includeRate?: boolean;
  }
): Promise<{
  baseUrl: string;
  accessType: EgaugeAccessType;
  register: string | null;
  includeRate: boolean;
  timeExpression: string;
  registerCount: number | null;
  raw: unknown;
}> {
  const timeExpression = buildEgaugeRegisterTimeExpression({
    startDate: options.startDate,
    endDate: options.endDate,
    intervalMinutes: options.intervalMinutes,
  });

  const client = new EgaugeClient(context);
  const raw = await client.getRegisterData({
    register: options.register,
    includeRate: options.includeRate,
    timeExpression,
  });

  return {
    baseUrl: normalizeEgaugeBaseUrl(context.baseUrl),
    accessType: normalizeEgaugeAccessType(context.accessType),
    register: toNonEmptyString(options.register),
    includeRate: Boolean(options.includeRate),
    timeExpression,
    registerCount: extractRegisterCount(raw),
    raw,
  };
}

export async function getEgaugePortfolioSystems(
  context: EgaugeApiContext,
  options?: {
    filter?: string | null;
    groupId?: string | null;
  }
): Promise<{
  baseUrl: string;
  accessType: EgaugeAccessType;
  filter: string | null;
  groupId: string | null;
  systemCount: number;
  systems: EgaugePortfolioSystem[];
  raw: unknown[];
}> {
  const client = new EgaugePortfolioClient(context);
  const raw = await client.fetchSystems({
    filter: options?.filter,
    groupId: options?.groupId,
  });

  const systems = raw.map((row) => mapPortfolioSystem(row));

  return {
    baseUrl: normalizeEgaugePortfolioBaseUrl(context.baseUrl),
    accessType: normalizeEgaugeAccessType(context.accessType),
    filter: toNonEmptyString(options?.filter),
    groupId: toNonEmptyString(options?.groupId),
    systemCount: systems.length,
    systems,
    raw,
  };
}
