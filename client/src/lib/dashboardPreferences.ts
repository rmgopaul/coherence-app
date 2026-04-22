export const DASHBOARD_HEADER_TOOL_BUTTON_OPTIONS = [
  { key: "notebook", label: "Notebook" },
  { key: "solarRec", label: "Solar REC" },
  { key: "invoiceMatch", label: "Invoice Match" },
  { key: "deepUpdate", label: "Deep Update" },
  { key: "contractScanner", label: "Contract Scanner" },
  { key: "contractScraper", label: "Contract Scraper" },
  { key: "enphaseV4", label: "Enphase v4" },
  { key: "solarEdgeApi", label: "SolarEdge API" },
  { key: "froniusApi", label: "Fronius API" },
  { key: "ennexOsApi", label: "ennexOS API" },
  { key: "egaugeApi", label: "eGauge API" },
  { key: "teslaSolarApi", label: "Tesla Solar API" },
  { key: "teslaPowerhubApi", label: "Tesla Powerhub API" },
  { key: "zendeskApi", label: "Zendesk API" },
] as const;

export type DashboardHeaderToolButtonKey =
  (typeof DASHBOARD_HEADER_TOOL_BUTTON_OPTIONS)[number]["key"];

const HIDDEN_BUTTONS_FIELD = "dashboardHiddenHeaderButtons";

function parseWidgetLayoutObject(
  widgetLayout: string | null | undefined
): Record<string, unknown> {
  if (!widgetLayout) return {};

  try {
    const parsed = JSON.parse(widgetLayout);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Keep resilient fallback for malformed preference payloads.
  }

  return {};
}

export function getHiddenDashboardHeaderButtons(
  widgetLayout: string | null | undefined
): DashboardHeaderToolButtonKey[] {
  const parsed = parseWidgetLayoutObject(widgetLayout);
  const candidateValues = parsed[HIDDEN_BUTTONS_FIELD];
  if (!Array.isArray(candidateValues)) return [];

  const allowed = new Set<DashboardHeaderToolButtonKey>(
    DASHBOARD_HEADER_TOOL_BUTTON_OPTIONS.map((option) => option.key)
  );

  return candidateValues
    .map((value) => String(value).trim())
    .filter((value): value is DashboardHeaderToolButtonKey => allowed.has(value as DashboardHeaderToolButtonKey));
}

export function buildDashboardWidgetLayoutWithHiddenButtons(
  widgetLayout: string | null | undefined,
  hiddenKeys: DashboardHeaderToolButtonKey[]
): string {
  const parsed = parseWidgetLayoutObject(widgetLayout);
  const uniqueHiddenKeys = Array.from(new Set(hiddenKeys));

  if (uniqueHiddenKeys.length === 0) {
    delete parsed[HIDDEN_BUTTONS_FIELD];
  } else {
    parsed[HIDDEN_BUTTONS_FIELD] = uniqueHiddenKeys;
  }

  return JSON.stringify(parsed);
}

// ── Per-Section Visibility ──────────────────────────────────────────

export type DashboardSectionKey =
  | "headlines"
  | "supplements"
  | "notes"
  | "workspace"
  | "chat";

export const DASHBOARD_SECTION_OPTIONS: Array<{
  key: DashboardSectionKey;
  label: string;
}> = [
  { key: "headlines", label: "Headlines & Markets" },
  { key: "supplements", label: "Supplements" },
  { key: "notes", label: "Notes" },
  { key: "workspace", label: "Workspace" },
  { key: "chat", label: "Chat" },
];

const HIDDEN_SECTIONS_FIELD = "dashboardHiddenSections";
const MARKET_STOCK_SYMBOLS_FIELD = "dashboardMarketStockSymbols";
const MARKET_CRYPTO_SYMBOLS_FIELD = "dashboardMarketCryptoSymbols";

const DEFAULT_MARKET_STOCK_SYMBOLS = ["GEVO", "MNTK", "PLUG", "ALTO", "REX"] as const;
const DEFAULT_MARKET_CRYPTO_SYMBOLS = ["BTC-USD", "ETH-USD"] as const;

export function getHiddenDashboardSections(
  widgetLayout: string | null | undefined
): DashboardSectionKey[] {
  const parsed = parseWidgetLayoutObject(widgetLayout);
  const candidateValues = parsed[HIDDEN_SECTIONS_FIELD];
  if (!Array.isArray(candidateValues)) return [];

  const allowed = new Set<DashboardSectionKey>(
    DASHBOARD_SECTION_OPTIONS.map((o) => o.key)
  );

  return candidateValues
    .map((v) => String(v).trim())
    .filter((v): v is DashboardSectionKey =>
      allowed.has(v as DashboardSectionKey)
    );
}

export function buildWidgetLayoutWithHiddenSections(
  widgetLayout: string | null | undefined,
  hiddenSections: DashboardSectionKey[]
): string {
  const parsed = parseWidgetLayoutObject(widgetLayout);
  const unique = Array.from(new Set(hiddenSections));

  if (unique.length === 0) {
    delete parsed[HIDDEN_SECTIONS_FIELD];
  } else {
    parsed[HIDDEN_SECTIONS_FIELD] = unique;
  }

  return JSON.stringify(parsed);
}

function normalizeStockSymbol(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

function normalizeCryptoSymbol(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/\s+/g, "");
  if (!normalized) return "";
  if (normalized.includes("-")) return normalized;
  if (/^[A-Z0-9]{2,12}$/.test(normalized)) return `${normalized}-USD`;
  return normalized;
}

function parseSymbolList(
  value: unknown,
  normalize: (symbol: string) => string
): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  value.forEach((entry) => {
    const symbol = normalize(String(entry ?? ""));
    if (!symbol) return;
    if (!/^[A-Z0-9.\-]{1,20}$/.test(symbol)) return;
    if (seen.has(symbol)) return;
    seen.add(symbol);
    normalized.push(symbol);
  });

  return normalized;
}

export function parseMarketSymbolInput(
  value: string,
  kind: "stock" | "crypto"
): string[] {
  const normalize = kind === "crypto" ? normalizeCryptoSymbol : normalizeStockSymbol;

  const seen = new Set<string>();
  const normalized: string[] = [];

  value
    .split(/[\s,;\n\t]+/g)
    .map((entry) => normalize(entry))
    .forEach((symbol) => {
      if (!symbol) return;
      if (!/^[A-Z0-9.\-]{1,20}$/.test(symbol)) return;
      if (seen.has(symbol)) return;
      seen.add(symbol);
      normalized.push(symbol);
    });

  return normalized;
}

export function getDashboardMarketSymbols(widgetLayout: string | null | undefined): {
  stocks: string[];
  crypto: string[];
} {
  const parsed = parseWidgetLayoutObject(widgetLayout);

  const stocks = parseSymbolList(parsed[MARKET_STOCK_SYMBOLS_FIELD], normalizeStockSymbol);
  const crypto = parseSymbolList(parsed[MARKET_CRYPTO_SYMBOLS_FIELD], normalizeCryptoSymbol);

  return {
    stocks: stocks.length > 0 ? stocks : [...DEFAULT_MARKET_STOCK_SYMBOLS],
    crypto: crypto.length > 0 ? crypto : [...DEFAULT_MARKET_CRYPTO_SYMBOLS],
  };
}

export function buildWidgetLayoutWithMarketSymbols(
  widgetLayout: string | null | undefined,
  stocks: string[],
  crypto: string[]
): string {
  const parsed = parseWidgetLayoutObject(widgetLayout);
  const normalizedStocks = parseSymbolList(stocks, normalizeStockSymbol);
  const normalizedCrypto = parseSymbolList(crypto, normalizeCryptoSymbol);

  if (normalizedStocks.length === 0) {
    delete parsed[MARKET_STOCK_SYMBOLS_FIELD];
  } else {
    parsed[MARKET_STOCK_SYMBOLS_FIELD] = normalizedStocks;
  }

  if (normalizedCrypto.length === 0) {
    delete parsed[MARKET_CRYPTO_SYMBOLS_FIELD];
  } else {
    parsed[MARKET_CRYPTO_SYMBOLS_FIELD] = normalizedCrypto;
  }

  return JSON.stringify(parsed);
}
