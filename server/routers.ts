import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, protectedProcedure, twoFactorPendingProcedure, router } from "./_core/trpc";
import { sdk } from "./_core/sdk";
import { z } from "zod";

const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

const ADDRESS_CLEANING_SYSTEM_PROMPT = [
  "You clean US mailing address records. Return valid JSON: {\"rows\":[...]}. No prose.",
  "",
  "RULES:",
  "1. Return EXACTLY the same number of rows, in the SAME order, with the SAME keys.",
  "2. payeeName: Title-case. Preserve LLC/Inc/Corp.",
  "3. mailingAddress1: street address ONLY. Never a name, phone, city, or state.",
  "4. mailingAddress2: ONLY secondary unit (Apt/Ste/Unit/PO Box). Empty string if none.",
  "5. city: city name ONLY. Never zip, phone, state, 'IL', 'USA'.",
  "6. state: 2-letter uppercase. Do NOT default to 'IL' — mailing may be any US state.",
  "7. zip: 5-digit or ZIP+4 ONLY.",
  "8. Standardize: Street→St, Avenue→Ave, Road→Rd, Drive→Dr, Lane→Ln, Court→Ct.",
  "9. Fix field-placement errors (city/state/zip in addr2, names in addr1, crammed addresses).",
  "10. Remove phone numbers, placeholders (N/A, TBD), duplicate fields.",
  "11. Use cityStateZip as fallback when city/state/zip are empty.",
  "12. Do NOT invent data. Empty string if uncertain.",
].join("\n");

async function callLlmForAddressCleaning(
  provider: "anthropic" | "openai",
  apiKey: string,
  model: string,
  rows: Array<{ key: string; payeeName: string | null; mailingAddress1: string | null; mailingAddress2: string | null; cityStateZip: string | null; city: string | null; state: string | null; zip: string | null }>,
): Promise<Array<{ key: string; payeeName: string | null; mailingAddress1: string | null; mailingAddress2: string | null; city: string | null; state: string | null; zip: string | null }>> {
  const userContent = JSON.stringify({
    instructions: `Clean these ${rows.length} ambiguous address records. Return EXACTLY ${rows.length} rows.`,
    rows,
  });

  let content: string;

  if (provider === "anthropic") {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model,
        max_tokens: 16384,
        system: ADDRESS_CLEANING_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let message = "Anthropic API error";
      try { message = (JSON.parse(errorBody) as any)?.error?.message || message; } catch {}
      throw new Error(`Anthropic API error (${response.status}): ${message}`);
    }

    const data = await response.json() as any;
    content = data?.content?.[0]?.text ?? "";
  } else {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: ADDRESS_CLEANING_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      let message = "OpenAI API error";
      try { message = (JSON.parse(errorBody) as any)?.error?.message || message; } catch {}
      throw new Error(`OpenAI API error (${response.status}): ${message}`);
    }

    const data = await response.json() as any;
    content = data?.choices?.[0]?.message?.content ?? "";
  }

  if (!content) throw new Error("LLM returned empty response.");

  // Extract JSON from potential markdown code fences
  const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();

  const parsed = JSON.parse(jsonStr) as { rows?: unknown };
  if (!Array.isArray(parsed?.rows)) {
    throw new Error("LLM response missing 'rows' array.");
  }

  return (parsed.rows as Array<Record<string, unknown>>).map((row) => ({
    key: String(row.key ?? ""),
    payeeName: toNonEmptyString(row.payeeName),
    mailingAddress1: toNonEmptyString(row.mailingAddress1),
    mailingAddress2: toNonEmptyString(row.mailingAddress2),
    city: toNonEmptyString(row.city),
    state: toNonEmptyString(row.state),
    zip: toNonEmptyString(row.zip),
  }));
}

function parseJsonMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function resolveOpenAIModel(metadata: string | null | undefined): string {
  const parsed = parseJsonMetadata(metadata);
  const model = parsed.model;
  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : DEFAULT_OPENAI_MODEL;
}

function toNullableScore(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return null;
}

function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const ENPHASE_V2_PROVIDER = "enphase-v2";
const ENPHASE_V4_PROVIDER = "enphase-v4";
const SOLAR_EDGE_PROVIDER = "solaredge-monitoring";
const ZENDESK_PROVIDER = "zendesk";
const TESLA_SOLAR_PROVIDER = "tesla-solar";
const TESLA_POWERHUB_PROVIDER = "tesla-powerhub";
const CLOCKIFY_PROVIDER = "clockify";
const CSG_PORTAL_PROVIDER = "csg-portal";

function toNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeMailingText(value: unknown): string | null {
  const raw = toNonEmptyString(value);
  if (!raw) return null;
  const normalized = raw
    .replace(/\u00a0/g, " ")
    .replace(/[’‘`´]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeMailingCompareToken(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function normalizeStateAbbreviation(value: string | null | undefined): string | null {
  const raw = normalizeMailingText(value);
  if (!raw) return null;

  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (!letters) return null;
  if (letters.length === 2) return letters;

  const fullStateMap: Record<string, string> = {
    ALABAMA: "AL",
    ALASKA: "AK",
    ARIZONA: "AZ",
    ARKANSAS: "AR",
    CALIFORNIA: "CA",
    COLORADO: "CO",
    CONNECTICUT: "CT",
    DELAWARE: "DE",
    FLORIDA: "FL",
    GEORGIA: "GA",
    HAWAII: "HI",
    IDAHO: "ID",
    ILLINOIS: "IL",
    INDIANA: "IN",
    IOWA: "IA",
    KANSAS: "KS",
    KENTUCKY: "KY",
    LOUISIANA: "LA",
    MAINE: "ME",
    MARYLAND: "MD",
    MASSACHUSETTS: "MA",
    MICHIGAN: "MI",
    MINNESOTA: "MN",
    MISSISSIPPI: "MS",
    MISSOURI: "MO",
    MONTANA: "MT",
    NEBRASKA: "NE",
    NEVADA: "NV",
    NEWHAMPSHIRE: "NH",
    NEWJERSEY: "NJ",
    NEWMEXICO: "NM",
    NEWYORK: "NY",
    NORTHCAROLINA: "NC",
    NORTHDAKOTA: "ND",
    OHIO: "OH",
    OKLAHOMA: "OK",
    OREGON: "OR",
    PENNSYLVANIA: "PA",
    RHODEISLAND: "RI",
    SOUTHCAROLINA: "SC",
    SOUTHDAKOTA: "SD",
    TENNESSEE: "TN",
    TEXAS: "TX",
    UTAH: "UT",
    VERMONT: "VT",
    VIRGINIA: "VA",
    WASHINGTON: "WA",
    WESTVIRGINIA: "WV",
    WISCONSIN: "WI",
    WYOMING: "WY",
  };

  return fullStateMap[letters] ?? letters.slice(0, 2);
}

function normalizeZipCode(value: string | null | undefined): string | null {
  const raw = normalizeMailingText(value);
  if (!raw) return null;
  const match = raw.match(/\d{5}(?:-\d{4})?/);
  return match ? match[0] : null;
}

function parseCityStateZip(value: string | null | undefined): {
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  const raw = normalizeMailingText(value);
  if (!raw) return { city: null, state: null, zip: null };

  const normalized = raw
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  const match = normalized.match(/^(.+?)(?:,\s*|\s+)([A-Za-z]{2,})(?:[\s,.\-]+(\d{5}(?:-\d{4})?))?$/);
  if (!match) return { city: null, state: null, zip: null };

  return {
    city: normalizeMailingText(match[1]?.replace(/[.,]+$/g, "")),
    state: normalizeStateAbbreviation(match[2]),
    zip: normalizeZipCode(match[3] ?? null),
  };
}

function looksLikePhoneNumber(value: string | null | undefined): boolean {
  const raw = normalizeMailingText(value);
  if (!raw) return false;
  return /\b(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}\b/.test(raw);
}

function looksLikeSecondaryAddressLine(value: string | null | undefined): boolean {
  const raw = normalizeMailingText(value);
  if (!raw) return false;
  return /\b(?:apt|apartment|unit|suite|ste|fl|floor|bldg|building|dept|lot|trlr|trailer)\b/i.test(raw) || /#\s*[A-Za-z0-9-]+/.test(raw);
}

function sanitizeMailingFields(input: {
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  cityStateZip?: string | null;
}): {
  payeeName: string | null;
  mailingAddress1: string | null;
  mailingAddress2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} {
  let payeeName = normalizeMailingText(input.payeeName);
  let mailingAddress1 = normalizeMailingText(input.mailingAddress1);
  let mailingAddress2 = normalizeMailingText(input.mailingAddress2);
  let city = normalizeMailingText(input.city);
  let state = normalizeStateAbbreviation(input.state);
  let zip = normalizeZipCode(input.zip);

  const parsedFromCityStateZip = parseCityStateZip(input.cityStateZip ?? null);
  if (!city && parsedFromCityStateZip.city) city = parsedFromCityStateZip.city;
  if (!state && parsedFromCityStateZip.state) state = parsedFromCityStateZip.state;
  if (!zip && parsedFromCityStateZip.zip) zip = parsedFromCityStateZip.zip;

  if (mailingAddress2 && looksLikePhoneNumber(mailingAddress2)) {
    mailingAddress2 = null;
  }

  if (mailingAddress2) {
    const parsedFromAddress2 = parseCityStateZip(mailingAddress2);
    const hasParsedLocation = Boolean(parsedFromAddress2.city || parsedFromAddress2.state || parsedFromAddress2.zip);
    if (hasParsedLocation) {
      if (!city && parsedFromAddress2.city) city = parsedFromAddress2.city;
      if (!state && parsedFromAddress2.state) state = parsedFromAddress2.state;
      if (!zip && parsedFromAddress2.zip) zip = parsedFromAddress2.zip;
      if (!looksLikeSecondaryAddressLine(mailingAddress2)) {
        mailingAddress2 = null;
      }
    }
  }

  if (mailingAddress1) {
    const parsedFromAddress1 = parseCityStateZip(mailingAddress1);
    const hasParsedLocation = Boolean(parsedFromAddress1.city || parsedFromAddress1.state || parsedFromAddress1.zip);
    const hasStreetNumber = /\d/.test(mailingAddress1);
    if (hasParsedLocation && !hasStreetNumber && !looksLikeSecondaryAddressLine(mailingAddress1)) {
      if (!city && parsedFromAddress1.city) city = parsedFromAddress1.city;
      if (!state && parsedFromAddress1.state) state = parsedFromAddress1.state;
      if (!zip && parsedFromAddress1.zip) zip = parsedFromAddress1.zip;
      mailingAddress1 = null;
    }
  }

  if (mailingAddress2) {
    const mailingAddress2Token = normalizeMailingCompareToken(mailingAddress2);
    const mailingAddress1Token = normalizeMailingCompareToken(mailingAddress1);
    const payeeToken = normalizeMailingCompareToken(payeeName);
    const cityStateZipToken = normalizeMailingCompareToken(
      [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    );

    if (
      !mailingAddress2Token ||
      mailingAddress2Token === mailingAddress1Token ||
      mailingAddress2Token === payeeToken ||
      (cityStateZipToken.length > 0 && mailingAddress2Token === cityStateZipToken)
    ) {
      mailingAddress2 = null;
    }
  }

  if (!mailingAddress1 && mailingAddress2) {
    const parsedFromAddress2 = parseCityStateZip(mailingAddress2);
    const hasParsedLocation = Boolean(parsedFromAddress2.city || parsedFromAddress2.state || parsedFromAddress2.zip);
    if (!hasParsedLocation && !looksLikePhoneNumber(mailingAddress2)) {
      mailingAddress1 = mailingAddress2;
      mailingAddress2 = null;
    }
  }

  city = city ? city.replace(/[.,]+$/g, "").trim() : null;
  state = normalizeStateAbbreviation(state);
  zip = normalizeZipCode(zip);

  return {
    payeeName,
    mailingAddress1,
    mailingAddress2,
    city,
    state,
    zip,
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

function truncateText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function scoreMatch(haystack: string, query: string): number {
  const text = normalizeSearchQuery(haystack);
  if (!text || !query) return 0;
  if (text === query) return 120;
  if (text.startsWith(query)) return 90;
  if (text.includes(query)) return 60;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => text.includes(token))) return 45;
  return 0;
}

function safeIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function computePearsonCorrelation(
  values: Array<{
    x: number | null;
    y: number | null;
  }>
): number | null {
  const points = values
    .filter((value) => value.x !== null && value.y !== null)
    .map((value) => ({ x: value.x as number, y: value.y as number }));
  if (points.length < 3) return null;

  const n = points.length;
  const sumX = points.reduce((acc, point) => acc + point.x, 0);
  const sumY = points.reduce((acc, point) => acc + point.y, 0);
  const sumXy = points.reduce((acc, point) => acc + point.x * point.y, 0);
  const sumX2 = points.reduce((acc, point) => acc + point.x * point.x, 0);
  const sumY2 = points.reduce((acc, point) => acc + point.y * point.y, 0);

  const numerator = n * sumXy - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const correlation = numerator / denominator;
  if (!Number.isFinite(correlation)) return null;
  return Math.max(-1, Math.min(1, correlation));
}

function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function extractIpv4FromText(value: string): string | null {
  const match = value.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  if (!match) return null;
  return isValidIpv4(match[0]) ? match[0] : null;
}

let cachedTeslaPowerhubEgressIpv4:
  | {
      ip: string;
      source: string;
      fetchedAt: number;
    }
  | null = null;

const TESLA_POWERHUB_EGRESS_IPV4_CACHE_MS = 5 * 60 * 1000;

async function fetchTeslaPowerhubServerEgressIpv4(options?: {
  forceRefresh?: boolean;
}): Promise<{
  ip: string;
  cidr: string;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
}> {
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedTeslaPowerhubEgressIpv4 &&
    now - cachedTeslaPowerhubEgressIpv4.fetchedAt < TESLA_POWERHUB_EGRESS_IPV4_CACHE_MS
  ) {
    return {
      ip: cachedTeslaPowerhubEgressIpv4.ip,
      cidr: `${cachedTeslaPowerhubEgressIpv4.ip}/32`,
      source: cachedTeslaPowerhubEgressIpv4.source,
      fetchedAt: new Date(cachedTeslaPowerhubEgressIpv4.fetchedAt).toISOString(),
      fromCache: true,
    };
  }

  const providers: Array<{
    source: string;
    url: string;
    format: "json" | "text";
    jsonKey?: string;
  }> = [
    {
      source: "api.ipify.org",
      url: "https://api.ipify.org?format=json",
      format: "json",
      jsonKey: "ip",
    },
    {
      source: "ifconfig.me",
      url: "https://ifconfig.me/ip",
      format: "text",
    },
    {
      source: "ipv4.icanhazip.com",
      url: "https://ipv4.icanhazip.com",
      format: "text",
    },
  ];

  let lastError: string | null = null;

  for (const provider of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const response = await fetch(provider.url, {
        method: "GET",
        headers: {
          Accept: provider.format === "json" ? "application/json" : "text/plain",
          "User-Agent": "coherence-rmg/tesla-powerhub-egress-check",
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        throw new Error(`${provider.source} responded ${response.status}`);
      }

      let ip: string | null = null;
      if (provider.format === "json") {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        ip = extractIpv4FromText(String(payload[provider.jsonKey ?? "ip"] ?? ""));
      } else {
        const text = await response.text().catch(() => "");
        ip = extractIpv4FromText(text);
      }

      if (!ip) {
        throw new Error(`${provider.source} response did not include a valid IPv4 address`);
      }

      cachedTeslaPowerhubEgressIpv4 = {
        ip,
        source: provider.source,
        fetchedAt: Date.now(),
      };

      return {
        ip,
        cidr: `${ip}/32`,
        source: provider.source,
        fetchedAt: new Date(cachedTeslaPowerhubEgressIpv4.fetchedAt).toISOString(),
        fromCache: false,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown network error";
    }
  }

  throw new Error(
    `Unable to detect server egress IPv4 address.${lastError ? ` Last error: ${lastError}` : ""}`
  );
}

type TeslaPowerhubProductionJobStatus = "queued" | "running" | "completed" | "failed";

type TeslaPowerhubProductionJob = {
  id: string;
  userId: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: TeslaPowerhubProductionJobStatus;
  progress: {
    currentStep: number;
    totalSteps: number;
    percent: number;
    message: string;
    windowKey: string | null;
  };
  error: string | null;
  result: unknown | null;
};

const TESLA_POWERHUB_PRODUCTION_JOB_TTL_MS = 2 * 60 * 60 * 1000;
const teslaPowerhubProductionJobs = new Map<string, TeslaPowerhubProductionJob>();

type AbpSettlementContractScanJobStatus = "queued" | "running" | "completed" | "failed";

type AbpSettlementContractScanJobResultRow = {
  csgId: string;
  systemPageUrl: string;
  pdfUrl: string | null;
  pdfFileName: string | null;
  scan: {
    fileName: string;
    ccAuthorizationCompleted: boolean | null;
    ccCardAsteriskCount: number | null;
    additionalFivePercentSelected: boolean | null;
    additionalCollateralPercent: number | null;
    vendorFeePercent: number | null;
    systemName: string | null;
    paymentMethod: string | null;
    payeeName: string | null;
    mailingAddress1: string | null;
    mailingAddress2: string | null;
    cityStateZip: string | null;
    recQuantity: number | null;
    recPrice: number | null;
    acSizeKw: number | null;
    dcSizeKw: number | null;
  } | null;
  error: string | null;
};

type AbpSettlementContractScanJob = {
  id: string;
  userId: number;
  scanConfig: {
    csgIds: string[];
    portalEmail: string;
    portalBaseUrl: string | null;
  };
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  status: AbpSettlementContractScanJobStatus;
  progress: {
    current: number;
    total: number;
    percent: number;
    message: string;
    currentCsgId: string | null;
  };
  error: string | null;
  result: {
    rows: AbpSettlementContractScanJobResultRow[];
    successCount: number;
    failureCount: number;
  };
};

type AbpSettlementSavedRunSummary = {
  runId: string;
  monthKey: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  rowCount: number | null;
};

type AbpSettlementSavedRun = {
  summary: AbpSettlementSavedRunSummary;
  payload: string;
};

const ABP_SETTLEMENT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
const ABP_SETTLEMENT_SCAN_SESSION_REFRESH_INTERVAL = 80;
const ABP_SETTLEMENT_SCAN_CONCURRENCY = 3;
const ABP_SETTLEMENT_SCAN_SNAPSHOT_BATCH_SIZE = 10;
const abpSettlementJobs = new Map<string, AbpSettlementContractScanJob>();
const abpSettlementActiveScanRunners = new Set<string>();
const ABP_SETTLEMENT_RUNS_INDEX_DB_KEY = "abpSettlement:runs-index";

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

function normalizeProgressPercent(currentStep: number, totalSteps: number): number {
  if (!Number.isFinite(totalSteps) || totalSteps <= 0) return 0;
  return clampPercent((currentStep / totalSteps) * 100);
}

function pruneTeslaPowerhubProductionJobs(nowMs: number): void {
  Array.from(teslaPowerhubProductionJobs.entries()).forEach(([jobId, job]) => {
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > TESLA_POWERHUB_PRODUCTION_JOB_TTL_MS) {
      teslaPowerhubProductionJobs.delete(jobId);
    }
  });
}

function pruneAbpSettlementJobs(nowMs: number): void {
  Array.from(abpSettlementJobs.entries()).forEach(([jobId, job]) => {
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > ABP_SETTLEMENT_JOB_TTL_MS) {
      abpSettlementJobs.delete(jobId);
    }
  });
}

function getAbpSettlementRunsIndexObjectKey(userId: number): string {
  return `abp-settlement/${userId}/runs-index.json`;
}

function getAbpSettlementRunObjectKey(userId: number, runId: string): string {
  return `abp-settlement/${userId}/runs/${runId}.json`;
}

function getAbpSettlementRunDbKey(runId: string): string {
  return `abpSettlement:run:${runId}`;
}

function getAbpSettlementScanJobObjectKey(userId: number, jobId: string): string {
  return `abp-settlement/${userId}/scan-jobs/${jobId}.json`;
}

function getAbpSettlementScanJobDbKey(jobId: string): string {
  return `abpSettlement:scanJob:${jobId}`;
}

function parseAbpSettlementRunsIndex(payload: string | null | undefined): AbpSettlementSavedRunSummary[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => {
        const row = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
        if (!row) return null;
        const runId = toNonEmptyString(row.runId);
        const monthKey = toNonEmptyString(row.monthKey);
        const createdAt = toNonEmptyString(row.createdAt);
        const updatedAt = toNonEmptyString(row.updatedAt);
        if (!runId || !monthKey || !createdAt || !updatedAt) return null;
        const rowCountRaw = row.rowCount;
        const rowCount = typeof rowCountRaw === "number" && Number.isFinite(rowCountRaw) ? rowCountRaw : null;
        return {
          runId,
          monthKey,
          label: toNonEmptyString(row.label),
          createdAt,
          updatedAt,
          rowCount,
        } satisfies AbpSettlementSavedRunSummary;
      })
      .filter((row): row is AbpSettlementSavedRunSummary => Boolean(row))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  } catch {
    return [];
  }
}

function serializeAbpSettlementRunsIndex(rows: AbpSettlementSavedRunSummary[]): string {
  return JSON.stringify(rows);
}

async function readPayloadWithFallback(input: {
  userId: number;
  objectKey: string;
  dbStorageKey: string;
}): Promise<string | null> {
  try {
    const { getSolarRecDashboardPayload } = await import("./db");
    const payload = await getSolarRecDashboardPayload(input.userId, input.dbStorageKey);
    if (payload) return payload;
  } catch {
    // Fall through to storage.
  }

  try {
    const { storageGet } = await import("./storage");
    const { url } = await storageGet(input.objectKey);
    const response = await fetch(url);
    if (!response.ok) return null;
    const payload = await response.text();
    return payload || null;
  } catch {
    return null;
  }
}

async function writePayloadWithFallback(input: {
  userId: number;
  objectKey: string;
  dbStorageKey: string;
  payload: string;
}): Promise<{ persistedToDatabase: boolean; storageSynced: boolean }> {
  let persistedToDatabase = false;
  try {
    const { saveSolarRecDashboardPayload } = await import("./db");
    persistedToDatabase = await saveSolarRecDashboardPayload(
      input.userId,
      input.dbStorageKey,
      input.payload
    );
  } catch {
    persistedToDatabase = false;
  }

  try {
    const { storagePut } = await import("./storage");
    await storagePut(input.objectKey, input.payload, "application/json");
    return { persistedToDatabase, storageSynced: true };
  } catch (storageError) {
    if (persistedToDatabase) {
      return { persistedToDatabase, storageSynced: false };
    }
    throw storageError;
  }
}

async function getAbpSettlementRunsIndex(userId: number): Promise<AbpSettlementSavedRunSummary[]> {
  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunsIndexObjectKey(userId),
    dbStorageKey: ABP_SETTLEMENT_RUNS_INDEX_DB_KEY,
  });
  return parseAbpSettlementRunsIndex(payload);
}

async function saveAbpSettlementRunsIndex(
  userId: number,
  rows: AbpSettlementSavedRunSummary[]
): Promise<{ persistedToDatabase: boolean; storageSynced: boolean }> {
  const payload = serializeAbpSettlementRunsIndex(rows);
  return writePayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunsIndexObjectKey(userId),
    dbStorageKey: ABP_SETTLEMENT_RUNS_INDEX_DB_KEY,
    payload,
  });
}

async function getAbpSettlementRun(userId: number, runId: string): Promise<AbpSettlementSavedRun | null> {
  const normalizedRunId = runId.trim();
  if (!normalizedRunId) return null;

  const index = await getAbpSettlementRunsIndex(userId);
  const summary = index.find((row) => row.runId === normalizedRunId);
  if (!summary) return null;

  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunObjectKey(userId, normalizedRunId),
    dbStorageKey: getAbpSettlementRunDbKey(normalizedRunId),
  });
  if (!payload) return null;

  return {
    summary,
    payload,
  };
}

async function saveAbpSettlementRun(input: {
  userId: number;
  runId: string;
  monthKey: string;
  label: string | null;
  payload: string;
  rowCount: number | null;
}): Promise<{
  summary: AbpSettlementSavedRunSummary;
  indexWrite: { persistedToDatabase: boolean; storageSynced: boolean };
  runWrite: { persistedToDatabase: boolean; storageSynced: boolean };
}> {
  const nowIso = new Date().toISOString();
  const index = await getAbpSettlementRunsIndex(input.userId);
  const existing = index.find((row) => row.runId === input.runId);

  const summary: AbpSettlementSavedRunSummary = {
    runId: input.runId,
    monthKey: input.monthKey,
    label: input.label,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    rowCount: input.rowCount,
  };

  const nextIndex = [summary, ...index.filter((row) => row.runId !== input.runId)].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );

  const runWrite = await writePayloadWithFallback({
    userId: input.userId,
    objectKey: getAbpSettlementRunObjectKey(input.userId, input.runId),
    dbStorageKey: getAbpSettlementRunDbKey(input.runId),
    payload: input.payload,
  });
  const indexWrite = await saveAbpSettlementRunsIndex(input.userId, nextIndex);

  return {
    summary,
    indexWrite,
    runWrite,
  };
}

function parseAbpSettlementScanJobSnapshot(
  payload: string | null | undefined
): AbpSettlementContractScanJob | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<AbpSettlementContractScanJob>;
    if (!parsed || typeof parsed !== "object") return null;

    const id = toNonEmptyString(parsed.id);
    const status = toNonEmptyString(parsed.status) as AbpSettlementContractScanJobStatus | null;
    const createdAt = toNonEmptyString(parsed.createdAt);
    const updatedAt = toNonEmptyString(parsed.updatedAt);
    const scanConfig =
      parsed.scanConfig && typeof parsed.scanConfig === "object"
        ? (parsed.scanConfig as Record<string, unknown>)
        : null;
    const userId = typeof parsed.userId === "number" && Number.isFinite(parsed.userId) ? parsed.userId : null;

    if (!id || !status || !createdAt || !updatedAt || !scanConfig || userId === null) return null;

    const csgIds = Array.isArray(scanConfig.csgIds)
      ? scanConfig.csgIds.map((value) => toNonEmptyString(value)).filter((value): value is string => Boolean(value))
      : [];
    const portalEmail = toNonEmptyString(scanConfig.portalEmail);
    if (csgIds.length === 0 || !portalEmail) return null;

    const progress =
      parsed.progress && typeof parsed.progress === "object"
        ? (parsed.progress as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const result =
      parsed.result && typeof parsed.result === "object"
        ? (parsed.result as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const rawRows = Array.isArray(result.rows) ? result.rows : [];
    const rows = rawRows.filter(
      (value: unknown): value is AbpSettlementContractScanJobResultRow =>
        Boolean(
          value &&
            typeof value === "object" &&
            toNonEmptyString((value as Record<string, unknown>).csgId) &&
            toNonEmptyString((value as Record<string, unknown>).systemPageUrl)
        )
    );

    return {
      id,
      userId,
      scanConfig: {
        csgIds,
        portalEmail,
        portalBaseUrl: toNonEmptyString(scanConfig.portalBaseUrl),
      },
      createdAt,
      updatedAt,
      startedAt: toNonEmptyString(parsed.startedAt),
      finishedAt: toNonEmptyString(parsed.finishedAt),
      status,
      progress: {
        current:
          typeof progress.current === "number" && Number.isFinite(progress.current)
            ? Math.max(0, Math.floor(progress.current))
            : 0,
        total:
          typeof progress.total === "number" && Number.isFinite(progress.total)
            ? Math.max(1, Math.floor(progress.total))
            : Math.max(1, csgIds.length),
        percent:
          typeof progress.percent === "number" && Number.isFinite(progress.percent)
            ? clampPercent(progress.percent)
            : 0,
        message: toNonEmptyString(progress.message) ?? "Queued",
        currentCsgId: toNonEmptyString(progress.currentCsgId),
      },
      error: toNonEmptyString(parsed.error),
      result: {
        rows,
        successCount:
          typeof result.successCount === "number" && Number.isFinite(result.successCount)
            ? Math.max(0, Math.floor(result.successCount))
            : rows.filter((row) => !row.error && row.scan).length,
        failureCount:
          typeof result.failureCount === "number" && Number.isFinite(result.failureCount)
            ? Math.max(0, Math.floor(result.failureCount))
            : rows.filter((row) => Boolean(row.error) || !row.scan).length,
      },
    };
  } catch {
    return null;
  }
}

async function saveAbpSettlementScanJobSnapshot(job: AbpSettlementContractScanJob): Promise<void> {
  const payload = JSON.stringify(job);
  await writePayloadWithFallback({
    userId: job.userId,
    objectKey: getAbpSettlementScanJobObjectKey(job.userId, job.id),
    dbStorageKey: getAbpSettlementScanJobDbKey(job.id),
    payload,
  });
}

async function loadAbpSettlementScanJobSnapshot(
  userId: number,
  jobId: string
): Promise<AbpSettlementContractScanJob | null> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) return null;
  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementScanJobObjectKey(userId, normalizedJobId),
    dbStorageKey: getAbpSettlementScanJobDbKey(normalizedJobId),
  });
  const parsed = parseAbpSettlementScanJobSnapshot(payload);
  if (!parsed || parsed.userId !== userId) return null;
  return parsed;
}

async function runAbpSettlementContractScanJob(jobId: string): Promise<void> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId || abpSettlementActiveScanRunners.has(normalizedJobId)) return;

  const initialJob = abpSettlementJobs.get(normalizedJobId);
  if (!initialJob) return;
  if (initialJob.status === "completed" || initialJob.status === "failed") return;

  abpSettlementActiveScanRunners.add(normalizedJobId);

  const markJob = async (
    updater: (job: AbpSettlementContractScanJob) => AbpSettlementContractScanJob,
    options?: { persist?: boolean }
  ): Promise<AbpSettlementContractScanJob | null> => {
    const existingJob = abpSettlementJobs.get(normalizedJobId);
    if (!existingJob) return null;
    const nextJob = updater(existingJob);
    abpSettlementJobs.set(normalizedJobId, nextJob);
    if (options?.persist) {
      try {
        await saveAbpSettlementScanJobSnapshot(nextJob);
      } catch {
        // Best effort: keep in-memory job even if snapshot write fails.
      }
    }
    return nextJob;
  };

  try {
    const currentJob = abpSettlementJobs.get(normalizedJobId);
    if (!currentJob) return;

    const { getIntegrationByProvider } = await import("./db");
    const integration = await getIntegrationByProvider(currentJob.userId, CSG_PORTAL_PROVIDER);
    const metadata = parseCsgPortalMetadata(integration?.metadata);
    const resolvedEmail = currentJob.scanConfig.portalEmail || metadata.email;
    const resolvedPassword = toNonEmptyString(integration?.accessToken);
    const resolvedBaseUrl = currentJob.scanConfig.portalBaseUrl ?? metadata.baseUrl;

    if (!resolvedEmail || !resolvedPassword) {
      await markJob(
        (job) => ({
          ...job,
          status: "failed",
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: "Missing CSG portal credentials. Save portal email/password and retry.",
          progress: {
            ...job.progress,
            message: "Failed",
            currentCsgId: null,
          },
        }),
        { persist: true }
      );
      return;
    }

    await markJob(
      (job) => ({
        ...job,
        status: "running",
        startedAt: job.startedAt ?? new Date().toISOString(),
        finishedAt: null,
        updatedAt: new Date().toISOString(),
        error: null,
        progress: {
          ...job.progress,
          total: Math.max(1, job.scanConfig.csgIds.length),
          message: "Logging into CSG portal...",
        },
      }),
      { persist: true }
    );

    const { extractContractDataFromPdfBuffer } = await import("./services/contractScannerServer");
    const { CsgPortalClient } = await import("./services/csgPortal");
    const client = new CsgPortalClient({
      email: resolvedEmail,
      password: resolvedPassword,
      baseUrl: resolvedBaseUrl ?? undefined,
    });
    await client.login();

    const activeJob = abpSettlementJobs.get(normalizedJobId);
    if (!activeJob) return;

    const allIds = activeJob.scanConfig.csgIds;
    const rows = [...activeJob.result.rows];
    let successCount = Math.max(0, activeJob.result.successCount);
    let failureCount = Math.max(0, activeJob.result.failureCount);
    const processedIds = new Set(rows.map((row) => row.csgId));
    const pendingIds = allIds.filter((id) => !processedIds.has(id));

    // ── Session refresh mutex ────────────────────────────────────
    let completedSinceLastRefresh = 0;
    let sessionRefreshInFlight: Promise<void> | null = null;

    const refreshSessionIfNeeded = async (): Promise<void> => {
      if (completedSinceLastRefresh < ABP_SETTLEMENT_SCAN_SESSION_REFRESH_INTERVAL) return;
      // Only one refresh at a time; other workers wait for the same promise
      if (!sessionRefreshInFlight) {
        sessionRefreshInFlight = (async () => {
          try {
            await client.login();
          } finally {
            completedSinceLastRefresh = 0;
            sessionRefreshInFlight = null;
          }
        })();
      }
      await sessionRefreshInFlight;
    };

    // ── Snapshot batching ────────────────────────────────────────
    let rowsSinceLastSnapshot = 0;

    const persistSnapshotIfNeeded = async (force: boolean): Promise<void> => {
      if (!force && rowsSinceLastSnapshot < ABP_SETTLEMENT_SCAN_SNAPSHOT_BATCH_SIZE) return;
      rowsSinceLastSnapshot = 0;
      await markJob(
        (job) => ({
          ...job,
          updatedAt: new Date().toISOString(),
          result: { rows: [...rows], successCount, failureCount },
          progress: {
            current: rows.length,
            total: allIds.length,
            percent: normalizeProgressPercent(rows.length, allIds.length),
            message: `Scanned ${rows.length} of ${allIds.length}`,
            currentCsgId: null,
          },
        }),
        { persist: true }
      );
    };

    // ── Process a single contract ────────────────────────────────
    const processSingleContract = async (csgId: string): Promise<void> => {
      await refreshSessionIfNeeded();

      let fetched = await client.fetchRecContractPdf(csgId);
      const fetchError = (fetched.error ?? "").toLowerCase();
      const shouldRetryAfterRefresh =
        Boolean(fetchError) &&
        (fetchError.includes("timed out") ||
          fetchError.includes("session is not authenticated") ||
          fetchError.includes("portal login"));

      if (shouldRetryAfterRefresh) {
        try {
          await client.login();
          completedSinceLastRefresh = 0;
        } catch {
          // Keep original error if session refresh fails.
        }
        fetched = await client.fetchRecContractPdf(csgId);
      }

      let rowError = fetched.error;
      let scan: AbpSettlementContractScanJobResultRow["scan"] = null;

      if (!rowError && fetched.pdfData && fetched.pdfData.length > 0) {
        try {
          const extraction = await extractContractDataFromPdfBuffer(
            fetched.pdfData,
            fetched.pdfFileName ?? `contract-${csgId}.pdf`
          );
          scan = {
            fileName: extraction.fileName,
            ccAuthorizationCompleted: extraction.ccAuthorizationCompleted,
            ccCardAsteriskCount: extraction.ccCardAsteriskCount,
            additionalFivePercentSelected: extraction.additionalFivePercentSelected,
            additionalCollateralPercent: extraction.additionalCollateralPercent,
            vendorFeePercent: extraction.vendorFeePercent,
            systemName: extraction.systemName,
            paymentMethod: extraction.paymentMethod,
            payeeName: extraction.payeeName,
            mailingAddress1: extraction.mailingAddress1,
            mailingAddress2: extraction.mailingAddress2,
            cityStateZip: extraction.cityStateZip,
            recQuantity: extraction.recQuantity,
            recPrice: extraction.recPrice,
            acSizeKw: extraction.acSizeKw,
            dcSizeKw: extraction.dcSizeKw,
          };
        } catch (error) {
          rowError = error instanceof Error ? error.message : "Failed to parse downloaded contract PDF.";
        }
      }

      // Append result (synchronized — JS is single-threaded between awaits)
      rows.push({
        csgId,
        systemPageUrl: fetched.systemPageUrl,
        pdfUrl: fetched.pdfUrl,
        pdfFileName: fetched.pdfFileName,
        scan,
        error: rowError,
      });

      if (rowError === null && scan) {
        successCount += 1;
      } else {
        failureCount += 1;
      }

      completedSinceLastRefresh += 1;
      rowsSinceLastSnapshot += 1;

      // Update in-memory progress after every contract (cheap, no disk I/O)
      await markJob((job) => ({
        ...job,
        updatedAt: new Date().toISOString(),
        result: { rows: [...rows], successCount, failureCount },
        progress: {
          current: rows.length,
          total: allIds.length,
          percent: normalizeProgressPercent(rows.length, allIds.length),
          message: `Scanned ${rows.length} of ${allIds.length}`,
          currentCsgId: csgId,
        },
      }));

      // Persist to disk in batches
      await persistSnapshotIfNeeded(false);
    };

    // ── Run concurrent workers ───────────────────────────────────
    await markJob((job) => ({
      ...job,
      updatedAt: new Date().toISOString(),
      progress: {
        ...job.progress,
        message: `Scanning ${pendingIds.length} contracts (${ABP_SETTLEMENT_SCAN_CONCURRENCY} concurrent)...`,
      },
    }));

    await mapWithConcurrency(pendingIds, ABP_SETTLEMENT_SCAN_CONCURRENCY, async (csgId) => {
      await processSingleContract(csgId);
    });

    // Final persist
    await persistSnapshotIfNeeded(true);

    await markJob(
      (job) => ({
        ...job,
        status: "completed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: null,
        result: {
          rows: [...rows],
          successCount,
          failureCount,
        },
        progress: {
          current: allIds.length,
          total: allIds.length,
          percent: 100,
          message: "Completed",
          currentCsgId: null,
        },
      }),
      { persist: true }
    );
  } catch (error) {
    await markJob(
      (job) => ({
        ...job,
        status: "failed",
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : "Unknown ABP settlement job error.",
        progress: {
          ...job.progress,
          message: "Failed",
          currentCsgId: null,
        },
      }),
      { persist: true }
    );
  } finally {
    abpSettlementActiveScanRunners.delete(normalizedJobId);
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  mapper: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  const safeConcurrency = Math.max(1, Math.floor(concurrency));
  const results: TOutput[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  const workerCount = Math.min(safeConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function parseEnphaseV2Metadata(metadata: string | null | undefined): {
  userId: string | null;
  baseUrl: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    userId: toNonEmptyString(parsed.userId),
    baseUrl: toNonEmptyString(parsed.baseUrl),
  };
}

function parseEnphaseV4Metadata(metadata: string | null | undefined): {
  apiKey: string | null;
  clientId: string | null;
  clientSecret: string | null;
  baseUrl: string | null;
  redirectUri: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    apiKey: toNonEmptyString(parsed.apiKey),
    clientId: toNonEmptyString(parsed.clientId),
    clientSecret: toNonEmptyString(parsed.clientSecret),
    baseUrl: toNonEmptyString(parsed.baseUrl),
    redirectUri: toNonEmptyString(parsed.redirectUri),
  };
}

function parseZendeskMetadata(metadata: string | null | undefined): {
  subdomain: string | null;
  email: string | null;
  trackedUsers: string[];
} {
  const parsed = parseJsonMetadata(metadata);
  const trackedUsersRaw = Array.isArray(parsed.trackedUsers) ? parsed.trackedUsers : [];
  const trackedUsers = trackedUsersRaw
    .map((value) => toNonEmptyString(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
    .filter((value, index, array) => array.indexOf(value) === index);
  return {
    subdomain: toNonEmptyString(parsed.subdomain),
    email: toNonEmptyString(parsed.email),
    trackedUsers,
  };
}

function parseTeslaSolarMetadata(metadata: string | null | undefined): {
  baseUrl: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    baseUrl: toNonEmptyString(parsed.baseUrl),
  };
}

function parseTeslaPowerhubMetadata(metadata: string | null | undefined): {
  clientId: string | null;
  tokenUrl: string | null;
  apiBaseUrl: string | null;
  portalBaseUrl: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    clientId: toNonEmptyString(parsed.clientId),
    tokenUrl: toNonEmptyString(parsed.tokenUrl),
    apiBaseUrl: toNonEmptyString(parsed.apiBaseUrl),
    portalBaseUrl: toNonEmptyString(parsed.portalBaseUrl),
  };
}

function parseClockifyMetadata(metadata: string | null | undefined): {
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    workspaceId: toNonEmptyString(parsed.workspaceId),
    workspaceName: toNonEmptyString(parsed.workspaceName),
    userId: toNonEmptyString(parsed.userId),
    userName: toNonEmptyString(parsed.userName),
    userEmail: toNonEmptyString(parsed.userEmail),
  };
}

function parseCsgPortalMetadata(metadata: string | null | undefined): {
  email: string | null;
  baseUrl: string | null;
  lastTestedAt: string | null;
  lastTestStatus: "success" | "failure" | null;
  lastTestMessage: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  const testStatus = toNonEmptyString(parsed.lastTestStatus);
  return {
    email: toNonEmptyString(parsed.email),
    baseUrl: toNonEmptyString(parsed.baseUrl),
    lastTestedAt: toNonEmptyString(parsed.lastTestedAt),
    lastTestStatus: testStatus === "success" || testStatus === "failure" ? testStatus : null,
    lastTestMessage: toNonEmptyString(parsed.lastTestMessage),
  };
}

function serializeCsgPortalMetadata(metadata: {
  email: string | null;
  baseUrl: string | null;
  lastTestedAt?: string | null;
  lastTestStatus?: "success" | "failure" | null;
  lastTestMessage?: string | null;
}): string {
  return JSON.stringify({
    email: metadata.email,
    baseUrl: metadata.baseUrl,
    lastTestedAt: metadata.lastTestedAt ?? null,
    lastTestStatus: metadata.lastTestStatus ?? null,
    lastTestMessage: metadata.lastTestMessage ?? null,
  });
}

function serializeZendeskMetadata(metadata: {
  subdomain: string;
  email: string;
  trackedUsers?: string[];
}): string {
  const trackedUsers = (metadata.trackedUsers ?? [])
    .map((value) => toNonEmptyString(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase())
    .filter((value, index, array) => array.indexOf(value) === index);

  return JSON.stringify({
    subdomain: metadata.subdomain,
    email: metadata.email,
    trackedUsers,
  });
}

type SolarEdgeConnectionConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

function maskApiKey(apiKey: string): string {
  const normalized = apiKey.trim();
  if (!normalized) return "";
  if (normalized.length <= 6) return `${"*".repeat(Math.max(0, normalized.length - 2))}${normalized.slice(-2)}`;
  return `${normalized.slice(0, 3)}${"*".repeat(Math.max(0, normalized.length - 6))}${normalized.slice(-3)}`;
}

function parseSolarEdgeMetadata(
  metadata: string | null | undefined,
  fallbackApiKey?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: SolarEdgeConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: SolarEdgeConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `solaredge-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      if (!apiKey) return null;
      const createdAt = toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `SolarEdge API ${index + 1}`,
        apiKey,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt,
        updatedAt,
      } satisfies SolarEdgeConnectionConfig;
    })
    .filter((value): value is SolarEdgeConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyApiKey = toNonEmptyString(fallbackApiKey);
    if (legacyApiKey) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-solaredge-key",
        name: "Legacy API Key",
        apiKey: legacyApiKey,
        baseUrl,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const activeConnectionId =
    (activeConnectionIdRaw && connections.some((connection) => connection.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;

  return {
    baseUrl,
    activeConnectionId,
    connections,
  };
}

function serializeSolarEdgeMetadata(
  connections: SolarEdgeConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({
    baseUrl,
    activeConnectionId,
    connections,
  });
}

async function getEnphaseV2Credentials(userId: number): Promise<{
  apiKey: string;
  userId: string;
  baseUrl: string | null;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, ENPHASE_V2_PROVIDER);
  const apiKey = toNonEmptyString(integration?.accessToken);
  const metadata = parseEnphaseV2Metadata(integration?.metadata);

  if (!apiKey || !metadata.userId) {
    throw new Error("Enphase v2 is not connected. Save API key and user ID first.");
  }

  return {
    apiKey,
    userId: metadata.userId,
    baseUrl: metadata.baseUrl,
  };
}

async function getEnphaseV4Context(userId: number): Promise<{
  accessToken: string;
  apiKey: string;
  baseUrl: string | null;
}> {
  const { getIntegrationByProvider, upsertIntegration } = await import("./db");
  const integration = await getIntegrationByProvider(userId, ENPHASE_V4_PROVIDER);
  if (!integration?.accessToken) {
    throw new Error("Enphase v4 is not connected. Exchange an authorization code first.");
  }

  const metadata = parseEnphaseV4Metadata(integration.metadata);
  if (!metadata.apiKey || !metadata.clientId || !metadata.clientSecret) {
    throw new Error("Enphase v4 connection is incomplete. Reconnect with API key + client credentials.");
  }

  const now = Date.now();
  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt).getTime() : null;
  const needsRefresh = !expiresAt || expiresAt - now < 5 * 60 * 1000;

  let accessToken = integration.accessToken;
  if (needsRefresh) {
    if (!integration.refreshToken) {
      throw new Error("Enphase token expired and no refresh token is available. Reconnect first.");
    }
    const { refreshEnphaseV4AccessToken } = await import("./services/enphaseV4");
    const refreshed = await refreshEnphaseV4AccessToken({
      clientId: metadata.clientId,
      clientSecret: metadata.clientSecret,
      refreshToken: integration.refreshToken,
    });

    accessToken = refreshed.access_token;
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await upsertIntegration({
      ...integration,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token || integration.refreshToken,
      expiresAt: newExpiresAt,
      scope: refreshed.scope || integration.scope,
    });
  }

  return {
    accessToken,
    apiKey: metadata.apiKey,
    baseUrl: metadata.baseUrl,
  };
}

async function getSolarEdgeContext(userId: number): Promise<{
  apiKey: string;
  baseUrl: string | null;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, SOLAR_EDGE_PROVIDER);
  const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection =
    metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];

  if (!activeConnection) {
    throw new Error("SolarEdge is not connected. Save API key first.");
  }

  return {
    apiKey: activeConnection.apiKey,
    baseUrl: activeConnection.baseUrl ?? metadata.baseUrl,
  };
}

async function getZendeskContext(userId: number): Promise<{
  subdomain: string;
  email: string;
  apiToken: string;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, ZENDESK_PROVIDER);
  const apiToken = toNonEmptyString(integration?.accessToken);
  const metadata = parseZendeskMetadata(integration?.metadata);

  if (!apiToken || !metadata.subdomain || !metadata.email) {
    throw new Error("Zendesk is not connected. Save subdomain, email, and API token first.");
  }

  return {
    subdomain: metadata.subdomain,
    email: metadata.email,
    apiToken,
  };
}

async function getTeslaSolarContext(userId: number): Promise<{
  accessToken: string;
  baseUrl: string | null;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, TESLA_SOLAR_PROVIDER);
  const accessToken = toNonEmptyString(integration?.accessToken);
  const metadata = parseTeslaSolarMetadata(integration?.metadata);

  if (!accessToken) {
    throw new Error("Tesla Solar is not connected. Save an access token first.");
  }

  return {
    accessToken,
    baseUrl: metadata.baseUrl,
  };
}

async function getTeslaPowerhubContext(userId: number): Promise<{
  clientId: string;
  clientSecret: string;
  tokenUrl: string | null;
  apiBaseUrl: string | null;
  portalBaseUrl: string | null;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, TESLA_POWERHUB_PROVIDER);
  const clientSecret = toNonEmptyString(integration?.accessToken);
  const metadata = parseTeslaPowerhubMetadata(integration?.metadata);

  if (!clientSecret || !metadata.clientId) {
    throw new Error("Tesla Powerhub is not connected. Save client ID and client secret first.");
  }

  return {
    clientId: metadata.clientId,
    clientSecret,
    tokenUrl: metadata.tokenUrl,
    apiBaseUrl: metadata.apiBaseUrl,
    portalBaseUrl: metadata.portalBaseUrl,
  };
}

async function getClockifyContext(userId: number): Promise<{
  apiKey: string;
  workspaceId: string;
  workspaceName: string | null;
  clockifyUserId: string;
  userName: string | null;
  userEmail: string | null;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, CLOCKIFY_PROVIDER);
  const apiKey = toNonEmptyString(integration?.accessToken);
  const metadata = parseClockifyMetadata(integration?.metadata);

  if (!apiKey) {
    throw new Error("Clockify is not connected. Save a Clockify API key first.");
  }
  if (!metadata.workspaceId || !metadata.userId) {
    throw new Error("Clockify setup is incomplete. Reconnect Clockify from Settings.");
  }

  return {
    apiKey,
    workspaceId: metadata.workspaceId,
    workspaceName: metadata.workspaceName,
    clockifyUserId: metadata.userId,
    userName: metadata.userName,
    userEmail: metadata.userEmail,
  };
}

async function getCsgPortalContext(userId: number): Promise<{
  email: string;
  password: string;
  baseUrl: string | null;
}> {
  const { getIntegrationByProvider } = await import("./db");
  const integration = await getIntegrationByProvider(userId, CSG_PORTAL_PROVIDER);
  const password = toNonEmptyString(integration?.accessToken);
  const metadata = parseCsgPortalMetadata(integration?.metadata);

  if (!password || !metadata.email) {
    throw new Error("CSG portal is not connected. Save portal email/password first.");
  }

  return {
    email: metadata.email,
    password,
    baseUrl: metadata.baseUrl,
  };
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(async (opts) => {
      if (!opts.ctx.user) return null;
      const { getTotpSecret } = await import("./db");
      const totp = await getTotpSecret(opts.ctx.user.id);
      const has2FA = totp?.verified === true;
      return {
        ...opts.ctx.user,
        twoFactorEnabled: has2FA,
        twoFactorPending: has2FA && !opts.ctx.twoFactorVerified,
      };
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  twoFactor: router({
    status: twoFactorPendingProcedure.query(async ({ ctx }) => {
      const { getTotpSecret, getUnusedRecoveryCodeCount } = await import("./db");
      const totp = await getTotpSecret(ctx.user.id);
      const enabled = totp?.verified === true;
      const recoveryCodesRemaining = enabled ? await getUnusedRecoveryCodeCount(ctx.user.id) : 0;
      return { enabled, recoveryCodesRemaining };
    }),

    setup: protectedProcedure.mutation(async ({ ctx }) => {
      const { generateTotpSecret, generateRecoveryCodes, hashRecoveryCode, generateQrDataUrl } = await import("./_core/totp");
      const { saveTotpSecret, saveRecoveryCodes } = await import("./db");

      const { secret, otpauthUri } = generateTotpSecret(ctx.user.email || ctx.user.name || "user");
      const qrDataUrl = await generateQrDataUrl(otpauthUri);
      const recoveryCodes = generateRecoveryCodes();
      const codeHashes = recoveryCodes.map(hashRecoveryCode);

      await saveTotpSecret(ctx.user.id, secret);
      await saveRecoveryCodes(ctx.user.id, codeHashes);

      return { qrDataUrl, secret, recoveryCodes };
    }),

    confirmSetup: twoFactorPendingProcedure
      .input(z.object({ code: z.string().length(6) }))
      .mutation(async ({ ctx, input }) => {
        const { getTotpSecret, markTotpVerified } = await import("./db");
        const { verifyTotpCode } = await import("./_core/totp");

        const totp = await getTotpSecret(ctx.user.id);
        if (!totp || totp.verified) {
          return { success: false, error: "No pending 2FA setup found" };
        }

        if (!verifyTotpCode(totp.secret, input.code)) {
          return { success: false, error: "Invalid code" };
        }

        await markTotpVerified(ctx.user.id);
        return { success: true };
      }),

    verify: twoFactorPendingProcedure
      .input(z.object({ code: z.string().min(1).max(20) }))
      .mutation(async ({ ctx, input }) => {
        const { getTotpSecret, consumeRecoveryCode } = await import("./db");
        const { verifyTotpCode, hashRecoveryCode } = await import("./_core/totp");
        const { parse: parseCookieHeader } = await import("cookie");

        const totp = await getTotpSecret(ctx.user.id);
        if (!totp?.verified) {
          return { success: false, error: "2FA not enabled" };
        }

        const code = input.code.trim();
        let valid = false;

        // Try TOTP code first (6 digits)
        if (/^\d{6}$/.test(code)) {
          valid = verifyTotpCode(totp.secret, code);
        }

        // Try recovery code if TOTP didn't match
        if (!valid) {
          const hash = hashRecoveryCode(code);
          valid = await consumeRecoveryCode(ctx.user.id, hash);
        }

        if (!valid) {
          return { success: false, error: "Invalid code" };
        }

        // Re-sign JWT with twoFactorVerified: true
        const cookies = parseCookieHeader(ctx.req.headers.cookie ?? "");
        const sessionCookie = cookies[COOKIE_NAME];
        const newToken = await sdk.reissueSessionWith2FA(sessionCookie);
        if (newToken) {
          const cookieOptions = getSessionCookieOptions(ctx.req);
          ctx.res.cookie(COOKIE_NAME, newToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
        }

        return { success: true };
      }),

    disable: protectedProcedure
      .input(z.object({ code: z.string().min(1).max(20) }))
      .mutation(async ({ ctx, input }) => {
        const { getTotpSecret, deleteTotpSecret, deleteRecoveryCodes } = await import("./db");
        const { verifyTotpCode } = await import("./_core/totp");

        const totp = await getTotpSecret(ctx.user.id);
        if (!totp?.verified) {
          return { success: false, error: "2FA not enabled" };
        }

        if (!verifyTotpCode(totp.secret, input.code.trim())) {
          return { success: false, error: "Invalid code" };
        }

        await deleteTotpSecret(ctx.user.id);
        await deleteRecoveryCodes(ctx.user.id);
        return { success: true };
      }),

    regenerateRecoveryCodes: protectedProcedure
      .input(z.object({ code: z.string().length(6) }))
      .mutation(async ({ ctx, input }) => {
        const { getTotpSecret, saveRecoveryCodes } = await import("./db");
        const { verifyTotpCode, generateRecoveryCodes, hashRecoveryCode } = await import("./_core/totp");

        const totp = await getTotpSecret(ctx.user.id);
        if (!totp?.verified) {
          return { success: false, error: "2FA not enabled", recoveryCodes: [] };
        }

        if (!verifyTotpCode(totp.secret, input.code.trim())) {
          return { success: false, error: "Invalid code", recoveryCodes: [] };
        }

        const recoveryCodes = generateRecoveryCodes();
        const codeHashes = recoveryCodes.map(hashRecoveryCode);
        await saveRecoveryCodes(ctx.user.id, codeHashes);

        return { success: true, recoveryCodes };
      }),
  }),

  integrations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getUserIntegrations } = await import("./db");
      return getUserIntegrations(ctx.user.id);
    }),
    delete: protectedProcedure.input(z.object({ id: z.string().max(64) })).mutation(async ({ input }) => {
      const { deleteIntegration } = await import("./db");
      await deleteIntegration(input.id);
      return { success: true };
    }),
  }),

  oauthCreds: router({
    get: protectedProcedure
      .input(z.object({ provider: z.string().min(1).max(64) }))
      .query(async ({ ctx, input }) => {
        const { getOAuthCredential } = await import("./db");
        return getOAuthCredential(ctx.user.id, input.provider);
      }),
    save: protectedProcedure
      .input(
        z.object({
          provider: z.string().min(1).max(64),
          clientId: z.string().min(1).max(512),
          clientSecret: z.string().min(1).max(512),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertOAuthCredential } = await import("./db");
        const { nanoid } = await import("nanoid");
        await upsertOAuthCredential({
          id: nanoid(),
          userId: ctx.user.id,
          provider: input.provider,
          clientId: input.clientId,
          clientSecret: input.clientSecret,
        });
        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ provider: z.string().min(1).max(64) }))
      .mutation(async ({ ctx, input }) => {
        const { deleteOAuthCredential } = await import("./db");
        await deleteOAuthCredential(ctx.user.id, input.provider);
        return { success: true };
      }),
  }),

  preferences: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const { getUserPreferences } = await import("./db");
      return getUserPreferences(ctx.user.id);
    }),
    update: protectedProcedure
      .input(
        z.object({
          displayName: z.string().max(120).nullable().optional(),
          enabledWidgets: z.string().optional(),
          widgetLayout: z.string().optional(),
          theme: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertUserPreferences } = await import("./db");
        const { nanoid } = await import("nanoid");
        await upsertUserPreferences({
          id: nanoid(),
          userId: ctx.user.id,
          ...input,
        });
        return { success: true };
      }),
  }),

  marketDashboard: (() => {
    // In-memory cache with 5-minute TTL; stale data served if fresh fetch fails
    let cachedData: {
      quotes: any[];
      headlines: any[];
      approvalRatings: any[];
      fetchedAt: string;
    } | null = null;
    let cacheExpiry = 0;
    const CACHE_TTL_MS = 5 * 60 * 1000;
    const APPROVAL_FETCH_TIMEOUT_MS = 4_500;

    async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          promise,
          new Promise<T>((resolve) => {
            timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
          }),
        ]);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }

    return router({
      getMarketData: protectedProcedure.query(async () => {
        const now = Date.now();
        if (cachedData && now < cacheExpiry) {
          return cachedData;
        }

        const { fetchMarketQuotes } = await import("./services/marketData");
        const { fetchNewsHeadlines } = await import("./services/newsHeadlines");
        const { fetchTrumpApprovalRatings } = await import("./services/approvalRatings");

        try {
          const [quotesResult, headlinesResult, approvalResult] = await Promise.allSettled([
            fetchMarketQuotes([
              "GEVO", "MNTK", "PLUG", "ALTO", "REX",
              "BTC-USD", "ETH-USD",
            ]),
            fetchNewsHeadlines(),
            withTimeout(fetchTrumpApprovalRatings(), APPROVAL_FETCH_TIMEOUT_MS, [] as any[]),
          ]);

          const quotes = quotesResult.status === "fulfilled" ? quotesResult.value : [];
          const headlines = headlinesResult.status === "fulfilled" ? headlinesResult.value : [];
          const approvalRatings = approvalResult.status === "fulfilled" ? approvalResult.value : [];
          const quotesError =
            quotesResult.status === "rejected" ? String((quotesResult.reason as any)?.message ?? quotesResult.reason ?? "") : "";
          const marketRateLimited =
            quotesResult.status === "rejected" &&
            /429|rate limit|too many requests/i.test(quotesError);

          if (quotesResult.status === "rejected") {
            console.warn("[MarketDashboard] Market quotes fetch failed:", quotesResult.reason);
          }
          if (headlinesResult.status === "rejected") {
            console.warn("[MarketDashboard] Headlines fetch failed:", headlinesResult.reason);
          }
          if (approvalResult.status === "rejected") {
            console.warn("[MarketDashboard] Approval ratings fetch failed:", approvalResult.reason);
          }

          // If Yahoo is rate-limited, prefer serving the last good cached quotes
          // instead of returning an empty market section.
          if (marketRateLimited && cachedData?.quotes?.length) {
            const staleSafeData = {
              ...cachedData,
              headlines: headlines.length > 0 ? headlines : cachedData.headlines,
              approvalRatings:
                approvalRatings.length > 0 ? approvalRatings : cachedData.approvalRatings,
              marketRateLimited: true,
              usingStaleQuotes: true,
            };
            cacheExpiry = now + CACHE_TTL_MS;
            return staleSafeData;
          }

          const freshData = {
            quotes,
            headlines,
            approvalRatings,
            fetchedAt: new Date().toISOString(),
            marketRateLimited,
          };
          // Only update cache if we got meaningful data
          if (quotes.length > 0 || headlines.length > 0 || approvalRatings.length > 0) {
            cachedData = freshData;
            cacheExpiry = now + CACHE_TTL_MS;
          }
          return freshData;
        } catch (error) {
          console.warn("[MarketDashboard] Fetch failed, returning stale cache if available:", error);
          // Return stale data rather than nothing
          if (cachedData) return cachedData;
          return { quotes: [], headlines: [], approvalRatings: [], fetchedAt: new Date().toISOString() };
        }
      }),
    });
  })(),

  feedback: router({
    submit: protectedProcedure
      .input(
        z.object({
          pagePath: z.string().min(1).max(255),
          sectionId: z.string().max(191).optional(),
          category: z
            .enum(["improvement", "bug", "ui", "data", "workflow", "other"])
            .optional(),
          note: z.string().min(3).max(4000),
          contextJson: z.string().max(16000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { submitUserFeedback } = await import("./db");
        const row = await submitUserFeedback({
          userId: ctx.user.id,
          pagePath: input.pagePath.trim(),
          sectionId: toNonEmptyString(input.sectionId),
          category: input.category ?? "improvement",
          note: input.note.trim(),
          status: "open",
          contextJson: toNonEmptyString(input.contextJson),
        });

        return {
          success: Boolean(row),
          feedbackId: row?.id ?? null,
        };
      }),
    listMine: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { listUserFeedback } = await import("./db");
        return listUserFeedback(ctx.user.id, input?.limit ?? 25);
      }),
    listRecent: adminProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(500).optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        const { listRecentUserFeedback } = await import("./db");
        return listRecentUserFeedback(input?.limit ?? 200);
      }),
  }),

  solarRecDashboard: router({
    getState: protectedProcedure.query(async ({ ctx }) => {
      const key = `solar-rec-dashboard/${ctx.user.id}/state.json`;
      const dbStorageKey = "state";

      try {
        const { getSolarRecDashboardPayload } = await import("./db");
        const payload = await getSolarRecDashboardPayload(ctx.user.id, dbStorageKey);
        if (payload) return { key, payload };
      } catch {
        // Fall back to storage proxy.
      }

      try {
        const { storageGet } = await import("./storage");
        const { url } = await storageGet(key);
        const response = await fetch(url);
        if (!response.ok) return null;
        const payload = await response.text();
        if (!payload) return null;
        return { key, payload };
      } catch {
        return null;
      }
    }),
    saveState: protectedProcedure
      .input(
        z.object({
          payload: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const key = `solar-rec-dashboard/${ctx.user.id}/state.json`;
        const dbStorageKey = "state";
        let persistedToDatabase = false;

        try {
          const { saveSolarRecDashboardPayload } = await import("./db");
          persistedToDatabase = await saveSolarRecDashboardPayload(ctx.user.id, dbStorageKey, input.payload);
        } catch {
          persistedToDatabase = false;
        }

        try {
          const { storagePut } = await import("./storage");
          await storagePut(key, input.payload, "application/json");
          return { success: true, key, persistedToDatabase, storageSynced: true };
        } catch (storageError) {
          if (persistedToDatabase) {
            return { success: true, key, persistedToDatabase, storageSynced: false };
          }
          throw storageError;
        }
      }),
    getDataset: protectedProcedure
      .input(
        z.object({
          key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const key = `solar-rec-dashboard/${ctx.user.id}/datasets/${input.key}.json`;
        const dbStorageKey = `dataset:${input.key}`;

        try {
          const { getSolarRecDashboardPayload } = await import("./db");
          const payload = await getSolarRecDashboardPayload(ctx.user.id, dbStorageKey);
          if (payload) return { key, payload };
        } catch {
          // Fall back to storage proxy.
        }

        try {
          const { storageGet } = await import("./storage");
          const { url } = await storageGet(key);
          const response = await fetch(url);
          if (!response.ok) return null;
          const payload = await response.text();
          if (!payload) return null;
          return { key, payload };
        } catch {
          return null;
        }
      }),
    saveDataset: protectedProcedure
      .input(
        z.object({
          key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          payload: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const key = `solar-rec-dashboard/${ctx.user.id}/datasets/${input.key}.json`;
        const dbStorageKey = `dataset:${input.key}`;
        let persistedToDatabase = false;

        try {
          const { saveSolarRecDashboardPayload } = await import("./db");
          persistedToDatabase = await saveSolarRecDashboardPayload(ctx.user.id, dbStorageKey, input.payload);
        } catch {
          persistedToDatabase = false;
        }

        try {
          const { storagePut } = await import("./storage");
          await storagePut(key, input.payload, "application/json");
          return { success: true, key, persistedToDatabase, storageSynced: true };
        } catch (storageError) {
          if (persistedToDatabase) {
            return { success: true, key, persistedToDatabase, storageSynced: false };
          }
          throw storageError;
        }
      }),
  }),

  // Service-specific routers
  enphaseV2: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V2_PROVIDER);
      const metadata = parseEnphaseV2Metadata(integration?.metadata);

      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.userId),
        userId: metadata.userId,
        baseUrl: metadata.baseUrl,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          userId: z.string().min(1),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");

        const metadata = JSON.stringify({
          userId: input.userId.trim(),
          baseUrl: toNonEmptyString(input.baseUrl),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENPHASE_V2_PROVIDER,
          accessToken: input.apiKey.trim(),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V2_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listSystems: protectedProcedure.query(async ({ ctx }) => {
      const credentials = await getEnphaseV2Credentials(ctx.user.id);
      const { listSystems } = await import("./services/enphaseV2");
      return listSystems(credentials);
    }),
    getSummary: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        const { getSystemSummary } = await import("./services/enphaseV2");
        return getSystemSummary(credentials, input.systemId.trim());
      }),
    getEnergyLifetime: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        const { getSystemEnergyLifetime } = await import("./services/enphaseV2");
        return getSystemEnergyLifetime(
          credentials,
          input.systemId.trim(),
          input.startDate,
          input.endDate
        );
      }),
    getRgmStats: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        const { getSystemRgmStats } = await import("./services/enphaseV2");
        return getSystemRgmStats(credentials, input.systemId.trim(), input.startDate, input.endDate);
      }),
    getProductionMeterReadings: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const credentials = await getEnphaseV2Credentials(ctx.user.id);
        const { getSystemProductionMeterReadings } = await import("./services/enphaseV2");
        return getSystemProductionMeterReadings(
          credentials,
          input.systemId.trim(),
          input.startDate,
          input.endDate
        );
      }),
  }),

  enphaseV4: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V4_PROVIDER);
      const metadata = parseEnphaseV4Metadata(integration?.metadata);
      return {
        connected: Boolean(integration?.accessToken && metadata.apiKey && metadata.clientId),
        hasRefreshToken: Boolean(integration?.refreshToken),
        expiresAt: integration?.expiresAt ? new Date(integration.expiresAt).toISOString() : null,
        clientId: metadata.clientId,
        baseUrl: metadata.baseUrl,
        redirectUri: metadata.redirectUri,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          clientId: z.string().min(1),
          clientSecret: z.string().min(1),
          authorizationCode: z.string().min(1),
          redirectUri: z.string().optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const { exchangeEnphaseV4AuthorizationCode } = await import("./services/enphaseV4");

        const tokenData = await exchangeEnphaseV4AuthorizationCode({
          clientId: input.clientId.trim(),
          clientSecret: input.clientSecret.trim(),
          authorizationCode: input.authorizationCode.trim(),
          redirectUri: input.redirectUri,
        });

        const metadata = JSON.stringify({
          apiKey: input.apiKey.trim(),
          clientId: input.clientId.trim(),
          clientSecret: input.clientSecret.trim(),
          redirectUri: toNonEmptyString(input.redirectUri),
          baseUrl: toNonEmptyString(input.baseUrl),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ENPHASE_V4_PROVIDER,
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token ?? null,
          expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
          scope: tokenData.scope ?? null,
          metadata,
        });

        return {
          success: true,
          hasRefreshToken: Boolean(tokenData.refresh_token),
          expiresInSeconds: tokenData.expires_in,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, ENPHASE_V4_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listSystems: protectedProcedure.query(async ({ ctx }) => {
      const context = await getEnphaseV4Context(ctx.user.id);
      const { listSystems } = await import("./services/enphaseV4");
      return listSystems(context);
    }),
    getSummary: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        const { getSystemSummary } = await import("./services/enphaseV4");
        return getSystemSummary(context, input.systemId.trim());
      }),
    getEnergyLifetime: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        const { getSystemEnergyLifetime } = await import("./services/enphaseV4");
        return getSystemEnergyLifetime(context, input.systemId.trim(), input.startDate, input.endDate);
      }),
    getRgmStats: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        const { getSystemRgmStats } = await import("./services/enphaseV4");
        return getSystemRgmStats(context, input.systemId.trim(), input.startDate, input.endDate);
      }),
    getProductionMeterReadings: protectedProcedure
      .input(
        z.object({
          systemId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getEnphaseV4Context(ctx.user.id);
        const { getSystemProductionMeterTelemetry } = await import("./services/enphaseV4");
        return getSystemProductionMeterTelemetry(
          context,
          input.systemId.trim(),
          input.startDate,
          input.endDate
        );
      }),
  }),

  solarEdge: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
      const activeConnection =
        metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];

      return {
        connected: metadata.connections.length > 0,
        baseUrl: activeConnection?.baseUrl ?? metadata.baseUrl,
        activeConnectionId: activeConnection?.id ?? null,
        connections: metadata.connections.map((connection) => ({
          id: connection.id,
          name: connection.name,
          baseUrl: connection.baseUrl,
          apiKeyMasked: maskApiKey(connection.apiKey),
          updatedAt: connection.updatedAt,
          isActive: connection.id === activeConnection?.id,
        })),
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          connectionName: z.string().optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        const existingMetadata = parseSolarEdgeMetadata(existing?.metadata, toNonEmptyString(existing?.accessToken));
        const nowIso = new Date().toISOString();
        const newConnection: SolarEdgeConnectionConfig = {
          id: nanoid(),
          name:
            toNonEmptyString(input.connectionName) ??
            `SolarEdge API ${existingMetadata.connections.length + 1}`,
          apiKey: input.apiKey.trim(),
          baseUrl: toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        const connections = [newConnection, ...existingMetadata.connections];
        const activeConnectionId = newConnection.id;
        const metadata = serializeSolarEdgeMetadata(
          connections,
          activeConnectionId,
          newConnection.baseUrl ?? existingMetadata.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: SOLAR_EDGE_PROVIDER,
          accessToken: newConnection.apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId,
          totalConnections: connections.length,
        };
      }),
    setActiveConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        if (!integration) {
          throw new Error("SolarEdge is not connected.");
        }
        const metadataState = parseSolarEdgeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const activeConnection = metadataState.connections.find((connection) => connection.id === input.connectionId);
        if (!activeConnection) {
          throw new Error("Selected SolarEdge API profile was not found.");
        }

        const metadata = serializeSolarEdgeMetadata(
          metadataState.connections,
          activeConnection.id,
          activeConnection.baseUrl ?? metadataState.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: SOLAR_EDGE_PROVIDER,
          accessToken: activeConnection.apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          activeConnectionId: activeConnection.id,
        };
      }),
    removeConnection: protectedProcedure
      .input(
        z.object({
          connectionId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { deleteIntegration, getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        if (!integration) {
          throw new Error("SolarEdge is not connected.");
        }
        const metadataState = parseSolarEdgeMetadata(integration.metadata, toNonEmptyString(integration.accessToken));
        const nextConnections = metadataState.connections.filter((connection) => connection.id !== input.connectionId);

        if (nextConnections.length === 0) {
          if (integration.id) {
            await deleteIntegration(integration.id);
          }
          return {
            success: true,
            connected: false,
            activeConnectionId: null,
            totalConnections: 0,
          };
        }

        const nextActiveConnection =
          nextConnections.find((connection) => connection.id === metadataState.activeConnectionId) ?? nextConnections[0];
        const metadata = serializeSolarEdgeMetadata(
          nextConnections,
          nextActiveConnection.id,
          nextActiveConnection.baseUrl ?? metadataState.baseUrl
        );

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: SOLAR_EDGE_PROVIDER,
          accessToken: nextActiveConnection.apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          connected: true,
          activeConnectionId: nextActiveConnection.id,
          totalConnections: nextConnections.length,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listSites: protectedProcedure.query(async ({ ctx }) => {
      const context = await getSolarEdgeContext(ctx.user.id);
      const { listSites } = await import("./services/solarEdge");
      return listSites(context);
    }),
    getOverview: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        const { getSiteOverview } = await import("./services/solarEdge");
        return getSiteOverview(context, input.siteId.trim());
      }),
    getDetails: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        const { getSiteDetails } = await import("./services/solarEdge");
        return getSiteDetails(context, input.siteId.trim());
      }),
    getEnergy: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timeUnit: z.enum(["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        const { getSiteEnergy } = await import("./services/solarEdge");
        return getSiteEnergy(context, input.siteId.trim(), input.startDate, input.endDate, input.timeUnit);
      }),
    getProductionMeterReadings: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          timeUnit: z.enum(["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        const { getSiteEnergyDetails } = await import("./services/solarEdge");
        return getSiteEnergyDetails(
          context,
          input.siteId.trim(),
          input.startDate,
          input.endDate,
          input.timeUnit,
          "PRODUCTION"
        );
      }),
    getMeters: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        const { getSiteMeters } = await import("./services/solarEdge");
        return getSiteMeters(context, input.siteId.trim(), input.startDate, input.endDate);
      }),
    getProductionSnapshot: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getSolarEdgeContext(ctx.user.id);
        const { getSiteProductionSnapshot } = await import("./services/solarEdge");
        return getSiteProductionSnapshot(context, input.siteId.trim(), input.anchorDate);
      }),
    getProductionSnapshots: protectedProcedure
      .input(
        z.object({
          siteIds: z.array(z.string().min(1)).min(1).max(200),
          anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          connectionScope: z.enum(["active", "all"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const { getSiteProductionSnapshot } = await import("./services/solarEdge");

        const uniqueSiteIds = Array.from(
          new Set(input.siteIds.map((siteId) => siteId.trim()).filter((siteId) => siteId.length > 0))
        );

        const scope = input.connectionScope ?? "active";
        const integration = await getIntegrationByProvider(ctx.user.id, SOLAR_EDGE_PROVIDER);
        const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));

        const allConnections = metadata.connections;
        if (allConnections.length === 0) {
          throw new Error("SolarEdge is not connected. Save at least one API profile first.");
        }

        const activeConnection =
          allConnections.find((connection) => connection.id === metadata.activeConnectionId) ?? allConnections[0];
        const targetConnections = scope === "all" ? allConnections : [activeConnection];

        const rows = await mapWithConcurrency(uniqueSiteIds, 4, async (siteId) => {
          let selectedSnapshot: Awaited<ReturnType<typeof getSiteProductionSnapshot>> | null = null;
          let selectedConnection: (typeof targetConnections)[number] | null = null;
          let firstError: string | null = null;
          let fallbackSnapshot: Awaited<ReturnType<typeof getSiteProductionSnapshot>> | null = null;
          const profileStatuses: Array<{
            connectionId: string;
            connectionName: string;
            status: "Found" | "Not Found" | "Error";
          }> = [];
          let foundInConnections = 0;

          for (const connection of targetConnections) {
            const snapshot = await getSiteProductionSnapshot(
              {
                apiKey: connection.apiKey,
                baseUrl: connection.baseUrl ?? metadata.baseUrl,
              },
              siteId,
              input.anchorDate
            );

            if (!fallbackSnapshot) {
              fallbackSnapshot = snapshot;
            }

            profileStatuses.push({
              connectionId: connection.id,
              connectionName: connection.name,
              status: snapshot.status,
            });

            if (snapshot.status === "Found") {
              foundInConnections += 1;
              if (!selectedSnapshot) {
                selectedSnapshot = snapshot;
                selectedConnection = connection;
              }
              continue;
            }

            if (snapshot.status === "Error" && !firstError) {
              firstError = snapshot.error ?? "Unknown API error.";
            }
          }

          const anchorDate = selectedSnapshot?.anchorDate ?? fallbackSnapshot?.anchorDate ?? input.anchorDate ?? "";
          const monthlyStartDate =
            selectedSnapshot?.monthlyStartDate ?? fallbackSnapshot?.monthlyStartDate ?? input.anchorDate ?? "";
          const weeklyStartDate =
            selectedSnapshot?.weeklyStartDate ?? fallbackSnapshot?.weeklyStartDate ?? input.anchorDate ?? "";

          if (selectedSnapshot && selectedConnection) {
            return {
              ...selectedSnapshot,
              matchedConnectionId: selectedConnection.id,
              matchedConnectionName: selectedConnection.name,
              checkedConnections: targetConnections.length,
              foundInConnections,
              profileStatusSummary: profileStatuses
                .map((row) => `${row.connectionName}:${row.status}`)
                .join(" | "),
            };
          }

          const notFoundStatus: "Error" | "Not Found" = firstError ? "Error" : "Not Found";
          return {
            siteId,
            status: notFoundStatus,
            found: false,
            lifetimeKwh: null,
            hourlyProductionKwh: null,
            monthlyProductionKwh: null,
            weeklyProductionKwh: null,
            dailyProductionKwh: null,
            anchorDate,
            monthlyStartDate,
            weeklyStartDate,
            error: firstError,
            matchedConnectionId: null,
            matchedConnectionName: null,
            checkedConnections: targetConnections.length,
            foundInConnections,
            profileStatusSummary: profileStatuses
              .map((row) => `${row.connectionName}:${row.status}`)
              .join(" | "),
          };
        });

        return {
          total: rows.length,
          found: rows.filter((row) => row.status === "Found").length,
          notFound: rows.filter((row) => row.status === "Not Found").length,
          errored: rows.filter((row) => row.status === "Error").length,
          scope,
          checkedConnections: targetConnections.length,
          rows,
        };
      }),
  }),

  zendesk: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
      const metadata = parseZendeskMetadata(integration?.metadata);

      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.subdomain && metadata.email),
        subdomain: metadata.subdomain,
        email: metadata.email,
        trackedUsers: metadata.trackedUsers,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          subdomain: z.string().min(1),
          email: z.string().email(),
          apiToken: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const { normalizeZendeskSubdomainInput } = await import("./services/zendesk");
        const existingIntegration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
        const existingMetadata = parseZendeskMetadata(existingIntegration?.metadata);

        const normalizedSubdomain = normalizeZendeskSubdomainInput(input.subdomain);
        if (!normalizedSubdomain) {
          throw new Error("Zendesk subdomain is invalid.");
        }

        const metadata = serializeZendeskMetadata({
          subdomain: normalizedSubdomain,
          email: input.email.trim().toLowerCase(),
          trackedUsers: existingMetadata.trackedUsers,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ZENDESK_PROVIDER,
          accessToken: input.apiToken.trim(),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    saveTrackedUsers: protectedProcedure
      .input(
        z.object({
          users: z.array(z.string().min(1).max(200)).max(500),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
        if (!integration) {
          throw new Error("Zendesk is not connected.");
        }
        const metadata = parseZendeskMetadata(integration.metadata);
        if (!metadata.subdomain || !metadata.email) {
          throw new Error("Zendesk metadata is incomplete. Reconnect first.");
        }

        const nextMetadata = serializeZendeskMetadata({
          subdomain: metadata.subdomain,
          email: metadata.email,
          trackedUsers: input.users,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: ZENDESK_PROVIDER,
          accessToken: integration.accessToken,
          refreshToken: integration.refreshToken,
          expiresAt: integration.expiresAt,
          scope: integration.scope,
          metadata: nextMetadata,
        });

        return {
          success: true,
          trackedUsers: parseZendeskMetadata(nextMetadata).trackedUsers,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    getTicketMetrics: protectedProcedure
      .input(
        z
          .object({
            maxTickets: z.number().int().min(100).max(50000).optional(),
            periodStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            periodEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            trackedUsersOnly: z.boolean().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, ZENDESK_PROVIDER);
        const metadata = parseZendeskMetadata(integration?.metadata);
        const zendeskContext = await getZendeskContext(ctx.user.id);
        const { getZendeskTicketMetricsByAssignee } = await import("./services/zendesk");
        return getZendeskTicketMetricsByAssignee(zendeskContext, {
          maxTickets: input?.maxTickets ?? 10000,
          periodStartDate: input?.periodStartDate,
          periodEndDate: input?.periodEndDate,
          trackedUsers: input?.trackedUsersOnly ? metadata.trackedUsers : undefined,
        });
      }),
  }),

  teslaSolar: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_SOLAR_PROVIDER);
      const metadata = parseTeslaSolarMetadata(integration?.metadata);
      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken)),
        baseUrl: metadata.baseUrl,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          accessToken: z.string().min(1),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const metadata = JSON.stringify({
          baseUrl: toNonEmptyString(input.baseUrl),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: TESLA_SOLAR_PROVIDER,
          accessToken: input.accessToken.trim(),
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_SOLAR_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    listProducts: protectedProcedure.query(async ({ ctx }) => {
      const context = await getTeslaSolarContext(ctx.user.id);
      const { listTeslaProducts } = await import("./services/teslaSolar");
      return listTeslaProducts(context);
    }),
    listSites: protectedProcedure.query(async ({ ctx }) => {
      const context = await getTeslaSolarContext(ctx.user.id);
      const { listTeslaProducts } = await import("./services/teslaSolar");
      const result = await listTeslaProducts(context);
      return {
        sites: result.energySites,
      };
    }),
    getLiveStatus: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaSolarContext(ctx.user.id);
        const { getTeslaEnergySiteLiveStatus } = await import("./services/teslaSolar");
        return getTeslaEnergySiteLiveStatus(context, input.siteId.trim());
      }),
    getSiteInfo: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaSolarContext(ctx.user.id);
        const { getTeslaEnergySiteInfo } = await import("./services/teslaSolar");
        return getTeslaEnergySiteInfo(context, input.siteId.trim());
      }),
    getHistory: protectedProcedure
      .input(
        z.object({
          siteId: z.string().min(1),
          kind: z.string().optional(),
          period: z.string().optional(),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaSolarContext(ctx.user.id);
        const { getTeslaEnergySiteHistory } = await import("./services/teslaSolar");
        return getTeslaEnergySiteHistory(context, input.siteId.trim(), {
          kind: input.kind,
          period: input.period,
          startDate: input.startDate,
          endDate: input.endDate,
        });
      }),
  }),

  teslaPowerhub: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_POWERHUB_PROVIDER);
      const metadata = parseTeslaPowerhubMetadata(integration?.metadata);
      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.clientId),
        hasClientSecret: Boolean(toNonEmptyString(integration?.accessToken)),
        clientId: metadata.clientId,
        tokenUrl: metadata.tokenUrl,
        apiBaseUrl: metadata.apiBaseUrl,
        portalBaseUrl: metadata.portalBaseUrl,
      };
    }),
    getServerEgressIpv4: protectedProcedure
      .input(
        z
          .object({
            forceRefresh: z.boolean().optional(),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return fetchTeslaPowerhubServerEgressIpv4({
          forceRefresh: Boolean(input?.forceRefresh),
        });
      }),
    refreshServerEgressIpv4: protectedProcedure.mutation(async () => {
      return fetchTeslaPowerhubServerEgressIpv4({
        forceRefresh: true,
      });
    }),
    connect: protectedProcedure
      .input(
        z.object({
          clientId: z.string().optional(),
          clientSecret: z.string().optional(),
          tokenUrl: z.string().optional(),
          apiBaseUrl: z.string().optional(),
          portalBaseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const { normalizeTeslaPowerhubUrl } = await import("./services/teslaPowerhub");
        const existing = await getIntegrationByProvider(ctx.user.id, TESLA_POWERHUB_PROVIDER);
        const existingMetadata = parseTeslaPowerhubMetadata(existing?.metadata);

        const incomingClientId = toNonEmptyString(input.clientId);
        const resolvedClientId = incomingClientId ?? existingMetadata.clientId;
        const persistedSecret = toNonEmptyString(existing?.accessToken);
        const incomingSecret = toNonEmptyString(input.clientSecret);
        const resolvedSecret = incomingSecret ?? persistedSecret;

        if (!resolvedClientId) {
          throw new Error("Client ID is required for initial Tesla Powerhub connection.");
        }
        if (!resolvedSecret) {
          throw new Error("Client secret is required for initial Tesla Powerhub connection.");
        }

        const incomingTokenUrl = normalizeTeslaPowerhubUrl(input.tokenUrl);
        const incomingApiBaseUrl = normalizeTeslaPowerhubUrl(input.apiBaseUrl);
        const incomingPortalBaseUrl = normalizeTeslaPowerhubUrl(input.portalBaseUrl);

        const metadata = JSON.stringify({
          clientId: resolvedClientId,
          tokenUrl: incomingTokenUrl ?? existingMetadata.tokenUrl,
          apiBaseUrl: incomingApiBaseUrl ?? existingMetadata.apiBaseUrl,
          portalBaseUrl: incomingPortalBaseUrl ?? existingMetadata.portalBaseUrl,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: TESLA_POWERHUB_PROVIDER,
          accessToken: resolvedSecret,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, TESLA_POWERHUB_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    startGroupProductionMetricsJob: protectedProcedure
      .input(
        z.object({
          groupId: z.string().min(1),
          endpointUrl: z.string().optional(),
          signal: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaPowerhubContext(ctx.user.id);
        const { nanoid } = await import("nanoid");
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        pruneTeslaPowerhubProductionJobs(nowMs);

        const jobId = nanoid();
        const groupId = input.groupId.trim();
        const endpointUrl = input.endpointUrl;
        const signal = input.signal;

        teslaPowerhubProductionJobs.set(jobId, {
          id: jobId,
          userId: ctx.user.id,
          createdAt: nowIso,
          updatedAt: nowIso,
          startedAt: null,
          finishedAt: null,
          status: "queued",
          progress: {
            currentStep: 0,
            totalSteps: 7,
            percent: 0,
            message: "Queued",
            windowKey: null,
          },
          error: null,
          result: null,
        });

        void (async () => {
          const markJob = (updater: (job: TeslaPowerhubProductionJob) => TeslaPowerhubProductionJob) => {
            const existing = teslaPowerhubProductionJobs.get(jobId);
            if (!existing) return;
            teslaPowerhubProductionJobs.set(jobId, updater(existing));
          };

          markJob((job) => ({
            ...job,
            status: "running",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            progress: {
              ...job.progress,
              message: "Starting...",
            },
          }));

          try {
            const { getTeslaPowerhubGroupProductionMetrics } = await import("./services/teslaPowerhub");
            const result = await getTeslaPowerhubGroupProductionMetrics(
              {
                clientId: context.clientId,
                clientSecret: context.clientSecret,
                tokenUrl: context.tokenUrl,
                apiBaseUrl: context.apiBaseUrl,
                portalBaseUrl: context.portalBaseUrl,
              },
              {
                groupId,
                endpointUrl,
                signal,
                onProgress: (progress) => {
                  markJob((job) => {
                    const currentStep = Math.max(0, progress.currentStep);
                    const totalSteps = Math.max(1, progress.totalSteps);
                    return {
                      ...job,
                      updatedAt: new Date().toISOString(),
                      progress: {
                        currentStep,
                        totalSteps,
                        percent: normalizeProgressPercent(currentStep, totalSteps),
                        message: progress.message,
                        windowKey: progress.windowKey ?? null,
                      },
                    };
                  });
                },
              }
            );

            markJob((job) => ({
              ...job,
              status: "completed",
              updatedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              error: null,
              result,
              progress: {
                ...job.progress,
                currentStep: job.progress.totalSteps,
                percent: 100,
                message: "Completed",
                windowKey: null,
              },
            }));
          } catch (error) {
            markJob((job) => ({
              ...job,
              status: "failed",
              updatedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              error: error instanceof Error ? error.message : "Unknown job error.",
              result: null,
              progress: {
                ...job.progress,
                message: "Failed",
                windowKey: null,
              },
            }));
          }
        })();

        return {
          jobId,
          status: "queued" as const,
        };
      }),
    getGroupProductionMetricsJob: protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
        })
      )
      .query(async ({ ctx, input }) => {
        pruneTeslaPowerhubProductionJobs(Date.now());
        const job = teslaPowerhubProductionJobs.get(input.jobId.trim());
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("Tesla production job not found.");
        }
        return job;
      }),
    getGroupUsers: protectedProcedure
      .input(
        z.object({
          groupId: z.string().min(1),
          endpointUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaPowerhubContext(ctx.user.id);
        const groupId = input.groupId.trim();

        const { getTeslaPowerhubGroupUsers } = await import("./services/teslaPowerhub");
        return getTeslaPowerhubGroupUsers(
          {
            clientId: context.clientId,
            clientSecret: context.clientSecret,
            tokenUrl: context.tokenUrl,
            apiBaseUrl: context.apiBaseUrl,
            portalBaseUrl: context.portalBaseUrl,
          },
          {
            groupId,
            endpointUrl: input.endpointUrl,
          }
        );
      }),
    getGroupProductionMetrics: protectedProcedure
      .input(
        z.object({
          groupId: z.string().min(1),
          endpointUrl: z.string().optional(),
          signal: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getTeslaPowerhubContext(ctx.user.id);
        const groupId = input.groupId.trim();

        const { getTeslaPowerhubGroupProductionMetrics } = await import("./services/teslaPowerhub");
        return getTeslaPowerhubGroupProductionMetrics(
          {
            clientId: context.clientId,
            clientSecret: context.clientSecret,
            tokenUrl: context.tokenUrl,
            apiBaseUrl: context.apiBaseUrl,
            portalBaseUrl: context.portalBaseUrl,
          },
          {
            groupId,
            endpointUrl: input.endpointUrl,
            signal: input.signal,
          }
        );
      }),
  }),

  csgPortal: router({
    status: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
      const metadata = parseCsgPortalMetadata(integration?.metadata);
      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.email),
        email: metadata.email,
        baseUrl: metadata.baseUrl,
        hasPassword: Boolean(toNonEmptyString(integration?.accessToken)),
        lastTestedAt: metadata.lastTestedAt,
        lastTestStatus: metadata.lastTestStatus,
        lastTestMessage: metadata.lastTestMessage,
      };
    }),
    saveCredentials: protectedProcedure
      .input(
        z.object({
          email: z.string().email().optional(),
          password: z.string().min(1).optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const existingMetadata = parseCsgPortalMetadata(existing?.metadata);

        const resolvedEmail = toNonEmptyString(input.email)?.toLowerCase() ?? existingMetadata.email;
        const resolvedPassword =
          toNonEmptyString(input.password) ?? toNonEmptyString(existing?.accessToken);
        const resolvedBaseUrl = toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl;

        if (!resolvedEmail) {
          throw new Error("Portal email is required.");
        }
        if (!resolvedPassword) {
          throw new Error("Portal password is required.");
        }

        const metadata = serializeCsgPortalMetadata({
          email: resolvedEmail,
          baseUrl: resolvedBaseUrl,
          lastTestedAt: existingMetadata.lastTestedAt,
          lastTestStatus: existingMetadata.lastTestStatus,
          lastTestMessage: existingMetadata.lastTestMessage,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: CSG_PORTAL_PROVIDER,
          accessToken: resolvedPassword,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return { success: true };
      }),
    testConnection: protectedProcedure
      .input(
        z
          .object({
            email: z.string().email().optional(),
            password: z.string().min(1).optional(),
            baseUrl: z.string().optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const { testCsgPortalCredentials } = await import("./services/csgPortal");

        const existing = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const existingMetadata = parseCsgPortalMetadata(existing?.metadata);
        const resolvedEmail = toNonEmptyString(input?.email)?.toLowerCase() ?? existingMetadata.email;
        const resolvedPassword =
          toNonEmptyString(input?.password) ?? toNonEmptyString(existing?.accessToken);
        const resolvedBaseUrl = toNonEmptyString(input?.baseUrl) ?? existingMetadata.baseUrl;

        if (!resolvedEmail || !resolvedPassword) {
          throw new Error("Missing credentials. Save portal email/password first or provide both for testing.");
        }

        try {
          await testCsgPortalCredentials({
            email: resolvedEmail,
            password: resolvedPassword,
            baseUrl: resolvedBaseUrl ?? undefined,
          });

          const metadata = serializeCsgPortalMetadata({
            email: resolvedEmail,
            baseUrl: resolvedBaseUrl,
            lastTestedAt: new Date().toISOString(),
            lastTestStatus: "success",
            lastTestMessage: "Connection successful.",
          });

          await upsertIntegration({
            id: nanoid(),
            userId: ctx.user.id,
            provider: CSG_PORTAL_PROVIDER,
            accessToken: resolvedPassword,
            refreshToken: null,
            expiresAt: null,
            scope: null,
            metadata,
          });

          return {
            success: true,
            message: "Connected successfully.",
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown portal connection error.";
          if (existing && existingMetadata.email && existing.accessToken) {
            const metadata = serializeCsgPortalMetadata({
              email: existingMetadata.email,
              baseUrl: existingMetadata.baseUrl,
              lastTestedAt: new Date().toISOString(),
              lastTestStatus: "failure",
              lastTestMessage: message,
            });

            await upsertIntegration({
              id: nanoid(),
              userId: ctx.user.id,
              provider: CSG_PORTAL_PROVIDER,
              accessToken: existing.accessToken,
              refreshToken: null,
              expiresAt: null,
              scope: null,
              metadata,
            });
          }
          throw new Error(`Portal connection test failed: ${message}`);
        }
      }),
  }),

  abpSettlement: router({
    startContractScanJob: protectedProcedure
      .input(
        z.object({
          csgIds: z.array(z.string().min(1).max(64)).min(1).max(1000),
          email: z.string().email().optional(),
          password: z.string().min(1).optional(),
          baseUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const { nanoid } = await import("nanoid");

        const existing = await getIntegrationByProvider(ctx.user.id, CSG_PORTAL_PROVIDER);
        const existingMetadata = parseCsgPortalMetadata(existing?.metadata);
        const resolvedEmail = toNonEmptyString(input.email)?.toLowerCase() ?? existingMetadata.email;
        const resolvedPassword =
          toNonEmptyString(input.password) ?? toNonEmptyString(existing?.accessToken);
        const resolvedBaseUrl = toNonEmptyString(input.baseUrl) ?? existingMetadata.baseUrl;
        if (!resolvedEmail || !resolvedPassword) {
          throw new Error("Missing CSG portal credentials. Save portal email/password first.");
        }

        const uniqueIds = Array.from(new Set(input.csgIds.map((value) => value.trim()).filter(Boolean)));
        if (uniqueIds.length === 0) {
          throw new Error("At least one CSG ID is required.");
        }

        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        pruneAbpSettlementJobs(nowMs);

        const jobId = nanoid();
        const job: AbpSettlementContractScanJob = {
          id: jobId,
          userId: ctx.user.id,
          scanConfig: {
            csgIds: uniqueIds,
            portalEmail: resolvedEmail,
            portalBaseUrl: resolvedBaseUrl ?? null,
          },
          createdAt: nowIso,
          updatedAt: nowIso,
          startedAt: null,
          finishedAt: null,
          status: "queued",
          progress: {
            current: 0,
            total: uniqueIds.length,
            percent: 0,
            message: "Queued",
            currentCsgId: null,
          },
          error: null,
          result: {
            rows: [],
            successCount: 0,
            failureCount: 0,
          },
        };
        abpSettlementJobs.set(jobId, job);
        try {
          await saveAbpSettlementScanJobSnapshot(job);
        } catch {
          // Best effort: continue even if snapshot write fails.
        }
        void runAbpSettlementContractScanJob(jobId);

        return {
          jobId,
          status: "queued" as const,
          total: uniqueIds.length,
        };
      }),
    getJobStatus: protectedProcedure
      .input(
        z.object({
          jobId: z.string().min(1),
        })
      )
      .query(async ({ ctx, input }) => {
        pruneAbpSettlementJobs(Date.now());
        const normalizedJobId = input.jobId.trim();
        let job = abpSettlementJobs.get(normalizedJobId);
        if (!job) {
          const restored = await loadAbpSettlementScanJobSnapshot(ctx.user.id, normalizedJobId);
          if (restored) {
            abpSettlementJobs.set(normalizedJobId, restored);
            job = restored;
          }
        }
        if (!job || job.userId !== ctx.user.id) {
          throw new Error("ABP settlement contract scan job not found.");
        }

        if ((job.status === "queued" || job.status === "running") && !abpSettlementActiveScanRunners.has(job.id)) {
          void runAbpSettlementContractScanJob(job.id);
        }

        return job;
      }),
    cleanMailingData: protectedProcedure
      .input(
        z.object({
          rows: z
            .array(
              z.object({
                key: z.string().min(1).max(128),
                payeeName: z.string().optional(),
                mailingAddress1: z.string().optional(),
                mailingAddress2: z.string().optional(),
                cityStateZip: z.string().optional(),
                city: z.string().optional(),
                state: z.string().optional(),
                zip: z.string().optional(),
              })
            )
            .min(1)
            .max(150),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const { cleanAddressBatch } = await import("./services/addressCleaner");

        // ── 1. Deterministic cleaning pass ───────────────────────
        const sourceRows = input.rows.map((row) => {
          const sanitized = sanitizeMailingFields({
            payeeName: toNonEmptyString(row.payeeName),
            mailingAddress1: toNonEmptyString(row.mailingAddress1),
            mailingAddress2: toNonEmptyString(row.mailingAddress2),
            cityStateZip: toNonEmptyString(row.cityStateZip),
            city: toNonEmptyString(row.city),
            state: toNonEmptyString(row.state),
            zip: toNonEmptyString(row.zip),
          });
          return {
            key: row.key,
            payeeName: sanitized.payeeName,
            mailingAddress1: sanitized.mailingAddress1,
            mailingAddress2: sanitized.mailingAddress2,
            cityStateZip: toNonEmptyString(row.cityStateZip),
            city: sanitized.city,
            state: sanitized.state,
            zip: sanitized.zip,
          };
        });

        const { cleaned: deterministicResults, ambiguousRows } = cleanAddressBatch(sourceRows);

        // Build lookup of deterministic results by key
        const resultByKey = new Map(deterministicResults.map((r) => [r.key, r]));

        // ── 2. LLM pass for ambiguous rows only ──────────────────
        if (ambiguousRows.length > 0) {
          // Try Anthropic first, then OpenAI as fallback
          const anthropicIntegration = await getIntegrationByProvider(ctx.user.id, "anthropic");
          const openaiIntegration = await getIntegrationByProvider(ctx.user.id, "openai");

          const llmProvider = anthropicIntegration?.accessToken ? "anthropic" : openaiIntegration?.accessToken ? "openai" : null;
          const llmApiKey = llmProvider === "anthropic" ? anthropicIntegration!.accessToken! : llmProvider === "openai" ? openaiIntegration!.accessToken! : null;

          if (llmProvider && llmApiKey) {
            const ambiguousKeys = new Set(ambiguousRows.map((r) => r.key));
            console.log(`[AI Cleaning] ${deterministicResults.length - ambiguousRows.length} cleaned deterministically, ${ambiguousRows.length} sent to ${llmProvider} for review.`);

            try {
              const llmCleaned = await callLlmForAddressCleaning(
                llmProvider,
                llmApiKey,
                llmProvider === "anthropic"
                  ? (parseJsonMetadata(anthropicIntegration!.metadata).model as string || "claude-sonnet-4-20250514")
                  : resolveOpenAIModel(openaiIntegration!.metadata),
                ambiguousRows
              );

              // Merge LLM results into deterministic results
              for (const llmRow of llmCleaned) {
                if (ambiguousKeys.has(llmRow.key)) {
                  resultByKey.set(llmRow.key, {
                    ...llmRow,
                    cityStateZip: resultByKey.get(llmRow.key)?.cityStateZip ?? null,
                    ambiguous: false,
                    ambiguousReason: "",
                  });
                }
              }
            } catch (llmError) {
              console.error(`[AI Cleaning] LLM pass failed: ${llmError instanceof Error ? llmError.message : "Unknown error"}. Using deterministic results for ambiguous rows.`);
            }
          } else {
            console.warn(`[AI Cleaning] No AI provider connected. ${ambiguousRows.length} ambiguous rows cleaned deterministically only.`);
          }
        }

        // ── 3. Build response ────────────────────────────────────
        const sourceKeys = new Set(sourceRows.map((row) => row.key));
        const warnings: string[] = [];
        const finalRows = sourceRows.map((src) => {
          const result = resultByKey.get(src.key);
          if (!result) {
            // No cleaning result — return source as-is
            return {
              key: src.key,
              payeeName: src.payeeName,
              mailingAddress1: src.mailingAddress1,
              mailingAddress2: src.mailingAddress2,
              city: src.city,
              state: src.state,
              zip: src.zip,
            };
          }
          // Use cleaned values directly — null means intentionally cleared
          return {
            key: src.key,
            payeeName: result.payeeName,
            mailingAddress1: result.mailingAddress1,
            mailingAddress2: result.mailingAddress2,
            city: result.city,
            state: result.state,
            zip: result.zip,
          };
        });

        const ambiguousCount = ambiguousRows.length;
        if (ambiguousCount > 0) {
          warnings.push(`${ambiguousCount} record(s) had ambiguous data and were sent to AI for review.`);
        }

        return {
          rows: finalRows,
          warnings,
          stats: {
            sent: sourceRows.length,
            returnedByAi: ambiguousCount,
            missing: 0,
            keptOriginal: 0,
            fieldWarnings: deterministicResults.filter((r) => r.ambiguous).length,
          },
        };

      }),
    saveRun: protectedProcedure
      .input(
        z.object({
          runId: z.string().min(1).max(128).optional(),
          monthKey: z.string().regex(/^\d{4}-\d{2}$/),
          label: z.string().max(200).optional(),
          payload: z.string().min(1),
          rowCount: z.number().int().min(0).max(50000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const runId = toNonEmptyString(input.runId) ?? nanoid();
        const saved = await saveAbpSettlementRun({
          userId: ctx.user.id,
          runId,
          monthKey: input.monthKey,
          label: toNonEmptyString(input.label),
          payload: input.payload,
          rowCount: input.rowCount ?? null,
        });

        return {
          success: true,
          runId,
          summary: saved.summary,
          persistedToDatabase: saved.runWrite.persistedToDatabase || saved.indexWrite.persistedToDatabase,
          storageSynced: saved.runWrite.storageSynced && saved.indexWrite.storageSynced,
        };
      }),
    getRun: protectedProcedure
      .input(
        z.object({
          runId: z.string().min(1).max(128),
        })
      )
      .query(async ({ ctx, input }) => {
        const run = await getAbpSettlementRun(ctx.user.id, input.runId);
        if (!run) {
          throw new Error("ABP settlement run not found.");
        }
        return run;
      }),
    listRuns: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(250).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const runs = await getAbpSettlementRunsIndex(ctx.user.id);
        return runs.slice(0, input?.limit ?? 50);
      }),
  }),

  clockify: router({
    getStatus: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
      const metadata = parseClockifyMetadata(integration?.metadata);

      return {
        connected: Boolean(toNonEmptyString(integration?.accessToken) && metadata.workspaceId && metadata.userId),
        workspaceId: metadata.workspaceId,
        workspaceName: metadata.workspaceName,
        userId: metadata.userId,
        userName: metadata.userName,
        userEmail: metadata.userEmail,
      };
    }),
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().min(1),
          workspaceId: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const { getClockifyCurrentUser, listClockifyWorkspaces } = await import("./services/clockify");

        const existingIntegration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
        const existingMetadata = parseClockifyMetadata(existingIntegration?.metadata);

        const apiKey = input.apiKey.trim();
        const user = await getClockifyCurrentUser(apiKey);
        const workspaces = await listClockifyWorkspaces(apiKey);

        const requestedWorkspaceId = toNonEmptyString(input.workspaceId);
        let resolvedWorkspace =
          requestedWorkspaceId
            ? workspaces.find((workspace) => workspace.id === requestedWorkspaceId) ?? null
            : null;

        if (requestedWorkspaceId && !resolvedWorkspace) {
          throw new Error("The selected Clockify workspace ID was not found for this API key.");
        }

        if (!resolvedWorkspace) {
          const preferredWorkspaceId =
            existingMetadata.workspaceId ?? user.activeWorkspaceId ?? user.defaultWorkspaceId;
          resolvedWorkspace =
            (preferredWorkspaceId
              ? workspaces.find((workspace) => workspace.id === preferredWorkspaceId)
              : null) ?? workspaces[0] ?? null;
        }

        if (!resolvedWorkspace) {
          throw new Error("No Clockify workspace was found for this account.");
        }

        const metadata = JSON.stringify({
          workspaceId: resolvedWorkspace.id,
          workspaceName: resolvedWorkspace.name,
          userId: user.id,
          userName: user.name || null,
          userEmail: user.email,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: CLOCKIFY_PROVIDER,
          accessToken: apiKey,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });

        return {
          success: true,
          workspaceId: resolvedWorkspace.id,
          workspaceName: resolvedWorkspace.name,
          userName: user.name || null,
          userEmail: user.email,
        };
      }),
    disconnect: protectedProcedure.mutation(async ({ ctx }) => {
      const { deleteIntegration, getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, CLOCKIFY_PROVIDER);
      if (integration?.id) {
        await deleteIntegration(integration.id);
      }
      return { success: true };
    }),
    getCurrentEntry: protectedProcedure.query(async ({ ctx }) => {
      const context = await getClockifyContext(ctx.user.id);
      const { getClockifyInProgressTimeEntry } = await import("./services/clockify");
      return getClockifyInProgressTimeEntry(
        context.apiKey,
        context.workspaceId,
        context.clockifyUserId
      );
    }),
    getRecentEntries: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(100).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const context = await getClockifyContext(ctx.user.id);
        const { getClockifyRecentTimeEntries } = await import("./services/clockify");
        return getClockifyRecentTimeEntries(
          context.apiKey,
          context.workspaceId,
          context.clockifyUserId,
          input?.limit ?? 20
        );
      }),
    startTimer: protectedProcedure
      .input(
        z.object({
          description: z.string().min(1).max(300),
          projectId: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const context = await getClockifyContext(ctx.user.id);
        const { getClockifyInProgressTimeEntry, startClockifyTimeEntry } = await import(
          "./services/clockify"
        );

        const currentEntry = await getClockifyInProgressTimeEntry(
          context.apiKey,
          context.workspaceId,
          context.clockifyUserId
        );
        if (currentEntry?.isRunning) {
          throw new Error("A Clockify timer is already running. Stop it before starting a new one.");
        }

        return startClockifyTimeEntry(context.apiKey, context.workspaceId, {
          description: input.description,
          projectId: toNonEmptyString(input.projectId),
        });
      }),
    stopTimer: protectedProcedure.mutation(async ({ ctx }) => {
      const context = await getClockifyContext(ctx.user.id);
      const { stopClockifyInProgressTimeEntry } = await import("./services/clockify");
      const stoppedEntry = await stopClockifyInProgressTimeEntry(
        context.apiKey,
        context.workspaceId,
        context.clockifyUserId
      );
      return {
        success: true,
        stopped: Boolean(stoppedEntry),
        entry: stoppedEntry,
      };
    }),
  }),

  todoist: router({
    connect: protectedProcedure
      .input(z.object({ apiToken: z.string().min(1).max(512) }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await getIntegrationByProvider(ctx.user.id, "todoist");
        const metadata = existing?.metadata ?? JSON.stringify({ defaultFilter: "all" });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "todoist",
          accessToken: input.apiToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata,
        });
        return { success: true };
      }),
    getTasks: protectedProcedure
      .input(z.object({ filter: z.string().max(500).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { getTodoistTasks } = await import("./services/todoist");
        return getTodoistTasks(integration.accessToken, input?.filter);
      }),
    getProjects: protectedProcedure.query(async ({ ctx }) => {
      const { getIntegrationByProvider } = await import("./db");
      const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
      if (!integration?.accessToken) {
        throw new Error("Todoist not connected");
      }
      const { getTodoistProjects } = await import("./services/todoist");
      return getTodoistProjects(integration.accessToken);
    }),
    getCompletedCount: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { getTodoistCompletedTaskCount } = await import("./services/todoist");
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const count = await getTodoistCompletedTaskCount(
          integration.accessToken,
          dateKey,
          input?.timezoneOffsetMinutes
        );
        return { dateKey, count };
      }),
    getCompletedDebug: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            timezoneOffsetMinutes: z.number().int().min(-840).max(840).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { getTodoistCompletedTasks } = await import("./services/todoist");
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const tasks = await getTodoistCompletedTasks(
          integration.accessToken,
          dateKey,
          input?.timezoneOffsetMinutes
        );
        return {
          dateKey,
          timezoneOffsetMinutes: input?.timezoneOffsetMinutes ?? null,
          count: tasks.length,
          tasks: tasks.map((task) => ({
            taskId: task.taskId,
            content: task.content,
            completedAt: task.completedAt,
            dateKey: task.dateKey,
          })),
        };
      }),
    saveSettings: protectedProcedure
      .input(z.object({ defaultFilter: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }

        const { nanoid } = await import("nanoid");
        const existingMetadata = parseJsonMetadata(integration.metadata);
        const metadata = JSON.stringify({
          ...existingMetadata,
          defaultFilter: input.defaultFilter,
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "todoist",
          accessToken: integration.accessToken,
          refreshToken: integration.refreshToken,
          expiresAt: integration.expiresAt,
          scope: integration.scope,
          metadata,
        });

        return { success: true, defaultFilter: input.defaultFilter };
      }),
    createTask: protectedProcedure
      .input(z.object({ 
        content: z.string(),
        description: z.string().optional(),
        projectId: z.string().optional(),
        priority: z.number().min(1).max(4).optional(),
        dueString: z.string().optional(),
        dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { createTodoistTask } = await import("./services/todoist");
        return createTodoistTask(
          integration.accessToken,
          input.content,
          input.description,
          input.projectId,
          input.priority,
          input.dueString,
          input.dueDate
        );
      }),
    completeTask: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { completeTodoistTask } = await import("./services/todoist");
        await completeTodoistTask(integration.accessToken, input.taskId);
        return { success: true };
      }),
    createTaskFromEmail: protectedProcedure
      .input(z.object({
        subject: z.string(),
        emailLink: z.string(),
        body: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (!integration?.accessToken) {
          throw new Error("Todoist not connected");
        }
        const { createTodoistTask, getTodoistProjects } = await import("./services/todoist");
        
        // Find the Inbox project
        const projects = await getTodoistProjects(integration.accessToken);
        const inboxProject = projects.find(p => p.name.toLowerCase() === "inbox");
        
        const taskContent = `[${input.subject}](${input.emailLink})`;
        const taskDescription = input.body || '';
        
        return createTodoistTask(
          integration.accessToken,
          taskContent,
          taskDescription,
          inboxProject?.id,
          undefined
        );
      }),
  }),

  conversations: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const { getConversations } = await import("./db");
      return getConversations(ctx.user.id);
    }),
    listSummaries: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(300).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { getConversationSummaries } = await import("./db");
        return getConversationSummaries(ctx.user.id, input?.limit ?? 100);
      }),
    create: protectedProcedure
      .input(z.object({ title: z.string().min(1).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const { createConversation } = await import("./db");
        const id = await createConversation(ctx.user.id, input.title);
        return { id };
      }),
    getMessages: protectedProcedure
      .input(z.object({ conversationId: z.string().max(64) }))
      .query(async ({ input }) => {
        const { getConversationMessages } = await import("./db");
        return getConversationMessages(input.conversationId);
      }),
    delete: protectedProcedure
      .input(z.object({ conversationId: z.string().max(64) }))
      .mutation(async ({ ctx, input }) => {
        const { deleteConversation } = await import("./db");
        await deleteConversation(input.conversationId, ctx.user.id);
        return { success: true };
      }),
  }),

  openai: router({
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().max(512).optional(),
          model: z.string().max(64).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await getIntegrationByProvider(ctx.user.id, "openai");
        const incomingKey = input.apiKey?.trim();
        const accessToken = incomingKey || existing?.accessToken || null;

        if (!accessToken) {
          throw new Error("OpenAI API key is required");
        }

        const existingModel = resolveOpenAIModel(existing?.metadata);
        const requestedModel = input.model?.trim();
        const model = requestedModel && requestedModel.length > 0 ? requestedModel : existingModel;

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "openai",
          accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: JSON.stringify({ model }),
        });
        return { success: true, model };
      }),
    generateDailyOverview: protectedProcedure
      .input(
        z.object({
          date: z.string(),
          weather: z
            .object({
              summary: z.string(),
              location: z.string().optional(),
              temperatureF: z.number().optional(),
            })
            .optional(),
          todoistTasks: z
            .array(
              z.object({
                content: z.string(),
                due: z.string().optional(),
                priority: z.number().optional(),
              })
            )
            .max(20),
          calendarEvents: z
            .array(
              z.object({
                summary: z.string(),
                start: z.string().optional(),
                location: z.string().optional(),
              })
            )
            .max(20),
          prioritizedEmails: z
            .array(
              z.object({
                from: z.string().optional(),
                subject: z.string(),
                snippet: z.string().optional(),
                date: z.string().optional(),
                reason: z.string().optional(),
              })
            )
            .max(20),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "openai");
        if (!integration?.accessToken) {
          throw new Error("OpenAI not connected");
        }

        const weatherLine = input.weather
          ? `Weather: ${input.weather.summary}${input.weather.location ? ` in ${input.weather.location}` : ""}`
          : "Weather: unavailable";

        const taskLines =
          input.todoistTasks.length > 0
            ? input.todoistTasks
                .map((task) => {
                  const priority = task.priority ? `P${task.priority}` : "P4";
                  return `- [${priority}] ${task.content}${task.due ? ` (Due: ${task.due})` : ""}`;
                })
                .join("\n")
            : "- None";

        const eventLines =
          input.calendarEvents.length > 0
            ? input.calendarEvents
                .map(
                  (event) =>
                    `- ${event.summary}${event.start ? ` (${event.start})` : ""}${
                      event.location ? ` @ ${event.location}` : ""
                    }`
                )
                .join("\n")
            : "- None";

        const emailLines =
          input.prioritizedEmails.length > 0
            ? input.prioritizedEmails
                .map(
                  (email) =>
                    `- ${email.subject}${email.from ? ` from ${email.from}` : ""}${
                      email.reason ? ` | Reason: ${email.reason}` : ""
                    }${email.date ? ` | Date: ${email.date}` : ""}`
                )
                .join("\n")
            : "- None";

        const safeNumber = (value: unknown): number | null =>
          typeof value === "number" && Number.isFinite(value) ? value : null;

        let whoopLine = "WHOOP: unavailable";
        const whoopIntegration = await getIntegrationByProvider(ctx.user.id, "whoop");
        if (whoopIntegration?.accessToken) {
          try {
            const { getValidWhoopToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidWhoopToken(ctx.user.id);
            const { getWhoopSummary } = await import("./services/whoop");
            const whoop = await getWhoopSummary(accessToken);

            const recovery = safeNumber(whoop.recoveryScore);
            const sleepHours = safeNumber(whoop.sleepHours);
            const strain = safeNumber(whoop.dayStrain);
            const restingHr = safeNumber(whoop.restingHeartRate);
            const hrv = safeNumber(whoop.hrvRmssdMilli);
            const spo2 = safeNumber(whoop.spo2Percentage);

            whoopLine = [
              `WHOOP: recovery ${recovery !== null ? `${Math.round(recovery)}%` : "N/A"}`,
              `sleep ${sleepHours !== null ? `${sleepHours.toFixed(1)}h` : "N/A"}`,
              `strain ${strain !== null ? strain.toFixed(1) : "N/A"}`,
              `resting HR ${restingHr !== null ? `${Math.round(restingHr)} bpm` : "N/A"}`,
              `HRV ${hrv !== null ? `${Math.round(hrv)} ms` : "N/A"}`,
              `SpO2 ${spo2 !== null ? `${Math.round(spo2)}%` : "N/A"}`,
            ].join(", ");
          } catch (error) {
            console.error("Failed to fetch WHOOP summary for daily overview:", error);
          }
        }

        let samsungLine = "Samsung Health: unavailable";
        const samsungIntegration = await getIntegrationByProvider(ctx.user.id, "samsung-health");
        if (samsungIntegration?.metadata) {
          const metadata = parseJsonMetadata(samsungIntegration.metadata);
          const summary =
            metadata.summary && typeof metadata.summary === "object"
              ? (metadata.summary as Record<string, unknown>)
              : {};
          const manualScores =
            metadata.manualScores && typeof metadata.manualScores === "object"
              ? (metadata.manualScores as Record<string, unknown>)
              : {};

          const steps = safeNumber(summary.steps);
          const sleepMinutes = safeNumber(summary.sleepTotalMinutes);
          const spo2 = safeNumber(summary.spo2AvgPercent);
          const sleepScore = safeNumber(manualScores.sleepScore) ?? safeNumber(summary.sleepScore);
          const energyScore = safeNumber(manualScores.energyScore) ?? safeNumber(summary.energyScore);
          const receivedAt =
            typeof metadata.receivedAt === "string" && metadata.receivedAt.length > 0
              ? metadata.receivedAt
              : null;

          samsungLine = [
            `Samsung Health: steps ${steps !== null ? Math.round(steps).toLocaleString() : "N/A"}`,
            `sleep ${sleepMinutes !== null ? `${(sleepMinutes / 60).toFixed(1)}h` : "N/A"}`,
            `SpO2 ${spo2 !== null ? `${spo2.toFixed(1)}%` : "N/A"}`,
            `sleep score ${sleepScore !== null ? sleepScore : "N/A"}`,
            `energy score ${energyScore !== null ? energyScore : "N/A"}`,
            `last sync ${receivedAt ?? "N/A"}`,
          ].join(", ");
        }

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${integration.accessToken}`,
          },
          body: JSON.stringify({
            model: resolveOpenAIModel(integration.metadata),
            messages: [
              {
                role: "system",
                content:
                  "You generate concise daily productivity overviews in clean GitHub-flavored markdown. Use exactly these headings: '## Summary', '## Must Do Today', '## Priority Emails', '## Risks & Follow-ups'. Under each heading, use 2-5 bullet points with '- '. Keep to about 120-180 words. Do not output any extra headings or prose outside these sections. Explicitly factor in health and recovery context (WHOOP and Samsung Health) when setting workload intensity and sequencing. If health data is available, mention at least one concrete WHOOP or Samsung metric in the output.",
              },
              {
                role: "user",
                content: `Date: ${input.date}\n${weatherLine}\n\nTodoist items due today:\n${taskLines}\n\nToday's calendar events:\n${eventLines}\n\nPriority emails (date/language based):\n${emailLines}\n\nHealth and recovery context:\n- ${whoopLine}\n- ${samsungLine}\n\nGenerate the daily overview now using the exact heading and bullet format.`,
              },
            ],
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({}));
          throw new Error(error?.error?.message || "Failed to generate daily overview");
        }

        const data = await response.json();
        const overview = data?.choices?.[0]?.message?.content;
        if (!overview || typeof overview !== "string") {
          throw new Error("Invalid overview response from OpenAI");
        }

        return { overview };
      }),
    generatePipelineReport: protectedProcedure
      .input(
        z.object({
          generatedAt: z.string(),
          rows3Year: z.array(
            z.object({
              month: z.string(),
              part1Count: z.number(), part2Count: z.number(),
              part1KwAc: z.number(), part2KwAc: z.number(),
              interconnectedCount: z.number(), interconnectedKwAc: z.number(),
              prevPart1Count: z.number(), prevPart2Count: z.number(),
              prevPart1KwAc: z.number(), prevPart2KwAc: z.number(),
              prevInterconnectedCount: z.number(), prevInterconnectedKwAc: z.number(),
            })
          ),
          rows12Month: z.array(
            z.object({
              month: z.string(),
              part1Count: z.number(), part2Count: z.number(),
              part1KwAc: z.number(), part2KwAc: z.number(),
              interconnectedCount: z.number(), interconnectedKwAc: z.number(),
              prevPart1Count: z.number(), prevPart2Count: z.number(),
              prevPart1KwAc: z.number(), prevPart2KwAc: z.number(),
              prevInterconnectedCount: z.number(), prevInterconnectedKwAc: z.number(),
            })
          ),
          summaryTotals: z.object({
            threeYear: z.object({
              totalPart1: z.number(), totalPart2: z.number(),
              totalPart1KwAc: z.number(), totalPart2KwAc: z.number(),
              totalInterconnected: z.number(), totalInterconnectedKwAc: z.number(),
            }),
            twelveMonth: z.object({
              totalPart1: z.number(), totalPart2: z.number(),
              totalPart1KwAc: z.number(), totalPart2KwAc: z.number(),
              totalInterconnected: z.number(), totalInterconnectedKwAc: z.number(),
            }),
          }),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "openai");
        if (!integration?.accessToken) {
          throw new Error("OpenAI not connected. Please add your API key in Settings.");
        }

        const formatRows = (rows: typeof input.rows3Year) =>
          rows
            .map(
              (r) =>
                `${r.month}: P1=${r.part1Count} (${r.part1KwAc.toFixed(1)} kW), P2=${r.part2Count} (${r.part2KwAc.toFixed(1)} kW), IC=${r.interconnectedCount} (${r.interconnectedKwAc.toFixed(1)} kW) | PY: P1=${r.prevPart1Count}, P2=${r.prevPart2Count}, IC=${r.prevInterconnectedCount}`
            )
            .join("\n");

        const systemMessage = {
          role: "system" as const,
          content: `You are a solar energy portfolio analyst generating a professional report on application pipeline trends. Write in clear, professional prose with markdown formatting. Use these exact sections:

## Executive Summary
A 3-4 sentence high-level summary of the pipeline health.

## Application Volume Trends
Analysis of Part I submissions and Part II verifications -- monthly patterns, seasonality, acceleration or deceleration. Use concise prose, not raw data dumps.

## Capacity Trends (kW AC)
Analysis of capacity flowing through the pipeline -- average system sizes, capacity growth, and how kW AC trends differ from count trends.

## Interconnection Analysis
Trends in systems going online -- throughput rates, bottlenecks, and how interconnection volume compares to application volume.

## Year-over-Year Comparison
Summarize YoY changes in 2-3 concise sentences covering the most significant shifts. Focus on the overall trend direction and magnitude rather than listing every month individually. State the trailing-12-month totals vs. prior-year totals for Part I, Part II, and Interconnected with percentage change. Do NOT list individual monthly comparisons.

## Key Risks & Opportunities
2-4 bullet points identifying risks (declining volumes, growing backlogs) and opportunities (capacity growth, improving conversion rates).

FORMATTING RULES:
- Write in concise professional prose. Avoid cramming multiple statistics into a single sentence.
- When citing numbers, round kW values to the nearest whole number or one decimal (e.g. 47.6 MW, not 47600.1 kW).
- Use "MW" for values above 1,000 kW (divide by 1,000).
- Do NOT use asterisks for emphasis within numbers or percentages. Use plain text.
- Keep the total analysis to 400-600 words.`,
        };

        const t3 = input.summaryTotals.threeYear;
        const t12 = input.summaryTotals.twelveMonth;
        const userMessage = {
          role: "user" as const,
          content: `Report generated: ${input.generatedAt}

3-YEAR PIPELINE DATA (monthly):
${formatRows(input.rows3Year)}

3-Year Totals: Part I: ${t3.totalPart1} apps (${t3.totalPart1KwAc.toFixed(1)} kW), Part II: ${t3.totalPart2} apps (${t3.totalPart2KwAc.toFixed(1)} kW), Interconnected: ${t3.totalInterconnected} (${t3.totalInterconnectedKwAc.toFixed(1)} kW)

12-MONTH PIPELINE DATA (monthly):
${formatRows(input.rows12Month)}

12-Month Totals: Part I: ${t12.totalPart1} apps (${t12.totalPart1KwAc.toFixed(1)} kW), Part II: ${t12.totalPart2} apps (${t12.totalPart2KwAc.toFixed(1)} kW), Interconnected: ${t12.totalInterconnected} (${t12.totalInterconnectedKwAc.toFixed(1)} kW)

Generate the pipeline analysis report now.`,
        };

        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${integration.accessToken}`,
          },
          body: JSON.stringify({
            model: resolveOpenAIModel(integration.metadata),
            messages: [systemMessage, userMessage],
          }),
        });

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          console.error("OpenAI pipeline report error:", response.status, errorBody);
          let errorMessage = "Failed to generate pipeline report";
          try {
            const parsed = JSON.parse(errorBody);
            errorMessage = parsed?.error?.message || errorMessage;
          } catch {}
          throw new Error(`OpenAI API error (${response.status}): ${errorMessage}`);
        }

        const data = await response.json();
        const analysis = (data as any)?.choices?.[0]?.message?.content;
        if (!analysis || typeof analysis !== "string") {
          throw new Error("Invalid response from OpenAI");
        }

        return { analysis };
      }),
    chat: protectedProcedure
      .input(z.object({ conversationId: z.string().max(64), message: z.string().min(1).max(32000) }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, getConversationMessages, addMessage } = await import("./db");
        const integration = await getIntegrationByProvider(ctx.user.id, "openai");
        if (!integration?.accessToken) {
          throw new Error("OpenAI not connected");
        }
        
        // Fetch productivity data if available
        let contextParts: string[] = [];
        
        // Todoist context
        const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
        if (todoistIntegration?.accessToken) {
          try {
            const { getTodoistTasks, getTodoistProjects } = await import("./services/todoist");
            const [tasks, projects] = await Promise.all([
              getTodoistTasks(todoistIntegration.accessToken),
              getTodoistProjects(todoistIntegration.accessToken)
            ]);
            
            const projectMap = new Map(projects.map(p => [p.id, p.name]));
            const taskList = tasks.slice(0, 50).map(t => {
              const projectName = projectMap.get(t.projectId) || "Inbox";
              const priority = ["P4", "P3", "P2", "P1"][t.priority - 1] || "P4";
              return `- [${priority}] ${t.content}${t.description ? ` (${t.description})` : ""} [${projectName}]${t.due ? ` Due: ${t.due.string}` : ""}`;
            }).join("\n");
            
            contextParts.push(`TODOIST TASKS (${tasks.length} total):\n${taskList}`);
          } catch (error) {
            console.error("Failed to fetch Todoist data:", error);
          }
        }
        
        // Google Calendar context
        const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
        if (googleIntegration?.accessToken) {
          try {
            const { getGoogleCalendarEvents } = await import("./services/google");
            const events = await getGoogleCalendarEvents(googleIntegration.accessToken);
            
            const eventList = events.slice(0, 20).map(e => {
              const start = e.start.dateTime || e.start.date || "";
              const end = e.end.dateTime || e.end.date || "";
              return `- ${e.summary || "Untitled"} (${start} to ${end})${e.location ? ` @ ${e.location}` : ""}`;
            }).join("\n");
            
            contextParts.push(`GOOGLE CALENDAR (${events.length} upcoming events):\n${eventList}`);
          } catch (error) {
            console.error("Failed to fetch Google Calendar data:", error);
          }
        }
        
        // Gmail context
        if (googleIntegration?.accessToken) {
          try {
            const { getGmailMessages } = await import("./services/google");
            const messages = await getGmailMessages(googleIntegration.accessToken, 10);
            
            const emailList = messages.map(m => {
              const from = m.payload.headers.find((h: any) => h.name === "From")?.value || "Unknown";
              const subject = m.payload.headers.find((h: any) => h.name === "Subject")?.value || "(no subject)";
              const date = m.payload.headers.find((h: any) => h.name === "Date")?.value || "";
              return `- From: ${from}\n  Subject: ${subject}\n  Date: ${date}\n  Preview: ${m.snippet}`;
            }).join("\n\n");
            
            contextParts.push(`GMAIL (${messages.length} recent emails):\n${emailList}`);
          } catch (error) {
            console.error("Failed to fetch Gmail data:", error);
          }
        }
        
        const productivityContext = contextParts.length > 0 
          ? `\n\nYou have access to the user's productivity data:\n\n${contextParts.join("\n\n")}\n\nYou can analyze, summarize, or provide insights about their tasks, schedule, and emails when relevant to their question.`
          : "";
        
        // Save user message
        const { nanoid } = await import("nanoid");
        await addMessage({ id: nanoid(), conversationId: input.conversationId, role: "user", content: input.message });
        
        // Get conversation history
        const history = await getConversationMessages(input.conversationId);
        const conversationMessages = history.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content
        }));
        
        const systemMessage = {
          role: "system" as const,
          content: `You are a helpful productivity assistant. You help users manage their tasks, schedule, and productivity.${productivityContext}`
        };
        
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${integration.accessToken}`,
          },
          body: JSON.stringify({
            model: resolveOpenAIModel(integration.metadata),
            messages: [
              systemMessage,
              ...conversationMessages
            ],
          }),
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error?.message || "OpenAI API error");
        }
        
        const data = await response.json();
        if (!data.choices || !data.choices[0] || !data.choices[0].message) {
          throw new Error("Invalid response from OpenAI");
        }
        
        const reply = data.choices[0].message.content;
        
        // Save assistant message
        await addMessage({ id: nanoid(), conversationId: input.conversationId, role: "assistant", content: reply });
        
        return { reply };
      }),
  }),

  google: router({
    getCalendarEvents: protectedProcedure
      .input(
        z
          .object({
            startIso: z.string().datetime().optional(),
            endIso: z.string().datetime().optional(),
            daysAhead: z.number().int().min(1).max(365).optional(),
            maxResults: z.number().int().min(1).max(250).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        try {
          const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const { getGoogleCalendarEvents } = await import("./services/google");
          const events = await getGoogleCalendarEvents(accessToken, {
            startIso: input?.startIso,
            endIso: input?.endIso,
            daysAhead: input?.daysAhead,
            maxResults: input?.maxResults,
          });
          console.log(`[Google Calendar] Fetched ${events.length} events`);
          return events;
        } catch (error) {
          console.error("[Google Calendar] Error fetching events:", error);
          throw error;
        }
      }),
    getGmailMessages: protectedProcedure
      .input(z.object({ maxResults: z.number().int().min(1).max(800).optional() }).optional())
      .query(async ({ ctx, input }) => {
      const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
      const accessToken = await getValidGoogleToken(ctx.user.id);
      const { getGmailMessages } = await import("./services/google");
      return getGmailMessages(accessToken, input?.maxResults ?? 50);
    }),
    getGmailWaitingOn: protectedProcedure
      .input(z.object({ maxResults: z.number().int().min(1).max(100).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { getGmailWaitingOn } = await import("./services/google");
        return getGmailWaitingOn(accessToken, input?.maxResults ?? 25);
      }),
    markGmailAsRead: protectedProcedure
      .input(z.object({ messageId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { markGmailMessageAsRead } = await import("./services/google");
        await markGmailMessageAsRead(accessToken, input.messageId);
        return { success: true };
      }),
    getDriveFiles: protectedProcedure.query(async ({ ctx }) => {
      try {
        const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
        const accessToken = await getValidGoogleToken(ctx.user.id);
        const { getGoogleDriveFiles } = await import("./services/google");
        const files = await getGoogleDriveFiles(accessToken);
        console.log(`[Google Drive] Fetched ${files.length} files`);
        return files;
      } catch (error) {
        console.error("[Google Drive] Error fetching files:", error);
        throw error;
      }
    }),
    createSpreadsheet: protectedProcedure
      .input(z.object({ title: z.string() }))
      .mutation(async ({ ctx, input }) => {
        try {
          const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const { createGoogleSpreadsheet } = await import("./services/google");
          const result = await createGoogleSpreadsheet(accessToken, input.title);
          console.log(`[Google Sheets] Created spreadsheet: ${input.title}`);
          return result;
        } catch (error) {
          console.error("[Google Sheets] Error creating spreadsheet:", error);
          throw error;
        }
      }),
    searchDrive: protectedProcedure
      .input(z.object({ query: z.string() }))
      .query(async ({ ctx, input }) => {
        try {
          const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
          const accessToken = await getValidGoogleToken(ctx.user.id);
          const { searchGoogleDrive } = await import("./services/google");
          const files = await searchGoogleDrive(accessToken, input.query);
          console.log(`[Google Drive Search] Found ${files.length} files for query: ${input.query}`);
          return files;
        } catch (error) {
          console.error("[Google Drive Search] Error searching Drive:", error);
          throw error;
        }
      }),
  }),

  whoop: router({
    getSummary: protectedProcedure.query(async ({ ctx }) => {
      const { getValidWhoopToken } = await import("./helpers/tokenRefresh");
      const accessToken = await getValidWhoopToken(ctx.user.id);
      const { getWhoopSummary } = await import("./services/whoop");
      return getWhoopSummary(accessToken);
    }),
  }),

  samsungHealth: router({
    getConfig: protectedProcedure.query(async () => {
      const syncKey = process.env.SAMSUNG_HEALTH_SYNC_KEY?.trim() || "";
      const userIdRaw = process.env.SAMSUNG_HEALTH_USER_ID?.trim() || "1";
      const userId = Number.parseInt(userIdRaw, 10);
      return {
        syncKey,
        hasSyncKey: syncKey.length > 0,
        userId: Number.isFinite(userId) && userId > 0 ? userId : 1,
      };
    }),
    saveManualScores: protectedProcedure
      .input(
        z.object({
          sleepScore: z.number().min(0).max(100).nullable(),
          energyScore: z.number().min(0).max(100).nullable(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");

        const existing = await getIntegrationByProvider(ctx.user.id, "samsung-health");
        const existingMetadata = parseJsonMetadata(existing?.metadata);
        const existingSummary =
          existingMetadata.summary && typeof existingMetadata.summary === "object"
            ? (existingMetadata.summary as Record<string, unknown>)
            : {};
        const existingManual =
          existingMetadata.manualScores && typeof existingMetadata.manualScores === "object"
            ? (existingMetadata.manualScores as Record<string, unknown>)
            : {};

        const sleepScore = input.sleepScore;
        const energyScore = input.energyScore;

        const nextMetadata = JSON.stringify({
          ...existingMetadata,
          summary: {
            ...existingSummary,
            sleepScore: toNullableScore(sleepScore),
            energyScore: toNullableScore(energyScore),
          },
          manualScores: {
            sleepScore: toNullableScore(sleepScore),
            energyScore: toNullableScore(energyScore),
          },
          manualScoresUpdatedAt: new Date().toISOString(),
        });

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "samsung-health",
          accessToken: existing?.accessToken ?? null,
          refreshToken: existing?.refreshToken ?? null,
          expiresAt: existing?.expiresAt ?? null,
          scope: existing?.scope ?? null,
          metadata: nextMetadata,
        });

        return {
          success: true,
          manualScores: {
            sleepScore: toNullableScore(sleepScore),
            energyScore: toNullableScore(energyScore),
          },
        };
      }),
  }),

  metrics: router({
    getHistory: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(120).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { getDailyMetricsHistory } = await import("./db");
        return getDailyMetricsHistory(ctx.user.id, input?.limit ?? 30);
      }),
    getTrendSeries: protectedProcedure
      .input(
        z
          .object({
            days: z.number().int().min(7).max(365).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const days = input?.days ?? 30;
        const { getDailyMetricsHistory } = await import("./db");
        const rows = await getDailyMetricsHistory(ctx.user.id, days);
        const ordered = [...rows].sort((a, b) => a.dateKey.localeCompare(b.dateKey));

        const makeSeries = (getter: (row: (typeof ordered)[number]) => number | null) =>
          ordered.map((row) => ({
            dateKey: row.dateKey,
            value: getter(row),
          }));

        const recoverySeries = makeSeries((row) => toFiniteNumber(row.whoopRecoveryScore));
        const sleepSeries = makeSeries(
          (row) => toFiniteNumber(row.whoopSleepHours) ?? toFiniteNumber(row.samsungSleepHours)
        );
        const strainSeries = makeSeries((row) => toFiniteNumber(row.whoopDayStrain));
        const hrvSeries = makeSeries((row) => toFiniteNumber(row.whoopHrvMs));
        const stepsSeries = makeSeries((row) =>
          row.samsungSteps !== null && row.samsungSteps !== undefined ? Number(row.samsungSteps) : null
        );
        const completedTaskSeries = makeSeries((row) =>
          row.todoistCompletedCount !== null && row.todoistCompletedCount !== undefined
            ? Number(row.todoistCompletedCount)
            : null
        );

        const recoveryVsSleep = computePearsonCorrelation(
          ordered.map((row) => ({
            x: toFiniteNumber(row.whoopSleepHours) ?? toFiniteNumber(row.samsungSleepHours),
            y: toFiniteNumber(row.whoopRecoveryScore),
          }))
        );
        const recoveryVsTasks = computePearsonCorrelation(
          ordered.map((row) => ({
            x:
              row.todoistCompletedCount !== null && row.todoistCompletedCount !== undefined
                ? Number(row.todoistCompletedCount)
                : null,
            y: toFiniteNumber(row.whoopRecoveryScore),
          }))
        );

        return {
          days,
          dateRange: {
            startDateKey: ordered[0]?.dateKey ?? null,
            endDateKey: ordered[ordered.length - 1]?.dateKey ?? null,
          },
          pointCount: ordered.length,
          series: {
            recovery: recoverySeries,
            sleepHours: sleepSeries,
            strain: strainSeries,
            hrvMs: hrvSeries,
            steps: stepsSeries,
            tasksCompleted: completedTaskSeries,
          },
          correlations: {
            recoveryVsSleep,
            recoveryVsTasksCompleted: recoveryVsTasks,
          },
        };
      }),
    captureToday: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .optional()
      )
      .mutation(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const { captureDailySnapshotForUser } = await import("./services/dailySnapshot");
        await captureDailySnapshotForUser(ctx.user.id, dateKey);

        return { success: true, dateKey };
      }),
  }),

  search: router({
    global: protectedProcedure
      .input(
        z.object({
          query: z.string().min(1).max(200),
          limit: z.number().int().min(1).max(100).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const query = normalizeSearchQuery(input.query);
        const limit = input.limit ?? 30;

        const {
          listNotes,
          getConversationSummaries,
          getIntegrationByProvider,
        } = await import("./db");

        const noteRowsPromise = listNotes(ctx.user.id, 300);
        const conversationRowsPromise = getConversationSummaries(ctx.user.id, 200);
        const todoistIntegrationPromise = getIntegrationByProvider(ctx.user.id, "todoist");
        const googleIntegrationPromise = getIntegrationByProvider(ctx.user.id, "google");

        const [noteRows, conversationRows, todoistIntegration, googleIntegration] = await Promise.all([
          noteRowsPromise,
          conversationRowsPromise,
          todoistIntegrationPromise,
          googleIntegrationPromise,
        ]);

        let todoistTasks: any[] = [];
        if (todoistIntegration?.accessToken) {
          try {
            const { getTodoistTasks } = await import("./services/todoist");
            todoistTasks = await getTodoistTasks(todoistIntegration.accessToken);
          } catch (error) {
            console.warn("[Search] Failed to load Todoist tasks:", error);
          }
        }

        let calendarEvents: any[] = [];
        let driveFiles: any[] = [];
        if (googleIntegration) {
          try {
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            const { getGoogleCalendarEvents, searchGoogleDrive } = await import("./services/google");
            const [events, files] = await Promise.all([
              getGoogleCalendarEvents(accessToken, { daysAhead: 120, maxResults: 250 }),
              searchGoogleDrive(accessToken, input.query),
            ]);
            calendarEvents = events;
            driveFiles = files;
          } catch (error) {
            console.warn("[Search] Failed to load Google search sources:", error);
          }
        }

        type SearchItem = {
          id: string;
          type: "task" | "note" | "calendar_event" | "conversation" | "drive_file";
          title: string;
          subtitle: string | null;
          url: string | null;
          timestamp: string | null;
          score: number;
        };

        const results: SearchItem[] = [];

        noteRows.forEach((note) => {
          const haystack = `${note.title} ${note.content} ${note.notebook}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: note.id,
            type: "note",
            title: note.title,
            subtitle: truncateText(note.content ?? "", 160),
            url: null,
            timestamp: safeIso(note.updatedAt ?? note.createdAt),
            score: score + 8,
          });
        });

        conversationRows.forEach((conversation) => {
          const title = String(conversation.title ?? "Conversation");
          const preview = String(conversation.lastMessagePreview ?? "");
          const haystack = `${title} ${preview}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: conversation.id,
            type: "conversation",
            title,
            subtitle: truncateText(preview, 160),
            url: null,
            timestamp: safeIso(conversation.lastMessageAt ?? conversation.updatedAt ?? conversation.createdAt),
            score: score + 5,
          });
        });

        todoistTasks.forEach((task) => {
          const content = String(task?.content ?? "");
          const description = String(task?.description ?? "");
          const haystack = `${content} ${description}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: String(task?.id ?? ""),
            type: "task",
            title: content || "(Untitled task)",
            subtitle: description ? truncateText(description, 160) : null,
            url: null,
            timestamp: safeIso(task?.createdAt ?? task?.addedAt ?? task?.due?.date),
            score: score + 10,
          });
        });

        calendarEvents.forEach((event) => {
          const title = String(event?.summary ?? "");
          const location = String(event?.location ?? "");
          const description = String(event?.description ?? "");
          const haystack = `${title} ${location} ${description}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: String(event?.id ?? ""),
            type: "calendar_event",
            title: title || "(Untitled event)",
            subtitle: truncateText([location, description].filter(Boolean).join(" | "), 160) || null,
            url: toNonEmptyString(event?.htmlLink),
            timestamp: safeIso(event?.start?.dateTime ?? event?.start?.date),
            score: score + 7,
          });
        });

        driveFiles.forEach((file) => {
          const name = String(file?.name ?? "");
          const mimeType = String(file?.mimeType ?? "");
          const haystack = `${name} ${mimeType}`;
          const score = scoreMatch(haystack, query);
          if (score <= 0) return;
          results.push({
            id: String(file?.id ?? ""),
            type: "drive_file",
            title: name || "(Untitled file)",
            subtitle: mimeType || null,
            url: toNonEmptyString(file?.webViewLink),
            timestamp: safeIso(file?.modifiedTime),
            score: score + 4,
          });
        });

        results.sort((a, b) => {
          if (a.score !== b.score) return b.score - a.score;
          const aTs = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const bTs = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return bTs - aTs;
        });

        return {
          query: input.query,
          totalMatched: results.length,
          items: results.slice(0, limit),
        };
      }),
  }),

  supplements: router({
    listDefinitions: protectedProcedure.query(async ({ ctx }) => {
      const { listSupplementDefinitions } = await import("./db");
      return listSupplementDefinitions(ctx.user.id);
    }),
    createDefinition: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          brand: z.string().max(128).optional(),
          dose: z.string().min(1).max(64),
          doseUnit: z
            .enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"])
            .optional(),
          dosePerUnit: z.string().max(64).optional(),
          productUrl: z.string().max(2048).optional(),
          pricePerBottle: z.number().nonnegative().optional(),
          quantityPerBottle: z.number().nonnegative().optional(),
          timing: z.enum(["am", "pm"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { listSupplementDefinitions, createSupplementDefinition } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await listSupplementDefinitions(ctx.user.id);
        const nextSortOrder =
          existing.length > 0
            ? Math.max(...existing.map((definition) => definition.sortOrder ?? 0)) + 1
            : 0;

        await createSupplementDefinition({
          id: nanoid(),
          userId: ctx.user.id,
          name: input.name.trim(),
          brand: input.brand?.trim() || null,
          dose: input.dose.trim(),
          doseUnit: input.doseUnit ?? "capsule",
          dosePerUnit: input.dosePerUnit?.trim() || null,
          productUrl: input.productUrl?.trim() || null,
          pricePerBottle: input.pricePerBottle ?? null,
          quantityPerBottle: input.quantityPerBottle ?? null,
          timing: input.timing ?? "am",
          isLocked: false,
          isActive: true,
          sortOrder: nextSortOrder,
        });

        return { success: true };
      }),
    updateDefinition: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          name: z.string().min(1).max(128),
          brand: z.string().max(128).nullable().optional(),
          dose: z.string().min(1).max(64),
          doseUnit: z.enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"]),
          dosePerUnit: z.string().max(64).nullable().optional(),
          productUrl: z.string().max(2048).nullable().optional(),
          pricePerBottle: z.number().nonnegative().nullable().optional(),
          quantityPerBottle: z.number().nonnegative().nullable().optional(),
          timing: z.enum(["am", "pm"]),
          isLocked: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { updateSupplementDefinition } = await import("./db");

        await updateSupplementDefinition(ctx.user.id, input.definitionId, {
          name: input.name.trim(),
          brand: input.brand?.trim() || null,
          dose: input.dose.trim(),
          doseUnit: input.doseUnit,
          dosePerUnit: input.dosePerUnit?.trim() || null,
          productUrl: input.productUrl?.trim() || null,
          pricePerBottle: input.pricePerBottle ?? null,
          quantityPerBottle: input.quantityPerBottle ?? null,
          timing: input.timing,
          isLocked: input.isLocked,
        });

        return { success: true };
      }),
    setDefinitionLock: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
          isLocked: z.boolean(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { setSupplementDefinitionLock } = await import("./db");
        await setSupplementDefinitionLock(ctx.user.id, input.definitionId, input.isLocked);
        return { success: true };
      }),
    deleteDefinition: protectedProcedure
      .input(
        z.object({
          definitionId: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { deleteSupplementDefinition } = await import("./db");
        await deleteSupplementDefinition(ctx.user.id, input.definitionId);
        return { success: true };
      }),
    getLogs: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            limit: z.number().min(1).max(200).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const {
          listSupplementLogs,
          listSupplementDefinitions,
          getSupplementLogByDefinitionAndDate,
          addSupplementLog,
        } = await import("./db");
        const { nanoid } = await import("nanoid");
        const dateKey = input?.dateKey ?? getTodayDateKey();

        const definitions = await listSupplementDefinitions(ctx.user.id);
        const locked = definitions.filter((definition) => definition.isLocked);

        for (const definition of locked) {
          const existingLog = await getSupplementLogByDefinitionAndDate(
            ctx.user.id,
            definition.id,
            dateKey
          );
          if (!existingLog) {
            await addSupplementLog({
              id: nanoid(),
              userId: ctx.user.id,
              definitionId: definition.id,
              name: definition.name,
              dose: definition.dose,
              doseUnit: definition.doseUnit,
              timing: definition.timing,
              autoLogged: true,
              notes: null,
              dateKey,
              takenAt: new Date(),
            });
          }
        }
        return listSupplementLogs(ctx.user.id, dateKey, input?.limit ?? 100);
      }),
    addLog: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(128),
          dose: z.string().min(1).max(64),
          doseUnit: z
            .enum(["capsule", "tablet", "mg", "mcg", "g", "ml", "drop", "scoop", "other"])
            .optional(),
          timing: z.enum(["am", "pm"]).optional(),
          notes: z.string().max(500).optional(),
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          definitionId: z.string().optional(),
          autoLogged: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { addSupplementLog } = await import("./db");
        const { nanoid } = await import("nanoid");
        const dateKey = input.dateKey ?? getTodayDateKey();

        await addSupplementLog({
          id: nanoid(),
          userId: ctx.user.id,
          definitionId: input.definitionId ?? null,
          name: input.name.trim(),
          dose: input.dose.trim(),
          doseUnit: input.doseUnit ?? "capsule",
          timing: input.timing ?? "am",
          autoLogged: input.autoLogged ?? false,
          notes: input.notes?.trim() || null,
          dateKey,
          takenAt: new Date(),
        });
        return { success: true };
      }),
    deleteLog: protectedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteSupplementLog } = await import("./db");
        await deleteSupplementLog(ctx.user.id, input.id);
        return { success: true };
      }),
  }),

  habits: router({
    listDefinitions: protectedProcedure.query(async ({ ctx }) => {
      const { listHabitDefinitions } = await import("./db");
      return listHabitDefinitions(ctx.user.id);
    }),
    createDefinition: protectedProcedure
      .input(
        z.object({
          name: z.string().min(1).max(120),
          color: z.string().min(1).max(32).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { listHabitDefinitions, createHabitDefinition } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await listHabitDefinitions(ctx.user.id);
        const nextSortOrder =
          existing.length > 0 ? Math.max(...existing.map((habit) => habit.sortOrder ?? 0)) + 1 : 0;

        await createHabitDefinition({
          id: nanoid(),
          userId: ctx.user.id,
          name: input.name.trim(),
          color: (input.color ?? "slate").trim().toLowerCase(),
          sortOrder: nextSortOrder,
          isActive: true,
        });
        return { success: true };
      }),
    deleteDefinition: protectedProcedure
      .input(z.object({ habitId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteHabitDefinition } = await import("./db");
        await deleteHabitDefinition(ctx.user.id, input.habitId);
        return { success: true };
      }),
    getForDate: protectedProcedure
      .input(
        z
          .object({
            dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const dateKey = input?.dateKey ?? getTodayDateKey();
        const { listHabitDefinitions, getHabitCompletionsByDate } = await import("./db");
        const [definitions, completions] = await Promise.all([
          listHabitDefinitions(ctx.user.id),
          getHabitCompletionsByDate(ctx.user.id, dateKey),
        ]);

        const completedMap = new Map(
          completions.map((completion) => [completion.habitId, Boolean(completion.completed)])
        );

        return definitions.map((habit) => ({
          ...habit,
          completed: completedMap.get(habit.id) ?? false,
          dateKey,
        }));
      }),
    setCompletion: protectedProcedure
      .input(
        z.object({
          habitId: z.string(),
          completed: z.boolean(),
          dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { listHabitDefinitions, upsertHabitCompletion } = await import("./db");
        const dateKey = input.dateKey ?? getTodayDateKey();
        const habits = await listHabitDefinitions(ctx.user.id);
        if (!habits.some((habit) => habit.id === input.habitId)) {
          throw new Error("Habit not found");
        }
        await upsertHabitCompletion(ctx.user.id, input.habitId, dateKey, input.completed);
        return { success: true };
      }),
    getStreaks: protectedProcedure.query(async ({ ctx }) => {
      const { listHabitDefinitions, getHabitCompletionsRange } = await import("./db");
      const today = new Date();
      // Get last 14 days of data for streak calculation (show 7 days, need 14 for streak count)
      const sinceDate = new Date(today);
      sinceDate.setDate(sinceDate.getDate() - 13);
      const sinceDateKey = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, "0")}-${String(sinceDate.getDate()).padStart(2, "0")}`;

      const [definitions, completions] = await Promise.all([
        listHabitDefinitions(ctx.user.id),
        getHabitCompletionsRange(ctx.user.id, sinceDateKey),
      ]);

      // Build a map: habitId -> Set of completed dateKeys
      const completionMap = new Map<string, Set<string>>();
      for (const c of completions) {
        if (!completionMap.has(c.habitId)) {
          completionMap.set(c.habitId, new Set());
        }
        completionMap.get(c.habitId)!.add(c.dateKey);
      }

      // Generate last 7 date keys for the dot calendar
      const last7Days: string[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        last7Days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
      }

      return definitions.map((habit) => {
        const completedDates = completionMap.get(habit.id) ?? new Set();

        // Calculate current streak (consecutive days ending today or yesterday)
        let streak = 0;
        for (let i = 0; i < 14; i++) {
          const d = new Date(today);
          d.setDate(d.getDate() - i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          if (completedDates.has(key)) {
            streak++;
          } else if (i === 0) {
            // Today not done yet — continue checking from yesterday
            continue;
          } else {
            break;
          }
        }

        // Build 7-day calendar
        const calendar = last7Days.map((dateKey) => ({
          dateKey,
          completed: completedDates.has(dateKey),
        }));

        return {
          habitId: habit.id,
          name: habit.name,
          color: habit.color,
          streak,
          calendar,
        };
      });
    }),
  }),

  notes: router({
    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(1000).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const { listNotes, listNoteLinks } = await import("./db");
        const limit = input?.limit ?? 100;
        const [noteRows, linkRows] = await Promise.all([
          listNotes(ctx.user.id, limit),
          listNoteLinks(ctx.user.id, undefined, Math.max(limit * 10, 200)),
        ]);

        const linksByNoteId = new Map<string, any[]>();
        for (const link of linkRows) {
          const bucket = linksByNoteId.get(link.noteId) ?? [];
          bucket.push(link);
          linksByNoteId.set(link.noteId, bucket);
        }

        return noteRows.map((note) => ({
          ...note,
          links: linksByNoteId.get(note.id) ?? [],
        }));
      }),
    create: protectedProcedure
      .input(
        z.object({
          notebook: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(180),
          content: z.string().max(250000).optional(),
          pinned: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { createNote } = await import("./db");

        const noteId = nanoid();
        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: input.notebook?.trim() || "General",
          title: input.title.trim(),
          content: input.content?.trim() || "",
          pinned: input.pinned ?? false,
        });

        return { success: true, noteId };
      }),
    update: protectedProcedure
      .input(
        z.object({
          noteId: z.string(),
          notebook: z.string().min(1).max(120).optional(),
          title: z.string().min(1).max(180).optional(),
          content: z.string().max(250000).optional(),
          pinned: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getNoteById, updateNote } = await import("./db");
        const existing = await getNoteById(ctx.user.id, input.noteId);
        if (!existing) throw new Error("Note not found");

        await updateNote(ctx.user.id, input.noteId, {
          notebook: input.notebook?.trim(),
          title: input.title?.trim(),
          content: input.content,
          pinned: input.pinned,
        });

        return { success: true };
      }),
    delete: protectedProcedure
      .input(z.object({ noteId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteNote } = await import("./db");
        await deleteNote(ctx.user.id, input.noteId);
        return { success: true };
      }),
    addLink: protectedProcedure
      .input(
        z.object({
          noteId: z.string(),
          linkType: z.enum(["todoist_task", "google_calendar_event", "note_link", "google_drive_file"]),
          externalId: z.string().min(1).max(255),
          seriesId: z.string().max(255).optional(),
          occurrenceStartIso: z.string().max(64).optional(),
          sourceUrl: z.string().max(4096).optional(),
          sourceTitle: z.string().max(255).optional(),
          metadata: z.record(z.string(), z.any()).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { getNoteById, addNoteLink, updateNote } = await import("./db");
        const note = await getNoteById(ctx.user.id, input.noteId);
        if (!note) throw new Error("Note not found");

        const linkResult = await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId: input.noteId,
          linkType: input.linkType,
          externalId: input.externalId.trim(),
          seriesId: input.seriesId?.trim() || "",
          occurrenceStartIso: input.occurrenceStartIso?.trim() || "",
          sourceUrl: input.sourceUrl?.trim() || null,
          sourceTitle: input.sourceTitle?.trim() || null,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        });

        if (linkResult.created) {
          await updateNote(ctx.user.id, input.noteId, {});
        }
        return { success: true, alreadyLinked: !linkResult.created };
      }),
    removeLink: protectedProcedure
      .input(z.object({ linkId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { deleteNoteLink } = await import("./db");
        await deleteNoteLink(ctx.user.id, input.linkId);
        return { success: true };
      }),
    uploadImage: protectedProcedure
      .input(
        z.object({
          base64Data: z.string().max(10_000_000),
          contentType: z.enum([
            "image/png",
            "image/jpeg",
            "image/gif",
            "image/webp",
            "image/svg+xml",
          ]),
          fileName: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { storagePut } = await import("./storage");

        const ext = input.contentType.split("/")[1] ?? "png";
        const key = `notes/${ctx.user.id}/images/${nanoid()}.${ext}`;
        const buffer = Buffer.from(input.base64Data, "base64");

        const { url } = await storagePut(key, buffer, input.contentType);
        return { url };
      }),
    createFromTodoistTask: protectedProcedure
      .input(
        z.object({
          taskId: z.string().min(1).max(255),
          taskContent: z.string().min(1).max(1000),
          taskUrl: z.string().max(4096).optional(),
          dueDate: z.string().max(128).optional(),
          projectName: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { createNote, addNoteLink } = await import("./db");
        const noteId = nanoid();

        const title = `Task: ${input.taskContent.slice(0, 120)}`;
        const contentLines = [
          `Task: ${input.taskContent}`,
          input.projectName ? `Project: ${input.projectName}` : null,
          input.dueDate ? `Due: ${input.dueDate}` : null,
          input.taskUrl ? `URL: ${input.taskUrl}` : null,
          "",
        ].filter(Boolean);

        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: "Tasks",
          title,
          content: contentLines.join("\n"),
          pinned: false,
        });

        await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId,
          linkType: "todoist_task",
          externalId: input.taskId,
          seriesId: "",
          occurrenceStartIso: "",
          sourceUrl: input.taskUrl?.trim() || null,
          sourceTitle: input.taskContent.slice(0, 255),
          metadata: JSON.stringify({
            dueDate: input.dueDate ?? null,
            projectName: input.projectName ?? null,
          }),
        });

        return { success: true, noteId };
      }),
    createFromCalendarEvent: protectedProcedure
      .input(
        z.object({
          eventId: z.string().min(1).max(255),
          eventSummary: z.string().min(1).max(1000),
          eventUrl: z.string().max(4096).optional(),
          start: z.string().max(128).optional(),
          location: z.string().max(500).optional(),
          recurringEventId: z.string().max(255).optional(),
          iCalUID: z.string().max(255).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { nanoid } = await import("nanoid");
        const { createNote, addNoteLink } = await import("./db");
        const noteId = nanoid();

        const title = `Event: ${input.eventSummary.slice(0, 120)}`;
        const contentLines = [
          `Event: ${input.eventSummary}`,
          input.start ? `Start: ${input.start}` : null,
          input.location ? `Location: ${input.location}` : null,
          input.eventUrl ? `URL: ${input.eventUrl}` : null,
          "",
        ].filter(Boolean);

        await createNote({
          id: noteId,
          userId: ctx.user.id,
          notebook: "Meetings",
          title,
          content: contentLines.join("\n"),
          pinned: false,
        });

        await addNoteLink({
          id: nanoid(),
          userId: ctx.user.id,
          noteId,
          linkType: "google_calendar_event",
          externalId: input.eventId,
          seriesId: (input.recurringEventId || input.iCalUID || "").trim(),
          occurrenceStartIso: input.start?.trim() || "",
          sourceUrl: input.eventUrl?.trim() || null,
          sourceTitle: input.eventSummary.slice(0, 255),
          metadata: JSON.stringify({
            location: input.location ?? null,
            recurringEventId: input.recurringEventId ?? null,
            iCalUID: input.iCalUID ?? null,
          }),
        });

        return { success: true, noteId };
      }),
  }),

  dataExport: router({
    dumpAll: protectedProcedure
      .input(
        z
          .object({
            metricsLimit: z.number().min(1).max(3650).optional(),
            logsLimit: z.number().min(1).max(5000).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limits = {
          metrics: input?.metricsLimit ?? 365,
          logs: input?.logsLimit ?? 2000,
        };
        const {
          getDailyMetricsHistory,
          listSupplementLogs,
          listSupplementDefinitions,
          listHabitDefinitions,
          listHabitCompletions,
          listDailySnapshots,
          getIntegrationByProvider,
          getLatestSamsungSyncPayload,
        } = await import("./db");

        const [
          metrics,
          supplementLogs,
          supplementDefinitions,
          habitDefinitions,
          habitCompletions,
          nightlySnapshots,
          samsungIntegration,
          latestSamsungRaw,
        ] = await Promise.all([
          getDailyMetricsHistory(ctx.user.id, limits.metrics),
          listSupplementLogs(ctx.user.id, undefined, limits.logs),
          listSupplementDefinitions(ctx.user.id),
          listHabitDefinitions(ctx.user.id),
          listHabitCompletions(ctx.user.id, limits.logs),
          listDailySnapshots(ctx.user.id, limits.metrics),
          getIntegrationByProvider(ctx.user.id, "samsung-health"),
          getLatestSamsungSyncPayload(ctx.user.id),
        ]);

        let samsungLatestMetadata: Record<string, unknown> | null = null;
        if (samsungIntegration?.metadata) {
          samsungLatestMetadata = parseJsonMetadata(samsungIntegration.metadata);
        }

        let samsungRawPayload: Record<string, unknown> | null = null;
        if (latestSamsungRaw?.payload) {
          try {
            samsungRawPayload = JSON.parse(latestSamsungRaw.payload) as Record<string, unknown>;
          } catch {
            samsungRawPayload = null;
          }
        }

        return {
          generatedAt: new Date().toISOString(),
          userId: ctx.user.id,
          tables: {
            dailyHealthMetrics: metrics,
            supplementLogs,
            supplementDefinitions,
            habitDefinitions,
            habitCompletions,
            nightlySnapshots,
          },
          latest: {
            samsungIntegrationMetadata: samsungLatestMetadata,
            samsungRawPayload,
          },
        };
      }),
    dumpStructuredCsv: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(3650).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const limit = input?.limit ?? 365;
        const {
          getDailyMetricsHistory,
          listSupplementLogs,
          listSupplementDefinitions,
          listHabitCompletions,
          listHabitDefinitions,
          listDailySnapshots,
          getIntegrationByProvider,
        } = await import("./db");

        const [metrics, supplementLogs, supplementDefinitions, habitCompletions, habitDefinitions, snapshots] = await Promise.all([
          getDailyMetricsHistory(ctx.user.id, limit),
          listSupplementLogs(ctx.user.id, undefined, Math.min(limit * 20, 5000)),
          listSupplementDefinitions(ctx.user.id),
          listHabitCompletions(ctx.user.id, Math.min(limit * 20, 5000)),
          listHabitDefinitions(ctx.user.id),
          listDailySnapshots(ctx.user.id, limit),
        ]);

        const dateSet = new Set<string>();
        for (const row of metrics) dateSet.add(row.dateKey);
        for (const row of supplementLogs) dateSet.add(row.dateKey);
        for (const row of habitCompletions) dateSet.add(row.dateKey);
        for (const row of snapshots) dateSet.add(row.dateKey);

        const nextDateKey = (dateKey: string): string => {
          const date = new Date(`${dateKey}T00:00:00`);
          if (Number.isNaN(date.getTime())) return dateKey;
          date.setDate(date.getDate() + 1);
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, "0");
          const d = String(date.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}`;
        };

        const toDateKey = (date: Date): string => {
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, "0");
          const d = String(date.getDate()).padStart(2, "0");
          return `${y}-${m}-${d}`;
        };

        const completedTodoistTaskCountsByDate = new Map<string, number>();

        try {
          const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
          if (todoistIntegration?.accessToken) {
            const { getTodoistCompletedTasksInRange } = await import("./services/todoist");
            const todayDateKey = getTodayDateKey();
            const startDate = new Date(`${todayDateKey}T00:00:00`);
            startDate.setDate(startDate.getDate() - (limit - 1));
            const completedTasks = await getTodoistCompletedTasksInRange(
              todoistIntegration.accessToken,
              toDateKey(startDate),
              nextDateKey(todayDateKey)
            );
            for (const task of completedTasks) {
              completedTodoistTaskCountsByDate.set(
                task.dateKey,
                (completedTodoistTaskCountsByDate.get(task.dateKey) ?? 0) + 1
              );
              dateSet.add(task.dateKey);
            }
          }
        } catch (error) {
          console.error("[Data Export] Failed to load Todoist completed counts:", error);
        }

        const dateKeys = Array.from(dateSet).sort((a, b) => a.localeCompare(b));
        const metricsByDate = new Map(metrics.map((row) => [row.dateKey, row]));

        const snapshotsByDate = new Map<string, Record<string, unknown>>();
        for (const snapshot of snapshots) {
          if (!snapshot.samsungPayload && !snapshot.whoopPayload) continue;
          snapshotsByDate.set(snapshot.dateKey, {
            whoopPayload: snapshot.whoopPayload,
            samsungPayload: snapshot.samsungPayload,
          });
        }

        const supplementKey = (name: string, timing: string, doseUnit: string) =>
          `${name.trim().toLowerCase()}|${timing.trim().toLowerCase()}|${doseUnit.trim().toLowerCase()}`;
        const supplementLabel = (name: string, timing: string, doseUnit: string) =>
          `Supplement: ${name} | Timing: ${timing.toUpperCase()} | Unit: ${doseUnit}`;
        const parseDoseNumber = (value: string): number | null => {
          const trimmed = value.trim();
          if (!trimmed) return null;
          const match = trimmed.match(/-?\d+(\.\d+)?/);
          if (!match) return null;
          const parsed = Number(match[0]);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const formatAmount = (value: number): string => {
          if (!Number.isFinite(value)) return "0";
          if (Number.isInteger(value)) return String(value);
          return value.toFixed(3).replace(/\.?0+$/, "");
        };

        const supplementByKey = new Map<
          string,
          { label: string; sortOrder: number }
        >();
        for (const definition of supplementDefinitions) {
          const key = supplementKey(definition.name, definition.timing, definition.doseUnit);
          if (!supplementByKey.has(key)) {
            supplementByKey.set(key, {
              label: supplementLabel(definition.name, definition.timing, definition.doseUnit),
              sortOrder: definition.sortOrder ?? Number.MAX_SAFE_INTEGER,
            });
          }
        }

        const supplementAmountsByKey = new Map<string, Map<string, number>>();
        for (const log of supplementLogs) {
          const key = supplementKey(log.name, log.timing, log.doseUnit);
          if (!supplementByKey.has(key)) {
            supplementByKey.set(key, {
              label: supplementLabel(log.name, log.timing, log.doseUnit),
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          }
          const byDate = supplementAmountsByKey.get(key) ?? new Map<string, number>();
          const numericDose = parseDoseNumber(log.dose);
          const currentTotal = byDate.get(log.dateKey) ?? 0;
          byDate.set(log.dateKey, currentTotal + (numericDose ?? 0));
          supplementAmountsByKey.set(key, byDate);
        }

        const habitById = new Map<
          string,
          { label: string; sortOrder: number }
        >(
          habitDefinitions.map((habit) => [
            habit.id,
            { label: habit.name, sortOrder: habit.sortOrder ?? Number.MAX_SAFE_INTEGER },
          ])
        );
        const habitCompletionsById = new Map<string, Map<string, boolean>>();
        for (const completion of habitCompletions) {
          if (!habitById.has(completion.habitId)) {
            habitById.set(completion.habitId, {
              label: completion.habitId,
              sortOrder: Number.MAX_SAFE_INTEGER,
            });
          }
          const byDate = habitCompletionsById.get(completion.habitId) ?? new Map<string, boolean>();
          byDate.set(completion.dateKey, Boolean(completion.completed));
          habitCompletionsById.set(completion.habitId, byDate);
        }

        const supplementRows = Array.from(supplementByKey.entries())
          .map(([key, value]) => ({ key, ...value }))
          .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));
        const habitRows = Array.from(habitById.entries())
          .map(([id, value]) => ({ id, ...value }))
          .sort((a, b) => (a.sortOrder - b.sortOrder) || a.label.localeCompare(b.label));

        const asObj = (value: unknown): Record<string, unknown> =>
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        const asNum = (value: unknown): number | null =>
          typeof value === "number" && Number.isFinite(value) ? value : null;
        const parseJson = (value: unknown): Record<string, unknown> => {
          if (typeof value !== "string" || !value) return {};
          try {
            return asObj(JSON.parse(value));
          } catch {
            return {};
          }
        };
        const getWhoop = (dateKey: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const whoopPayload = parseJson(row?.whoopPayload);
          return asNum(whoopPayload[key]);
        };
        const getSamsungSummary = (dateKey: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const samsungPayload = parseJson(row?.samsungPayload);
          const summary = asObj(samsungPayload.summary);
          return asNum(summary[key]);
        };
        const getSamsungRaw = (dateKey: string, section: string, key: string): number | null => {
          const row = snapshotsByDate.get(dateKey);
          const samsungPayload = parseJson(row?.samsungPayload);
          const sectionObj = asObj(samsungPayload[section]);
          return asNum(sectionObj[key]);
        };
        const getSamsungSleepHoursFallback = (dateKey: string): number | null => {
          const summaryMinutes = getSamsungSummary(dateKey, "sleepTotalMinutes");
          if (summaryMinutes !== null) {
            return Number((summaryMinutes / 60).toFixed(1));
          }
          const rawMinutes = getSamsungRaw(dateKey, "sleep", "totalSleepMinutes");
          if (rawMinutes !== null) {
            return Number((rawMinutes / 60).toFixed(1));
          }
          return null;
        };

        const csvRows: string[][] = [];
        const addMetricRow = (
          label: string,
          getter: (dateKey: string) => string | number | null | undefined
        ) => {
          csvRows.push([
            label,
            ...dateKeys.map((dateKey) => {
              const value = getter(dateKey);
              return value === null || value === undefined ? "" : String(value);
            }),
          ]);
        };
        const addSectionRow = (label: string) => {
          csvRows.push([label, ...dateKeys.map(() => "")]);
        };

        addMetricRow("WHOOP Recovery %", (dateKey) => metricsByDate.get(dateKey)?.whoopRecoveryScore ?? getWhoop(dateKey, "recoveryScore"));
        addMetricRow("WHOOP Day Strain", (dateKey) => metricsByDate.get(dateKey)?.whoopDayStrain ?? getWhoop(dateKey, "dayStrain"));
        addMetricRow("WHOOP Sleep Hours", (dateKey) => metricsByDate.get(dateKey)?.whoopSleepHours ?? getWhoop(dateKey, "sleepHours"));
        addMetricRow("WHOOP HRV ms", (dateKey) => metricsByDate.get(dateKey)?.whoopHrvMs ?? getWhoop(dateKey, "hrvRmssdMilli"));
        addMetricRow("WHOOP Resting HR bpm", (dateKey) => metricsByDate.get(dateKey)?.whoopRestingHr ?? getWhoop(dateKey, "restingHeartRate"));
        addMetricRow("WHOOP Sleep Performance %", (dateKey) => getWhoop(dateKey, "sleepPerformance"));
        addMetricRow("WHOOP Sleep Efficiency %", (dateKey) => getWhoop(dateKey, "sleepEfficiency"));
        addMetricRow("WHOOP Sleep Consistency %", (dateKey) => getWhoop(dateKey, "sleepConsistency"));
        addMetricRow("WHOOP Respiratory Rate", (dateKey) => getWhoop(dateKey, "respiratoryRate"));
        addMetricRow("WHOOP SpO2 %", (dateKey) => getWhoop(dateKey, "spo2Percentage"));
        addMetricRow("WHOOP Avg HR bpm", (dateKey) => getWhoop(dateKey, "averageHeartRate"));
        addMetricRow("WHOOP Max HR bpm", (dateKey) => getWhoop(dateKey, "maxHeartRate"));

        addMetricRow("Samsung Steps", (dateKey) => metricsByDate.get(dateKey)?.samsungSteps ?? getSamsungSummary(dateKey, "steps") ?? getSamsungRaw(dateKey, "activity", "steps"));
        addMetricRow("Samsung Sleep Hours", (dateKey) => metricsByDate.get(dateKey)?.samsungSleepHours ?? getSamsungSleepHoursFallback(dateKey));
        addMetricRow("Samsung SpO2 Avg %", (dateKey) => metricsByDate.get(dateKey)?.samsungSpo2AvgPercent ?? getSamsungSummary(dateKey, "spo2AvgPercent") ?? getSamsungRaw(dateKey, "oxygenAndTemperature", "spo2AvgPercent"));
        addMetricRow("Samsung Sleep Score", (dateKey) => metricsByDate.get(dateKey)?.samsungSleepScore ?? getSamsungSummary(dateKey, "sleepScore") ?? getSamsungRaw(dateKey, "sleep", "sleepScore"));
        addMetricRow("Samsung Energy Score", (dateKey) => metricsByDate.get(dateKey)?.samsungEnergyScore ?? getSamsungSummary(dateKey, "energyScore") ?? getSamsungRaw(dateKey, "cardio", "recoveryScore"));
        addMetricRow("Todoist Completed Tasks", (dateKey) => {
          const liveCount = completedTodoistTaskCountsByDate.get(dateKey) ?? null;
          if (liveCount !== null) return liveCount;
          return metricsByDate.get(dateKey)?.todoistCompletedCount ?? 0;
        });

        addSectionRow("Habits");
        if (habitRows.length === 0) {
          addMetricRow("No habits configured", () => "");
        } else {
          for (const habit of habitRows) {
            addMetricRow(habit.label, (dateKey) => {
              const completed = habitCompletionsById.get(habit.id)?.get(dateKey) ?? false;
              return completed ? 1 : 0;
            });
          }
        }

        addSectionRow("Supplements");
        if (supplementRows.length === 0) {
          addMetricRow("No supplements configured", () => "");
        } else {
          for (const supplement of supplementRows) {
            addMetricRow(supplement.label, (dateKey) => {
              const amount = supplementAmountsByKey.get(supplement.key)?.get(dateKey) ?? 0;
              return formatAmount(amount);
            });
          }
        }

        const escapeCsv = (value: string) => {
          if (/[",\n]/.test(value)) {
            return `"${value.replace(/"/g, "\"\"")}"`;
          }
          return value;
        };
        const csv = [
          ["Metric", ...dateKeys],
          ...csvRows,
        ]
          .map((row) => row.map((cell) => escapeCsv(cell)).join(","))
          .join("\n");

        return {
          generatedAt: new Date().toISOString(),
          filename: `coherence-structured-metrics-${new Date().toISOString().slice(0, 10)}.csv`,
          csv,
          dates: dateKeys,
          rowCount: csvRows.length,
        };
      }),
  }),

  dock: router({
    getItemDetails: protectedProcedure
      .input(z.object({
        source: z.enum(["gmail", "gcal", "gsheet", "todoist", "url"]),
        url: z.string(),
        meta: z.record(z.string(), z.any()).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider } = await import("./db");
        
        try {
          if (input.source === "gmail") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Email" };
            }
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            // Extract message ID from parsed metadata or URL fallback.
            let messageId = input.meta?.messageId as string | undefined;
            if (!messageId) {
              try {
                const urlObj = new URL(input.url);
                const hash = urlObj.hash.startsWith("#") ? urlObj.hash.slice(1) : urlObj.hash;
                const hashMessageId = hash.split("/").pop();
                const queryMessageId = urlObj.searchParams.get("th");
                messageId = queryMessageId || hashMessageId || undefined;
              } catch {
                messageId = undefined;
              }
            }
            if (!messageId) return { title: "Email" };
            
            // Fetch email details from Gmail API
            const response = await fetch(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=Subject`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Email" };
            
            const data = await response.json();
            const subject = data.payload?.headers?.find(
              (h: any) => h.name === "Subject"
            )?.value || "Email";
            
            return { title: subject };
          }
          
          if (input.source === "gcal") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Calendar Event" };
            }
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            // Extract event ID from meta (already decoded in frontend) or eid parameter
            let eventId = input.meta?.eventId as string | undefined;
            
            if (!eventId) {
              const eid = input.meta?.eid as string;
              if (!eid) return { title: "Calendar Event" };
              
              // Decode base64 event ID
              try {
                const decoded = Buffer.from(eid, "base64").toString("utf-8");
                // Event ID format: "eventId calendarId"
                eventId = decoded.split(" ")[0];
              } catch {
                return { title: "Calendar Event" };
              }
            }
            
            if (!eventId) return { title: "Calendar Event" };
            
            // Fetch event details from Calendar API
            const response = await fetch(
              `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Calendar Event" };
            
            const event = await response.json();
            return { title: event.summary || "Calendar Event" };
          }
          
          if (input.source === "gsheet") {
            const googleIntegration = await getIntegrationByProvider(ctx.user.id, "google");
            if (!googleIntegration?.accessToken) {
              return { title: "Spreadsheet" };
            }
            const { getValidGoogleToken } = await import("./helpers/tokenRefresh");
            const accessToken = await getValidGoogleToken(ctx.user.id);
            
            const sheetId = input.meta?.sheetId as string;
            if (!sheetId) return { title: "Spreadsheet" };
            
            // Fetch spreadsheet details from Drive API
            const response = await fetch(
              `https://www.googleapis.com/drive/v3/files/${sheetId}?fields=name`,
              { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            
            if (!response.ok) return { title: "Spreadsheet" };
            
            const file = await response.json();
            return { title: file.name || "Spreadsheet" };
          }
          
          if (input.source === "todoist") {
            const todoistIntegration = await getIntegrationByProvider(ctx.user.id, "todoist");
            if (!todoistIntegration?.accessToken) {
              return { title: "Task" };
            }
            
            let taskId = input.meta?.taskId as string | undefined;
            if (!taskId) {
              const taskMatch = input.url.match(/\/task\/([A-Za-z0-9_-]+)/);
              taskId = taskMatch?.[1];
            }
            if (!taskId) return { title: "Task" };
            
            // Fetch task details from Todoist API (v1).
            const response = await fetch(
              `https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`,
              { headers: { Authorization: `Bearer ${todoistIntegration.accessToken}` } }
            );
            
            if (!response.ok) {
              const { getTodoistTasks } = await import("./services/todoist");
              const tasks = await getTodoistTasks(todoistIntegration.accessToken);
              const task = tasks.find((t) => t.id === taskId);
              return { title: task?.content || "Task" };
            }
            
            const data = await response.json();
            const task = data?.task ?? data;
            return { title: task?.content || "Task" };
          }
          
          return { title: input.url };
        } catch (error) {
          console.error(`[Dock] Error fetching details for ${input.source}:`, error);
          return { title: input.source === "gmail" ? "Email" : input.source === "gcal" ? "Calendar Event" : input.source === "gsheet" ? "Spreadsheet" : input.source === "todoist" ? "Task" : input.url };
        }
      }),
  }),

  engagement: router({
    recordBatch: protectedProcedure
      .input(
        z.object({
          events: z.array(
            z.object({
              sectionId: z.string().max(48),
              eventType: z.string().max(32),
              eventValue: z.string().max(64).optional(),
              sessionDate: z.string().length(10),
              durationMs: z.number().int().optional(),
            })
          ),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.events.length === 0) return { ok: true };
        const { insertSectionEngagementBatch } = await import("./db");
        await insertSectionEngagementBatch(
          input.events.map((event) => ({
            userId: ctx.user.id,
            sectionId: event.sectionId,
            eventType: event.eventType,
            eventValue: event.eventValue ?? null,
            sessionDate: event.sessionDate,
            durationMs: event.durationMs ?? null,
          }))
        );
        return { ok: true };
      }),

    setRating: protectedProcedure
      .input(
        z.object({
          sectionId: z.string().max(48),
          rating: z.enum(["essential", "useful", "rarely-use", "remove"]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { insertSectionEngagementBatch } = await import("./db");
        const now = new Date();
        const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        await insertSectionEngagementBatch([
          {
            userId: ctx.user.id,
            sectionId: input.sectionId,
            eventType: "rating",
            eventValue: input.rating,
            sessionDate: dateKey,
            durationMs: null,
          },
        ]);
        return { ok: true };
      }),

    getRatings: protectedProcedure.query(async ({ ctx }) => {
      const { getSectionRatings } = await import("./db");
      return getSectionRatings(ctx.user.id);
    }),

    getSummary: protectedProcedure
      .input(
        z.object({
          sinceDateKey: z.string().length(10),
        })
      )
      .query(async ({ ctx, input }) => {
        const { getSectionEngagementSummary } = await import("./db");
        return getSectionEngagementSummary(ctx.user.id, input.sinceDateKey);
      }),

    clearAll: protectedProcedure.mutation(async ({ ctx }) => {
      const { clearSectionEngagement } = await import("./db");
      await clearSectionEngagement(ctx.user.id);
      return { ok: true };
    }),
  }),

  anthropic: router({
    connect: protectedProcedure
      .input(
        z.object({
          apiKey: z.string().max(512).optional(),
          model: z.string().max(64).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { getIntegrationByProvider, upsertIntegration } = await import("./db");
        const { nanoid } = await import("nanoid");
        const existing = await getIntegrationByProvider(ctx.user.id, "anthropic");
        const incomingKey = input.apiKey?.trim();
        const accessToken = incomingKey || existing?.accessToken || null;

        if (!accessToken) {
          throw new Error("Anthropic API key is required");
        }

        const existingMeta = parseJsonMetadata(existing?.metadata);
        const existingModel = typeof existingMeta.model === "string" ? existingMeta.model : "claude-sonnet-4-20250514";
        const requestedModel = input.model?.trim();
        const model = requestedModel && requestedModel.length > 0 ? requestedModel : existingModel;

        await upsertIntegration({
          id: nanoid(),
          userId: ctx.user.id,
          provider: "anthropic",
          accessToken,
          refreshToken: null,
          expiresAt: null,
          scope: null,
          metadata: JSON.stringify({ model }),
        });
        return { success: true, model };
      }),
  }),
});

export type AppRouter = typeof appRouter;
