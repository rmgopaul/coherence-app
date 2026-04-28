/**
 * Shared constants for the Settings page.
 *
 * Extracted from Settings.tsx during refactoring.
 */

export const SECTION_LABELS: Record<string, string> = {
  "section-headlines": "Headlines & Markets",
  "section-overview": "Today's Plan",
  "section-health": "Samsung Health",
  "section-whoop": "WHOOP",
  "section-dailylog": "Daily Log Trend",
  "section-supplements": "Supplements",
  "section-tracking": "Habits",
  "section-notes": "Notes",
  "section-triage": "Triage Inbox",
  "section-calendar": "Calendar",
  "section-todoist": "Todoist",
  "section-emails": "Emails",
  "section-drive": "Drive Files",
  "section-workspace": "Workspace",
  "section-chat": "Chat",
};

export const RATING_COLORS: Record<string, string> = {
  essential: "bg-emerald-100 text-emerald-800",
  useful: "bg-blue-100 text-blue-800",
  "rarely-use": "bg-amber-100 text-amber-800",
  remove: "bg-red-100 text-red-800",
};

export const OPENAI_MODELS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
];

export const ANTHROPIC_MODELS = [
  "claude-sonnet-4-20250514",
  "claude-haiku-4-20250414",
];

export const TODOIST_DEFAULT_OPTIONS = [
  { value: "all", label: "All open tasks" },
  { value: "#Inbox", label: "Inbox" },
  { value: "today", label: "Today" },
  { value: "upcoming", label: "Upcoming (7 days)" },
];

export const HABIT_COLOR_OPTIONS = [
  "slate",
  "emerald",
  "blue",
  "violet",
  "rose",
  "amber",
];

/**
 * Phase E (2026-04-28) — top-level tabs on the Settings page.
 *
 * The page used to be a single 2,500-line scroll. Tabs group the
 * 13 sections by intent so the top of the page is no longer a wall
 * of section headers. Order here = order rendered in the TabsList.
 *
 * Each tab id is also the URL hash fragment (`/settings#profile`,
 * `/settings#integrations`) so deep links + page refreshes keep
 * the user on the same tab.
 */
export const SETTINGS_TABS = [
  { id: "profile", label: "Profile" },
  { id: "tracking", label: "Tracking" },
  { id: "integrations", label: "Integrations" },
  { id: "ai", label: "AI" },
  { id: "oauth", label: "OAuth" },
  { id: "data", label: "Data" },
] as const;

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

export const SETTINGS_DEFAULT_TAB: SettingsTabId = "profile";

/**
 * Maps each Settings section key to the tab it lives under. The
 * keys here are short identifiers; the actual section render
 * call sites pass them to the `showSection` helper alongside the
 * existing keyword string used by the search bar.
 */
export const SETTINGS_SECTION_TAB: Record<string, SettingsTabId> = {
  dataExport: "data",
  profile: "profile",
  appearance: "profile",
  twoFactor: "profile",
  supplements: "tracking",
  habits: "tracking",
  todoist: "integrations",
  timeTracking: "integrations",
  google: "integrations",
  fitness: "integrations",
  openai: "ai",
  anthropic: "ai",
  oauth: "oauth",
  engagement: "data",
};
