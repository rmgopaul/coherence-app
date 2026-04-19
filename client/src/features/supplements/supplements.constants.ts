/**
 * Shared constants for the Supplements feature.
 *
 * Kept tiny and co-located per CLAUDE.md's `feature.constants.ts` convention.
 */

/** DOM id used by GlobalFeedbackWidget's section-discovery scan. */
export const SECTION_ID = "section-supplements";

/** Tab keys on the standalone /supplements page. */
export const SUPPLEMENTS_TABS = ["today", "protocol", "history", "insights"] as const;
export type SupplementsTab = (typeof SUPPLEMENTS_TABS)[number];

export const DEFAULT_TAB: SupplementsTab = "today";

/** Default window for adherence stats shown on the dashboard card (days). */
export const DEFAULT_DASHBOARD_ADHERENCE_WINDOW_DAYS = 7;

/** Default window for adherence stats shown on the standalone page (days). */
export const DEFAULT_PAGE_ADHERENCE_WINDOW_DAYS = 30;
