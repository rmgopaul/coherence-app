export const SOLAR_EDGE_DEFAULT_BASE_URL = "https://monitoringapi.solaredge.com/v2";

export type SolarEdgeApiContext = {
  apiKey: string;
  baseUrl?: string | null;
};

export type SolarEdgeSite = {
  siteId: string;
  siteName: string;
  status: string | null;
  peakPowerW: number | null;
  timezone: string | null;
  location: string | null;
};

export type SolarEdgeInverterInventory = {
  serialNumber: string;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  status: string | null;
};

export type SolarEdgeInverterProductionRow = {
  serialNumber: string;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  status: string | null;
  endpoint: string | null;
  telemetryCount: number;
  firstTelemetryAt: string | null;
  lastTelemetryAt: string | null;
  latestPowerW: number | null;
  latestEnergyWh: number | null;
  error: string | null;
  telemetries: Array<Record<string, unknown>>;
};

export type SolarEdgeInverterProductionResult = {
  siteId: string;
  startDate: string | null;
  endDate: string | null;
  inventoryCount: number;
  successfulInverters: number;
  failedInverters: number;
  inverters: SolarEdgeInverterProductionRow[];
};

export type SolarEdgeMeterSnapshot = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  meterCount: number | null;
  productionMeterCount: number | null;
  consumptionMeterCount: number | null;
  meterTypes: string[];
  error: string | null;
};

export type SolarEdgeInverterSnapshot = {
  siteId: string;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  inverterCount: number | null;
  invertersWithTelemetry: number | null;
  inverterFailures: number | null;
  totalLatestPowerW: number | null;
  totalLatestEnergyWh: number | null;
  firstTelemetryAt: string | null;
  lastTelemetryAt: string | null;
  error: string | null;
};

export type SolarEdgeProductionSnapshot = {
  siteId: string;
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
  anchorDate: string;
  monthlyStartDate: string;
  weeklyStartDate: string;
  mtdStartDate: string;
  previousCalendarMonthStartDate: string;
  previousCalendarMonthEndDate: string;
  last12MonthsStartDate: string;
  error: string | null;
};

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
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

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((row) => asRecord(row));
}

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return SOLAR_EDGE_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
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

function asDateKey(value: string | null | undefined): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const leading = normalized.slice(0, 10);
  return parseIsoDate(leading) ? leading : null;
}

function toKwh(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  const normalizedUnit = (unit ?? "").trim().toLowerCase();
  if (normalizedUnit.includes("kwh")) return value;
  if (normalizedUnit.includes("wh")) return value / 1000;
  return value / 1000;
}

function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function isIsoDateInput(value: string | null | undefined): value is string {
  const normalized = toNullableString(value);
  if (!normalized) return false;
  return parseIsoDate(normalized) !== null;
}

function pickTelemetryTimestamp(record: Record<string, unknown>): string | null {
  return (
    toNullableString(record.dateTime) ??
    toNullableString(record.date) ??
    toNullableString(record.endTime) ??
    toNullableString(record.startTime) ??
    toNullableString(record.time) ??
    null
  );
}

function pickTelemetryPower(record: Record<string, unknown>): number | null {
  return (
    toNullableNumber(record.totalActivePower) ??
    toNullableNumber(record.activePower) ??
    toNullableNumber(record.acPower) ??
    toNullableNumber(record.power) ??
    toNullableNumber(record.value) ??
    null
  );
}

function pickTelemetryEnergyWh(record: Record<string, unknown>): number | null {
  return (
    toNullableNumber(record.totalEnergy) ??
    toNullableNumber(record.energy) ??
    toNullableNumber(record.energyWh) ??
    toNullableNumber(record.eLifetime) ??
    null
  );
}

function sumFinite(values: Array<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (finite.length === 0) return null;
  const total = finite.reduce((sum, value) => sum + value, 0);
  return Math.round(total * 1000) / 1000;
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  const candidates = values
    .map((value) => toNullableString(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, ms: new Date(value).getTime() }))
    .filter((row) => Number.isFinite(row.ms));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.ms - b.ms);
  return candidates[candidates.length - 1].value;
}

function minTimestamp(values: Array<string | null | undefined>): string | null {
  const candidates = values
    .map((value) => toNullableString(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => ({ value, ms: new Date(value).getTime() }))
    .filter((row) => Number.isFinite(row.ms));
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.ms - b.ms);
  return candidates[0].value;
}

function normalizeMeterType(raw: string | null | undefined): string {
  const normalized = toNullableString(raw);
  if (!normalized) return "Unknown";
  return normalized;
}

function extractMeterTypeRows(payload: unknown): string[] {
  const root = asRecord(payload);
  const metersRecord = asRecord(root.meters);
  const siteMetersRecord = asRecord(root.siteMeters);
  let rows = asRecordArray(root.meters);
  if (rows.length === 0) rows = asRecordArray(metersRecord.meter);
  if (rows.length === 0) rows = asRecordArray(root.meter);
  if (rows.length === 0) rows = asRecordArray(siteMetersRecord.meter);
  if (rows.length === 0) rows = asRecordArray(siteMetersRecord.meters);

  const output: string[] = [];
  for (const row of rows) {
    const type = normalizeMeterType(
      toNullableString(row.type) ??
        toNullableString(row.meterType) ??
        toNullableString(row.meter_type) ??
        toNullableString(row.name)
    );
    output.push(type);
  }

  return output;
}

function extractInverterInventory(payload: unknown): SolarEdgeInverterInventory[] {
  const root = asRecord(payload);
  const inventory = asRecord(root.inventory ?? root.Inventory);
  const rows = asRecordArray(inventory.inverters ?? root.inverters);
  const output: SolarEdgeInverterInventory[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const serialNumber = (
      toNullableString(row.serialNumber) ??
      toNullableString(row.serial_number) ??
      toNullableString(row.SN) ??
      toNullableString(row.sn)
    )?.trim();

    if (!serialNumber) continue;
    if (seen.has(serialNumber)) continue;
    seen.add(serialNumber);

    output.push({
      serialNumber,
      name: toNullableString(row.name) ?? toNullableString(row.logicalName),
      manufacturer: toNullableString(row.manufacturer),
      model: toNullableString(row.model),
      status: toNullableString(row.status),
    });
  }

  return output;
}

function extractInverterTelemetry(payload: unknown): Array<Record<string, unknown>> {
  const root = asRecord(payload);
  const data = asRecord(root.data ?? root.equipmentData ?? root.equipment);
  const rows = asRecordArray(data.telemetries ?? data.values ?? root.telemetries ?? root.values);
  return rows.map((row) => ({ ...row }));
}

async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  worker: (item: TInput, index: number) => Promise<TOutput>
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const safeLimit = Math.max(1, Math.floor(limit) || 1);
  const output = new Array<TOutput>(items.length);
  let cursor = 0;

  const run = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  };

  const workers = Array.from({ length: Math.min(safeLimit, items.length) }, () => run());
  await Promise.all(workers);
  return output;
}

async function getInverterTelemetryPayload(
  context: SolarEdgeApiContext,
  siteId: string,
  serialNumber: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<{ endpoint: string; payload: unknown }> {
  const startTime = startDate ? toSolarEdgeDateTime(startDate, false) : undefined;
  const endTime = endDate ? toSolarEdgeDateTime(endDate, true) : undefined;
  const encodedSerial = encodeURIComponent(serialNumber);
  const encodedSite = encodeURIComponent(siteId);
  const candidates = [
    `/equipment/${encodedSerial}/data`,
    `/equipment/${encodedSerial}/${encodedSite}/data`,
    `/equipment/${encodedSite}/${encodedSerial}/data`,
  ];

  let lastError: unknown = null;
  for (const endpoint of candidates) {
    try {
      const payload = await getSolarEdgeJson(endpoint, context, {
        startTime,
        endTime,
      });
      return { endpoint, payload };
    } catch (error) {
      lastError = error;
      if (isNotFoundError(error)) continue;
      if (error instanceof Error && /\(404\b/.test(error.message)) continue;
    }
  }

  throw lastError ?? new Error("Inverter telemetry endpoint not available for this site.");
}

function sumKwh(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, current) => sum + current, 0);
  return safeRound(total);
}

function extractOverviewLifetimeKwh(payload: unknown): number | null {
  const root = asRecord(payload);
  const overview = asRecord(root.overview);
  const lifeTimeData = asRecord(
    overview.lifeTimeData ?? overview.lifetimeData ?? overview.lifeTime ?? overview.life_time_data
  );
  const energy = toNullableNumber(lifeTimeData.energy ?? overview.lifeTimeEnergy ?? overview.lifetimeEnergy);
  return safeRound(toKwh(energy, "Wh"));
}

type DailyEnergyPoint = {
  dateKey: string;
  kwh: number;
};

type HourlyEnergyPoint = {
  timestamp: string;
  kwh: number;
};

function extractDailyEnergySeriesKwh(payload: unknown): DailyEnergyPoint[] {
  const root = asRecord(payload);
  const energy = asRecord(root.energy);
  const values = Array.isArray(energy.values)
    ? energy.values
    : Array.isArray(root.values)
      ? root.values
      : [];
  const unit = toNullableString(energy.unit) ?? toNullableString(root.unit);
  const output: DailyEnergyPoint[] = [];

  for (const row of values) {
    const record = asRecord(row);
    const dateKey = asDateKey(
      toNullableString(record.date) ??
        toNullableString(record.dateTime) ??
        toNullableString(record.endTime) ??
        toNullableString(record.startTime)
    );
    const value = toNullableNumber(record.value ?? record.energy ?? record.production);
    const kwh = toKwh(value, unit);
    if (!dateKey || kwh === null) continue;
    output.push({
      dateKey,
      kwh,
    });
  }

  return output;
}

function extractHourlyEnergySeriesKwh(payload: unknown): HourlyEnergyPoint[] {
  const root = asRecord(payload);
  const energy = asRecord(root.energy);
  const values = Array.isArray(energy.values)
    ? energy.values
    : Array.isArray(root.values)
      ? root.values
      : [];
  const unit = toNullableString(energy.unit) ?? toNullableString(root.unit);
  const output: HourlyEnergyPoint[] = [];

  for (const row of values) {
    const record = asRecord(row);
    const timestamp =
      toNullableString(record.dateTime) ??
      toNullableString(record.endTime) ??
      toNullableString(record.startTime) ??
      toNullableString(record.date);
    const value = toNullableNumber(record.value ?? record.energy ?? record.production);
    const kwh = toKwh(value, unit);
    if (!timestamp || kwh === null) continue;
    output.push({
      timestamp,
      kwh,
    });
  }

  output.sort((a, b) => {
    const aMs = new Date(a.timestamp).getTime();
    const bMs = new Date(b.timestamp).getTime();
    const safeA = Number.isFinite(aMs) ? aMs : 0;
    const safeB = Number.isFinite(bMs) ? bMs : 0;
    return safeA - safeB;
  });

  return output;
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found");
}

function toSolarEdgeDateTime(dateIso: string, endOfDay: boolean): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) {
    throw new Error("Dates must be in YYYY-MM-DD format.");
  }

  const hh = endOfDay ? "23" : "00";
  const mm = endOfDay ? "59" : "00";
  const ss = endOfDay ? "59" : "00";
  const month = String(parsed.month).padStart(2, "0");
  const day = String(parsed.day).padStart(2, "0");
  return `${parsed.year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

function buildApiUrl(
  path: string,
  context: SolarEdgeApiContext,
  query?: Record<string, string | number | null | undefined>,
  options?: {
    includeApiKeyQuery?: boolean;
  }
): string {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  if (options?.includeApiKeyQuery !== false) {
    url.searchParams.set("api_key", context.apiKey);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  return url.toString();
}

type SolarEdgeAuthMode = "query-only" | "bearer-plus-query";

function buildApiHeaders(context: SolarEdgeApiContext, authMode: SolarEdgeAuthMode): HeadersInit {
  const apiKey = context.apiKey.trim();
  if (authMode === "query-only") {
    return {
      Accept: "application/json",
    };
  }
  return {
    Accept: "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
  };
}

function stripV2Suffix(rawBaseUrl: string | null | undefined): string | null {
  const base = normalizeBaseUrl(rawBaseUrl);
  if (!base.toLowerCase().endsWith("/v2")) return null;
  return base.slice(0, -3).replace(/\/+$/, "");
}

async function getSolarEdgeJson(
  path: string,
  context: SolarEdgeApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const primaryBase = normalizeBaseUrl(context.baseUrl);
  const fallbackBase = stripV2Suffix(context.baseUrl);

  const attempted = new Set<string>();
  const attempts: Array<{ baseUrl: string; authMode: SolarEdgeAuthMode }> = [];

  const addAttempt = (baseUrl: string | null | undefined, authMode: SolarEdgeAuthMode) => {
    if (!baseUrl) return;
    const normalizedBase = normalizeBaseUrl(baseUrl);
    const signature = `${authMode}:${normalizedBase}`;
    if (attempted.has(signature)) return;
    attempted.add(signature);
    attempts.push({ baseUrl: normalizedBase, authMode });
  };

  // Most SolarEdge monitoring keys are valid with query-string api_key only.
  addAttempt(primaryBase, "query-only");
  addAttempt(fallbackBase, "query-only");
  // Some endpoint variants require bearer-style auth.
  addAttempt(primaryBase, "bearer-plus-query");
  addAttempt(fallbackBase, "bearer-plus-query");

  let lastFailureMessage = "SolarEdge request failed.";
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    const attemptContext: SolarEdgeApiContext = {
      ...context,
      baseUrl: attempt.baseUrl,
    };

    const url = buildApiUrl(path, attemptContext, query, {
      includeApiKeyQuery: true,
    });
    const response = await fetch(url, {
      headers: buildApiHeaders(attemptContext, attempt.authMode),
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) {
      return response.json();
    }

    const errorText = await response.text().catch(() => "");
    lastFailureMessage = `SolarEdge request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`;

    // Retry auth permutations only for auth failures.
    const isAuthFailure = response.status === 401 || response.status === 403;
    if (isAuthFailure && index < attempts.length - 1) {
      continue;
    }

    throw new Error(lastFailureMessage);
  }

  throw new Error(lastFailureMessage);
}

export function extractSites(payload: unknown): SolarEdgeSite[] {
  const record = asRecord(payload);
  const sitesRecord = asRecord(record.sites);
  const rows = Array.isArray(sitesRecord.site)
    ? sitesRecord.site
    : Array.isArray(record.sites)
      ? (record.sites as unknown[])
      : Array.isArray(payload)
        ? payload
        : [];

  const output: SolarEdgeSite[] = [];
  for (const row of rows) {
    const value = asRecord(row);
    const id = toNullableString(value.id ?? value.siteId);
    if (!id) continue;

    const city = toNullableString(value.city);
    const country = toNullableString(value.country);
    const location = [city, country].filter(Boolean).join(", ") || null;

    output.push({
      siteId: id,
      siteName: toNullableString(value.name) ?? `Site ${id}`,
      status: toNullableString(value.status),
      peakPowerW: toNullableNumber(value.peakPower ?? value.peakPowerW),
      timezone: toNullableString(value.timeZone ?? value.timezone),
      location,
    });
  }

  return output;
}

export async function listSites(context: SolarEdgeApiContext): Promise<{
  sites: SolarEdgeSite[];
  raw: unknown;
}> {
  const raw = await getSolarEdgeJson("/sites/list", context);
  return {
    sites: extractSites(raw),
    raw,
  };
}

export async function getSiteOverview(context: SolarEdgeApiContext, siteId: string): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/overview`, context);
}

export async function getSiteDetails(context: SolarEdgeApiContext, siteId: string): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/details`, context);
}

export async function getSiteEnergy(
  context: SolarEdgeApiContext,
  siteId: string,
  startDate?: string | null,
  endDate?: string | null,
  timeUnit?: string | null
): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/energy`, context, {
    startDate: startDate ?? undefined,
    endDate: endDate ?? undefined,
    timeUnit: timeUnit ?? undefined,
  });
}

export async function getSiteEnergyDetails(
  context: SolarEdgeApiContext,
  siteId: string,
  startDate?: string | null,
  endDate?: string | null,
  timeUnit?: string | null,
  meters?: string | null
): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/energyDetails`, context, {
    startTime: startDate ? toSolarEdgeDateTime(startDate, false) : undefined,
    endTime: endDate ? toSolarEdgeDateTime(endDate, true) : undefined,
    timeUnit: timeUnit ?? undefined,
    meters: meters ?? "PRODUCTION",
  });
}

export async function getSiteMeters(
  context: SolarEdgeApiContext,
  siteId: string,
  startDate?: string | null,
  endDate?: string | null
): Promise<unknown> {
  return getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/meters`, context, {
    startTime: startDate ? toSolarEdgeDateTime(startDate, false) : undefined,
    endTime: endDate ? toSolarEdgeDateTime(endDate, true) : undefined,
  });
}

export async function getSiteInverterProduction(
  context: SolarEdgeApiContext,
  siteIdRaw: string,
  startDateRaw?: string | null,
  endDateRaw?: string | null
): Promise<SolarEdgeInverterProductionResult> {
  const siteId = siteIdRaw.trim();
  const startDate = toNullableString(startDateRaw);
  const endDate = toNullableString(endDateRaw);

  if (startDate && !isIsoDateInput(startDate)) {
    throw new Error("Start date must be in YYYY-MM-DD format.");
  }
  if (endDate && !isIsoDateInput(endDate)) {
    throw new Error("End date must be in YYYY-MM-DD format.");
  }

  const inventoryPayload = await getSolarEdgeJson(`/site/${encodeURIComponent(siteId)}/inventory`, context);
  const inventory = extractInverterInventory(inventoryPayload);
  if (inventory.length === 0) {
    throw new Error("No inverters found in site inventory.");
  }

  const inverters = await mapWithConcurrency(inventory, 4, async (inverter) => {
    try {
      const { endpoint, payload } = await getInverterTelemetryPayload(
        context,
        siteId,
        inverter.serialNumber,
        startDate,
        endDate
      );
      const telemetries = extractInverterTelemetry(payload);
      const withTimestamp = telemetries
        .map((row) => ({
          row,
          timestamp: pickTelemetryTimestamp(row),
        }))
        .sort((a, b) => {
          const aMs = a.timestamp ? new Date(a.timestamp).getTime() : -Infinity;
          const bMs = b.timestamp ? new Date(b.timestamp).getTime() : -Infinity;
          const safeA = Number.isFinite(aMs) ? aMs : -Infinity;
          const safeB = Number.isFinite(bMs) ? bMs : -Infinity;
          return safeA - safeB;
        });

      const firstTelemetryAt = withTimestamp[0]?.timestamp ?? null;
      const lastTelemetryAt = withTimestamp[withTimestamp.length - 1]?.timestamp ?? null;
      const latestTelemetry = withTimestamp[withTimestamp.length - 1]?.row ?? null;

      return {
        ...inverter,
        endpoint,
        telemetryCount: telemetries.length,
        firstTelemetryAt,
        lastTelemetryAt,
        latestPowerW: latestTelemetry ? pickTelemetryPower(latestTelemetry) : null,
        latestEnergyWh: latestTelemetry ? pickTelemetryEnergyWh(latestTelemetry) : null,
        error: null,
        telemetries,
      } satisfies SolarEdgeInverterProductionRow;
    } catch (error) {
      return {
        ...inverter,
        endpoint: null,
        telemetryCount: 0,
        firstTelemetryAt: null,
        lastTelemetryAt: null,
        latestPowerW: null,
        latestEnergyWh: null,
        error: error instanceof Error ? error.message : "Unknown inverter fetch error.",
        telemetries: [],
      } satisfies SolarEdgeInverterProductionRow;
    }
  });

  return {
    siteId,
    startDate: startDate ?? null,
    endDate: endDate ?? null,
    inventoryCount: inventory.length,
    successfulInverters: inverters.filter((row) => !row.error).length,
    failedInverters: inverters.filter((row) => Boolean(row.error)).length,
    inverters,
  };
}

export async function getSiteMeterSnapshot(
  context: SolarEdgeApiContext,
  siteIdRaw: string
): Promise<SolarEdgeMeterSnapshot> {
  const siteId = siteIdRaw.trim();

  try {
    const payload = await getSiteMeters(context, siteId);
    const meterTypes = extractMeterTypeRows(payload);
    const productionMeterCount = meterTypes.filter((type) => /production|prod/i.test(type)).length;
    const consumptionMeterCount = meterTypes.filter((type) => /consumption|cons/i.test(type)).length;

    return {
      siteId,
      status: "Found",
      found: true,
      meterCount: meterTypes.length,
      productionMeterCount,
      consumptionMeterCount,
      meterTypes: Array.from(new Set(meterTypes)).sort((a, b) => a.localeCompare(b)),
      error: null,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        siteId,
        status: "Not Found",
        found: false,
        meterCount: null,
        productionMeterCount: null,
        consumptionMeterCount: null,
        meterTypes: [],
        error: error instanceof Error ? error.message : "Site not found.",
      };
    }

    return {
      siteId,
      status: "Error",
      found: false,
      meterCount: null,
      productionMeterCount: null,
      consumptionMeterCount: null,
      meterTypes: [],
      error: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}

export async function getSiteInverterSnapshot(
  context: SolarEdgeApiContext,
  siteIdRaw: string,
  anchorDateRaw?: string | null
): Promise<SolarEdgeInverterSnapshot> {
  const siteId = siteIdRaw.trim();
  const anchorDate = (anchorDateRaw ?? "").trim() || formatIsoDate(new Date());
  if (!parseIsoDate(anchorDate)) {
    throw new Error("Anchor date must be in YYYY-MM-DD format.");
  }

  const startDate = shiftIsoDate(anchorDate, -29);

  try {
    const result = await getSiteInverterProduction(context, siteId, startDate, anchorDate);
    const invertersWithTelemetry = result.inverters.filter((inverter) => inverter.telemetryCount > 0).length;
    const inverterFailures = result.inverters.filter((inverter) => Boolean(inverter.error)).length;
    const totalLatestPowerW = sumFinite(result.inverters.map((inverter) => inverter.latestPowerW));
    const totalLatestEnergyWh = sumFinite(result.inverters.map((inverter) => inverter.latestEnergyWh));
    const firstTelemetryAt = minTimestamp(result.inverters.map((inverter) => inverter.firstTelemetryAt));
    const lastTelemetryAt = maxTimestamp(result.inverters.map((inverter) => inverter.lastTelemetryAt));

    return {
      siteId,
      status: "Found",
      found: true,
      inverterCount: result.inventoryCount,
      invertersWithTelemetry,
      inverterFailures,
      totalLatestPowerW,
      totalLatestEnergyWh,
      firstTelemetryAt,
      lastTelemetryAt,
      error: null,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        siteId,
        status: "Not Found",
        found: false,
        inverterCount: null,
        invertersWithTelemetry: null,
        inverterFailures: null,
        totalLatestPowerW: null,
        totalLatestEnergyWh: null,
        firstTelemetryAt: null,
        lastTelemetryAt: null,
        error: error instanceof Error ? error.message : "Site not found.",
      };
    }

    return {
      siteId,
      status: "Error",
      found: false,
      inverterCount: null,
      invertersWithTelemetry: null,
      inverterFailures: null,
      totalLatestPowerW: null,
      totalLatestEnergyWh: null,
      firstTelemetryAt: null,
      lastTelemetryAt: null,
      error: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}

export async function getSiteProductionSnapshot(
  context: SolarEdgeApiContext,
  siteIdRaw: string,
  anchorDateRaw?: string | null
): Promise<SolarEdgeProductionSnapshot> {
  const siteId = siteIdRaw.trim();
  const anchorDate = (anchorDateRaw ?? "").trim() || formatIsoDate(new Date());
  if (!parseIsoDate(anchorDate)) {
    throw new Error("Anchor date must be in YYYY-MM-DD format.");
  }

  const monthlyStartDate = shiftIsoDate(anchorDate, -29);
  const weeklyStartDate = shiftIsoDate(anchorDate, -6);
  const mtdStartDate = firstDayOfMonth(anchorDate);
  const previousCalendarMonthStartDate = firstDayOfPreviousMonth(anchorDate);
  const previousCalendarMonthEndDate = lastDayOfPreviousMonth(anchorDate);
  const last12MonthsStartDate = shiftIsoDateByYears(anchorDate, -1);

  try {
    const [overviewPayload, periodEnergyPayload, last12MonthsEnergyPayload, hourlyPayload] = await Promise.all([
      getSiteOverview(context, siteId),
      getSiteEnergy(context, siteId, previousCalendarMonthStartDate, anchorDate, "DAY"),
      getSiteEnergy(context, siteId, last12MonthsStartDate, anchorDate, "MONTH"),
      getSiteEnergy(context, siteId, anchorDate, anchorDate, "HOUR"),
    ]);

    const lifetimeKwh = extractOverviewLifetimeKwh(overviewPayload);
    const periodSeries = extractDailyEnergySeriesKwh(periodEnergyPayload);
    const last12MonthsSeries = extractDailyEnergySeriesKwh(last12MonthsEnergyPayload);
    const hourlySeries = extractHourlyEnergySeriesKwh(hourlyPayload);
    const hourlyProductionKwh = safeRound(hourlySeries.length > 0 ? hourlySeries[hourlySeries.length - 1].kwh : null);
    const monthlyProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey >= monthlyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );
    const weeklyProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey >= weeklyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );
    const dailyProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey === anchorDate)
        .map((point) => point.kwh)
    );
    const mtdProductionKwh = sumKwh(
      periodSeries
        .filter((point) => point.dateKey >= mtdStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );
    const previousCalendarMonthProductionKwh = sumKwh(
      periodSeries
        .filter(
          (point) =>
            point.dateKey >= previousCalendarMonthStartDate &&
            point.dateKey <= previousCalendarMonthEndDate
        )
        .map((point) => point.kwh)
    );
    const last12MonthsProductionKwh = sumKwh(last12MonthsSeries.map((point) => point.kwh));

    return {
      siteId,
      status: "Found",
      found: true,
      lifetimeKwh,
      hourlyProductionKwh,
      monthlyProductionKwh,
      mtdProductionKwh,
      previousCalendarMonthProductionKwh,
      last12MonthsProductionKwh,
      weeklyProductionKwh,
      dailyProductionKwh,
      anchorDate,
      monthlyStartDate,
      weeklyStartDate,
      mtdStartDate,
      previousCalendarMonthStartDate,
      previousCalendarMonthEndDate,
      last12MonthsStartDate,
      error: null,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        siteId,
        status: "Not Found",
        found: false,
        lifetimeKwh: null,
        hourlyProductionKwh: null,
        monthlyProductionKwh: null,
        mtdProductionKwh: null,
        previousCalendarMonthProductionKwh: null,
        last12MonthsProductionKwh: null,
        weeklyProductionKwh: null,
        dailyProductionKwh: null,
        anchorDate,
        monthlyStartDate,
        weeklyStartDate,
        mtdStartDate,
        previousCalendarMonthStartDate,
        previousCalendarMonthEndDate,
        last12MonthsStartDate,
        error: error instanceof Error ? error.message : "Site not found.",
      };
    }

    return {
      siteId,
      status: "Error",
      found: false,
      lifetimeKwh: null,
      hourlyProductionKwh: null,
      monthlyProductionKwh: null,
      mtdProductionKwh: null,
      previousCalendarMonthProductionKwh: null,
      last12MonthsProductionKwh: null,
      weeklyProductionKwh: null,
      dailyProductionKwh: null,
      anchorDate,
      monthlyStartDate,
      weeklyStartDate,
      mtdStartDate,
      previousCalendarMonthStartDate,
      previousCalendarMonthEndDate,
      last12MonthsStartDate,
      error: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}
