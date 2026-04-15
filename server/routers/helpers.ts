import path from "node:path";
import { mkdir, appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { nanoid } from "nanoid";
import { z } from "zod";
import {
  toNonEmptyString,
} from "../services/core/addressCleaning";
import { mapWithConcurrency } from "../services/core/concurrency";
import {
  HOURS_PER_YEAR,
  ANNUAL_DEGRADATION_FACTOR,
  SEARCH_SCORE_EXACT,
  SEARCH_SCORE_PREFIX,
  SEARCH_SCORE_CONTAINS,
  SEARCH_SCORE_ALL_TOKENS,
  FETCH_TIMEOUT_MS,
  JOB_TTL_MS,
} from "../constants";
import { IntegrationNotConnectedError } from "../errors";
import {
  getIntegrationByProvider,
  upsertIntegration,
  getSolarRecDashboardPayload,
  saveSolarRecDashboardPayload,
  getSupplementDefinitionById,
  listSupplementDefinitions,
  createSupplementDefinition,
  updateSupplementDefinition,
  addSupplementPriceLog,
} from "../db";
import { storageGet, storagePut } from "../storage";
import {
  checkSupplementPrice,
  extractSupplementsFromBottleImage,
  findExistingSupplementMatch,
  sourceDomainFromUrl,
} from "../services/integrations/supplements";
import {
  refreshEnphaseV4AccessToken,
} from "../services/solar/enphaseV4";
import {
  CsgPortalClient,
} from "../services/integrations/csgPortal";
import { extractContractDataFromPdfBuffer } from "../services/core/contractScannerServer";
import {
  getTeslaPowerhubGroupProductionMetrics,
} from "../services/solar/teslaPowerhub";
import { maskApiKey } from "./solarConnectionFactory";

// Re-export for convenience from sub-router files
export { toNonEmptyString } from "../services/core/addressCleaning";
export { maskApiKey } from "./solarConnectionFactory";
export { IntegrationNotConnectedError } from "../errors";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1";

export const ENPHASE_V2_PROVIDER = "enphase-v2";
export const ENPHASE_V4_PROVIDER = "enphase-v4";
export const SOLAR_EDGE_PROVIDER = "solaredge-monitoring";
export const ENNEX_OS_PROVIDER = "ennexos-monitoring";
export const ZENDESK_PROVIDER = "zendesk";
export const TESLA_SOLAR_PROVIDER = "tesla-solar";
export const TESLA_POWERHUB_PROVIDER = "tesla-powerhub";
export const CLOCKIFY_PROVIDER = "clockify";
export const CSG_PORTAL_PROVIDER = "csg-portal";
export const FRONIUS_PROVIDER = "fronius-solar";
export const EGAUGE_PROVIDER = "egauge-monitoring";
export const SOLIS_PROVIDER = "solis-cloud";
export const GOODWE_PROVIDER = "goodwe-sems";
export const GENERAC_PROVIDER = "generac-pwrfleet";
export const LOCUS_PROVIDER = "locus-energy";
export const GROWATT_PROVIDER = "growatt-server";
export const APSYSTEMS_PROVIDER = "apsystems-ema";
export const EKM_PROVIDER = "ekm-encompass";
export const HOYMILES_PROVIDER = "hoymiles-smiles";
export const SOLAR_LOG_PROVIDER = "solar-log";

// ---------------------------------------------------------------------------
// Generic utility functions
// ---------------------------------------------------------------------------

export function parseJsonMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function resolveOpenAIModel(metadata: string | null | undefined): string {
  const parsed = parseJsonMetadata(metadata);
  const model = parsed.model;
  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : DEFAULT_OPENAI_MODEL;
}

export function toNullableScore(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return null;
}

export function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function truncateText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}\u2026`;
}

export function scoreMatch(haystack: string, query: string): number {
  const text = normalizeSearchQuery(haystack);
  if (!text || !query) return 0;
  if (text === query) return SEARCH_SCORE_EXACT;
  if (text.startsWith(query)) return SEARCH_SCORE_PREFIX;
  if (text.includes(query)) return SEARCH_SCORE_CONTAINS;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => text.includes(token))) return SEARCH_SCORE_ALL_TOKENS;
  return 0;
}

export function safeIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function computePearsonCorrelation(
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

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function normalizeProgressPercent(currentStep: number, totalSteps: number): number {
  if (!Number.isFinite(totalSteps) || totalSteps <= 0) return 0;
  return clampPercent((currentStep / totalSteps) * 100);
}

// ---------------------------------------------------------------------------
// Schedule B helpers
// ---------------------------------------------------------------------------

export const SCHEDULE_B_UPLOAD_TMP_ROOT = path.resolve(process.cwd(), ".schedule_b_uploads");
export const SCHEDULE_B_UPLOAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
export const SCHEDULE_B_UPLOAD_CHUNK_BASE64_LIMIT = 320_000;
export const SCHEDULE_B_INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
export const SCHEDULE_B_CHUNK_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

export function sanitizeScheduleBFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) return "schedule-b.pdf";
  return trimmed.replace(SCHEDULE_B_INVALID_FILENAME_CHARS, "_").slice(0, 255);
}

export function normalizeScheduleBDeliveryYears(
  raw: string | null | undefined
): Array<{ label: string; startYear: number; recQuantity: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as Record<string, unknown>;
        const label = typeof candidate.label === "string" ? candidate.label : "";
        const startYear = Number(candidate.startYear);
        const recQuantity = Number(candidate.recQuantity);
        if (!label || !Number.isFinite(startYear) || !Number.isFinite(recQuantity)) {
          return null;
        }
        return {
          label,
          startYear,
          recQuantity,
        };
      })
      .filter((entry): entry is { label: string; startYear: number; recQuantity: number } => Boolean(entry));
  } catch {
    return [];
  }
}

export function parseChunkPointerPayload(payload: string): string[] | null {
  try {
    const parsed = JSON.parse(payload) as { _chunkedDataset?: unknown; chunkKeys?: unknown };
    if (parsed._chunkedDataset !== true) return null;
    if (!Array.isArray(parsed.chunkKeys) || parsed.chunkKeys.length === 0) return null;
    const keys = parsed.chunkKeys.filter(
      (key): key is string =>
        typeof key === "string" && SCHEDULE_B_CHUNK_KEY_PATTERN.test(key)
    );
    return keys.length === parsed.chunkKeys.length ? keys : null;
  } catch {
    return null;
  }
}

export function parseScheduleBRemoteSourceManifest(payload: string): Array<{
  storageKey: string;
  encoding: "utf8" | "base64";
}> | null {
  try {
    const parsed = JSON.parse(payload) as {
      _rawSourcesV1?: unknown;
      version?: unknown;
      sources?: unknown;
    };
    if (parsed._rawSourcesV1 !== true || parsed.version !== 1) return null;
    if (!Array.isArray(parsed.sources)) return null;

    const sources = parsed.sources
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as { storageKey?: unknown; encoding?: unknown };
        if (
          typeof candidate.storageKey !== "string" ||
          !SCHEDULE_B_CHUNK_KEY_PATTERN.test(candidate.storageKey)
        ) {
          return null;
        }
        const encoding =
          candidate.encoding === "base64" || candidate.encoding === "utf8"
            ? candidate.encoding
            : "utf8";
        return {
          storageKey: candidate.storageKey,
          encoding,
        };
      })
      .filter((entry): entry is { storageKey: string; encoding: "utf8" | "base64" } => Boolean(entry));

    return sources;
  } catch {
    return null;
  }
}

export type ParsedRemoteCsvDataset = {
  fileName: string;
  uploadedAt: string;
  headers: string[];
  rows: Array<Record<string, string>>;
};

export function parseCsvText(csvText: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const lines: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < csvText.length; index += 1) {
    const char = csvText[index];
    if (inQuotes) {
      if (char === '"') {
        if (csvText[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && csvText[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      cell = "";
      if (row.some((value) => value.length > 0)) {
        lines.push(row);
      }
      row = [];
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.length > 0)) {
    lines.push(row);
  }

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = lines[0]
    .map((header) => String(header ?? "").trim())
    .filter((header) => header.length > 0);
  if (headers.length === 0) {
    return { headers: [], rows: [] };
  }

  const rows = lines.slice(1).map((line) => {
    const rowObject: Record<string, string> = {};
    headers.forEach((header, headerIndex) => {
      rowObject[header] = String(line[headerIndex] ?? "");
    });
    return rowObject;
  });

  return { headers, rows };
}

export function escapeCsvCell(value: string): string {
  if (/["\r\n,]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildCsvText(headers: string[], rows: Array<Record<string, string>>): string {
  const headerRow = headers.map((header) => escapeCsvCell(header)).join(",");
  const body = rows.map((row) =>
    headers.map((header) => escapeCsvCell(String(row[header] ?? ""))).join(",")
  );
  return [headerRow, ...body].join("\n");
}

export function parseRemoteCsvDataset(payload: string): ParsedRemoteCsvDataset | null {
  try {
    const parsed = JSON.parse(payload) as {
      fileName?: unknown;
      uploadedAt?: unknown;
      headers?: unknown;
      csvText?: unknown;
      rows?: unknown;
    };

    const fileName =
      typeof parsed.fileName === "string" && parsed.fileName.trim().length > 0
        ? parsed.fileName.trim()
        : "Schedule B Import";
    const uploadedAt =
      typeof parsed.uploadedAt === "string" && parsed.uploadedAt.trim().length > 0
        ? parsed.uploadedAt
        : new Date().toISOString();
    const parsedHeaders = Array.isArray(parsed.headers)
      ? parsed.headers.filter((header): header is string => typeof header === "string")
      : [];

    if (typeof parsed.csvText === "string") {
      const parsedCsv = parseCsvText(parsed.csvText);
      return {
        fileName,
        uploadedAt,
        headers: parsedCsv.headers.length > 0 ? parsedCsv.headers : parsedHeaders,
        rows: parsedCsv.rows,
      };
    }

    if (Array.isArray(parsed.rows)) {
      const rowObjects = parsed.rows
        .map((candidate) => {
          if (!candidate || typeof candidate !== "object") return null;
          const row = candidate as Record<string, unknown>;
          return Object.fromEntries(
            Object.entries(row).map(([key, value]) => [key, String(value ?? "")])
          );
        })
        .filter((row): row is Record<string, string> => Boolean(row));
      const headers =
        parsedHeaders.length > 0
          ? parsedHeaders
          : Array.from(
              rowObjects.reduce((set, row) => {
                Object.keys(row).forEach((key) => set.add(key));
                return set;
              }, new Set<string>())
            );
      return {
        fileName,
        uploadedAt,
        headers,
        rows: rowObjects,
      };
    }
  } catch {
    return null;
  }

  return null;
}

export function cleanScheduleBCell(value: unknown): string {
  return String(value ?? "").trim();
}

/** Parse a NON-ID -> Contract-ID mapping text (one pair per line, comma/tab separated). */
export function parseContractIdMappingText(text: string): Map<string, string> {
  const mapping = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const parts = line.split(/[,\t]+/).map((s) => s.trim());
    if (parts.length < 2) continue;
    let gatsId = "";
    let contractId = "";
    for (const part of parts) {
      const cleaned = part.replace(/^["']|["']$/g, "");
      if (!cleaned) continue;
      if (/^[A-Z]{2,5}\d{4,10}$/i.test(cleaned) && !gatsId) {
        gatsId = cleaned.toUpperCase();
      } else if (/^\d{1,5}$/.test(cleaned) && !contractId) {
        contractId = cleaned;
      }
    }
    if (gatsId && contractId) {
      mapping.set(gatsId, contractId);
    }
  }
  return mapping;
}

export const SCHEDULE_B_TRANSFER_UTILITY_TOKENS = ["comed", "ameren", "midamerican"];

export function parseScheduleBNumber(value: unknown): number | null {
  const cleaned = cleanScheduleBCell(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseScheduleBDate(value: unknown): Date | null {
  const raw = cleanScheduleBCell(value);
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const usDateTime = raw.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/
  );
  if (usDateTime) {
    const month = Number(usDateTime[1]) - 1;
    const day = Number(usDateTime[2]);
    const year = Number(usDateTime[3]) < 100 ? 2000 + Number(usDateTime[3]) : Number(usDateTime[3]);
    let hours = usDateTime[4] ? Number(usDateTime[4]) : 0;
    const minutes = usDateTime[5] ? Number(usDateTime[5]) : 0;
    const meridiem = usDateTime[6]?.toUpperCase();

    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;

    const date = new Date(year, month, day, hours, minutes);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

export function buildTransferDeliveryLookup(
  transferRows: Array<Record<string, string>>
): Map<string, Map<number, number>> {
  const lookup = new Map<string, Map<number, number>>();

  for (const row of transferRows) {
    const unitId = cleanScheduleBCell(row["Unit ID"]);
    if (!unitId) continue;

    const quantity = parseScheduleBNumber(row.Quantity) ?? 0;
    if (quantity === 0) continue;

    const transferor = cleanScheduleBCell(row.Transferor).toLowerCase();
    const transferee = cleanScheduleBCell(row.Transferee).toLowerCase();

    const isFromCarbonSolutions = transferor.includes("carbon solutions");
    const isToCarbonSolutions = transferee.includes("carbon solutions");
    const transfereeIsUtility = SCHEDULE_B_TRANSFER_UTILITY_TOKENS.some((token) =>
      transferee.includes(token)
    );
    const transferorIsUtility = SCHEDULE_B_TRANSFER_UTILITY_TOKENS.some((token) =>
      transferor.includes(token)
    );

    let direction = 0;
    if (isFromCarbonSolutions && transfereeIsUtility) direction = 1;
    else if (transferorIsUtility && isToCarbonSolutions) direction = -1;
    else continue;

    const completionDate = parseScheduleBDate(row["Transfer Completion Date"]);
    if (!completionDate) continue;

    const month = completionDate.getMonth();
    const year = completionDate.getFullYear();
    const energyYearStart = month >= 5 ? year : year - 1;

    const lookupKey = unitId.toLowerCase();
    if (!lookup.has(lookupKey)) {
      lookup.set(lookupKey, new Map<number, number>());
    }
    const yearMap = lookup.get(lookupKey)!;
    yearMap.set(
      energyYearStart,
      (yearMap.get(energyYearStart) ?? 0) + quantity * direction
    );
  }

  return lookup;
}

export function findFirstTransferEnergyYear(
  gatsId: string,
  transferDeliveryLookup: Map<string, Map<number, number>>
): number | null {
  const yearMap = transferDeliveryLookup.get(gatsId.toLowerCase());
  if (!yearMap || yearMap.size === 0) return null;

  let earliest: number | null = null;
  yearMap.forEach((quantity, year) => {
    if (quantity > 0 && (earliest === null || year < earliest)) {
      earliest = year;
    }
  });

  return earliest;
}

export function makeDeliveryRowKey(row: Record<string, string>, fallbackPrefix: string, index: number): string {
  const trackingId = cleanScheduleBCell(row.tracking_system_ref_id).toUpperCase();
  if (trackingId) return `tracking:${trackingId}`;
  const designatedSystemId = cleanScheduleBCell(row.designated_system_id);
  if (designatedSystemId) return `designated:${designatedSystemId}`;
  const systemName = cleanScheduleBCell(row.system_name).toLowerCase();
  if (systemName) return `name:${systemName}`;
  return `${fallbackPrefix}:${index}`;
}

export function scheduleRowsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of Array.from(allKeys)) {
    if (String(a[key] ?? "") !== String(b[key] ?? "")) {
      return false;
    }
  }
  return true;
}

export function mergeDeliveryRows(
  existing: Record<string, string>,
  incoming: Record<string, string>
): Record<string, string> {
  const merged = { ...existing, ...incoming };
  const preserveFields = [
    "tracking_system_ref_id",
    "system_name",
    "designated_system_id",
    "utility_contract_number",
  ];

  for (const field of preserveFields) {
    const incomingValue = cleanScheduleBCell(incoming[field]);
    const existingValue = cleanScheduleBCell(existing[field]);
    if (!incomingValue && existingValue) {
      merged[field] = existingValue;
    }
  }

  return merged;
}

export type ScheduleBAdjustedYear = {
  yearNumber: number;
  startYear: number;
  recQuantity: number;
};

export function calculateScheduleBRecForYear(
  acSizeKw: number,
  capacityFactor: number,
  yearNumber: number
): number {
  let unrounded = (acSizeKw / 1000) * capacityFactor * HOURS_PER_YEAR;
  for (let year = 2; year <= yearNumber; year += 1) {
    unrounded *= ANNUAL_DEGRADATION_FACTOR;
  }
  return Math.floor(unrounded);
}

export function buildAdjustedScheduleFromExtraction(
  extraction: {
    deliveryYears: Array<{ startYear: number; recQuantity: number }>;
    acSizeKw: number | null;
    capacityFactor: number | null;
  },
  firstTransferEnergyYear: number | null
): ScheduleBAdjustedYear[] {
  if (!extraction.deliveryYears.length) return [];

  const pdfFirstStartYear = extraction.deliveryYears[0].startYear;
  const firstDeliveryStartYear =
    firstTransferEnergyYear !== null ? firstTransferEnergyYear + 1 : pdfFirstStartYear;
  const offset = Math.max(0, firstDeliveryStartYear - pdfFirstStartYear);
  const result: ScheduleBAdjustedYear[] = [];

  for (let index = 0; index < 15; index += 1) {
    const pdfIndex = offset + index;
    const startYear = firstDeliveryStartYear + index;

    if (pdfIndex < extraction.deliveryYears.length) {
      result.push({
        yearNumber: index + 1,
        startYear,
        recQuantity: extraction.deliveryYears[pdfIndex].recQuantity,
      });
      continue;
    }

    if (extraction.acSizeKw === null || extraction.capacityFactor === null) {
      continue;
    }

    result.push({
      yearNumber: index + 1,
      startYear,
      recQuantity: calculateScheduleBRecForYear(
        extraction.acSizeKw,
        extraction.capacityFactor,
        pdfIndex + 1
      ),
    });
  }

  return result;
}

export function buildScheduleBDeliveryRow(params: {
  fileName: string;
  designatedSystemId: string | null;
  gatsId: string;
  contractId: string;
  adjustedYears: ScheduleBAdjustedYear[];
}): Record<string, string> {
  const row: Record<string, string> = {
    tracking_system_ref_id: params.gatsId,
    system_name: params.designatedSystemId
      ? `App ${params.designatedSystemId}`
      : params.fileName,
    designated_system_id: params.designatedSystemId ?? "",
    utility_contract_number: params.contractId,
  };

  for (let yearIndex = 0; yearIndex < 15; yearIndex += 1) {
    const year = params.adjustedYears[yearIndex];
    row[`year${yearIndex + 1}_quantity_required`] = year ? String(year.recQuantity) : "0";
    row[`year${yearIndex + 1}_start_date`] = year ? `${year.startYear}-06-01` : "";
    row[`year${yearIndex + 1}_end_date`] = year ? `${year.startYear + 1}-05-31` : "";
  }

  return row;
}

// ---------------------------------------------------------------------------
// Supplement bottle scan helper
// ---------------------------------------------------------------------------

export type SupplementBottleScanInput = {
  base64Data: string;
  contentType: "image/png" | "image/jpeg" | "image/webp";
  timing?: "am" | "pm";
  autoLogPrice?: boolean;
};

type SupplementDefinitionRow = NonNullable<
  Awaited<ReturnType<typeof import("../db").getSupplementDefinitionById>>
>;
type SupplementExtraction = Awaited<
  ReturnType<
    typeof import("../services/integrations/supplements").extractSupplementsFromBottleImage
  >
>[number];
type SupplementPriceCheck = Awaited<
  ReturnType<typeof import("../services/integrations/supplements").checkSupplementPrice>
>;

export type SupplementBottleScanResultItem = {
  existed: boolean;
  definitionId: string;
  definition: SupplementDefinitionRow | null;
  extracted: SupplementExtraction;
  priceCheck: SupplementPriceCheck | null;
  priceCheckError: string | null;
  priceLogCreated: boolean;
};

export type SupplementBottleScanResult = {
  success: boolean;
  imageUrl: string;
  results: SupplementBottleScanResultItem[];
  // Legacy top-level fields mirror `results[0]` for mobile clients
  // that were built before multi-extraction landed. Remove once every
  // mobile build is on the new shape.
  existed: boolean;
  definitionId: string;
  definition: SupplementDefinitionRow | null;
  extracted: SupplementExtraction;
  priceCheck: SupplementPriceCheck | null;
  priceCheckError: string | null;
  priceLogCreated: boolean;
};

/**
 * Ensure a matched-or-created supplement definition exists for a
 * single extracted record, returning the ID plus the freshly-loaded
 * row. Does NOT run a price check — that happens in a second pass so
 * price checks can be parallelized.
 */
async function resolveSupplementForExtraction(
  userId: number,
  extracted: SupplementExtraction,
  existingDefinitions: SupplementDefinitionRow[],
  fallbackTiming: "am" | "pm" | undefined
): Promise<{
  definitionId: string;
  existed: boolean;
  definitionRow: SupplementDefinitionRow;
}> {
  const matchedDefinition = findExistingSupplementMatch(
    existingDefinitions,
    extracted.name ?? "",
    extracted.brand
  );

  const defaultDose = toNonEmptyString(extracted.dose) ?? "1";
  const defaultDoseUnit = extracted.doseUnit ?? "capsule";
  const defaultTiming = extracted.timing ?? fallbackTiming ?? "am";

  let definitionId: string;
  const existed = Boolean(matchedDefinition);

  if (matchedDefinition) {
    definitionId = matchedDefinition.id;
    await updateSupplementDefinition(userId, matchedDefinition.id, {
      brand:
        toNonEmptyString(matchedDefinition.brand) ??
        toNonEmptyString(extracted.brand) ??
        null,
      dose: toNonEmptyString(matchedDefinition.dose) ?? defaultDose,
      doseUnit: matchedDefinition.doseUnit ?? defaultDoseUnit,
      dosePerUnit:
        toNonEmptyString(matchedDefinition.dosePerUnit) ??
        toNonEmptyString(extracted.dosePerUnit) ??
        null,
      quantityPerBottle:
        matchedDefinition.quantityPerBottle ?? extracted.quantityPerBottle ?? null,
      timing: matchedDefinition.timing ?? defaultTiming,
    });
  } else {
    const nextSortOrder =
      existingDefinitions.length > 0
        ? Math.max(
            ...existingDefinitions.map((definition) => definition.sortOrder ?? 0)
          ) + 1
        : 0;
    definitionId = nanoid();
    await createSupplementDefinition({
      id: definitionId,
      userId,
      name: extracted.name ?? "Unnamed supplement",
      brand: toNonEmptyString(extracted.brand) ?? null,
      dose: defaultDose,
      doseUnit: defaultDoseUnit,
      dosePerUnit: toNonEmptyString(extracted.dosePerUnit) ?? null,
      productUrl: null,
      pricePerBottle: null,
      quantityPerBottle: extracted.quantityPerBottle ?? null,
      timing: defaultTiming,
      isLocked: false,
      isActive: true,
      sortOrder: nextSortOrder,
    });
  }

  const reloaded = await getSupplementDefinitionById(userId, definitionId);
  const definitionRow = reloaded ?? matchedDefinition;
  if (!definitionRow) {
    throw new Error("Supplement was created but could not be reloaded.");
  }
  return { definitionId, existed, definitionRow };
}

export async function performSupplementBottleScanForUser(
  userId: number,
  input: SupplementBottleScanInput
): Promise<SupplementBottleScanResult> {
  const anthropicIntegration = await getIntegrationByProvider(userId, "anthropic");
  const apiKey = toNonEmptyString(anthropicIntegration?.accessToken);
  if (!apiKey) {
    throw new IntegrationNotConnectedError("Claude");
  }

  const anthropicMeta = parseJsonMetadata(anthropicIntegration?.metadata);
  const model =
    typeof anthropicMeta.model === "string" && anthropicMeta.model.trim().length > 0
      ? anthropicMeta.model.trim()
      : "claude-sonnet-4-20250514";

  const extMap: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
  };
  const ext = extMap[input.contentType] ?? "jpg";
  const imageKey = `supplements/${userId}/bottles/${nanoid()}.${ext}`;
  const imageBuffer = Buffer.from(input.base64Data, "base64");
  const { url: imageUrl } = await storagePut(imageKey, imageBuffer, input.contentType);

  const extractedList = await extractSupplementsFromBottleImage({
    credentials: { apiKey, model },
    base64Image: input.base64Data,
    mimeType: input.contentType,
  });

  if (extractedList.length === 0) {
    throw new Error(
      "Could not read any supplement labels from the photo. Try a clearer image with the front labels visible."
    );
  }

  // Phase 1 — reconcile each extracted item against the DB. Serialized
  // so that if the same image shows two bottles of the same product
  // (unlikely but possible), the second pass sees the first one's
  // insert and merges instead of creating a duplicate.
  const existingDefinitions = (await listSupplementDefinitions(
    userId
  )) as SupplementDefinitionRow[];
  const workingDefinitions: SupplementDefinitionRow[] = [...existingDefinitions];

  const resolved: Array<{
    extracted: SupplementExtraction;
    definitionId: string;
    existed: boolean;
    definitionRow: SupplementDefinitionRow;
  }> = [];

  for (const extracted of extractedList) {
    const outcome = await resolveSupplementForExtraction(
      userId,
      extracted,
      workingDefinitions,
      input.timing
    );
    resolved.push({ extracted, ...outcome });
    // Fold the newly-created/updated row into the working set so the
    // next iteration's match check can see it.
    const idx = workingDefinitions.findIndex(
      (row) => row.id === outcome.definitionRow.id
    );
    if (idx >= 0) {
      workingDefinitions[idx] = outcome.definitionRow;
    } else {
      workingDefinitions.push(outcome.definitionRow);
    }
  }

  // Phase 2 — run price checks in parallel. Claude price lookups hit
  // the web and are the slowest part of the pipeline; serializing them
  // would turn a 10-supplement photo into a minute-long stall.
  const priceCheckOutcomes = await Promise.all(
    resolved.map(async (item) => {
      try {
        const priceCheck = await checkSupplementPrice({
          credentials: { apiKey, model },
          supplementName: item.definitionRow.name,
          brand: toNonEmptyString(item.definitionRow.brand),
          dosePerUnit: toNonEmptyString(item.definitionRow.dosePerUnit),
        });
        return { priceCheck, priceCheckError: null as string | null };
      } catch (error) {
        return {
          priceCheck: null as SupplementPriceCheck | null,
          priceCheckError:
            error instanceof Error ? error.message : "Claude price lookup failed.",
        };
      }
    })
  );

  // Phase 3 — persist price updates + logs. Sequential because each
  // write targets a distinct definition ID and the overhead of a few
  // awaits is nothing next to the Claude round-trips that already ran.
  const results: SupplementBottleScanResultItem[] = [];
  for (let i = 0; i < resolved.length; i++) {
    const item = resolved[i];
    const { priceCheck, priceCheckError } = priceCheckOutcomes[i];
    let priceLogCreated = false;

    if (priceCheck && priceCheck.pricePerBottle !== null) {
      await updateSupplementDefinition(userId, item.definitionId, {
        pricePerBottle: priceCheck.pricePerBottle,
        productUrl: priceCheck.sourceUrl ?? item.definitionRow.productUrl ?? null,
      });

      if (input.autoLogPrice ?? true) {
        await addSupplementPriceLog({
          id: nanoid(),
          userId,
          definitionId: item.definitionId,
          supplementName: item.definitionRow.name,
          brand: item.definitionRow.brand ?? null,
          pricePerBottle: priceCheck.pricePerBottle,
          currency: priceCheck.currency ?? "USD",
          sourceName: priceCheck.sourceName ?? null,
          sourceUrl: priceCheck.sourceUrl ?? null,
          sourceDomain: sourceDomainFromUrl(priceCheck.sourceUrl),
          confidence: priceCheck.confidence,
          imageUrl,
          capturedAt: new Date(),
        });
        priceLogCreated = true;
      }
    }

    const finalDefinition = await getSupplementDefinitionById(
      userId,
      item.definitionId
    );
    results.push({
      existed: item.existed,
      definitionId: item.definitionId,
      definition: finalDefinition,
      extracted: item.extracted,
      priceCheck,
      priceCheckError,
      priceLogCreated,
    });
  }

  const primary = results[0];
  return {
    success: true,
    imageUrl,
    results,
    // Legacy fields — see type definition.
    existed: primary.existed,
    definitionId: primary.definitionId,
    definition: primary.definition,
    extracted: primary.extracted,
    priceCheck: primary.priceCheck,
    priceCheckError: primary.priceCheckError,
    priceLogCreated: primary.priceLogCreated,
  };
}

// ---------------------------------------------------------------------------
// IPv4 helpers (used by Tesla Powerhub)
// ---------------------------------------------------------------------------

export function isValidIpv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

export function extractIpv4FromText(value: string): string | null {
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

export async function fetchTeslaPowerhubServerEgressIpv4(options?: {
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
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
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

// ---------------------------------------------------------------------------
// Tesla Powerhub job types and state
// ---------------------------------------------------------------------------

export type TeslaPowerhubProductionJobStatus = "queued" | "running" | "completed" | "failed";

export type TeslaPowerhubProductionJob = {
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
  jobConfig: {
    groupId: string;
    endpointUrl: string | null;
    signal: string | null;
  } | null;
};

const TESLA_POWERHUB_PRODUCTION_JOB_TTL_MS = JOB_TTL_MS;
export const teslaPowerhubProductionJobs = new Map<string, TeslaPowerhubProductionJob>();
export const teslaPowerhubResumingJobIds = new Set<string>();

// ---------------------------------------------------------------------------
// ABP Settlement job types and state
// ---------------------------------------------------------------------------

export type AbpSettlementContractScanJobStatus = "queued" | "running" | "completed" | "failed";

export type AbpSettlementContractScanJobResultRow = {
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

export type AbpSettlementContractScanJob = {
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

export type AbpSettlementSavedRunSummary = {
  runId: string;
  monthKey: string;
  label: string | null;
  createdAt: string;
  updatedAt: string;
  rowCount: number | null;
};

export type AbpSettlementSavedRun = {
  summary: AbpSettlementSavedRunSummary;
  payload: string;
};

const ABP_SETTLEMENT_JOB_TTL_MS = JOB_TTL_MS;
export const ABP_SETTLEMENT_SCAN_SESSION_REFRESH_INTERVAL = 80;
export const ABP_SETTLEMENT_SCAN_CONCURRENCY = 3;
export const ABP_SETTLEMENT_SCAN_SNAPSHOT_BATCH_SIZE = 10;
export const abpSettlementJobs = new Map<string, AbpSettlementContractScanJob>();
export const abpSettlementActiveScanRunners = new Set<string>();
export const ABP_SETTLEMENT_RUNS_INDEX_DB_KEY = "abpSettlement:runs-index";

export function pruneTeslaPowerhubProductionJobs(nowMs: number): void {
  Array.from(teslaPowerhubProductionJobs.entries()).forEach(([jobId, job]) => {
    // Never prune active jobs from memory.
    if (job.status === "queued" || job.status === "running") return;
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > TESLA_POWERHUB_PRODUCTION_JOB_TTL_MS) {
      teslaPowerhubProductionJobs.delete(jobId);
    }
  });
}

export function pruneAbpSettlementJobs(nowMs: number): void {
  Array.from(abpSettlementJobs.entries()).forEach(([jobId, job]) => {
    const updatedAtMs = Date.parse(job.updatedAt);
    if (!Number.isFinite(updatedAtMs)) return;
    if (nowMs - updatedAtMs > ABP_SETTLEMENT_JOB_TTL_MS) {
      abpSettlementJobs.delete(jobId);
    }
  });
}

// Periodic cleanup every 15 minutes to prevent unbounded map growth
setInterval(() => {
  const now = Date.now();
  pruneTeslaPowerhubProductionJobs(now);
  pruneAbpSettlementJobs(now);
}, 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// ABP Settlement storage helpers
// ---------------------------------------------------------------------------

export function getAbpSettlementRunsIndexObjectKey(userId: number): string {
  return `abp-settlement/${userId}/runs-index.json`;
}

export function getAbpSettlementRunObjectKey(userId: number, runId: string): string {
  return `abp-settlement/${userId}/runs/${runId}.json`;
}

export function getAbpSettlementRunDbKey(runId: string): string {
  return `abpSettlement:run:${runId}`;
}

export function getAbpSettlementScanJobObjectKey(userId: number, jobId: string): string {
  return `abp-settlement/${userId}/scan-jobs/${jobId}.json`;
}

export function getAbpSettlementScanJobDbKey(jobId: string): string {
  return `abpSettlement:scanJob:${jobId}`;
}

export function getTeslaPowerhubProductionJobObjectKey(userId: number, jobId: string): string {
  return `tesla-powerhub/${userId}/production-jobs/${jobId}.json`;
}

export function getTeslaPowerhubProductionJobDbKey(jobId: string): string {
  return `teslaPowerhub:productionJob:${jobId}`;
}

// ---------------------------------------------------------------------------
// Read/write payload with DB+storage fallback
// ---------------------------------------------------------------------------

export async function readPayloadWithFallback(input: {
  userId: number;
  objectKey: string;
  dbStorageKey: string;
}): Promise<string | null> {
  try {
    const payload = await getSolarRecDashboardPayload(input.userId, input.dbStorageKey);
    if (payload) return payload;
  } catch (error) {
    console.warn("[solarRec] DB read failed, falling through to storage:", error instanceof Error ? error.message : error);
  }

  try {
    const { url } = await storageGet(input.objectKey);
    const response = await fetch(url);
    if (!response.ok) return null;
    const payload = await response.text();
    return payload || null;
  } catch (error) {
    console.warn("[storage] Operation failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function writePayloadWithFallback(input: {
  userId: number;
  objectKey: string;
  dbStorageKey: string;
  payload: string;
}): Promise<{ persistedToDatabase: boolean; storageSynced: boolean }> {
  let persistedToDatabase = false;
  try {
    persistedToDatabase = await saveSolarRecDashboardPayload(
      input.userId,
      input.dbStorageKey,
      input.payload
    );
  } catch (error) {
    console.warn("[storage] DB persist failed:", error instanceof Error ? error.message : error);
    persistedToDatabase = false;
  }

  try {
    await storagePut(input.objectKey, input.payload, "application/json");
    return { persistedToDatabase, storageSynced: true };
  } catch (storageError) {
    if (persistedToDatabase) {
      return { persistedToDatabase, storageSynced: false };
    }
    throw storageError;
  }
}

// ---------------------------------------------------------------------------
// ABP Settlement run index helpers
// ---------------------------------------------------------------------------

export function parseAbpSettlementRunsIndex(payload: string | null | undefined): AbpSettlementSavedRunSummary[] {
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
  } catch (error) {
    console.warn("[storage] Failed to list saved runs:", error instanceof Error ? error.message : error);
    return [];
  }
}

export function serializeAbpSettlementRunsIndex(rows: AbpSettlementSavedRunSummary[]): string {
  return JSON.stringify(rows);
}

export async function getAbpSettlementRunsIndex(userId: number): Promise<AbpSettlementSavedRunSummary[]> {
  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getAbpSettlementRunsIndexObjectKey(userId),
    dbStorageKey: ABP_SETTLEMENT_RUNS_INDEX_DB_KEY,
  });
  return parseAbpSettlementRunsIndex(payload);
}

export async function saveAbpSettlementRunsIndex(
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

export async function getAbpSettlementRun(userId: number, runId: string): Promise<AbpSettlementSavedRun | null> {
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

export async function saveAbpSettlementRun(input: {
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

// ---------------------------------------------------------------------------
// Tesla Powerhub job snapshot helpers
// ---------------------------------------------------------------------------

export function parseTeslaPowerhubProductionJobSnapshot(
  payload: string | null | undefined
): TeslaPowerhubProductionJob | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Partial<TeslaPowerhubProductionJob>;
    if (!parsed || typeof parsed !== "object") return null;

    const id = toNonEmptyString(parsed.id);
    const createdAt = toNonEmptyString(parsed.createdAt);
    const updatedAt = toNonEmptyString(parsed.updatedAt);
    const status = toNonEmptyString(parsed.status) as TeslaPowerhubProductionJobStatus | null;
    const userId = typeof parsed.userId === "number" && Number.isFinite(parsed.userId) ? parsed.userId : null;
    if (!id || !createdAt || !updatedAt || !status || userId === null) return null;

    const progress =
      parsed.progress && typeof parsed.progress === "object"
        ? (parsed.progress as Record<string, unknown>)
        : ({} as Record<string, unknown>);
    const currentStep =
      typeof progress.currentStep === "number" && Number.isFinite(progress.currentStep)
        ? Math.max(0, Math.floor(progress.currentStep))
        : 0;
    const totalSteps =
      typeof progress.totalSteps === "number" && Number.isFinite(progress.totalSteps)
        ? Math.max(1, Math.floor(progress.totalSteps))
        : 1;
    const percent =
      typeof progress.percent === "number" && Number.isFinite(progress.percent)
        ? clampPercent(progress.percent)
        : normalizeProgressPercent(currentStep, totalSteps);

    return {
      id,
      userId,
      createdAt,
      updatedAt,
      startedAt: toNonEmptyString(parsed.startedAt),
      finishedAt: toNonEmptyString(parsed.finishedAt),
      status,
      progress: {
        currentStep,
        totalSteps,
        percent,
        message: toNonEmptyString(progress.message) ?? "Queued",
        windowKey: toNonEmptyString(progress.windowKey),
      },
      error: toNonEmptyString(parsed.error),
      result: parsed.result ?? null,
      jobConfig: (() => {
        const cfg = parsed.jobConfig && typeof parsed.jobConfig === "object" ? (parsed.jobConfig as Record<string, unknown>) : null;
        if (!cfg) return null;
        const groupId = toNonEmptyString(cfg.groupId);
        if (!groupId) return null;
        return {
          groupId,
          endpointUrl: toNonEmptyString(cfg.endpointUrl),
          signal: toNonEmptyString(cfg.signal),
        };
      })(),
    };
  } catch (error) {
    console.warn("[storage] Failed to parse Tesla Powerhub job snapshot:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function saveTeslaPowerhubProductionJobSnapshot(job: TeslaPowerhubProductionJob): Promise<void> {
  const payload = JSON.stringify(job);
  await writePayloadWithFallback({
    userId: job.userId,
    objectKey: getTeslaPowerhubProductionJobObjectKey(job.userId, job.id),
    dbStorageKey: getTeslaPowerhubProductionJobDbKey(job.id),
    payload,
  });
}

export async function loadTeslaPowerhubProductionJobSnapshot(
  userId: number,
  jobId: string
): Promise<TeslaPowerhubProductionJob | null> {
  const normalizedJobId = jobId.trim();
  if (!normalizedJobId) return null;

  const payload = await readPayloadWithFallback({
    userId,
    objectKey: getTeslaPowerhubProductionJobObjectKey(userId, normalizedJobId),
    dbStorageKey: getTeslaPowerhubProductionJobDbKey(normalizedJobId),
  });
  const parsed = parseTeslaPowerhubProductionJobSnapshot(payload);
  if (!parsed || parsed.userId !== userId) return null;
  return parsed;
}

/**
 * Launch the async worker that drives a Tesla Powerhub production metrics job.
 * Used both for initial job creation and for auto-resuming interrupted jobs.
 */
export function launchTeslaPowerhubProductionJobWorker(
  jobId: string,
  context: { clientId: string; clientSecret: string; tokenUrl: string | null; apiBaseUrl: string | null; portalBaseUrl: string | null },
  config: { groupId: string; endpointUrl: string | null; signal: string | null }
): void {
  void (async () => {
    let progressUpdatesSinceSnapshot = 0;

    const markJob = async (
      updater: (job: TeslaPowerhubProductionJob) => TeslaPowerhubProductionJob,
      options?: { persist?: boolean }
    ) => {
      const existing = teslaPowerhubProductionJobs.get(jobId);
      if (!existing) return null;
      const nextJob = updater(existing);
      teslaPowerhubProductionJobs.set(jobId, nextJob);

      if (options?.persist) {
        try {
          await saveTeslaPowerhubProductionJobSnapshot(nextJob);
        } catch (error) {
          console.warn(
            "[snapshot] Tesla Powerhub job snapshot write failed:",
            error instanceof Error ? error.message : error
          );
        }
      }

      return nextJob;
    };

    await markJob(
      (job) => ({
        ...job,
        status: "running",
        startedAt: job.startedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        error: null,
        progress: {
          ...job.progress,
          currentStep: 0,
          percent: 0,
          message: "Starting...",
          windowKey: null,
        },
      }),
      { persist: true }
    );

    try {
      const result = await getTeslaPowerhubGroupProductionMetrics(
        {
          clientId: context.clientId,
          clientSecret: context.clientSecret,
          tokenUrl: context.tokenUrl,
          apiBaseUrl: context.apiBaseUrl,
          portalBaseUrl: context.portalBaseUrl,
        },
        {
          groupId: config.groupId,
          endpointUrl: config.endpointUrl,
          signal: config.signal,
          onProgress: (progress) => {
            progressUpdatesSinceSnapshot += 1;
            const shouldPersist = progressUpdatesSinceSnapshot >= 25;
            if (shouldPersist) {
              progressUpdatesSinceSnapshot = 0;
            }

            void markJob(
              (job) => {
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
              },
              { persist: shouldPersist }
            );
          },
        }
      );

      await markJob(
        (job) => ({
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
          error: error instanceof Error ? error.message : "Unknown job error.",
          result: null,
          progress: {
            ...job.progress,
            message: "Failed",
            windowKey: null,
          },
        }),
        { persist: true }
      );
    } finally {
      teslaPowerhubResumingJobIds.delete(jobId);
    }
  })();
}

// ---------------------------------------------------------------------------
// ABP Settlement scan job helpers
// ---------------------------------------------------------------------------

export function parseAbpSettlementScanJobSnapshot(
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
  } catch (error) {
    console.warn("[storage] Operation failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function saveAbpSettlementScanJobSnapshot(job: AbpSettlementContractScanJob): Promise<void> {
  const payload = JSON.stringify(job);
  await writePayloadWithFallback({
    userId: job.userId,
    objectKey: getAbpSettlementScanJobObjectKey(job.userId, job.id),
    dbStorageKey: getAbpSettlementScanJobDbKey(job.id),
    payload,
  });
}

export async function loadAbpSettlementScanJobSnapshot(
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

export async function runAbpSettlementContractScanJob(jobId: string): Promise<void> {
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
      } catch (error) {
        console.warn("[snapshot] Best-effort snapshot write failed:", error instanceof Error ? error.message : error);
      }
    }
    return nextJob;
  };

  try {
    const currentJob = abpSettlementJobs.get(normalizedJobId);
    if (!currentJob) return;

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

    // -- Session refresh mutex --
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

    // -- Snapshot batching --
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

    // -- Process a single contract --
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
        } catch (refreshErr) {
          console.warn(`[contractScan] Session refresh failed for ${csgId}:`, refreshErr instanceof Error ? refreshErr.message : refreshErr);
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

      // Append result (synchronized -- JS is single-threaded between awaits)
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

    // -- Run concurrent workers --
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

// ---------------------------------------------------------------------------
// Provider metadata types, parsers, serializers
// ---------------------------------------------------------------------------

export function parseEnphaseV2Metadata(metadata: string | null | undefined): {
  userId: string | null;
  baseUrl: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    userId: toNonEmptyString(parsed.userId),
    baseUrl: toNonEmptyString(parsed.baseUrl),
  };
}

export function parseEnphaseV4Metadata(metadata: string | null | undefined): {
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

export function parseZendeskMetadata(metadata: string | null | undefined): {
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

export function parseTeslaSolarMetadata(metadata: string | null | undefined): {
  baseUrl: string | null;
} {
  const parsed = parseJsonMetadata(metadata);
  return {
    baseUrl: toNonEmptyString(parsed.baseUrl),
  };
}

export type EgaugeAccessType = "public" | "user_login" | "site_login" | "portfolio_login";

export function normalizeEgaugeAccessType(value: unknown): EgaugeAccessType {
  if (value === "user_login" || value === "site_login" || value === "portfolio_login" || value === "public") return value;
  return "public";
}

export type EgaugeConnectionConfig = {
  id: string;
  name: string;
  meterId: string;
  baseUrl: string;
  accessType: EgaugeAccessType;
  username: string | null;
  password: string | null;
  createdAt: string;
  updatedAt: string;
};

export function deriveEgaugeMeterId(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.toLowerCase();
    const firstLabel = host.split(".")[0]?.trim();
    return firstLabel && firstLabel.length > 0 ? firstLabel : host;
  } catch {
    const normalized = baseUrl
      .replace(/^https?:\/\//i, "")
      .split(/[/?#]/)[0]
      .trim()
      .toLowerCase();
    return normalized.split(".")[0] || normalized || "egauge-meter";
  }
}

export function parseEgaugeMetadata(
  metadata: string | null | undefined,
  fallbackPassword?: string | null
): {
  activeConnectionId: string | null;
  connections: EgaugeConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];

  const connections: EgaugeConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `egauge-conn-${index + 1}`;
      const baseUrl = toNonEmptyString(row.baseUrl);
      if (!baseUrl) return null;

      const accessType = normalizeEgaugeAccessType(row.accessType);
      const createdAt = toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      const username = toNonEmptyString(row.username);
      const password = toNonEmptyString(row.password);
      const meterId =
        toNonEmptyString(row.meterId)?.toLowerCase() ?? deriveEgaugeMeterId(baseUrl).toLowerCase();

      return {
        id,
        name: toNonEmptyString(row.name) ?? `eGauge ${index + 1}`,
        meterId,
        baseUrl,
        accessType,
        username,
        password,
        createdAt,
        updatedAt,
      } satisfies EgaugeConnectionConfig;
    })
    .filter((value): value is EgaugeConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyBaseUrl = toNonEmptyString(parsed.baseUrl);
    if (legacyBaseUrl) {
      const nowIso = new Date().toISOString();
      const legacyAccessType = normalizeEgaugeAccessType(parsed.accessType);
      const legacyUsername = toNonEmptyString(parsed.username);
      const legacyPassword = toNonEmptyString(fallbackPassword);

      connections.push({
        id: "legacy-egauge-connection",
        name: "Legacy eGauge Connection",
        meterId: deriveEgaugeMeterId(legacyBaseUrl).toLowerCase(),
        baseUrl: legacyBaseUrl,
        accessType: legacyAccessType,
        username: legacyUsername,
        password: legacyPassword,
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
    activeConnectionId,
    connections,
  };
}

export function serializeEgaugeMetadata(
  connections: EgaugeConnectionConfig[],
  activeConnectionId: string | null
): string {
  return JSON.stringify({
    activeConnectionId,
    connections,
  });
}

export function parseTeslaPowerhubMetadata(metadata: string | null | undefined): {
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

export function parseClockifyMetadata(metadata: string | null | undefined): {
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

export function parseCsgPortalMetadata(metadata: string | null | undefined): {
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

export function serializeCsgPortalMetadata(metadata: {
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

export function serializeZendeskMetadata(metadata: {
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

export type SolarEdgeConnectionConfig = {
  id: string;
  name: string;
  apiKey: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseSolarEdgeMetadata(
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

export function serializeSolarEdgeMetadata(
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

export type EnnexOsConnectionConfig = {
  id: string;
  name: string;
  accessToken: string;
  baseUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

export function parseEnnexOsMetadata(
  metadata: string | null | undefined,
  fallbackAccessToken?: string | null
): {
  baseUrl: string | null;
  activeConnectionId: string | null;
  connections: EnnexOsConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: EnnexOsConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `ennexos-conn-${index + 1}`;
      const accessToken = toNonEmptyString(row.accessToken);
      if (!accessToken) return null;
      const createdAt = toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `ennexOS API ${index + 1}`,
        accessToken,
        baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl,
        createdAt,
        updatedAt,
      } satisfies EnnexOsConnectionConfig;
    })
    .filter((value): value is EnnexOsConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyAccessToken = toNonEmptyString(fallbackAccessToken);
    if (legacyAccessToken) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-ennexos-token",
        name: "Legacy Access Token",
        accessToken: legacyAccessToken,
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

export function serializeEnnexOsMetadata(
  connections: EnnexOsConnectionConfig[],
  activeConnectionId: string | null,
  baseUrl: string | null
): string {
  return JSON.stringify({
    baseUrl,
    activeConnectionId,
    connections,
  });
}

export type FroniusConnectionConfig = {
  id: string;
  name: string;
  accessKeyId: string;
  accessKeyValue: string;
  createdAt: string;
  updatedAt: string;
};

export function parseFroniusMetadata(
  metadata: string | null | undefined,
  fallbackAccessKeyId?: string | null
): {
  activeConnectionId: string | null;
  connections: FroniusConnectionConfig[];
} {
  const parsed = parseJsonMetadata(metadata);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: FroniusConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `fronius-conn-${index + 1}`;
      const accessKeyId = toNonEmptyString(row.accessKeyId);
      const accessKeyValue = toNonEmptyString(row.accessKeyValue);
      if (!accessKeyId || !accessKeyValue) return null;
      const createdAt = toNonEmptyString(row.createdAt) ?? new Date().toISOString();
      const updatedAt = toNonEmptyString(row.updatedAt) ?? createdAt;
      return {
        id,
        name: toNonEmptyString(row.name) ?? `Fronius API ${index + 1}`,
        accessKeyId,
        accessKeyValue,
        createdAt,
        updatedAt,
      } satisfies FroniusConnectionConfig;
    })
    .filter((value): value is FroniusConnectionConfig => value !== null);

  if (connections.length === 0) {
    const legacyKeyId = toNonEmptyString(fallbackAccessKeyId);
    if (legacyKeyId) {
      const nowIso = new Date().toISOString();
      connections.push({
        id: "legacy-fronius-key",
        name: "Legacy Access Key",
        accessKeyId: legacyKeyId,
        accessKeyValue: "",
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }
  }

  const activeConnectionId =
    (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw)
      ? activeConnectionIdRaw
      : connections[0]?.id) ?? null;

  return { activeConnectionId, connections };
}

export function serializeFroniusMetadata(
  connections: FroniusConnectionConfig[],
  activeConnectionId: string | null
): string {
  return JSON.stringify({ activeConnectionId, connections });
}

// ---------------------------------------------------------------------------
// Solar cloud connection configs (Solis, GoodWe, Generac, Locus, Growatt,
// APsystems, EKM, Hoymiles, SolarLog)
// ---------------------------------------------------------------------------

export type SolisConnectionConfig = { id: string; name: string; apiKey: string; apiSecret: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseSolisMetadata(metadata: string | null | undefined, fallbackApiKey?: string | null): { baseUrl: string | null; activeConnectionId: string | null; connections: SolisConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: SolisConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `solis-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      const apiSecret = toNonEmptyString(row.apiSecret);
      if (!apiKey || !apiSecret) return null;
      return { id, name: toNonEmptyString(row.name) ?? `Solis API ${index + 1}`, apiKey, apiSecret, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies SolisConnectionConfig;
    })
    .filter((v): v is SolisConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) { const legacyKey = toNonEmptyString(fallbackApiKey); if (legacyKey) { const nowIso = new Date().toISOString(); connections.push({ id: "legacy-solis-key", name: "Legacy API Key", apiKey: legacyKey, apiSecret: "", baseUrl, createdAt: nowIso, updatedAt: nowIso }); } }
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeSolisMetadata(connections: SolisConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type GoodWeConnectionConfig = { id: string; name: string; account: string; password: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseGoodWeMetadata(metadata: string | null | undefined): { baseUrl: string | null; activeConnectionId: string | null; connections: GoodWeConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: GoodWeConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `goodwe-conn-${index + 1}`;
      const account = toNonEmptyString(row.account);
      const password = toNonEmptyString(row.password);
      if (!account || !password) return null;
      return { id, name: toNonEmptyString(row.name) ?? `GoodWe ${index + 1}`, account, password, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies GoodWeConnectionConfig;
    })
    .filter((v): v is GoodWeConnectionConfig => v !== null);
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeGoodWeMetadata(connections: GoodWeConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type GeneracConnectionConfig = { id: string; name: string; apiKey: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseGeneracMetadata(metadata: string | null | undefined, fallbackApiKey?: string | null): { baseUrl: string | null; activeConnectionId: string | null; connections: GeneracConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: GeneracConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `generac-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      if (!apiKey) return null;
      return { id, name: toNonEmptyString(row.name) ?? `Generac API ${index + 1}`, apiKey, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies GeneracConnectionConfig;
    })
    .filter((v): v is GeneracConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) { const legacyKey = toNonEmptyString(fallbackApiKey); if (legacyKey) { const nowIso = new Date().toISOString(); connections.push({ id: "legacy-generac-key", name: "Legacy API Key", apiKey: legacyKey, baseUrl, createdAt: nowIso, updatedAt: nowIso }); } }
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeGeneracMetadata(connections: GeneracConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type LocusConnectionConfig = { id: string; name: string; clientId: string; clientSecret: string; partnerId: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseLocusMetadata(metadata: string | null | undefined): { baseUrl: string | null; activeConnectionId: string | null; connections: LocusConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: LocusConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `locus-conn-${index + 1}`;
      const clientId = toNonEmptyString(row.clientId);
      const clientSecret = toNonEmptyString(row.clientSecret);
      const partnerId = toNonEmptyString(row.partnerId);
      if (!clientId || !clientSecret || !partnerId) return null;
      return { id, name: toNonEmptyString(row.name) ?? `Locus API ${index + 1}`, clientId, clientSecret, partnerId, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies LocusConnectionConfig;
    })
    .filter((v): v is LocusConnectionConfig => v !== null);
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeLocusMetadata(connections: LocusConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type GrowattConnectionConfig = { id: string; name: string; username: string; password: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseGrowattMetadata(metadata: string | null | undefined): { baseUrl: string | null; activeConnectionId: string | null; connections: GrowattConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: GrowattConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `growatt-conn-${index + 1}`;
      const username = toNonEmptyString(row.username);
      const password = toNonEmptyString(row.password);
      if (!username || !password) return null;
      return { id, name: toNonEmptyString(row.name) ?? `Growatt ${index + 1}`, username, password, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies GrowattConnectionConfig;
    })
    .filter((v): v is GrowattConnectionConfig => v !== null);
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeGrowattMetadata(connections: GrowattConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type APsystemsConnectionConfig = { id: string; name: string; appId: string; appSecret: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseAPsystemsMetadata(metadata: string | null | undefined, fallbackApiKey?: string | null): { baseUrl: string | null; activeConnectionId: string | null; connections: APsystemsConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: APsystemsConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `apsystems-conn-${index + 1}`;
      const appId = toNonEmptyString(row.appId) ?? toNonEmptyString(row.apiKey);
      const appSecret = toNonEmptyString(row.appSecret) ?? "";
      if (!appId) return null;
      return { id, name: toNonEmptyString(row.name) ?? `APsystems API ${index + 1}`, appId, appSecret, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies APsystemsConnectionConfig;
    })
    .filter((v): v is APsystemsConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) { const legacyKey = toNonEmptyString(fallbackApiKey); if (legacyKey) { const nowIso = new Date().toISOString(); connections.push({ id: "legacy-apsystems-key", name: "Legacy API Key", appId: legacyKey, appSecret: "", baseUrl, createdAt: nowIso, updatedAt: nowIso }); } }
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeAPsystemsMetadata(connections: APsystemsConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type EkmConnectionConfig = { id: string; name: string; apiKey: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseEkmMetadata(metadata: string | null | undefined, fallbackApiKey?: string | null): { baseUrl: string | null; activeConnectionId: string | null; connections: EkmConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: EkmConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `ekm-conn-${index + 1}`;
      const apiKey = toNonEmptyString(row.apiKey);
      if (!apiKey) return null;
      return { id, name: toNonEmptyString(row.name) ?? `EKM API ${index + 1}`, apiKey, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies EkmConnectionConfig;
    })
    .filter((v): v is EkmConnectionConfig => v !== null);
  if (connections.length === 0 && fallbackApiKey) { const legacyKey = toNonEmptyString(fallbackApiKey); if (legacyKey) { const nowIso = new Date().toISOString(); connections.push({ id: "legacy-ekm-key", name: "Legacy API Key", apiKey: legacyKey, baseUrl, createdAt: nowIso, updatedAt: nowIso }); } }
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeEkmMetadata(connections: EkmConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type HoymilesConnectionConfig = { id: string; name: string; username: string; password: string; baseUrl: string | null; createdAt: string; updatedAt: string };

export function parseHoymilesMetadata(metadata: string | null | undefined): { baseUrl: string | null; activeConnectionId: string | null; connections: HoymilesConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const baseUrl = toNonEmptyString(parsed.baseUrl);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: HoymilesConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `hoymiles-conn-${index + 1}`;
      const username = toNonEmptyString(row.username);
      const password = toNonEmptyString(row.password);
      if (!username || !password) return null;
      return { id, name: toNonEmptyString(row.name) ?? `Hoymiles ${index + 1}`, username, password, baseUrl: toNonEmptyString(row.baseUrl) ?? baseUrl, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies HoymilesConnectionConfig;
    })
    .filter((v): v is HoymilesConnectionConfig => v !== null);
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { baseUrl, activeConnectionId, connections };
}

export function serializeHoymilesMetadata(connections: HoymilesConnectionConfig[], activeConnectionId: string | null, baseUrl: string | null): string { return JSON.stringify({ baseUrl, activeConnectionId, connections }); }

export type SolarLogConnectionConfig = { id: string; name: string; baseUrl: string; password: string | null; createdAt: string; updatedAt: string };

export function parseSolarLogMetadata(metadata: string | null | undefined): { activeConnectionId: string | null; connections: SolarLogConnectionConfig[] } {
  const parsed = parseJsonMetadata(metadata);
  const activeConnectionIdRaw = toNonEmptyString(parsed.activeConnectionId);
  const parsedConnections = Array.isArray(parsed.connections) ? parsed.connections : [];
  const connections: SolarLogConnectionConfig[] = parsedConnections
    .map((value, index) => {
      const row = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      const id = toNonEmptyString(row.id) ?? `solarlog-conn-${index + 1}`;
      const baseUrl = toNonEmptyString(row.baseUrl);
      if (!baseUrl) return null;
      return { id, name: toNonEmptyString(row.name) ?? `Solar-Log ${index + 1}`, baseUrl, password: toNonEmptyString(row.password) ?? null, createdAt: toNonEmptyString(row.createdAt) ?? new Date().toISOString(), updatedAt: toNonEmptyString(row.updatedAt) ?? new Date().toISOString() } satisfies SolarLogConnectionConfig;
    })
    .filter((v): v is SolarLogConnectionConfig => v !== null);
  const activeConnectionId = (activeConnectionIdRaw && connections.some((c) => c.id === activeConnectionIdRaw) ? activeConnectionIdRaw : connections[0]?.id) ?? null;
  return { activeConnectionId, connections };
}

export function serializeSolarLogMetadata(connections: SolarLogConnectionConfig[], activeConnectionId: string | null): string { return JSON.stringify({ activeConnectionId, connections }); }

// ---------------------------------------------------------------------------
// getXxxContext helper functions
// ---------------------------------------------------------------------------

export async function getFroniusContext(userId: number): Promise<{ accessKeyId: string; accessKeyValue: string }> {
  const integration = await getIntegrationByProvider(userId, FRONIUS_PROVIDER);
  const metadata = parseFroniusMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Fronius");
  return { accessKeyId: activeConnection.accessKeyId, accessKeyValue: activeConnection.accessKeyValue };
}

export async function getEnnexOsContext(userId: number): Promise<{ accessToken: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, ENNEX_OS_PROVIDER);
  const metadata = parseEnnexOsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("ennexOS");
  return { accessToken: activeConnection.accessToken, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getEnphaseV2Credentials(userId: number): Promise<{ apiKey: string; userId: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, ENPHASE_V2_PROVIDER);
  const apiKey = toNonEmptyString(integration?.accessToken);
  const metadata = parseEnphaseV2Metadata(integration?.metadata);
  if (!apiKey || !metadata.userId) throw new IntegrationNotConnectedError("Enphase v2");
  return { apiKey, userId: metadata.userId, baseUrl: metadata.baseUrl };
}

export async function getEnphaseV4Context(userId: number): Promise<{ accessToken: string; apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, ENPHASE_V4_PROVIDER);
  if (!integration?.accessToken) throw new IntegrationNotConnectedError("Enphase v4");
  const metadata = parseEnphaseV4Metadata(integration.metadata);
  if (!metadata.apiKey || !metadata.clientId || !metadata.clientSecret) throw new Error("Enphase v4 connection is incomplete. Reconnect with API key + client credentials.");
  const now = Date.now();
  const expiresAt = integration.expiresAt ? new Date(integration.expiresAt).getTime() : null;
  const needsRefresh = !expiresAt || expiresAt - now < 5 * 60 * 1000;
  let accessToken = integration.accessToken;
  if (needsRefresh) {
    if (!integration.refreshToken) throw new Error("Enphase token expired and no refresh token is available. Reconnect first.");
    const refreshed = await refreshEnphaseV4AccessToken({ clientId: metadata.clientId, clientSecret: metadata.clientSecret, refreshToken: integration.refreshToken });
    accessToken = refreshed.access_token;
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
    await upsertIntegration({ ...integration, accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token || integration.refreshToken, expiresAt: newExpiresAt, scope: refreshed.scope || integration.scope });
  }
  return { accessToken, apiKey: metadata.apiKey, baseUrl: metadata.baseUrl };
}

export async function getSolarEdgeContext(userId: number): Promise<{ apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, SOLAR_EDGE_PROVIDER);
  const metadata = parseSolarEdgeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("SolarEdge");
  return { apiKey: activeConnection.apiKey, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getZendeskContext(userId: number): Promise<{ subdomain: string; email: string; apiToken: string }> {
  const integration = await getIntegrationByProvider(userId, ZENDESK_PROVIDER);
  const apiToken = toNonEmptyString(integration?.accessToken);
  const metadata = parseZendeskMetadata(integration?.metadata);
  if (!apiToken || !metadata.subdomain || !metadata.email) throw new IntegrationNotConnectedError("Zendesk");
  return { subdomain: metadata.subdomain, email: metadata.email, apiToken };
}

export async function getTeslaSolarContext(userId: number): Promise<{ accessToken: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, TESLA_SOLAR_PROVIDER);
  const accessToken = toNonEmptyString(integration?.accessToken);
  const metadata = parseTeslaSolarMetadata(integration?.metadata);
  if (!accessToken) throw new IntegrationNotConnectedError("Tesla Solar");
  return { accessToken, baseUrl: metadata.baseUrl };
}

export async function getEgaugeContext(userId: number): Promise<{ baseUrl: string; accessType: EgaugeAccessType; username: string | null; password: string | null }> {
  const integration = await getIntegrationByProvider(userId, EGAUGE_PROVIDER);
  const metadata = parseEgaugeMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((connection) => connection.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("eGauge");
  const requiresCredentials = activeConnection.accessType !== "public";
  if (requiresCredentials && (!activeConnection.username || !activeConnection.password)) throw new Error("eGauge login is incomplete for the active profile. Save username and password.");
  return { baseUrl: activeConnection.baseUrl, accessType: activeConnection.accessType, username: activeConnection.username, password: activeConnection.password };
}

export async function getTeslaPowerhubContext(userId: number): Promise<{ clientId: string; clientSecret: string; tokenUrl: string | null; apiBaseUrl: string | null; portalBaseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, TESLA_POWERHUB_PROVIDER);
  const clientSecret = toNonEmptyString(integration?.accessToken);
  const metadata = parseTeslaPowerhubMetadata(integration?.metadata);
  if (!clientSecret || !metadata.clientId) throw new IntegrationNotConnectedError("Tesla Powerhub");
  return { clientId: metadata.clientId, clientSecret, tokenUrl: metadata.tokenUrl, apiBaseUrl: metadata.apiBaseUrl, portalBaseUrl: metadata.portalBaseUrl };
}

export async function getClockifyContext(userId: number): Promise<{ apiKey: string; workspaceId: string; workspaceName: string | null; clockifyUserId: string; userName: string | null; userEmail: string | null }> {
  const integration = await getIntegrationByProvider(userId, CLOCKIFY_PROVIDER);
  const apiKey = toNonEmptyString(integration?.accessToken);
  const metadata = parseClockifyMetadata(integration?.metadata);
  if (!apiKey) throw new IntegrationNotConnectedError("Clockify");
  if (!metadata.workspaceId || !metadata.userId) throw new Error("Clockify setup is incomplete. Reconnect Clockify from Settings.");
  return { apiKey, workspaceId: metadata.workspaceId, workspaceName: metadata.workspaceName, clockifyUserId: metadata.userId, userName: metadata.userName, userEmail: metadata.userEmail };
}

export async function getCsgPortalContext(userId: number): Promise<{ email: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, CSG_PORTAL_PROVIDER);
  const password = toNonEmptyString(integration?.accessToken);
  const metadata = parseCsgPortalMetadata(integration?.metadata);
  if (!password || !metadata.email) throw new IntegrationNotConnectedError("CSG Portal");
  return { email: metadata.email, password, baseUrl: metadata.baseUrl };
}

export async function getSolisContext(userId: number): Promise<{ apiKey: string; apiSecret: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, SOLIS_PROVIDER);
  const metadata = parseSolisMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Solis");
  return { apiKey: activeConnection.apiKey, apiSecret: activeConnection.apiSecret, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getGoodWeContext(userId: number): Promise<{ account: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, GOODWE_PROVIDER);
  const metadata = parseGoodWeMetadata(integration?.metadata);
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("GoodWe");
  return { account: activeConnection.account, password: activeConnection.password, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getGeneracContext(userId: number): Promise<{ apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, GENERAC_PROVIDER);
  const metadata = parseGeneracMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Generac");
  return { apiKey: activeConnection.apiKey, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getLocusContext(userId: number): Promise<{ clientId: string; clientSecret: string; partnerId: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, LOCUS_PROVIDER);
  const metadata = parseLocusMetadata(integration?.metadata);
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Locus Energy");
  return { clientId: activeConnection.clientId, clientSecret: activeConnection.clientSecret, partnerId: activeConnection.partnerId, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getGrowattContext(userId: number): Promise<{ username: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, GROWATT_PROVIDER);
  const metadata = parseGrowattMetadata(integration?.metadata);
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Growatt");
  return { username: activeConnection.username, password: activeConnection.password, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getAPsystemsContext(userId: number): Promise<{ appId: string; appSecret: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, APSYSTEMS_PROVIDER);
  const metadata = parseAPsystemsMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("APsystems");
  if (!activeConnection.appSecret) throw new Error("APsystems App Secret is missing. Please reconnect with both App ID and App Secret.");
  return { appId: activeConnection.appId, appSecret: activeConnection.appSecret, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getEkmContext(userId: number): Promise<{ apiKey: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, EKM_PROVIDER);
  const metadata = parseEkmMetadata(integration?.metadata, toNonEmptyString(integration?.accessToken));
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("EKM");
  return { apiKey: activeConnection.apiKey, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getHoymilesContext(userId: number): Promise<{ username: string; password: string; baseUrl: string | null }> {
  const integration = await getIntegrationByProvider(userId, HOYMILES_PROVIDER);
  const metadata = parseHoymilesMetadata(integration?.metadata);
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Hoymiles");
  return { username: activeConnection.username, password: activeConnection.password, baseUrl: activeConnection.baseUrl ?? metadata.baseUrl };
}

export async function getSolarLogContext(userId: number): Promise<{ baseUrl: string; password: string | null }> {
  const integration = await getIntegrationByProvider(userId, SOLAR_LOG_PROVIDER);
  const metadata = parseSolarLogMetadata(integration?.metadata);
  const activeConnection = metadata.connections.find((c) => c.id === metadata.activeConnectionId) ?? metadata.connections[0];
  if (!activeConnection) throw new IntegrationNotConnectedError("Solar-Log");
  return { baseUrl: activeConnection.baseUrl, password: activeConnection.password };
}
