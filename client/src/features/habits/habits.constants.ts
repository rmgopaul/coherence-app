/**
 * Shared constants for the Habits feature.
 * Kept tiny and co-located per CLAUDE.md's `feature.constants.ts` convention.
 */

export const SECTION_ID = "section-tracking";

export const HABITS_TABS = [
  "today",
  "protocol",
  "history",
  "sleep",
  "insights",
] as const;
export type HabitsTab = (typeof HABITS_TABS)[number];
export const DEFAULT_TAB: HabitsTab = "today";

export const HISTORY_WINDOW_OPTIONS = [30, 90, 365] as const;
export type HistoryWindow = (typeof HISTORY_WINDOW_OPTIONS)[number];

/** Sleep metrics surfaced in the dedicated Sleep tab's report table. */
export const SLEEP_REPORT_METRICS = [
  { key: "whoopSleepHours", label: "Sleep hours (Whoop)" },
  { key: "whoopHrvMs", label: "HRV (ms)" },
  { key: "samsungSleepScore", label: "Sleep score (Samsung)" },
  { key: "samsungSleepHours", label: "Sleep hours (Samsung)" },
] as const;

/** Colors available for habits + categories. Matches shadcn Tailwind tokens. */
export const HABIT_COLORS = [
  "slate",
  "emerald",
  "blue",
  "violet",
  "rose",
  "amber",
] as const;
export type HabitColor = (typeof HABIT_COLORS)[number];
