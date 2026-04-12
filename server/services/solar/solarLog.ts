export type SolarLogApiContext = {
  baseUrl: string;
  password?: string | null;
};

export type SolarLogDevice = {
  deviceId: string;
  name: string;
  capacity: number | null;
  status: string | null;
};

export type SolarLogProductionSnapshot = {
  deviceId: string;
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
  error: string | null;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

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
  return formatIsoDate(new Date(parsed.year, parsed.month - 1, 1));
}

function firstDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  return formatIsoDate(new Date(parsed.year, parsed.month - 2, 1));
}

function lastDayOfPreviousMonth(dateIso: string): string {
  const parsed = parseIsoDate(dateIso);
  if (!parsed) throw new Error("Dates must be in YYYY-MM-DD format.");
  return formatIsoDate(new Date(parsed.year, parsed.month - 1, 0));
}

function asDateKey(value: string | null | undefined): string | null {
  const normalized = toNullableString(value);
  if (!normalized) return null;
  const leading = normalized.slice(0, 10);
  return parseIsoDate(leading) ? leading : null;
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function sumKwh(values: number[]): number | null {
  if (values.length === 0) return null;
  return safeRound(values.reduce((sum, current) => sum + current, 0));
}

function safeRound(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function toKwh(value: number | null): number | null {
  if (value === null) return null;
  return value / 1000; // Solar-Log reports in Wh
}

function isNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes("(404") || message.includes("not found") || message.includes("econnrefused");
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// HTTP layer — local device POST to /getjp
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string | null | undefined): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) throw new Error("Solar-Log base URL (device IP) is required.");
  return trimmed.replace(/\/+$/, "");
}

async function postSolarLogJson(
  context: SolarLogApiContext,
  command: Record<string, unknown>
): Promise<unknown> {
  const baseUrl = normalizeBaseUrl(context.baseUrl);
  const url = `${baseUrl}/getjp`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (context.password) {
    // Solar-Log uses basic auth or password in request body depending on firmware
    headers.Authorization = `Basic ${Buffer.from(`user:${context.password}`).toString("base64")}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Solar-Log authentication failed (${response.status}). Check device password.${errorText ? ` ${errorText}` : ""}`
      );
    }
    throw new Error(
      `Solar-Log request failed (${response.status} ${response.statusText})${errorText ? `: ${errorText}` : ""}`
    );
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Data command codes
// ---------------------------------------------------------------------------

// Solar-Log JSON API command codes:
// 801.170 = current/last data (PDC, PAC, yield today/total, etc.)
// 782.170 = daily yield array (Wh per day)
// 783.170 = monthly yield array (Wh per month)

async function getLastData(context: SolarLogApiContext): Promise<Record<string, unknown>> {
  const raw = await postSolarLogJson(context, { "801": { "170": null } });
  const root = asRecord(raw);
  const data801 = asRecord(root["801"]);
  const data170 = asRecord(data801["170"]);
  return data170;
}

async function getDailyYieldArray(context: SolarLogApiContext): Promise<Array<{ dateKey: string; kwh: number }>> {
  const points: Array<{ dateKey: string; kwh: number }> = [];

  try {
    const raw = await postSolarLogJson(context, { "782": { "170": null } });
    const root = asRecord(raw);
    const data782 = asRecord(root["782"]);
    const data170 = asRecord(data782["170"]);

    // Solar-Log returns daily yields as { "dd/mm/yyyy": whValue, ... } or indexed
    for (const [key, value] of Object.entries(data170)) {
      const wh = toNullableNumber(value);
      if (wh === null) continue;

      // Try parsing date key in various formats
      let dateKey: string | null = null;

      // Try dd/mm/yyyy format
      const dmyMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(key);
      if (dmyMatch) {
        const day = String(Number(dmyMatch[1])).padStart(2, "0");
        const month = String(Number(dmyMatch[2])).padStart(2, "0");
        dateKey = `${dmyMatch[3]}-${month}-${day}`;
      }

      // Try yyyy-mm-dd format
      if (!dateKey) dateKey = asDateKey(key);

      // Try mm/dd/yyyy format
      if (!dateKey) {
        const mdyMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(key);
        if (mdyMatch) {
          const month = String(Number(mdyMatch[1])).padStart(2, "0");
          const day = String(Number(mdyMatch[2])).padStart(2, "0");
          dateKey = `${mdyMatch[3]}-${month}-${day}`;
        }
      }

      if (dateKey) {
        const kwh = toKwh(wh);
        if (kwh !== null) {
          points.push({ dateKey, kwh: safeRound(kwh)! });
        }
      }
    }
  } catch {
    // Non-critical
  }

  return points;
}

async function getMonthlyYieldArray(context: SolarLogApiContext): Promise<Array<{ dateKey: string; kwh: number }>> {
  const points: Array<{ dateKey: string; kwh: number }> = [];

  try {
    const raw = await postSolarLogJson(context, { "783": { "170": null } });
    const root = asRecord(raw);
    const data783 = asRecord(root["783"]);
    const data170 = asRecord(data783["170"]);

    for (const [key, value] of Object.entries(data170)) {
      const wh = toNullableNumber(value);
      if (wh === null) continue;

      // Try mm/yyyy format
      const myMatch = /^(\d{1,2})\/(\d{4})$/.exec(key);
      if (myMatch) {
        const month = String(Number(myMatch[1])).padStart(2, "0");
        const dateKey = `${myMatch[2]}-${month}-01`;
        const kwh = toKwh(wh);
        if (kwh !== null) {
          points.push({ dateKey, kwh: safeRound(kwh)! });
        }
      }
    }
  } catch {
    // Non-critical
  }

  return points;
}

// ---------------------------------------------------------------------------
// Extraction: Devices (Solar-Log is typically a single device)
// ---------------------------------------------------------------------------

export function extractDevices(payload: unknown): SolarLogDevice[] {
  const root = asRecord(payload);
  // Solar-Log is typically a single datalogger, but may have multiple inverters
  // Treat the Solar-Log device itself as the "site"
  const deviceId = toNullableString(root.serialNumber ?? root.serial ?? root.sn) ?? "solar-log-1";

  return [{
    deviceId,
    name: toNullableString(root.name ?? root.plantName ?? root.siteName) ?? "Solar-Log Device",
    capacity: toNullableNumber(root.capacity ?? root.peakPower ?? root.installedPower),
    status: toNullableString(root.status),
  }];
}

// ---------------------------------------------------------------------------
// API: List Devices (returns single Solar-Log device)
// ---------------------------------------------------------------------------

export async function listDevices(context: SolarLogApiContext): Promise<{
  devices: SolarLogDevice[];
  raw: unknown;
}> {
  const raw = await getLastData(context);
  return {
    devices: extractDevices(raw),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Production Snapshot
// ---------------------------------------------------------------------------

export async function getDeviceProductionSnapshot(
  context: SolarLogApiContext,
  deviceIdRaw: string,
  anchorDateRaw?: string | null,
  nameOverride?: string | null
): Promise<SolarLogProductionSnapshot> {
  const deviceId = deviceIdRaw.trim() || "solar-log-1";
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
    const [lastData, dailySeries, monthlySeries] = await Promise.all([
      getLastData(context),
      getDailyYieldArray(context),
      getMonthlyYieldArray(context),
    ]);

    // Extract lifetime from last data
    const totalYieldWh = toNullableNumber(
      lastData.totalYield ?? lastData.total_yield ?? lastData.Yield_Total ?? lastData.YieldTotal
    );
    const lifetimeKwh = safeRound(toKwh(totalYieldWh));

    // Extract today's yield from last data
    const todayYieldWh = toNullableNumber(
      lastData.dayYield ?? lastData.day_yield ?? lastData.Yield_Day ?? lastData.YieldDay
    );
    const todayKwh = safeRound(toKwh(todayYieldWh));

    const hourlyProductionKwh: number | null = null;

    const dailyProductionKwh =
      todayKwh ??
      sumKwh(dailySeries.filter((p) => p.dateKey === anchorDate).map((p) => p.kwh));

    const weeklyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= weeklyStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const monthlyProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= monthlyStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const mtdProductionKwh = sumKwh(
      dailySeries.filter((p) => p.dateKey >= mtdStartDate && p.dateKey <= anchorDate).map((p) => p.kwh)
    );

    const previousCalendarMonthProductionKwh = sumKwh(
      dailySeries
        .filter((p) => p.dateKey >= previousCalendarMonthStartDate && p.dateKey <= previousCalendarMonthEndDate)
        .map((p) => p.kwh)
    );

    const last12MonthsProductionKwh = sumKwh(
      monthlySeries
        .filter((p) => p.dateKey >= last12MonthsStartDate)
        .map((p) => p.kwh)
    );

    return {
      deviceId,
      name,
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
    const isNf = isNotFoundError(error);
    return {
      deviceId,
      name,
      status: isNf ? "Not Found" : "Error",
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
