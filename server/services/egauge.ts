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
  const date = new Date(parsed.year, parsed.month - 1, 1);
  return formatIsoDate(date);
}

function firstDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 2, 1);
  return formatIsoDate(date);
}

function lastDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  const date = new Date(parsed.year, parsed.month - 1, 0);
  return formatIsoDate(date);
}

function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
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
  sinceMidnightGenerationKwh: number | null;
  last24HoursGenerationKwh: number | null;
  lastWeekGenerationKwh: number | null;
  lastMonthGenerationKwh: number | null;
  lastYearGenerationKwh: number | null;
  totalGenerationKwh: number | null;
  sinceMidnightConsumptionKwh: number | null;
  last24HoursConsumptionKwh: number | null;
  lastWeekConsumptionKwh: number | null;
  lastMonthConsumptionKwh: number | null;
  lastYearConsumptionKwh: number | null;
  totalConsumptionKwh: number | null;
};

export type EgaugePortfolioSnapshotRow = {
  meterId: string;
  meterName: string | null;
  siteName: string | null;
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
  yearlyProductionKwh: number | null;
  anchorDate: string;
  monthlyStartDate: string;
  weeklyStartDate: string;
  mtdStartDate: string;
  previousCalendarMonthStartDate: string;
  previousCalendarMonthEndDate: string;
  last12MonthsStartDate: string;
  group: string | null;
  job: string | null;
  owner: string | null;
  model: string | null;
  firmware: string | null;
  online: boolean | null;
  availabilityPercent: number | null;
  temperatureC: number | null;
  proxyHost: string | null;
  error: string | null;
};

type EgaugePortfolioFetchOptions = {
  filter?: string | null;
  groupId?: string | null;
  anchorDate?: string | null;
  start?: number | null;
  length?: number | null;
  page?: number | null;
  perPage?: number | null;
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
      // Allow empty strings (needed for DataTables search[value]= params)
      url.searchParams.set(key, value);
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

    // Django CSRF: for AJAX POST, send the csrftoken cookie value as X-CSRFToken header
    if ((options?.method === "POST") && this.cookies.has("csrftoken")) {
      headers["X-CSRFToken"] = this.cookies.get("csrftoken")!;
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

  getUsername(): string | null {
    return this.username;
  }

  async fetchSystems(options?: EgaugePortfolioFetchOptions): Promise<{
    rows: unknown[];
    recordsTotal: number | null;
    recordsFiltered: number | null;
  }> {
    await this.ensureAuthenticated();

    const start =
      typeof options?.start === "number" && Number.isFinite(options.start) && options.start >= 0
        ? String(Math.floor(options.start))
        : "0";
    const length =
      typeof options?.length === "number" && Number.isFinite(options.length) && options.length > 0
        ? String(Math.floor(options.length))
        : "10000";

    // Build full DataTables server-side query params (GET — endpoint rejects POST).
    const query: Record<string, string | null | undefined> = {
      draw: "1",
      start,
      length,
      "search[value]": toNonEmptyString(options?.filter) ?? "",
      "search[regex]": "false",
      "order[0][column]": "0",
      "order[0][dir]": "asc",
    };

    // DataTables column definitions
    const columns = [
      "name", "serial_number", "group", "status", "last_update",
      "generation_today", "generation_mtd", "generation_last_month",
      "generation_12_months", "alerts",
    ];
    for (let i = 0; i < columns.length; i++) {
      query[`columns[${i}][data]`] = String(i);
      query[`columns[${i}][name]`] = columns[i];
      query[`columns[${i}][searchable]`] = "true";
      query[`columns[${i}][orderable]`] = "true";
      query[`columns[${i}][search][value]`] = "";
      query[`columns[${i}][search][regex]`] = "false";
    }

    const groupId = toNonEmptyString(options?.groupId);
    if (groupId) {
      query["group_id"] = groupId;
    }

    const response = await this.request("/eguard/data/", {
      method: "GET",
      accept: "application/json,text/plain,*/*",
      referer: this.buildUrl("/eguard/"),
      xhr: true,
      query,
    });

    const trimmed = response.text.trim();
    if (!trimmed) return { rows: [], recordsTotal: null, recordsFiltered: null };

    try {
      const parsed = JSON.parse(trimmed);

      let recordsTotal: number | null = null;
      let recordsFiltered: number | null = null;

      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const container = parsed as Record<string, unknown>;
        if (typeof container.recordsTotal === "number") recordsTotal = container.recordsTotal;
        if (typeof container.recordsFiltered === "number") recordsFiltered = container.recordsFiltered;

        if (Array.isArray(container.data)) return { rows: container.data as unknown[], recordsTotal, recordsFiltered };
        if (Array.isArray(container.rows)) return { rows: container.rows as unknown[], recordsTotal, recordsFiltered };
        if (Array.isArray(container.results)) return { rows: container.results as unknown[], recordsTotal, recordsFiltered };
      }

      if (Array.isArray(parsed)) {
        return { rows: parsed as unknown[], recordsTotal, recordsFiltered };
      }

      throw new Error("Expected an array-like payload.");
    } catch {
      if (/<html/i.test(response.text) || /name=["']auth-username["']/i.test(response.text)) {
        throw new Error("Portfolio request returned HTML instead of JSON. Verify portfolio URL and login credentials.");
      }
      throw new Error("Portfolio request returned invalid JSON.");
    }
  }
}

function extractMeterIdFromDevicePath(value: string | null): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;

  const fromPath = (pathname: string): string | null => {
    const segments = pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    const deviceSegmentIndex = segments.findIndex((segment) => {
      const normalized = segment.toLowerCase();
      return normalized === "device" || normalized === "devices";
    });
    if (deviceSegmentIndex < 0) return null;
    const candidate = segments[deviceSegmentIndex + 1];
    if (!candidate) return null;
    return /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : null;
  };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return fromPath(parsed.pathname);
    } catch {
      return null;
    }
  }

  if (raw.startsWith("/")) {
    return fromPath(raw);
  }

  return null;
}

function extractMeterIdFromQueryParam(value: string | null): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;

  const parseFromSearchParams = (searchParams: URLSearchParams): string | null => {
    for (const key of ["device_name", "meter_id", "meterId", "name"]) {
      const candidate = toNonEmptyString(searchParams.get(key));
      if (candidate && /^[A-Za-z0-9._-]+$/.test(candidate)) {
        return candidate;
      }
    }
    return null;
  };

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return parseFromSearchParams(parsed.searchParams);
    } catch {
      return null;
    }
  }

  if (raw.startsWith("/")) {
    try {
      const parsed = new URL(raw, "https://www.egauge.net");
      return parseFromSearchParams(parsed.searchParams);
    } catch {
      return null;
    }
  }

  return null;
}

function extractMeterIdFromProxyUrl(value: string | null): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;

  try {
    const parsed = new URL(raw);
    const hostname = parsed.hostname.trim();
    if (!hostname) return null;
    const firstLabel = hostname.split(".")[0]?.trim();
    if (!firstLabel || !/^[A-Za-z0-9._-]+$/.test(firstLabel)) return null;
    return firstLabel;
  } catch {
    return null;
  }
}

function extractMeterIdFromInlineUrl(value: string | null): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;

  const urlMatch = raw.match(/https?:\/\/[^\s)]+/i);
  if (!urlMatch) return null;
  return extractMeterIdFromProxyUrl(urlMatch[0]);
}

function looksLikePortfolioMeterId(value: string | null): boolean {
  if (!value) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return false;
  return /^egauge/i.test(value) || /\d/.test(value);
}

function extractPortfolioSystemId(record: Record<string, unknown>, extra: Record<string, unknown>): string | null {
  const fromLabel = toNonEmptyString(extra.label);
  if (fromLabel && /^[A-Za-z0-9._-]+$/.test(fromLabel)) {
    return fromLabel;
  }

  const fromExplicitFields =
    toNonEmptyString(record.id) ??
    toNonEmptyString(record.ID) ??
    toNonEmptyString(record.meter_id) ??
    toNonEmptyString(record.meterId) ??
    toNonEmptyString(record.Meter_ID) ??
    toNonEmptyString(record.MeterId) ??
    toNonEmptyString(record.Device_ID) ??
    toNonEmptyString(record.device_id) ??
    toNonEmptyString(record.serial) ??
    toNonEmptyString(record.Serial);
  if (looksLikePortfolioMeterId(fromExplicitFields)) {
    return fromExplicitFields;
  }

  const fromQueryParam =
    extractMeterIdFromQueryParam(toNonEmptyString(record.Group_Edit)) ??
    extractMeterIdFromQueryParam(toNonEmptyString(record.Name_Edit)) ??
    extractMeterIdFromQueryParam(toNonEmptyString(record.Map_Link));
  if (looksLikePortfolioMeterId(fromQueryParam)) {
    return fromQueryParam;
  }

  const fromDevicePath =
    extractMeterIdFromDevicePath(toNonEmptyString(record.Name_Edit)) ??
    extractMeterIdFromDevicePath(toNonEmptyString(record.Map_Link)) ??
    extractMeterIdFromDevicePath(toNonEmptyString(record.Group_Edit));
  if (looksLikePortfolioMeterId(fromDevicePath)) {
    return fromDevicePath;
  }

  const fromProxyUrl = extractMeterIdFromProxyUrl(toNonEmptyString(extra.proxy_url));
  if (looksLikePortfolioMeterId(fromProxyUrl)) {
    return fromProxyUrl;
  }

  const fromInlineUrl =
    extractMeterIdFromInlineUrl(toNonEmptyString(record.Name)) ??
    extractMeterIdFromInlineUrl(toNonEmptyString(extra.label));
  if (looksLikePortfolioMeterId(fromInlineUrl)) {
    return fromInlineUrl;
  }

  const fallback =
    toNonEmptyString(extra.label) ??
    toNonEmptyString(record.Name);
  if (looksLikePortfolioMeterId(fallback)) {
    return fallback;
  }

  return null;
}

function buildPortfolioRowKey(row: unknown): string {
  const record = asRecord(row);
  const extra = asRecord(record.extra_context);

  const parts = [
    toNonEmptyString(extra.label),
    toNonEmptyString(record.Name_Edit),
    toNonEmptyString(record.Group_Edit),
    toNonEmptyString(record.Name),
    toNonEmptyString(extra.proxy_url),
    toNonEmptyString(record.Group),
    toNonEmptyString(record.Job),
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());

  if (parts.length > 0) {
    return parts.join("|");
  }

  return JSON.stringify(record);
}

function mapPortfolioSystem(row: unknown): EgaugePortfolioSystem {
  const record = asRecord(row);
  const extra = asRecord(record.extra_context);

  const name = toNonEmptyString(record.Name) ?? toNonEmptyString(extra.label) ?? "Unknown";
  const status = toNonEmptyString(record.Status);

  const parsePortfolioMetricKwh = (value: unknown): number | null => {
    if (Array.isArray(value)) {
      const numericValues = value
        .map((entry) => parseLooseNumber(entry))
        .filter((entry): entry is number => entry !== null);
      if (numericValues.length === 0) return null;
      return safeRound(numericValues[numericValues.length - 1]);
    }
    return safeRound(parseLooseNumber(value));
  };

  return {
    systemId: extractPortfolioSystemId(record, extra),
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
    sinceMidnightGenerationKwh: parsePortfolioMetricKwh(record.Since_Midnight_Gen),
    last24HoursGenerationKwh: parsePortfolioMetricKwh(record.Last_24_Hours_Gen),
    lastWeekGenerationKwh: parsePortfolioMetricKwh(record.Last_Week_Gen),
    lastMonthGenerationKwh: parsePortfolioMetricKwh(record.Last_Month_Gen),
    lastYearGenerationKwh: parsePortfolioMetricKwh(record.Last_Year_Gen),
    totalGenerationKwh: parsePortfolioMetricKwh(record.Total_Gen),
    sinceMidnightConsumptionKwh: parsePortfolioMetricKwh(record.Since_Midnight_Used),
    last24HoursConsumptionKwh: parsePortfolioMetricKwh(record.Last_24_Hours_Used),
    lastWeekConsumptionKwh: parsePortfolioMetricKwh(record.Last_Week_Used),
    lastMonthConsumptionKwh: parsePortfolioMetricKwh(record.Last_Month_Used),
    lastYearConsumptionKwh: parsePortfolioMetricKwh(record.Last_Year_Used),
    totalConsumptionKwh: parsePortfolioMetricKwh(record.Total_Used),
  };
}

function mapPortfolioSystemToSnapshotRow(
  system: EgaugePortfolioSystem,
  anchorDate: string
): EgaugePortfolioSnapshotRow {
  const monthlyStartDate = shiftIsoDate(anchorDate, -29);
  const weeklyStartDate = shiftIsoDate(anchorDate, -6);
  const mtdStartDate = firstDayOfMonth(anchorDate);
  const previousCalendarMonthStartDate = firstDayOfPreviousMonth(anchorDate);
  const previousCalendarMonthEndDate = lastDayOfPreviousMonth(anchorDate);
  const last12MonthsStartDate = shiftIsoDateByYears(anchorDate, -1);
  const meterId = system.systemId ?? system.name;

  return {
    meterId,
    meterName: system.name,
    siteName: system.siteName ?? system.job ?? null,
    status: "Found",
    found: true,
    lifetimeKwh: system.totalGenerationKwh,
    hourlyProductionKwh: null,
    monthlyProductionKwh: system.lastMonthGenerationKwh,
    mtdProductionKwh: null,
    previousCalendarMonthProductionKwh: null,
    last12MonthsProductionKwh: system.lastYearGenerationKwh,
    weeklyProductionKwh: system.lastWeekGenerationKwh,
    dailyProductionKwh: system.sinceMidnightGenerationKwh ?? system.last24HoursGenerationKwh,
    yearlyProductionKwh: system.lastYearGenerationKwh,
    anchorDate,
    monthlyStartDate,
    weeklyStartDate,
    mtdStartDate,
    previousCalendarMonthStartDate,
    previousCalendarMonthEndDate,
    last12MonthsStartDate,
    group: system.group,
    job: system.job,
    owner: system.owner,
    model: system.model,
    firmware: system.firmware,
    online: system.online,
    availabilityPercent: system.availabilityPercent,
    temperatureC: system.temperatureC,
    proxyHost: system.proxyHost,
    error: null,
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
    anchorDate?: string | null;
  }
): Promise<{
  baseUrl: string;
  accessType: EgaugeAccessType;
  authenticatedUsername: string | null;
  filter: string | null;
  groupId: string | null;
  queryAttempts: Array<{
    groupId: string | null;
    start: number | null;
    length: number | null;
    rowsReturned: number;
    recordsTotal: number | null;
    recordsFiltered: number | null;
    error: string | null;
  }>;
  total: number;
  found: number;
  notFound: number;
  errored: number;
  rows: EgaugePortfolioSnapshotRow[];
  systemCount: number;
  systems: EgaugePortfolioSystem[];
  raw: unknown[];
}> {
  const client = new EgaugePortfolioClient(context);
  const normalizedFilter = toNonEmptyString(options?.filter);
  const normalizedGroupId = toNonEmptyString(options?.groupId);

  // For DataTables-style API: only make one request with no group filter,
  // requesting all records. The eGauge /eguard/data/ endpoint returns all
  // systems the authenticated account has access to.
  const fetchAttempts: EgaugePortfolioFetchOptions[] =
    normalizedGroupId || normalizedFilter
      ? [
          {
            filter: normalizedFilter,
            groupId: normalizedGroupId,
            start: 0,
            length: 10000,
          },
        ]
      : [
          { start: 0, length: 10000 },
        ];

  const mergedRowsByKey = new Map<string, unknown>();
  let firstError: Error | null = null;
  let serverRecordsTotal: number | null = null;
  const queryAttempts: Array<{
    groupId: string | null;
    start: number | null;
    length: number | null;
    rowsReturned: number;
    recordsTotal: number | null;
    recordsFiltered: number | null;
    error: string | null;
  }> = [];

  for (const attempt of fetchAttempts) {
    try {
      const result = await client.fetchSystems({
        filter: normalizedFilter,
        groupId: attempt.groupId,
        start: attempt.start,
        length: attempt.length,
        page: attempt.page,
        perPage: attempt.perPage,
      });

      queryAttempts.push({
        groupId: attempt.groupId ?? null,
        start: attempt.start ?? null,
        length: attempt.length ?? null,
        rowsReturned: result.rows.length,
        recordsTotal: result.recordsTotal,
        recordsFiltered: result.recordsFiltered,
        error: null,
      });

      if (result.recordsTotal !== null) serverRecordsTotal = result.recordsTotal;

      for (const row of result.rows) {
        const key = buildPortfolioRowKey(row);
        if (!mergedRowsByKey.has(key)) {
          mergedRowsByKey.set(key, row);
        }
      }

      // If the server reports more records than we received, paginate
      if (result.recordsTotal !== null && result.rows.length < result.recordsTotal) {
        let fetched = result.rows.length;
        while (fetched < result.recordsTotal) {
          const pageResult = await client.fetchSystems({
            filter: normalizedFilter,
            groupId: attempt.groupId,
            start: fetched,
            length: 10000,
          });

          queryAttempts.push({
            groupId: attempt.groupId ?? null,
            start: fetched,
            length: 10000,
            rowsReturned: pageResult.rows.length,
            recordsTotal: pageResult.recordsTotal,
            recordsFiltered: pageResult.recordsFiltered,
            error: null,
          });

          if (pageResult.rows.length === 0) break;

          for (const row of pageResult.rows) {
            const key = buildPortfolioRowKey(row);
            if (!mergedRowsByKey.has(key)) {
              mergedRowsByKey.set(key, row);
            }
          }
          fetched += pageResult.rows.length;
        }
      }
    } catch (error) {
      queryAttempts.push({
        groupId: attempt.groupId ?? null,
        start: attempt.start ?? null,
        length: attempt.length ?? null,
        rowsReturned: 0,
        recordsTotal: null,
        recordsFiltered: null,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      if (!firstError && error instanceof Error) {
        firstError = error;
      }
    }
  }

  if (mergedRowsByKey.size === 0) {
    if (firstError) throw firstError;
    throw new Error("No portfolio systems were returned.");
  }

  const raw = Array.from(mergedRowsByKey.values());

  const systems = raw.map((row) => mapPortfolioSystem(row));
  const requestedAnchorDate = toNonEmptyString(options?.anchorDate);
  const anchorDate =
    requestedAnchorDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedAnchorDate)
      ? requestedAnchorDate
      : formatIsoDate(new Date());
  const rows = systems.map((system) => mapPortfolioSystemToSnapshotRow(system, anchorDate));
  const found = rows.filter((row) => row.status === "Found").length;
  const notFound = rows.filter((row) => row.status === "Not Found").length;
  const errored = rows.filter((row) => row.status === "Error").length;

  return {
    baseUrl: normalizeEgaugePortfolioBaseUrl(context.baseUrl),
    accessType: normalizeEgaugeAccessType(context.accessType),
    authenticatedUsername: client.getUsername(),
    filter: normalizedFilter,
    groupId: normalizedGroupId,
    queryAttempts,
    total: rows.length,
    found,
    notFound,
    errored,
    rows,
    systemCount: systems.length,
    systems,
    raw,
  };
}

/* ------------------------------------------------------------------ */
/*  Production snapshot (bulk support)                                  */
/* ------------------------------------------------------------------ */

export type EgaugeProductionSnapshot = {
  meterId: string;
  meterName: string | null;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  lifetimeKwh: number | null;
  anchorDate: string;
  error: string | null;
};

function extractRegisterCumulativeWh(raw: unknown): number | null {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  // The register endpoint returns registers with cumulative values.
  // Look for common production register names.
  const registers = record.registers ?? record.data ?? record;
  if (!registers || typeof registers !== "object") return null;

  const reg = registers as Record<string, unknown>;

  // Try common eGauge production register names.
  for (const key of ["Generation", "Solar", "Solar+", "generation", "solar", "PV", "Grid", "Total Generation"]) {
    const val = reg[key];
    if (typeof val === "number" && Number.isFinite(val)) return val;
    if (val && typeof val === "object") {
      const nested = val as Record<string, unknown>;
      const cumulative = nested.cumulative ?? nested.total ?? nested.value ?? nested.energy;
      if (typeof cumulative === "number" && Number.isFinite(cumulative)) return cumulative;
    }
  }

  // Fallback: if there's a single numeric register, use it.
  const values = Object.values(reg).filter((v) => typeof v === "number" && Number.isFinite(v)) as number[];
  if (values.length === 1) return values[0];

  return null;
}

export async function getMeterProductionSnapshot(
  context: EgaugeApiContext,
  meterId: string,
  meterName: string | null,
  anchorDate: string
): Promise<EgaugeProductionSnapshot> {
  try {
    const result = await getEgaugeRegisterLatest(context);
    const lifetimeWh = extractRegisterCumulativeWh(result.raw);
    const lifetimeKwh = lifetimeWh !== null ? Math.round((lifetimeWh / 1000) * 1000) / 1000 : null;

    return {
      meterId,
      meterName,
      status: "Found",
      found: true,
      lifetimeKwh,
      anchorDate,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error.";
    return {
      meterId,
      meterName,
      status: "Error",
      found: false,
      lifetimeKwh: null,
      anchorDate,
      error: message,
    };
  }
}

export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  fn: (item: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}
