/**
 * Shared constants for the Health feature.
 */

export const SECTION_ID = "section-health";

export const HEALTH_TABS = ["today", "trends", "sleep", "insights"] as const;
export type HealthTab = (typeof HEALTH_TABS)[number];
export const DEFAULT_TAB: HealthTab = "today";

export const TREND_WINDOW_OPTIONS = [30, 90, 365] as const;
export type TrendWindow = (typeof TREND_WINDOW_OPTIONS)[number];

/**
 * The 11 metrics on `dailyHealthMetrics` grouped for UI pickers.
 * Matches the enum used server-side in supplements.getCorrelation and
 * habits.getCorrelation.
 */
export const HEALTH_METRICS = [
  { key: "whoopRecoveryScore", label: "Recovery score", group: "Whoop", unit: "%" },
  { key: "whoopDayStrain", label: "Day strain", group: "Whoop", unit: "" },
  { key: "whoopSleepHours", label: "Sleep hours (Whoop)", group: "Whoop", unit: "h" },
  { key: "whoopHrvMs", label: "HRV", group: "Whoop", unit: "ms" },
  { key: "whoopRestingHr", label: "Resting HR", group: "Whoop", unit: "bpm" },
  { key: "samsungSteps", label: "Steps", group: "Samsung", unit: "" },
  { key: "samsungSleepHours", label: "Sleep hours (Samsung)", group: "Samsung", unit: "h" },
  { key: "samsungSpo2AvgPercent", label: "SpO₂ avg", group: "Samsung", unit: "%" },
  { key: "samsungSleepScore", label: "Sleep score (Samsung)", group: "Samsung", unit: "" },
  { key: "samsungEnergyScore", label: "Energy score", group: "Samsung", unit: "" },
  { key: "todoistCompletedCount", label: "Tasks completed", group: "Productivity", unit: "" },
] as const;

export type HealthMetricKey = (typeof HEALTH_METRICS)[number]["key"];

export const METRIC_GROUPS = Array.from(
  new Set(HEALTH_METRICS.map((m) => m.group))
);

/** Canonical tags the Sleep journal offers as one-click chips. */
export const SLEEP_QUICK_TAGS = [
  "late caffeine",
  "alcohol",
  "travel",
  "sick",
  "late workout",
  "late meal",
  "high stress",
] as const;
