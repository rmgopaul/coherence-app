export const DASHBOARD_HEADER_TOOL_BUTTON_OPTIONS = [
  { key: "notebook", label: "Notebook" },
  { key: "clockifyTracker", label: "Clockify" },
  { key: "solarRec", label: "Solar REC" },
  { key: "invoiceMatch", label: "Invoice Match" },
  { key: "deepUpdate", label: "Deep Update" },
  { key: "contractScanner", label: "Contract Scanner" },
  { key: "enphaseV4", label: "Enphase v4" },
  { key: "solarEdgeApi", label: "SolarEdge API" },
  { key: "froniusApi", label: "Fronius API" },
  { key: "ennexOsApi", label: "ennexOS API" },
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
