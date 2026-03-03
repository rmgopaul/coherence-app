import * as XLSX from "xlsx";

type Unit = "wh" | "kwh" | "mwh" | "gwh";

type ParsedEntry = {
  ids: string[];
  names: string[];
  lifetimeWh: number | null;
};

type Rule = {
  sheetName: string;
  monitoring: string;
  startRow: number;
  enabledByDefault?: boolean;
  disabledNote?: string;
  parse: (row: unknown[]) => ParsedEntry;
};

type OutputRow = {
  monitoring: string;
  monitoringSystemId: string;
  monitoringSystemName: string;
  lifetimeMeterReadWh: number;
  readDate: string;
};

export type MeterReadsConversionResult = {
  csvText: string;
  totalRows: number;
  readDate: string;
  sourceWorkbookName: string;
  byMonitoring: Array<{ monitoring: string; rows: number }>;
  notes: string[];
};

const OUTPUT_HEADERS = [
  "monitoring",
  "monitoring_system_id",
  "monitoring_system_name",
  "lifetime_meter_read_wh",
  "status",
  "alert_severity",
  "read_date",
];

function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeName(value: unknown): string {
  return clean(value);
}

function normalizeKey(value: unknown): string {
  const raw = clean(value).replaceAll(",", "");
  if (!raw) return "";

  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      if (Number.isInteger(numeric)) return String(numeric);
      return String(Math.trunc(numeric));
    }
  }

  return raw;
}

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = clean(value);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }

  return out;
}

function normalizeUnit(raw: string | null | undefined): Unit | null {
  const unit = clean(raw).replace(/\s+/g, "").toLowerCase();
  if (unit === "wh" || unit === "kwh" || unit === "mwh" || unit === "gwh") return unit;
  return null;
}

function parseEnergyToWh(
  value: unknown,
  options?: {
    defaultUnit?: Unit;
    extraUnitText?: unknown;
  }
): number | null {
  if (value === null || value === undefined) return null;

  let amount: number | null = null;
  let unitFromValue: Unit | null = null;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    amount = value;
  } else {
    const text = clean(value);
    if (!text || text === "-" || text === "—" || text === "h" || text === "H") return null;

    const compact = text.replaceAll(",", "").replace(/\s+/g, "");
    const numberMatch = compact.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!numberMatch) return null;

    const parsed = Number(numberMatch[0]);
    if (!Number.isFinite(parsed)) return null;
    amount = parsed;

    const unitMatch = compact.match(/gwh|mwh|kwh|wh/i);
    unitFromValue = normalizeUnit(unitMatch?.[0]);
  }

  if (amount === null) return null;

  const unitFromExtra = normalizeUnit(clean(options?.extraUnitText));
  const unit = unitFromValue ?? unitFromExtra ?? options?.defaultUnit ?? "wh";
  const multipliers: Record<Unit, number> = {
    wh: 1,
    kwh: 1_000,
    mwh: 1_000_000,
    gwh: 1_000_000_000,
  };

  const converted = Math.round(amount * multipliers[unit]);
  if (!Number.isFinite(converted) || converted < 0) return null;
  return converted;
}

function colIndex(columnLetter: string): number {
  let value = 0;
  for (let i = 0; i < columnLetter.length; i += 1) {
    value = value * 26 + (columnLetter.charCodeAt(i) - 64);
  }
  return value - 1;
}

function cell(row: unknown[], columnLetter: string): unknown {
  return row[colIndex(columnLetter)] ?? "";
}

function buildOutputRows(monitoring: string, readDate: string, parsed: ParsedEntry): OutputRow[] {
  if (parsed.lifetimeWh === null) return [];

  const ids = uniqueNonEmpty(parsed.ids.map((value) => clean(value)));
  const names = uniqueNonEmpty(parsed.names.map((value) => clean(value)));
  if (ids.length === 0 && names.length === 0) return [];

  const rows: OutputRow[] = [];
  for (const id of ids) {
    rows.push({
      monitoring,
      monitoringSystemId: id,
      monitoringSystemName: "",
      lifetimeMeterReadWh: parsed.lifetimeWh,
      readDate,
    });
  }
  for (const name of names) {
    rows.push({
      monitoring,
      monitoringSystemId: "",
      monitoringSystemName: name,
      lifetimeMeterReadWh: parsed.lifetimeWh,
      readDate,
    });
  }
  if (ids.length === 1 && names.length === 1) {
    rows.push({
      monitoring,
      monitoringSystemId: ids[0],
      monitoringSystemName: names[0],
      lifetimeMeterReadWh: parsed.lifetimeWh,
      readDate,
    });
  }

  return rows;
}

function parseReadDateFromFileName(fileName: string): string {
  const match = fileName.match(/(\d{1,2})[_-](\d{1,2})[_-](\d{2,4})/);
  if (!match) {
    const now = new Date();
    return `${now.getMonth() + 1}/${now.getDate()}/${now.getFullYear()}`;
  }

  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  return `${month}/${day}/${year}`;
}

function parseAlsoEnergy(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "B"))],
    names: [normalizeName(cell(row, "C"))],
    lifetimeWh: parseEnergyToWh(cell(row, "D"), { defaultUnit: "kwh" }),
  };
}

function parseApSystems(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "E"), { defaultUnit: "mwh" }),
  };
}

function parseArrayMeter(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "A"))],
    names: [normalizeName(cell(row, "F"))],
    lifetimeWh: parseEnergyToWh(cell(row, "M"), { defaultUnit: "kwh" }),
  };
}

function parseArrayMeterTwo(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "C"))],
    lifetimeWh: parseEnergyToWh(cell(row, "G"), { defaultUnit: "mwh" }),
  };
}

function parseChilicon(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "D")),
  };
}

function parseDuracell(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "A"))],
    lifetimeWh: parseEnergyToWh(cell(row, "B"), { defaultUnit: "kwh" }),
  };
}

function parseEncompass(row: unknown[]): ParsedEntry {
  const rawName = normalizeName(cell(row, "A"));
  const firstLine = rawName.split(/\r?\n/)[0]?.trim() ?? "";
  const idMatch = rawName.match(/\bID\s*([A-Za-z0-9_-]+)\b/i);
  const siteId = idMatch?.[1] ?? "";

  return {
    ids: [normalizeKey(siteId)],
    names: [firstLine],
    lifetimeWh: parseEnergyToWh(cell(row, "B")),
  };
}

function parseEnnexOs(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "F")),
  };
}

function parseEnphase(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "D"))],
    names: [normalizeName(cell(row, "E"))],
    lifetimeWh: parseEnergyToWh(cell(row, "K"), { defaultUnit: "wh" }),
  };
}

function parseFronius(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "E")),
  };
}

function parseGenerac(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "E"), { defaultUnit: "kwh" }),
  };
}

function parseGoodWe(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "G"), { defaultUnit: "kwh" }),
  };
}

function parseGrowatt(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "B"))],
    names: [normalizeName(cell(row, "A"))],
    lifetimeWh: parseEnergyToWh(cell(row, "M"), { defaultUnit: "kwh" }),
  };
}

function parseHoymiles(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "A"))],
    lifetimeWh: parseEnergyToWh(cell(row, "B"), { defaultUnit: "kwh" }),
  };
}

function parseLocus(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "E")),
  };
}

function parseSolarEdgePrimary(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "B"))],
    names: [normalizeName(cell(row, "A"))],
    lifetimeWh: parseEnergyToWh(cell(row, "L"), { defaultUnit: "kwh" }),
  };
}

function parseSolarEdgeSecondary(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "G")),
  };
}

function parseSenseRgm(row: unknown[]): ParsedEntry {
  const siteKey = normalizeKey(cell(row, "A"));
  return {
    ids: [siteKey],
    names: [siteKey],
    lifetimeWh: parseEnergyToWh(cell(row, "E"), { defaultUnit: "kwh" }),
  };
}

function parseSolarLog(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "I"), { extraUnitText: cell(row, "J") }),
  };
}

function parseSolArk(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "C"), { defaultUnit: "kwh" }),
  };
}

function parseSolis(row: unknown[]): ParsedEntry {
  return {
    ids: [],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "D")),
  };
}

function parseSunpower(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "C"))],
    names: [normalizeName(cell(row, "B"))],
    lifetimeWh: parseEnergyToWh(cell(row, "F")),
  };
}

function parseTigo(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "B"))],
    names: [normalizeName(cell(row, "C"))],
    lifetimeWh: parseEnergyToWh(cell(row, "E")),
  };
}

function parseVisionMetering(row: unknown[]): ParsedEntry {
  return {
    ids: [normalizeKey(cell(row, "B")), normalizeKey(cell(row, "D"))],
    names: [normalizeName(cell(row, "C"))],
    lifetimeWh: parseEnergyToWh(cell(row, "F"), { defaultUnit: "kwh" }),
  };
}

const RULES: Rule[] = [
  { sheetName: "AlsoEnergy", monitoring: "AlsoEnergy", startRow: 2, parse: parseAlsoEnergy },
  { sheetName: "APSystem", monitoring: "APSystems", startRow: 2, parse: parseApSystems },
  { sheetName: "ArrayMeter", monitoring: "SDSI ArrayMeter", startRow: 2, parse: parseArrayMeter },
  { sheetName: "ArrayMeter - 2", monitoring: "SDSI ArrayMeter", startRow: 2, parse: parseArrayMeterTwo },
  { sheetName: "ChiliconPower", monitoring: "Chilicon Power", startRow: 2, parse: parseChilicon },
  { sheetName: "Duracell", monitoring: "DURACELL Power Center", startRow: 2, parse: parseDuracell },
  { sheetName: "Encompass.io", monitoring: "EKM Encompass.io", startRow: 2, parse: parseEncompass },
  {
    sheetName: "eGuage",
    monitoring: "eGauge",
    startRow: 2,
    enabledByDefault: false,
    disabledNote: "Skipped eGuage tab (disabled by configuration).",
    parse: () => ({ ids: [], names: [], lifetimeWh: null }),
  },
  { sheetName: "Ennox", monitoring: "ennexOS", startRow: 2, parse: parseEnnexOs },
  { sheetName: "Enphase", monitoring: "Enphase", startRow: 2, parse: parseEnphase },
  { sheetName: "Fronius", monitoring: "Fronius Solar.web", startRow: 2, parse: parseFronius },
  { sheetName: "Generac", monitoring: "Generac PWRfleet", startRow: 2, parse: parseGenerac },
  { sheetName: "GoodWe", monitoring: "GoodWe SEMS Portal", startRow: 3, parse: parseGoodWe },
  { sheetName: "Growatt", monitoring: "Growatt", startRow: 3, parse: parseGrowatt },
  { sheetName: "Hoymile", monitoring: "Hoymiles S-Miles Cloud", startRow: 2, parse: parseHoymiles },
  { sheetName: "Locus", monitoring: "Locus Energy", startRow: 2, parse: parseLocus },
  { sheetName: "SE", monitoring: "SolarEdge", startRow: 3, parse: parseSolarEdgePrimary },
  { sheetName: "SE2", monitoring: "SolarEdge", startRow: 3, parse: parseSolarEdgeSecondary },
  {
    sheetName: "SE3",
    monitoring: "SolarEdge",
    startRow: 2,
    enabledByDefault: false,
    disabledNote: "Skipped SE3 tab (disabled by configuration).",
    parse: () => ({ ids: [], names: [], lifetimeWh: null }),
  },
  { sheetName: "senseRGM", monitoring: "SenseRGM", startRow: 2, parse: parseSenseRgm },
  { sheetName: "SolarLog", monitoring: "Solar-Log", startRow: 2, parse: parseSolarLog },
  { sheetName: "Solark", monitoring: "Sol-Ark PowerView Inteless", startRow: 2, parse: parseSolArk },
  { sheetName: "Solis", monitoring: "Solis", startRow: 2, parse: parseSolis },
  { sheetName: "Sunpower", monitoring: "SUNPOWER", startRow: 2, parse: parseSunpower },
  { sheetName: "Tigo", monitoring: "Tigo", startRow: 2, parse: parseTigo },
  { sheetName: "VisionMetering", monitoring: "Vision Metering", startRow: 2, parse: parseVisionMetering },
];

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replaceAll("\"", "\"\"")}"`;
  }
  return value;
}

function toCsvLine(values: string[]): string {
  return values.map(csvEscape).join(",");
}

export async function convertMeterReadWorkbook(file: File): Promise<MeterReadsConversionResult> {
  const readDate = parseReadDateFromFileName(file.name);
  const notes: string[] = [];
  const byMonitoring = new Map<string, number>();
  let totalRows = 0;

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", raw: false, cellDates: false });
  const lines: string[] = [toCsvLine(OUTPUT_HEADERS)];

  for (const rule of RULES) {
    if (rule.enabledByDefault === false) {
      notes.push(rule.disabledNote ?? `Skipped ${rule.sheetName} (disabled).`);
      continue;
    }

    const sheet = workbook.Sheets[rule.sheetName];
    if (!sheet) continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });

    for (let rowIndex = rule.startRow - 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] ?? [];
      const parsed = rule.parse(row);
      const outputRows = buildOutputRows(rule.monitoring, readDate, parsed);
      if (outputRows.length === 0) continue;

      for (const outputRow of outputRows) {
        lines.push(
          toCsvLine([
            outputRow.monitoring,
            outputRow.monitoringSystemId,
            outputRow.monitoringSystemName,
            String(outputRow.lifetimeMeterReadWh),
            "",
            "",
            outputRow.readDate,
          ])
        );
      }

      totalRows += outputRows.length;
      byMonitoring.set(rule.monitoring, (byMonitoring.get(rule.monitoring) ?? 0) + outputRows.length);
    }
  }

  return {
    csvText: lines.join("\n"),
    totalRows,
    readDate,
    sourceWorkbookName: file.name,
    byMonitoring: Array.from(byMonitoring.entries())
      .map(([monitoring, rows]) => ({ monitoring, rows }))
      .sort((a, b) => a.monitoring.localeCompare(b.monitoring)),
    notes,
  };
}

export function buildMeterReadDownloadFileName(readDate: string): string {
  return `Meter Read - ${readDate.replaceAll("/", "_")} - Upload.csv`;
}
