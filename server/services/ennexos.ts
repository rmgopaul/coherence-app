export const ENNEX_OS_DEFAULT_BASE_URL = "https://sandbox.smaapis.de";

export type EnnexOsApiContext = {
  accessToken: string;
  baseUrl?: string | null;
};

export type EnnexOsPlant = {
  plantId: string;
  name: string;
  location: string | null;
  timeZone: string | null;
  status: string | null;
};

export type EnnexOsDevice = {
  deviceId: string;
  deviceType: string | null;
  name: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  isActive: boolean;
  isOnline: boolean;
};

export type EnnexOsProductionSnapshot = {
  plantId: string;
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

export type EnnexOsDeviceSnapshot = {
  plantId: string;
  status: "Found" | "Not Found" | "Error";
  found: boolean;
  deviceCount: number | null;
  inverterCount: number | null;
  currentPowerW: number | null;
  isOnline: boolean | null;
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
  return `${parsed.year}-${String(parsed.month).padStart(2, "0")}-01`;
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
  if (!/^(\d{4})-(\d{2})$/.test(leading)) return null;
  return leading;
}

function sumKwh(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, current) => sum + current, 0);
  return safeRound(total);
}

function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) return ENNEX_OS_DEFAULT_BASE_URL;
  return trimmed.replace(/\/+$/, "");
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found");
}

function isRecoverableFallbackError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("(400");
}

export async function mapWithConcurrency<TInput, TOutput>(
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

async function getEnnexOsJson(
  path: string,
  context: EnnexOsApiContext,
  query?: Record<string, string | number | null | undefined>
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const safePath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${baseUrl}${safePath}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === null || value === undefined) continue;
    const normalized = String(value).trim();
    if (!normalized) continue;
    url.searchParams.set(key, normalized);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${context.accessToken}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (response.ok) {
    return response.json();
  }

  const errorText = await response.text().catch(() => "");

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `ennexOS authentication failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  throw new Error(
    `ennexOS request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
  );
}

export function extractPlants(payload: unknown): EnnexOsPlant[] {
  const root = asRecord(payload);
  const rows = asRecordArray(root.plants ?? root.items ?? root.data ?? root.content);
  const items = rows.length > 0 ? rows : Array.isArray(payload) ? asRecordArray(payload) : [];

  const output: EnnexOsPlant[] = [];
  for (const row of items) {
    const plantId = toNullableString(row.plantId ?? row.plant_id ?? row.id);
    if (!plantId) continue;

    const location =
      toNullableString(row.location) ??
      (([toNullableString(row.street), toNullableString(row.city), toNullableString(row.country)]
        .filter(Boolean)
        .join(", ")) ||
        null);

    output.push({
      plantId,
      name: toNullableString(row.name ?? row.displayName ?? row.plantName) ?? `Plant ${plantId}`,
      location,
      timeZone: toNullableString(row.timeZone ?? row.timezone),
      status: toNullableString(row.status ?? row.lifecycleStatus),
    });
  }

  return output;
}

export async function listPlants(context: EnnexOsApiContext): Promise<{
  plants: EnnexOsPlant[];
  raw: unknown;
}> {
  const raw = await getEnnexOsJson("/monitoring/v1/plants", context);
  return {
    plants: extractPlants(raw),
    raw,
  };
}

export async function getPlantDetails(context: EnnexOsApiContext, plantId: string): Promise<unknown> {
  return getEnnexOsJson(`/monitoring/v1/plants/${encodeURIComponent(plantId)}`, context);
}

export async function getPlantDevices(context: EnnexOsApiContext, plantId: string): Promise<EnnexOsDevice[]> {
  const raw = await getEnnexOsJson(`/monitoring/v1/plants/${encodeURIComponent(plantId)}/devices`, context);
  const root = asRecord(raw);
  const rows = asRecordArray(root.devices ?? root.items ?? root.data ?? root.content);
  const items = rows.length > 0 ? rows : Array.isArray(raw) ? asRecordArray(raw) : [];

  const output: EnnexOsDevice[] = [];
  for (const row of items) {
    const deviceId = toNullableString(row.deviceId ?? row.device_id ?? row.id);
    if (!deviceId) continue;

    const statusRaw = toNullableString(row.status ?? row.state)?.toLowerCase() ?? "";
    const onlineFlag = row.isOnline === true || row.online === true || statusRaw.includes("online");
    const activeFlag = row.isActive === true || row.active === true || !statusRaw.includes("inactive");

    output.push({
      deviceId,
      deviceType: toNullableString(row.deviceType ?? row.type),
      name: toNullableString(row.name ?? row.displayName),
      manufacturer: toNullableString(row.manufacturer),
      model: toNullableString(row.model),
      serialNumber: toNullableString(row.serialNumber ?? row.serial_number ?? row.sn),
      isActive: activeFlag,
      isOnline: onlineFlag,
    });
  }

  return output;
}

export async function getPlantMeasurements(
  context: EnnexOsApiContext,
  plantId: string,
  measurementSet = "EnergyBalance",
  period = "Day",
  date?: string | null
): Promise<unknown> {
  const encodedPlantId = encodeURIComponent(plantId);
  const encodedSet = encodeURIComponent(measurementSet);
  const encodedPeriod = encodeURIComponent(period);
  const candidates = [
    `/monitoring/v2/plants/${encodedPlantId}/measurements/sets/${encodedSet}/${encodedPeriod}`,
    `/monitoring/v1/plants/${encodedPlantId}/measurements/sets/${encodedSet}/${encodedPeriod}`,
    `/monitoring/v2/plants/${encodedPlantId}/measurements/${encodedSet}/${encodedPeriod}`,
  ];

  let lastError: unknown = null;
  for (const endpoint of candidates) {
    try {
      return await getEnnexOsJson(endpoint, context, {
        Date: date ?? undefined,
        date: date ?? undefined,
      });
    } catch (error) {
      lastError = error;
      if (!isRecoverableFallbackError(error)) throw error;
    }
  }

  throw lastError ?? new Error("No supported ennexOS measurement endpoint found for this plant.");
}

type EnergyPoint = {
  dateKey: string;
  monthKey: string;
  kwh: number;
};

function unitToKwh(value: number | null, unitRaw: string | null): number | null {
  if (value === null) return null;
  const unit = (unitRaw ?? "").trim().toLowerCase();
  if (unit.includes("kwh")) return value;
  if (unit.includes("mwh")) return value * 1000;
  if (unit.includes("wh")) return value / 1000;
  if (unit.includes("kw")) return value;
  if (Math.abs(value) > 50000) return value / 1000;
  return value;
}

function unitToPowerW(value: number | null, unitRaw: string | null): number | null {
  if (value === null) return null;
  const unit = (unitRaw ?? "").trim().toLowerCase();
  if (unit.includes("mw")) return value * 1_000_000;
  if (unit.includes("kw")) return value * 1000;
  if (unit.includes("w")) return value;
  return value;
}

function pickTimestamp(record: Record<string, unknown>): string | null {
  return (
    toNullableString(record.dateTime) ??
    toNullableString(record.logDateTime) ??
    toNullableString(record.timestamp) ??
    toNullableString(record.date) ??
    toNullableString(record.startTime) ??
    toNullableString(record.endTime) ??
    null
  );
}

function findEnergyChannel(record: Record<string, unknown>): Record<string, unknown> | null {
  const channels = asRecordArray(record.channels ?? record.measurements ?? record.values);
  if (channels.length === 0) return null;

  const preferred = channels.find((channel) => {
    const name =
      toNullableString(channel.channelName) ??
      toNullableString(channel.name) ??
      toNullableString(channel.measurementName);
    if (!name) return false;
    return /energy|generation|pv|feedin|production/i.test(name);
  });

  return preferred ?? channels[0] ?? null;
}

function extractEnergyKwhFromRecord(record: Record<string, unknown>): number | null {
  const scalarValue =
    toNullableNumber(record.energy) ??
    toNullableNumber(record.pvGeneration) ??
    toNullableNumber(record.generation) ??
    toNullableNumber(record.feedIn) ??
    toNullableNumber(record.value) ??
    toNullableNumber(record.totalEnergy) ??
    toNullableNumber(record.total) ??
    null;

  const scalarUnit =
    toNullableString(record.unit) ??
    toNullableString(record.measurementUnit) ??
    toNullableString(record.valueUnit) ??
    null;

  if (scalarValue !== null) {
    return unitToKwh(scalarValue, scalarUnit);
  }

  const channel = findEnergyChannel(record);
  if (!channel) return null;
  const channelValue = toNullableNumber(channel.value ?? channel.energy ?? channel.total ?? channel.amount);
  const channelUnit =
    toNullableString(channel.unit) ??
    toNullableString(channel.measurementUnit) ??
    toNullableString(channel.valueUnit) ??
    null;
  return unitToKwh(channelValue, channelUnit);
}

function extractMeasurementRows(payload: unknown): Array<Record<string, unknown>> {
  const root = asRecord(payload);
  const data = asRecord(root.data);

  const candidateArrays = [
    root.measurements,
    root.values,
    root.items,
    root.rows,
    root.data,
    data.measurements,
    data.values,
    data.items,
    data.rows,
  ];

  const output: Array<Record<string, unknown>> = [];
  for (const candidate of candidateArrays) {
    const rows = asRecordArray(candidate);
    if (rows.length > 0) {
      output.push(...rows);
    }
  }

  return output;
}

function extractEnergySeries(payload: unknown): EnergyPoint[] {
  const rows = extractMeasurementRows(payload);
  const output: EnergyPoint[] = [];

  for (const row of rows) {
    const timestamp = pickTimestamp(row);
    const dateKey = asDateKey(timestamp);
    if (!dateKey) continue;

    const kwh = extractEnergyKwhFromRecord(row);
    if (kwh === null) continue;

    const monthKey = asMonthKey(timestamp) ?? dateKey.slice(0, 7);
    output.push({
      dateKey,
      monthKey,
      kwh,
    });
  }

  return output;
}

function extractLatestPowerW(payload: unknown): number | null {
  const root = asRecord(payload);
  const scalarValue =
    toNullableNumber(root.currentPower) ??
    toNullableNumber(root.power) ??
    toNullableNumber(root.totalActivePower) ??
    null;
  const scalarUnit =
    toNullableString(root.unit) ??
    toNullableString(root.measurementUnit) ??
    toNullableString(root.valueUnit) ??
    null;

  const scalarW = unitToPowerW(scalarValue, scalarUnit);
  if (scalarW !== null) return safeRound(scalarW);

  const rows = extractMeasurementRows(payload);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];

    const rowValue =
      toNullableNumber(row.currentPower) ??
      toNullableNumber(row.power) ??
      toNullableNumber(row.totalActivePower) ??
      toNullableNumber(row.value) ??
      null;

    const rowUnit =
      toNullableString(row.unit) ??
      toNullableString(row.measurementUnit) ??
      toNullableString(row.valueUnit) ??
      null;

    const rowW = unitToPowerW(rowValue, rowUnit);
    if (rowW !== null) return safeRound(rowW);

    const channel = asRecord(findEnergyChannel(row));
    const channelPower = toNullableNumber(channel.currentPower ?? channel.power ?? channel.value);
    const channelUnit = toNullableString(channel.unit) ?? toNullableString(channel.valueUnit);
    const channelW = unitToPowerW(channelPower, channelUnit);
    if (channelW !== null) return safeRound(channelW);
  }

  return null;
}

function safeMonthKey(dateIso: string): string {
  return dateIso.slice(0, 7);
}

function extractLifetimeKwh(payloads: unknown[]): number | null {
  for (const payload of payloads) {
    const root = asRecord(payload);
    const summary = asRecord(root.summary ?? root.totals ?? root.total ?? root.data);
    const totalRaw =
      toNullableNumber(summary.totalEnergy) ??
      toNullableNumber(summary.energyTotal) ??
      toNullableNumber(summary.lifetimeEnergy) ??
      null;
    const totalUnit =
      toNullableString(summary.unit) ??
      toNullableString(summary.measurementUnit) ??
      null;

    const converted = unitToKwh(totalRaw, totalUnit);
    if (converted !== null) return safeRound(converted);
  }
  return null;
}

export async function getPlantProductionSnapshot(
  context: EnnexOsApiContext,
  plantIdRaw: string,
  anchorDateRaw?: string | null
): Promise<EnnexOsProductionSnapshot> {
  const plantId = plantIdRaw.trim();
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
    const dayDateArg = anchorDate;
    const monthDateArg = safeMonthKey(anchorDate);

    const [dayPayload, monthPayload] = await Promise.all([
      getPlantMeasurements(context, plantId, "EnergyBalance", "Day", dayDateArg).catch(() => null),
      getPlantMeasurements(context, plantId, "EnergyBalance", "Month", monthDateArg).catch(() => null),
    ]);

    if (!dayPayload && !monthPayload) {
      throw new Error("No EnergyBalance measurements were returned for this plant.");
    }

    const dailySeries = dayPayload ? extractEnergySeries(dayPayload) : [];
    const monthlySeries = monthPayload ? extractEnergySeries(monthPayload) : [];

    const lifetimeKwh = extractLifetimeKwh([dayPayload, monthPayload].filter(Boolean));

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

    const monthlyProductionKwh =
      sumKwh(
        dailySeries
          .filter((point) => point.dateKey >= monthlyStartDate && point.dateKey <= anchorDate)
          .map((point) => point.kwh)
      ) ??
      sumKwh(
        monthlySeries
          .filter((point) => point.monthKey === safeMonthKey(anchorDate))
          .map((point) => point.kwh)
      );

    const mtdProductionKwh = sumKwh(
      dailySeries
        .filter((point) => point.dateKey >= mtdStartDate && point.dateKey <= anchorDate)
        .map((point) => point.kwh)
    );

    const previousCalendarMonthProductionKwh =
      sumKwh(
        dailySeries
          .filter((point) => point.dateKey >= previousCalendarMonthStartDate && point.dateKey <= previousCalendarMonthEndDate)
          .map((point) => point.kwh)
      ) ??
      sumKwh(
        monthlySeries
          .filter((point) => point.monthKey === safeMonthKey(previousCalendarMonthStartDate))
          .map((point) => point.kwh)
      );

    const last12MonthsProductionKwh = sumKwh(
      monthlySeries
        .filter((point) => point.monthKey >= safeMonthKey(last12MonthsStartDate) && point.monthKey <= safeMonthKey(anchorDate))
        .map((point) => point.kwh)
    );

    return {
      plantId,
      status: "Found",
      found: true,
      lifetimeKwh,
      hourlyProductionKwh: null,
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
        plantId,
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
        error: error instanceof Error ? error.message : "Plant not found.",
      };
    }

    return {
      plantId,
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

export async function getPlantDeviceSnapshot(
  context: EnnexOsApiContext,
  plantIdRaw: string,
  anchorDateRaw?: string | null
): Promise<EnnexOsDeviceSnapshot> {
  const plantId = plantIdRaw.trim();
  const anchorDate = (anchorDateRaw ?? "").trim() || formatIsoDate(new Date());

  try {
    const [devices, detailsPayload, dayPayload] = await Promise.all([
      getPlantDevices(context, plantId),
      getPlantDetails(context, plantId).catch(() => null),
      getPlantMeasurements(context, plantId, "EnergyBalance", "Day", anchorDate).catch(() => null),
    ]);

    const inverterCount = devices.filter((device) => {
      const type = (device.deviceType ?? "").toLowerCase();
      return type.includes("inverter") || type.includes("pv");
    }).length;

    const detailRecord = asRecord(detailsPayload);
    const detailsPowerW = safeRound(
      unitToPowerW(
        toNullableNumber(detailRecord.currentPower ?? detailRecord.power ?? detailRecord.totalActivePower),
        toNullableString(detailRecord.unit ?? detailRecord.valueUnit)
      )
    );

    const currentPowerW = detailsPowerW ?? (dayPayload ? extractLatestPowerW(dayPayload) : null);
    const statusRaw = toNullableString(detailRecord.status ?? detailRecord.lifecycleStatus)?.toLowerCase() ?? "";
    const isOnline = devices.some((device) => device.isOnline) || statusRaw.includes("online");

    return {
      plantId,
      status: "Found",
      found: true,
      deviceCount: devices.length,
      inverterCount,
      currentPowerW,
      isOnline,
      error: null,
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      return {
        plantId,
        status: "Not Found",
        found: false,
        deviceCount: null,
        inverterCount: null,
        currentPowerW: null,
        isOnline: null,
        error: error instanceof Error ? error.message : "Plant not found.",
      };
    }

    return {
      plantId,
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
