/**
 * Shared constants for the Dashboard page.
 *
 * Extracted from Dashboard.tsx during refactoring.
 */

import type { LucideIcon } from "lucide-react";
import {
  FileText,
  Clock3,
  BarChart3,
  FileSpreadsheet,
  Database,
} from "lucide-react";
import type { DashboardHeaderToolButtonKey } from "@/lib/dashboardPreferences";

/** LocalStorage key for the cached daily-brief payload. */
export const DAILY_BRIEF_CACHE_KEY = "dailyBriefCacheV1";

/** Open-Meteo weather code → human label. */
export const WEATHER_CODE_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Rime fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Dense drizzle",
  56: "Freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  66: "Freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Heavy rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Severe thunderstorm with hail",
};

export type DashboardHeaderButtonConfig = {
  key: DashboardHeaderToolButtonKey;
  label: string;
  route: string;
  icon: LucideIcon;
};

/** Top-of-dashboard tool button configuration (navigate to tools/apps). */
export const DASHBOARD_HEADER_BUTTONS: DashboardHeaderButtonConfig[] = [
  { key: "notebook", label: "Notebook", route: "/notes", icon: FileText },
  { key: "clockifyTracker", label: "Clockify", route: "/widget/clockify", icon: Clock3 },
  { key: "solarRec", label: "Solar REC", route: "/solar-rec-dashboard", icon: BarChart3 },
  { key: "invoiceMatch", label: "Invoice Match", route: "/invoice-match-dashboard", icon: FileSpreadsheet },
  { key: "deepUpdate", label: "Deep Update", route: "/deep-update-synthesizer", icon: FileSpreadsheet },
  { key: "contractScanner", label: "Contract Scanner", route: "/contract-scanner", icon: FileText },
  { key: "contractScraper", label: "Contract Scraper", route: "/contract-scrape-manager", icon: FileText },
  { key: "enphaseV4", label: "Enphase v4", route: "/enphase-v4-meter-reads", icon: Database },
  { key: "solarEdgeApi", label: "SolarEdge API", route: "/solaredge-meter-reads", icon: Database },
  { key: "froniusApi", label: "Fronius API", route: "/fronius-meter-reads", icon: Database },
  { key: "ennexOsApi", label: "ennexOS API", route: "/ennexos-meter-reads", icon: Database },
  { key: "egaugeApi", label: "eGauge API", route: "/egauge-api", icon: Database },
  { key: "teslaSolarApi", label: "Tesla Solar API", route: "/tesla-solar-api", icon: Database },
  { key: "teslaPowerhubApi", label: "Tesla Powerhub API", route: "/tesla-powerhub-api", icon: Database },
  { key: "zendeskApi", label: "Zendesk API", route: "/zendesk-ticket-metrics", icon: Database },
];

/** All-day events with these summaries are location/status markers, not actionable events. */
export const IGNORED_ALL_DAY_SUMMARIES = new Set([
  "home",
  "office",
  "wfh",
  "work from home",
  "remote",
  "travel",
  "vacation",
  "ooo",
  "out of office",
]);
