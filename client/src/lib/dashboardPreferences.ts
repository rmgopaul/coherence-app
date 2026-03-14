export const DASHBOARD_HEADER_TOOL_BUTTON_OPTIONS = [
  { key: "notebook", label: "Notebook" },
  { key: "solarRec", label: "Solar REC" },
  { key: "invoiceMatch", label: "Invoice Match" },
  { key: "deepUpdate", label: "Deep Update" },
  { key: "contractScanner", label: "Contract Scanner" },
  { key: "enphaseV4", label: "Enphase v4" },
  { key: "solarEdgeApi", label: "SolarEdge API" },
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
