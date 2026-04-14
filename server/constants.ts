/**
 * Shared named constants.
 *
 * Previously magic numbers scattered across routers.ts.
 */

/** Number of hours in a calendar year (365 × 24). */
export const HOURS_PER_YEAR = 8760;

/** Per-year degradation factor applied to solar production estimates. */
export const ANNUAL_DEGRADATION_FACTOR = 0.995;

/** Search scoring weights — higher = better match. */
export const SEARCH_SCORE_EXACT = 120;
export const SEARCH_SCORE_PREFIX = 90;
export const SEARCH_SCORE_CONTAINS = 60;
export const SEARCH_SCORE_ALL_TOKENS = 45;

/** Default timeout for outbound HTTP fetches (ms). */
export const FETCH_TIMEOUT_MS = 7000;

/** Time-to-live for long-running job state (24 hours). */
export const JOB_TTL_MS = 24 * 60 * 60 * 1000;
