import path from "node:path";
import {
  HOURS_PER_YEAR,
  ANNUAL_DEGRADATION_FACTOR,
} from "../../constants";

// ---------------------------------------------------------------------------
// Schedule B helpers
// ---------------------------------------------------------------------------

export const SCHEDULE_B_UPLOAD_TMP_ROOT = path.resolve(process.cwd(), ".schedule_b_uploads");
export const SCHEDULE_B_UPLOAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
export const SCHEDULE_B_UPLOAD_CHUNK_BASE64_LIMIT = 320_000;

// Phase 1 (server-side dashboard refactor) — sibling temp root for
// dataset-upload jobs. Same shape as the Schedule B path so the
// existing operational tooling (cleanup crons, disk-usage probes)
// can target both.
export const DATASET_UPLOAD_TMP_ROOT = path.resolve(
  process.cwd(),
  ".dataset_uploads"
);
export const DATASET_UPLOAD_ID_PATTERN = /^[a-zA-Z0-9_-]{8,128}$/;
export const DATASET_UPLOAD_CHUNK_BASE64_LIMIT = 320_000;
const SCHEDULE_B_INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const SCHEDULE_B_CHUNK_KEY_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

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

function escapeCsvCell(value: string): string {
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

/**
 * Load and decode the `deliveryScheduleBase` dataset into a canonical
 * `ParsedRemoteCsvDataset`. Consolidates the three payload shapes
 * callers have to handle:
 *   1. Chunk-pointer (payload is a list of chunk keys to concatenate)
 *   2. Source-manifest (payload lists uploaded source files; we decode
 *      the latest one, honoring base64 encoding)
 *   3. Flat remote CSV (payload is the dataset directly)
 *
 * Takes `loadPayload` as a dependency so this helper stays free of
 * `server/db` coupling — callers pass in
 * `(key) => getSolarRecDashboardPayload(userId, \`dataset:${key}\`)`.
 *
 * Returns an empty-but-shaped dataset when the key is missing so
 * callers can iterate `.rows` unconditionally.
 */
export async function loadDeliveryScheduleBaseDataset(
  loadPayload: (key: string) => Promise<string | null>,
): Promise<ParsedRemoteCsvDataset> {
  const empty: ParsedRemoteCsvDataset = {
    fileName: "Schedule B Import",
    uploadedAt: new Date().toISOString(),
    headers: [],
    rows: [],
  };

  const resolveKey = async (key: string): Promise<string | null> => {
    const basePayload = await loadPayload(key);
    if (!basePayload) return null;

    const chunkKeys = parseChunkPointerPayload(basePayload);
    if (!chunkKeys || chunkKeys.length === 0) {
      return basePayload;
    }

    let merged = "";
    for (const chunkKey of chunkKeys) {
      const chunk = await loadPayload(chunkKey);
      if (typeof chunk !== "string") return null;
      merged += chunk;
    }
    return merged;
  };

  const existingPayload = await resolveKey("deliveryScheduleBase");
  if (!existingPayload) return empty;

  const sourceManifest = parseScheduleBRemoteSourceManifest(existingPayload);
  if (sourceManifest && sourceManifest.length > 0) {
    const latestSource = sourceManifest[sourceManifest.length - 1];
    const sourcePayload = await resolveKey(latestSource.storageKey);
    if (!sourcePayload) return empty;
    const decoded =
      latestSource.encoding === "base64"
        ? Buffer.from(sourcePayload, "base64").toString("utf8")
        : sourcePayload;
    const parsedCsv = parseCsvText(decoded);
    return {
      fileName: "Schedule B Import",
      uploadedAt: new Date().toISOString(),
      headers: parsedCsv.headers,
      rows: parsedCsv.rows,
    };
  }

  const parsed = parseRemoteCsvDataset(existingPayload);
  return parsed ?? empty;
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

const SCHEDULE_B_TRANSFER_UTILITY_TOKENS = ["comed", "ameren", "midamerican"];

function parseScheduleBNumber(value: unknown): number | null {
  const cleaned = cleanScheduleBCell(value).replace(/[$,%\s]/g, "").replaceAll(",", "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseScheduleBDate(value: unknown): Date | null {
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
