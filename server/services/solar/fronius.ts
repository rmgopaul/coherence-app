import {
  toNullableString,
  toNullableNumber,
  asRecord,
  asRecordArray,
  parseIsoDate,
  normalizeBaseUrl,
  formatIsoDate,
  shiftIsoDate,
  shiftIsoDateByYears,
  safeRound,
  sumKwh,
  isNotFoundError,
} from "./helpers";

export const FRONIUS_DEFAULT_BASE_URL = "https://api.solarweb.com/swqapi";

export type FroniusApiContext = {
  accessKeyId: string;
  accessKeyValue: string;
  baseUrl?: string | null;
};

export type FroniusPvSystem = {
  pvSystemId: string;
  name: string;
  peakPower: number | null;
  address: string | null;
  timeZone: string | null;
  status: string | null;
};

export type FroniusDevice = {
  deviceId: string;
  deviceType: string | null;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  isActive: boolean;
  isOnline: boolean;
  peakPower: number | null;
};

export type FroniusProductionSnapshot = {
  pvSystemId: string;
  name: string | null;
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
  lifetimeChannelName: string | null;
  lifetimeChannelUnit: string | null;
  lifetimeChannelSelection: string | null;
  dailyChannelName: string | null;
  dailyChannelUnit: string | null;
  dailyChannelSelection: string | null;
  monthlyChannelName: string | null;
  monthlyChannelUnit: string | null;
  monthlyChannelSelection: string | null;
  error: string | null;
};

export type FroniusDeviceSnapshot = {
  pvSystemId: string;
  name: string | null;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  deviceCount: number | null;
  inverterCount: number | null;
  currentPowerW: number | null;
  isOnline: boolean | null;
  error: string | null;
};

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

function asMonthKey(value: string | null | undefined): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const leading = normalized.slice(0, 7);
  const match = /^(\d{4})-(\d{2})$/.exec(leading);
  if (!match) return null;
  return leading;
}

// ---------------------------------------------------------------------------
// Fronius channel helpers
// ---------------------------------------------------------------------------

type ProductionChannelMatch = {
  channel: Record<string, unknown>;
  channelName: string;
  unit: string | null;
  selectionSource: "priority_exact" | "priority_normalized" | "fallback_scored";
};

/** Priority order for channels that represent PV production/yield energy. */
const PRODUCTION_CHANNEL_PRIORITY_NAMES = [
  "EnergyReal_WAC_Sum_Produced",
  "EnergyReal_WAC_Plus_Produced",
  "EnergyReal_WAC_Sum",
  "EnergyProduced",
  "EnergyYield",
  "Yield",
];

/**
 * Excludes channels that are likely import/export, consumption, battery, or grid flow
 * values (these often cause false zeroes for production windows).
 */
const NON_PRODUCTION_CHANNEL_NAME_PATTERN =
  /(consum|import|export|feedin|feed_in|grid|load|battery|charge|discharge|purchas|sold|absolute)/i;

function channelNameOf(channel: Record<string, unknown>): string | null {
  return toNullableString(channel.channelName) ?? toNullableString(channel.channel_name) ?? toNullableString(channel.name);
}

function normalizeChannelName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isLikelyNonProductionChannel(channelName: string): boolean {
  return NON_PRODUCTION_CHANNEL_NAME_PATTERN.test(channelName);
}

function fallbackProductionScore(channelNameRaw: string): number {
  const channelName = channelNameRaw.toLowerCase();
  let score = 0;
  if (/produced|production|yield|generated/.test(channelName)) score += 30;
  if (/wac/.test(channelName)) score += 15;
  if (/sum/.test(channelName)) score += 10;
  if (/energy/.test(channelName)) score += 5;
  if (/plus/.test(channelName)) score -= 5;
  return score;
}

function findProductionChannel(channels: Array<Record<string, unknown>>): ProductionChannelMatch | null {
  const namedChannels = channels
    .map((channel) => {
      const channelName = channelNameOf(channel);
      return channelName ? { channel, channelName } : null;
    })
    .filter((value): value is { channel: Record<string, unknown>; channelName: string } => value !== null);

  // 1) Exact priority-name match
  for (const priorityName of PRODUCTION_CHANNEL_PRIORITY_NAMES) {
    const match = namedChannels.find(({ channelName }) => channelName === priorityName);
    if (match) {
      return {
        channel: match.channel,
        channelName: match.channelName,
        unit: toNullableString(match.channel.unit),
        selectionSource: "priority_exact",
      };
    }
  }

  // 2) Normalized priority-name match (defensive against separators/casing variance)
  const priorityNormalizedSet = new Set(PRODUCTION_CHANNEL_PRIORITY_NAMES.map(normalizeChannelName));
  for (const candidate of namedChannels) {
    if (priorityNormalizedSet.has(normalizeChannelName(candidate.channelName))) {
      return {
        channel: candidate.channel,
        channelName: candidate.channelName,
        unit: toNullableString(candidate.channel.unit),
        selectionSource: "priority_normalized",
      };
    }
  }

  // 3) Scored fallback for yield/production-like names, excluding known non-production channels
  const fallbackCandidates = namedChannels
    .filter(({ channelName }) => {
      if (isLikelyNonProductionChannel(channelName)) return false;
      return /energy|yield|produced|production|generated/i.test(channelName);
    })
    .map(({ channel, channelName }) => ({
      channel,
      channelName,
      unit: toNullableString(channel.unit),
      score: fallbackProductionScore(channelName),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score);

  if (fallbackCandidates.length === 0) return null;

  const best = fallbackCandidates[0];
  return {
    channel: best.channel,
    channelName: best.channelName,
    unit: best.unit,
    selectionSource: "fallback_scored",
  };
}

function channelValueToKwh(value: number | null, unit: string | null): number | null {
  if (value === null) return null;
  const normalizedUnit = (unit ?? "").trim().toLowerCase();
  if (normalizedUnit.includes("kwh")) return value;
  if (normalizedUnit.includes("wh")) return value / 1000;
  // Default assumption: Wh
  return value / 1000;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

const FRONIUS_SAFE_REQUESTS_PER_MINUTE = 900;
const FRONIUS_WINDOW_MS = 60_000;
const FRONIUS_MIN_REQUEST_GAP_MS = 75;
const FRONIUS_MAX_RETRY_ATTEMPTS = 3;

type FroniusThrottleState = {
  tail: Promise<void>;
  releaseTail: (() => void) | null;
  windowStart: number;
  windowCount: number;
  nextAllowedAt: number;
  lastRequestAt: number;
};

const froniusThrottleByKey = new Map<string, FroniusThrottleState>();
const THROTTLE_EVICTION_THRESHOLD = 50;
const THROTTLE_STALE_MS = 10 * 60 * 1000; // 10 minutes

function getFroniusThrottleKey(context: FroniusApiContext): string {
  return `${context.accessKeyId.trim()}::${normalize(context.baseUrl)}`;
}

function getOrCreateFroniusThrottleState(context: FroniusApiContext): FroniusThrottleState {
  const key = getFroniusThrottleKey(context);
  const existing = froniusThrottleByKey.get(key);
  if (existing) return existing;

  // Evict stale entries to prevent unbounded growth from rotated keys.
  if (froniusThrottleByKey.size >= THROTTLE_EVICTION_THRESHOLD) {
    const now = Date.now();
    for (const [k, v] of Array.from(froniusThrottleByKey.entries())) {
      if (now - v.lastRequestAt > THROTTLE_STALE_MS) {
        froniusThrottleByKey.delete(k);
      }
    }
  }

  const initialTail = Promise.resolve();
  const state: FroniusThrottleState = {
    tail: initialTail,
    releaseTail: null,
    windowStart: 0,
    windowCount: 0,
    nextAllowedAt: 0,
    lastRequestAt: 0,
  };
  froniusThrottleByKey.set(key, state);
  return state;
}

function sleep(ms: number): Promise<void> {
  const safeMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

async function waitForFroniusRateLimitSlot(context: FroniusApiContext): Promise<void> {
  const state = getOrCreateFroniusThrottleState(context);

  const previousTail = state.tail;
  let releaseCurrentTail: () => void = () => undefined;
  state.tail = new Promise<void>((resolve) => {
    releaseCurrentTail = resolve;
  });
  state.releaseTail = releaseCurrentTail;

  await previousTail.catch(() => undefined);

  try {
    const now = Date.now();

    // Reset the tumbling window when it expires.
    if (now - state.windowStart >= FRONIUS_WINDOW_MS) {
      state.windowStart = now;
      state.windowCount = 0;
    }

    let waitMs = 0;
    if (state.windowCount >= FRONIUS_SAFE_REQUESTS_PER_MINUTE) {
      waitMs = Math.max(waitMs, FRONIUS_WINDOW_MS - (now - state.windowStart) + 50);
    }

    waitMs = Math.max(waitMs, state.nextAllowedAt - now);
    waitMs = Math.max(waitMs, state.lastRequestAt + FRONIUS_MIN_REQUEST_GAP_MS - now);

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const scheduledAt = Date.now();
    state.lastRequestAt = scheduledAt;
    state.windowCount += 1;
  } finally {
    releaseCurrentTail();
    if (state.releaseTail === releaseCurrentTail) {
      state.releaseTail = null;
    }
  }
}

function parseFroniusRetryAfterMs(response: Response, errorText: string): number | null {
  const retryAfterHeader = response.headers.get("retry-after");
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader.trim());
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.floor(seconds * 1000);
    }

    const parsedDateMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(parsedDateMs)) {
      const delta = parsedDateMs - Date.now();
      if (delta > 0) return Math.floor(delta);
    }
  }

  const messageRetryMatch = /retry\s*after\s*:\s*(\d+)/i.exec(errorText);
  if (messageRetryMatch) {
    const seconds = Number(messageRetryMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.floor(seconds * 1000);
    }
  }

  return null;
}

function applyFroniusBackoff(context: FroniusApiContext, retryAfterMs: number): void {
  const state = getOrCreateFroniusThrottleState(context);
  const until = Date.now() + Math.max(0, Math.floor(retryAfterMs));
  state.nextAllowedAt = Math.max(state.nextAllowedAt, until);
}

const normalize = (raw: string | null | undefined) =>
  normalizeBaseUrl(raw, FRONIUS_DEFAULT_BASE_URL);

async function getFroniusJson(
  path: string,
  context: FroniusApiContext,
  query?: Record<string, string | number | null | undefined>,
  signal?: AbortSignal,
): Promise<unknown> {
  const baseUrl = normalize(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  for (let attempt = 1; attempt <= FRONIUS_MAX_RETRY_ATTEMPTS; attempt += 1) {
    await waitForFroniusRateLimitSlot(context);

    const composedSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);

    const response = await fetch(url.toString(), {
      headers: {
        AccessKeyId: context.accessKeyId,
        AccessKeyValue: context.accessKeyValue,
        Accept: "application/json",
      },
      signal: composedSignal,
    });

    if (response.ok) {
      return response.json();
    }

    const errorText = await response.text().catch(() => "");

    if (response.status === 404) {
      throw new Error(`Fronius request failed (404 Not Found)${errorText ? `: ${errorText}` : ""}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Fronius authentication failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
      );
    }

    if (response.status === 429) {
      const retryAfterMs =
        parseFroniusRetryAfterMs(response, errorText) ?? Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      applyFroniusBackoff(context, retryAfterMs);

      if (attempt < FRONIUS_MAX_RETRY_ATTEMPTS) {
        await sleep(retryAfterMs);
        continue;
      }

      throw new Error(
        `Fronius rate limit exceeded (429 Too Many Requests). Retry in about ${Math.ceil(retryAfterMs / 1000)}s.${errorText ? ` API response: ${errorText}` : ""}`
      );
    }

    throw new Error(
      `Fronius request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  throw new Error("Fronius request failed after retry attempts.");
}

// ---------------------------------------------------------------------------
// Extraction: PV Systems
// ---------------------------------------------------------------------------

export function extractPvSystems(payload: unknown): FroniusPvSystem[] {
  const root = asRecord(payload);
  const rows = asRecordArray(
    root.pvSystems ?? root.pvsystems ?? root.PvSystems ?? root.systems
  );

  // If the top-level IS an array, try that
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: FroniusPvSystem[] = [];
  for (const row of items) {
    const pvSystemId = toNullableString(
      row.pvSystemId ?? row.pvSystemID ?? row.PvSystemId ?? row.id
    );
    if (!pvSystemId) continue;

    const street = toNullableString(row.street);
    const city = toNullableString(row.city);
    const country = toNullableString(row.country);
    const addressFromField = toNullableString(row.address);
    const address = addressFromField ?? ([street, city, country].filter(Boolean).join(", ") || null);

    output.push({
      pvSystemId,
      name: toNullableString(row.name) ?? `PV System ${pvSystemId}`,
      peakPower: toNullableNumber(row.peakPower ?? row.peak_power ?? row.PeakPower),
      address,
      timeZone: toNullableString(row.timeZone ?? row.timezone ?? row.TimeZone),
      status: toNullableString(row.status ?? row.Status),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: List PV Systems (with pagination)
// ---------------------------------------------------------------------------

export async function listPvSystems(
  context: FroniusApiContext,
  signal?: AbortSignal,
): Promise<{
  pvSystems: FroniusPvSystem[];
  raw: unknown;
}> {
  const allSystems: FroniusPvSystem[] = [];
  const allRawPages: unknown[] = [];
  let offset = 0;
  const limit = 100;
  const maxSystems = 10000;

  while (offset < maxSystems) {
    const raw = await getFroniusJson("/pvsystems", context, {
      Limit: limit,
      Offset: offset,
    }, signal);
    allRawPages.push(raw);

    const systems = extractPvSystems(raw);
    allSystems.push(...systems);

    // Stop if we got fewer than the limit (no more pages)
    if (systems.length < limit) break;
    offset += limit;
  }

  return {
    pvSystems: allSystems,
    raw: allRawPages.length === 1 ? allRawPages[0] : allRawPages,
  };
}

// ---------------------------------------------------------------------------
// API: PV System Details
// ---------------------------------------------------------------------------

export async function getPvSystemDetails(
  context: FroniusApiContext,
  pvSystemId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return getFroniusJson(`/pvsystems/${encodeURIComponent(pvSystemId)}`, context, undefined, signal);
}

// ---------------------------------------------------------------------------
// API: PV System Devices
// ---------------------------------------------------------------------------

export async function getPvSystemDevices(
  context: FroniusApiContext,
  pvSystemId: string,
  signal?: AbortSignal,
): Promise<FroniusDevice[]> {
  const raw = await getFroniusJson(
    `/pvsystems/${encodeURIComponent(pvSystemId)}/devices`,
    context,
    { Limit: 100 },
    signal,
  );

  const root = asRecord(raw);
  const rows = asRecordArray(
    root.devices ?? root.Devices ?? root.data
  );
  const items = rows.length > 0 ? rows : Array.isArray(raw) ? asRecordArray(raw) : [];

  const output: FroniusDevice[] = [];
  for (const row of items) {
    const deviceId = toNullableString(
      row.deviceId ?? row.DeviceId ?? row.device_id ?? row.id
    );
    if (!deviceId) continue;

    output.push({
      deviceId,
      deviceType: toNullableString(row.deviceType ?? row.DeviceType ?? row.device_type ?? row.type),
      name: toNullableString(row.name ?? row.Name),
      manufacturer: toNullableString(row.manufacturer ?? row.Manufacturer),
      model: toNullableString(row.model ?? row.Model),
      serialNumber: toNullableString(row.serialNumber ?? row.SerialNumber ?? row.serial_number ?? row.SN),
      isActive: row.isActive === true || row.IsActive === true,
      isOnline: row.isOnline === true || row.IsOnline === true,
      peakPower: toNullableNumber(row.peakPower ?? row.PeakPower ?? row.peak_power),
    });
  }

  return output;
}

// ---------------------------------------------------------------------------
// API: Aggdata (lifetime totals)
// ---------------------------------------------------------------------------

export async function getAggData(
  context: FroniusApiContext,
  pvSystemId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return getFroniusJson(`/pvsystems/${encodeURIComponent(pvSystemId)}/aggdata`, context, undefined, signal);
}

// ---------------------------------------------------------------------------
// API: Aggrdata (aggregated by period)
// ---------------------------------------------------------------------------

export async function getAggrData(
  context: FroniusApiContext,
  pvSystemId: string,
  from?: string | null,
  to?: string | null,
  signal?: AbortSignal,
): Promise<unknown> {
  // The SWQAPI aggrdata endpoint accepts From/To date range parameters.
  // Period is NOT supported by this endpoint (returns error 3204).
  // The API returns data at the granularity appropriate for the date range.
  return getFroniusJson(`/pvsystems/${encodeURIComponent(pvSystemId)}/aggrdata`, context, {
    From: from ?? undefined,
    To: to ?? undefined,
  }, signal);
}

// ---------------------------------------------------------------------------
// API: Flow data (current power flow)
// ---------------------------------------------------------------------------

export async function getFlowData(
  context: FroniusApiContext,
  pvSystemId: string,
  signal?: AbortSignal,
): Promise<unknown> {
  return getFroniusJson(`/pvsystems/${encodeURIComponent(pvSystemId)}/flowdata`, context, undefined, signal);
}

// ---------------------------------------------------------------------------
// Extraction: Lifetime kWh from aggdata
// ---------------------------------------------------------------------------

type LifetimeKwhExtraction = {
  kwh: number | null;
  channelName: string | null;
  channelUnit: string | null;
  channelSelection: string | null;
};

export function extractLifetimeKwh(payload: unknown): LifetimeKwhExtraction {
  const root = asRecord(payload);
  const data = asRecord(root.data);

  // aggdata response: { data: { channels: [ { channelName, unit, values: { Total: number } } ] } }
  const channels = asRecordArray(data.channels ?? root.channels);

  const selectedChannel = findProductionChannel(channels);
  if (!selectedChannel) {
    return {
      kwh: null,
      channelName: null,
      channelUnit: null,
      channelSelection: null,
    };
  }

  const unit = selectedChannel.unit ?? "Wh";
  const valuesRecord = asRecord(selectedChannel.channel.values);

  // Try "Total" key first, then any numeric value
  let rawValue = toNullableNumber(valuesRecord.Total ?? valuesRecord.total ?? valuesRecord.TOTAL);
  if (rawValue === null) {
    // Pick the first numeric value from the values object
    for (const val of Object.values(valuesRecord)) {
      const num = toNullableNumber(val);
      if (num !== null) {
        rawValue = num;
        break;
      }
    }
  }

  // Also handle case where value is directly on the channel object
  if (rawValue === null) {
    rawValue = toNullableNumber(selectedChannel.channel.value);
  }

  return {
    kwh: safeRound(channelValueToKwh(rawValue, unit)),
    channelName: selectedChannel.channelName,
    channelUnit: selectedChannel.unit,
    channelSelection: selectedChannel.selectionSource,
  };
}

// ---------------------------------------------------------------------------
// Extraction: Aggregated energy from aggrdata
// ---------------------------------------------------------------------------

type EnergyPoint = {
  dateKey: string;
  kwh: number;
};

type EnergyExtraction = {
  points: EnergyPoint[];
  channelName: string | null;
  channelUnit: string | null;
  channelSelection: string | null;
};

export function extractAggrEnergyKwh(payload: unknown): EnergyExtraction {
  const root = asRecord(payload);
  const dataEntries = asRecordArray(root.data ?? root.Data);
  const output: EnergyPoint[] = [];
  let channelName: string | null = null;
  let channelUnit: string | null = null;
  let channelSelection: string | null = null;

  for (const entry of dataEntries) {
    const logDateTime = toNullableString(
      entry.logDateTime ?? entry.LogDateTime ?? entry.logDate ?? entry.timestamp
    );
    const dateKey = asDateKey(logDateTime);
    if (!dateKey) continue;

    const channels = asRecordArray(entry.channels ?? entry.Channels);
    const selectedChannel = findProductionChannel(channels);
    if (!selectedChannel) continue;

    const unit = selectedChannel.unit ?? "Wh";
    const rawValue = toNullableNumber(selectedChannel.channel.value ?? selectedChannel.channel.Value);
    const kwh = channelValueToKwh(rawValue, unit);
    if (kwh === null) continue;

    if (!channelName) {
      channelName = selectedChannel.channelName;
      channelUnit = selectedChannel.unit;
      channelSelection = selectedChannel.selectionSource;
    }

    output.push({ dateKey, kwh });
  }

  return {
    points: output,
    channelName,
    channelUnit,
    channelSelection,
  };
}

/** @deprecated Use {@link extractAggrEnergyKwh} — kept for backward compatibility. */
export const extractAggrDailyEnergyKwh = extractAggrEnergyKwh;
/** @deprecated Use {@link extractAggrEnergyKwh} — kept for backward compatibility. */
export const extractAggrMonthlyEnergyKwh = extractAggrEnergyKwh;

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

type SnapshotDateMetadata = {
  anchorDate: string;
  monthlyStartDate: string;
  weeklyStartDate: string;
  mtdStartDate: string;
  previousCalendarMonthStartDate: string;
  previousCalendarMonthEndDate: string;
  last12MonthsStartDate: string;
};

function makeErrorSnapshot(
  pvSystemId: string,
  name: string | null,
  status: "Not Found" | "Error",
  dates: SnapshotDateMetadata,
  error: unknown,
): FroniusProductionSnapshot {
  return {
    pvSystemId,
    name,
    status,
    found: false,
    lifetimeKwh: null,
    hourlyProductionKwh: null,
    monthlyProductionKwh: null,
    mtdProductionKwh: null,
    previousCalendarMonthProductionKwh: null,
    last12MonthsProductionKwh: null,
    weeklyProductionKwh: null,
    dailyProductionKwh: null,
    ...dates,
    lifetimeChannelName: null,
    lifetimeChannelUnit: null,
    lifetimeChannelSelection: null,
    dailyChannelName: null,
    dailyChannelUnit: null,
    dailyChannelSelection: null,
    monthlyChannelName: null,
    monthlyChannelUnit: null,
    monthlyChannelSelection: null,
    error:
      status === "Not Found"
        ? (error instanceof Error ? error.message : "PV system not found.")
        : (error instanceof Error ? error.message : "Unknown error."),
  };
}

export async function getPvSystemProductionSnapshot(
  context: FroniusApiContext,
  pvSystemIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null,
  signal?: AbortSignal,
): Promise<FroniusProductionSnapshot> {
  const pvSystemId = pvSystemIdRaw.trim();
  const name = nameOverride ?? null;
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
    // IMPORTANT: Both aggrdata calls are intentional and CANNOT be merged.
    // The Fronius SWQAPI aggrdata endpoint returns data at a granularity
    // determined by the date range span:
    //   ~60-day range (previousCalendarMonthStart..anchorDate) → daily rows
    //   ~12-month range (last12MonthsStart..anchorDate) → monthly rows
    // A single call with the 12-month range would NOT return daily-resolution
    // data, which is needed for daily/weekly/MTD rollups.
    const [aggdataPayload, dailyAggrPayload, monthlyAggrPayload] = await Promise.all([
      getAggData(context, pvSystemId, signal),
      getAggrData(context, pvSystemId, previousCalendarMonthStartDate, anchorDate, signal),
      getAggrData(context, pvSystemId, last12MonthsStartDate, anchorDate, signal),
    ]);

    const lifetimeExtraction = extractLifetimeKwh(aggdataPayload);
    const dailyExtraction = extractAggrEnergyKwh(dailyAggrPayload);
    const monthlyExtraction = extractAggrEnergyKwh(monthlyAggrPayload);
    const dailySeries = dailyExtraction.points;
    const monthlySeries = monthlyExtraction.points;

    // hourlyProductionKwh: not available from aggrdata endpoints, would require separate flow/power endpoint
    // Use the most recent daily value as a rough proxy, or null
    const hourlyProductionKwh: number | null = null;

    const dailyProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey === anchorDate)
        .map((point) => point.kwh)
    );

    const weeklyProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= weeklyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const monthlyProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= monthlyStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const mtdProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= mtdStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const previousCalendarMonthProductionKwh = sumKwh(
      dailySeries
        .filter(
          (point) =>
            point.dateKey >= previousCalendarMonthStartDate &&
            point.dateKey <= previousCalendarMonthEndDate
        )
        .map((point) => point.kwh)
    );

    const last12MonthsProductionKwh = sumKwh(
      monthlySeries.map((point) => point.kwh)
    );

    return {
      pvSystemId,
      name,
      status: "Found",
      found: true,
      lifetimeKwh: lifetimeExtraction.kwh,
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
      lifetimeChannelName: lifetimeExtraction.channelName,
      lifetimeChannelUnit: lifetimeExtraction.channelUnit,
      lifetimeChannelSelection: lifetimeExtraction.channelSelection,
      dailyChannelName: dailyExtraction.channelName,
      dailyChannelUnit: dailyExtraction.channelUnit,
      dailyChannelSelection: dailyExtraction.channelSelection,
      monthlyChannelName: monthlyExtraction.channelName,
      monthlyChannelUnit: monthlyExtraction.channelUnit,
      monthlyChannelSelection: monthlyExtraction.channelSelection,
      error: null,
    };
  } catch (error) {
    const dates: SnapshotDateMetadata = {
      anchorDate,
      monthlyStartDate,
      weeklyStartDate,
      mtdStartDate,
      previousCalendarMonthStartDate,
      previousCalendarMonthEndDate,
      last12MonthsStartDate,
    };
    return makeErrorSnapshot(
      pvSystemId,
      name,
      isNotFoundError(error) ? "Not Found" : "Error",
      dates,
      error,
    );
  }
}

// ---------------------------------------------------------------------------
// Device Snapshot
// ---------------------------------------------------------------------------

export async function getPvSystemDeviceSnapshot(
  context: FroniusApiContext,
  pvSystemIdRaw: string,
  nameOverride?: string | null,
  signal?: AbortSignal,
): Promise<FroniusDeviceSnapshot> {
  const pvSystemId = pvSystemIdRaw.trim();
  const name = nameOverride ?? null;

  try {
    const [devices, flowPayload] = await Promise.all([
      getPvSystemDevices(context, pvSystemId, signal),
      getFlowData(context, pvSystemId, signal),
    ]);

    const inverterCount = devices.filter(
      (device) => (device.deviceType ?? "").toLowerCase().includes("inverter")
    ).length;

    const isOnline = devices.some((device) => device.isOnline);

    // Extract current power from flow data
    const flowRoot = asRecord(flowPayload);
    const flowData = asRecord(flowRoot.data ?? flowRoot);
    const site = asRecord(flowData.site ?? flowData.Site);
    let currentPowerW = toNullableNumber(
      site.currentPower ?? site.CurrentPower ?? site.current_power ?? site.powerFlow
    );

    // Try alternate locations for power in flow data
    if (currentPowerW === null) {
      const pv = asRecord(flowData.pv ?? flowData.PV ?? flowData.photovoltaic);
      currentPowerW = toNullableNumber(
        pv.currentPower ?? pv.CurrentPower ?? pv.power ?? pv.Power
      );
    }

    // Try channels in flow data
    if (currentPowerW === null) {
      const channels = asRecordArray(flowData.channels ?? flowRoot.channels);
      for (const ch of channels) {
        const name = toNullableString(ch.channelName ?? ch.name);
        if (name && /power/i.test(name)) {
          currentPowerW = toNullableNumber(ch.value ?? ch.Value);
          if (currentPowerW !== null) break;
        }
      }
    }

    return {
      pvSystemId,
      name,
      status: "Found",
      found: true,
      deviceCount: devices.length,
      inverterCount,
      currentPowerW: safeRound(currentPowerW),
      isOnline,
      error: null,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        pvSystemId,
        name,
        status: "Not Found",
        found: false,
        deviceCount: null,
        inverterCount: null,
        currentPowerW: null,
        isOnline: null,
        error: error instanceof Error ? error.message : "PV system not found.",
      };
    }

    return {
      pvSystemId,
      name,
      status: "Error",
      found: false,
      deviceCount: null,
      inverterCount: null,
      currentPowerW: null,
      isOnline: null,
      error: error instanceof Error ? error.message : "Unknown error.",
    };
  }
}
