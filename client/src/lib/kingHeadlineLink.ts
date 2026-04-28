/**
 * Task 10.4 (2026-04-28) — King of the Day headline deep-link.
 *
 * Pure helper that turns a `kingOfDay` row + the dashboard's
 * already-fetched `calendarEvents` list into a deep-link URL the
 * hero's `<h1>` headline can wrap in an anchor.
 *
 * Resolution rules (in priority order):
 *
 *   1. `taskId`  → `https://todoist.com/app/task/<id>`
 *      The Todoist web app accepts a bare task ID at this path; same
 *      pattern used by `DashboardLegacy.tsx` and the river feed.
 *   2. `eventId` → matched event's `htmlLink` from `calendarEvents`
 *      The hero already has the upcoming-events list as a prop, so we
 *      reuse it instead of round-tripping a separate fetch. Google
 *      Calendar's `htmlLink` is the canonical "open in your default
 *      calendar UI" deep link — accepts any signed-in user's
 *      browser session, doesn't require URL surgery on our side.
 *   3. neither  → `null` (caller renders the headline as plain text).
 *
 * The `eventId` branch can also return `null` if the matching event
 * isn't in the supplied `calendarEvents` list (e.g. it's outside
 * the dashboard's lookahead window). Falling back to a hand-built
 * `?eid=<base64>` URL is fragile because the base64 includes the
 * calendar ID — without that we'd ship a URL that 404s. Better to
 * keep the headline plain than to ship a broken link.
 */

export interface KingHeadlineLinkInput {
  taskId: string | null | undefined;
  eventId: string | null | undefined;
}

export interface CalendarEventLite {
  id?: string | null;
  htmlLink?: string | null;
}

const TODOIST_TASK_URL_PREFIX = "https://todoist.com/app/task/";

/**
 * Returns the deep-link URL for a king-of-the-day headline, or `null`
 * if no link can be resolved. Pure — exposed as the testable surface
 * so the hero component itself doesn't need React-aware tests.
 */
export function resolveKingHeadlineHref(
  king: KingHeadlineLinkInput | null | undefined,
  calendarEvents: ReadonlyArray<CalendarEventLite> = []
): string | null {
  if (!king) return null;

  const taskId = typeof king.taskId === "string" ? king.taskId.trim() : "";
  if (taskId) {
    return `${TODOIST_TASK_URL_PREFIX}${encodeURIComponent(taskId)}`;
  }

  const eventId = typeof king.eventId === "string" ? king.eventId.trim() : "";
  if (eventId) {
    const matching = calendarEvents.find((event) => {
      const id = typeof event?.id === "string" ? event.id : null;
      return id === eventId;
    });
    const htmlLink =
      typeof matching?.htmlLink === "string" ? matching.htmlLink.trim() : "";
    if (htmlLink) return htmlLink;
  }

  return null;
}
