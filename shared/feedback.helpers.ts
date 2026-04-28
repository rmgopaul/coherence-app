/**
 * Phase E (2026-04-28) — pure helpers for the admin feedback review
 * dashboard. Lives in `shared/` so it's reachable from both the
 * client (filter/sort the in-memory list) and the server (the
 * `feedback.listRecent` proc imports `FEEDBACK_STATUSES` here so the
 * zod enum + the dashboard render share a single source of truth).
 *
 * No DB, no DOM — just data shaping over the row shape returned
 * by `feedback.listRecent`.
 */

/**
 * Recognized feedback statuses. Stored as a varchar (no DB enum)
 * but the proc layer validates against this list so the column
 * doesn't drift. Order matches the review dashboard's pipeline
 * narrative: open → triaged → in-progress → resolved | wont-fix.
 */
export const FEEDBACK_STATUSES = [
  "open",
  "triaged",
  "in-progress",
  "resolved",
  "wont-fix",
] as const;

export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** True when `value` is one of the recognized statuses. Pure. */
export function isFeedbackStatus(value: string): value is FeedbackStatus {
  return (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

export const FEEDBACK_CATEGORIES = [
  "improvement",
  "bug",
  "ui",
  "data",
  "workflow",
  "other",
] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/**
 * Counts of recent feedback rows by status, used by the admin
 * dashboard's pipeline summary chips. Pure — exposed for
 * testability.
 */
export function summarizeFeedbackByStatus<R extends { status: string }>(
  rows: readonly R[]
): Record<FeedbackStatus, number> {
  const out: Record<FeedbackStatus, number> = {
    open: 0,
    triaged: 0,
    "in-progress": 0,
    resolved: 0,
    "wont-fix": 0,
  };
  for (const row of rows) {
    if (isFeedbackStatus(row.status)) {
      out[row.status] += 1;
    }
  }
  return out;
}

/**
 * Row shape consumed by the dashboard. Mirrors the `userFeedback`
 * table columns we read in `listRecentUserFeedback`. Defined locally
 * (rather than imported from drizzle) so this module stays free of
 * server-only dependencies and can be unit-tested in any environment.
 */
export interface FeedbackRow {
  id: string;
  userId: number;
  pagePath: string;
  sectionId: string | null;
  category: string;
  note: string;
  status: string;
  contextJson: string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
}

export interface FeedbackFilter {
  /** "all" / undefined = no status restriction. */
  status?: string;
  /** "all" / undefined = no category restriction. */
  category?: string;
  /**
   * Free-form search over `note`, `pagePath`, and `sectionId`. Empty
   * string = no search. Case-insensitive substring match.
   */
  search?: string;
}

/**
 * Apply the dashboard filter bar to a list of feedback rows. Pure
 * — exposed for testability and for the server-side counter-balance
 * a future `feedback.search` proc would want.
 *
 * Empty / "all" filters are no-ops. The search term is trimmed and
 * lower-cased once; rows with a missing field on a particular
 * dimension simply don't match (rather than throwing).
 */
export function filterFeedbackRows(
  rows: readonly FeedbackRow[],
  filter: FeedbackFilter
): FeedbackRow[] {
  const status =
    filter.status && filter.status !== "all" ? filter.status : null;
  const category =
    filter.category && filter.category !== "all" ? filter.category : null;
  const search = (filter.search ?? "").trim().toLowerCase();

  return rows.filter((row) => {
    if (status && row.status !== status) return false;
    if (category && row.category !== category) return false;
    if (search) {
      const haystack = [
        row.note,
        row.pagePath,
        row.sectionId ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

const STATUS_GROUP: Record<string, number> = {
  open: 0,
  triaged: 0,
  "in-progress": 0,
  resolved: 1,
  "wont-fix": 1,
};

/**
 * Stable client-side sort: open/triaged/in-progress first (newest
 * within), then resolved/wont-fix at the bottom. Within a group we
 * sort by `createdAt` descending. Pure — exposed for testability.
 *
 * The dashboard renders the most actionable rows at the top so a
 * reviewer can triage without scrolling past closed items.
 */
export function sortFeedbackForReview(
  rows: readonly FeedbackRow[]
): FeedbackRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const ga = STATUS_GROUP[a.status] ?? 0;
    const gb = STATUS_GROUP[b.status] ?? 0;
    if (ga !== gb) return ga - gb;
    const ta = toMillis(a.createdAt);
    const tb = toMillis(b.createdAt);
    return tb - ta;
  });
  return copy;
}

function toMillis(value: Date | string | null): number {
  if (!value) return 0;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : 0;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Distinct page paths in the row list. The dashboard exposes them
 * as quick-filter chips so a reviewer can jump from "all feedback"
 * to "feedback for /supplements" with one click. Sorted by descending
 * count so the noisiest pages surface first.
 */
export function topPagePaths(
  rows: readonly FeedbackRow[],
  limit = 12
): Array<{ pagePath: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const p = (row.pagePath ?? "").trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([pagePath, count]) => ({ pagePath, count }))
    .sort((a, b) => b.count - a.count || a.pagePath.localeCompare(b.pagePath))
    .slice(0, Math.max(1, limit));
}
