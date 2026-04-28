/**
 * King of the Day — Phase C + Task 10.2 extensions (2026-04-28)
 *
 * `get`   — returns the persisted headline for (user, dateKey) or
 *           auto-selects, persists, and returns. Auto-unpins a
 *           `manual` king whose Todoist task has been completed
 *           (Task 10.2) before falling through to re-select.
 * `pin`   — upserts a `manual` row (replaces any `auto` pick).
 * `unpin` — deletes the row; next `.get()` re-runs the selector.
 *
 * The rules-based selector (`selectKingOfDay`) considers:
 *
 *   - Overdue Todoist tasks      — score 100 + priority + days
 *   - Today's P1 / P2 Todoist    — score 80 / 60
 *   - Pinned DropDock items      — score 50  (Task 10.2)
 *   - Waiting-on Gmail >7d       — score 35  (Task 10.2)
 *   - First calendar event       — score 40 (only if no others)
 *
 * Simplified from the spec — no business-hours or attachment
 * heuristics — and the AI layer from the spec is deferred behind
 * a feature flag (`SMART_KING_AI_ENABLED`, currently unused).
 *
 * See: productivity-hub/handoff/king-of-the-day.md
 */
import { z } from "zod";
import { protectedProcedure, router } from "../_core/trpc";
import {
  getKingOfDay,
  upsertKingOfDay,
  deleteKingOfDay,
  getIntegrationByProvider,
  listDockItems,
} from "../db";
import type { UserKingOfDay, DockItem } from "../../drizzle/schema";
import { getValidGoogleToken } from "../helpers/tokenRefresh";
import {
  getTodoistTasks,
  type TodoistTask,
} from "../services/integrations/todoist";
import {
  getGmailWaitingOn,
  getGoogleCalendarEvents,
} from "../services/integrations/google";
import {
  aiSelectKingOfDay,
  extractAnthropicAuth,
  isAiSelectorEnabled,
  type AiCandidate,
} from "../services/integrations/anthropicSelector";

const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

interface PickedKing {
  title: string;
  reason: string | null;
  taskId: string | null;
  eventId: string | null;
  source: "auto" | "ai";
}

/* ------------------------------------------------------------------ */
/*  Selector — rules-based                                             */
/* ------------------------------------------------------------------ */

function parseDueDate(task: TodoistTask): Date | null {
  const raw = task.due?.datetime ?? task.due?.date ?? null;
  if (!raw) return null;
  // `due.date` is YYYY-MM-DD; parse as local midnight.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    return new Date(Number(y), Number(m) - 1, Number(d));
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function daysOverdue(task: TodoistTask, now: Date = new Date()): number {
  const due = parseDueDate(task);
  if (!due) return 0;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.floor(
    (today.getTime() - due.getTime()) / 86_400_000
  );
  return Math.max(0, diffDays);
}

/* ------------------------------------------------------------------ */
/*  Task 10.2 helpers — pure, exposed for tests                        */
/* ------------------------------------------------------------------ */

const WAITING_ON_AGE_THRESHOLD_DAYS = 7;
const WAITING_ON_AGE_THRESHOLD_MS =
  WAITING_ON_AGE_THRESHOLD_DAYS * 86_400_000;

/**
 * Friendly title for a pinned dock item. Prefers the stored title;
 * falls back to a host-prefixed slug of the URL so the king never
 * displays a bare 80-char URL on the hero.
 */
export function dockItemKingTitle(item: DockItem): string {
  const trimmedTitle = item.title?.trim();
  if (trimmedTitle) return trimmedTitle;
  try {
    const url = new URL(item.url);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.host}${path}`.slice(0, 80);
  } catch {
    return item.url.slice(0, 80);
  }
}

/**
 * Parse a Gmail Date header (RFC 5322) and return ms-since-epoch.
 * Returns `null` for unparseable values so the waiting-on filter
 * can skip those rows defensively rather than crashing the whole
 * candidate-source step.
 */
export function parseEmailSentDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return ms;
}

/**
 * `true` if the waiting-on row's last-sent date is more than 7 days
 * before `now`. Returns `false` for unparseable dates so we don't
 * accidentally promote rows where Gmail didn't ship a Date header.
 */
export function isWaitingOnOlderThanThreshold(
  row: { date?: string | null | undefined },
  now: Date = new Date()
): boolean {
  const sentMs = parseEmailSentDateMs(row.date);
  if (sentMs === null) return false;
  const ageMs = now.getTime() - sentMs;
  return ageMs > WAITING_ON_AGE_THRESHOLD_MS;
}

/**
 * Compute `Math.floor((now - sentMs) / 86_400_000)` for display.
 * Public so the candidate-builder can reuse the same age math the
 * threshold check uses.
 */
export function waitingOnAgeDays(
  row: { date?: string | null | undefined },
  now: Date = new Date()
): number {
  const sentMs = parseEmailSentDateMs(row.date);
  if (sentMs === null) return 0;
  return Math.max(0, Math.floor((now.getTime() - sentMs) / 86_400_000));
}

/**
 * `true` if the king's Todoist task ID still appears in the user's
 * active-tasks list. `false` means the task was completed or
 * deleted — both reasons to auto-unpin the king.
 *
 * Defensive on shape: if `taskId` is null/empty we return `true`
 * (nothing to unpin), and the active list itself is matched by
 * exact id string.
 */
export function isTodoistTaskStillActive(
  taskId: string | null | undefined,
  activeTasks: ReadonlyArray<{ id: string }>
): boolean {
  if (!taskId) return true;
  return activeTasks.some((t) => t.id === taskId);
}

interface Candidate {
  title: string;
  reason: string;
  taskId: string | null;
  eventId: string | null;
  score: number;
}

async function selectKingOfDay(
  userId: number,
  dateKey: string
): Promise<PickedKing> {
  const candidates: Candidate[] = [];

  // --- Todoist (if connected) ---
  try {
    const integration = await getIntegrationByProvider(userId, "todoist");
    if (integration?.accessToken) {
      const overdue = await getTodoistTasks(
        integration.accessToken,
        "overdue"
      );
      for (const t of overdue) {
        const days = daysOverdue(t);
        candidates.push({
          title: t.content,
          reason:
            days > 1
              ? `${days} days overdue · ship it today`
              : "overdue — finish first",
          taskId: t.id,
          eventId: null,
          // Todoist priority: 4 = P1 (highest). Overdue P1 wins easily.
          score: 100 + (t.priority - 1) * 10 + days * 3,
        });
      }

      const todayTasks = await getTodoistTasks(
        integration.accessToken,
        "today"
      );
      for (const t of todayTasks) {
        if (t.priority === 4) {
          candidates.push({
            title: t.content,
            reason: "P1 · due today",
            taskId: t.id,
            eventId: null,
            score: 80,
          });
        } else if (t.priority === 3) {
          candidates.push({
            title: t.content,
            reason: "P2 · due today",
            taskId: t.id,
            eventId: null,
            score: 60,
          });
        }
      }
    }
  } catch (err) {
    console.warn("[kingOfDay] Todoist selector step failed:", err);
  }

  // --- Pinned DropDock items (Task 10.2 · score 50) ---
  // The user's deliberate "I want to come back to this" signal —
  // weighted between today's P2 (60) and the calendar-event fallback
  // (40) so a pinned chip beats a meeting prep but never beats a
  // P1 / overdue task. Read directly from the DB; no token-refresh
  // dance needed.
  try {
    const dockRows = await listDockItems(userId);
    for (const item of dockRows) {
      if (!item.pinnedAt) continue;
      candidates.push({
        title: dockItemKingTitle(item),
        reason: `pinned in dock · ${item.source}`,
        taskId: null,
        eventId: null,
        score: 50,
      });
    }
  } catch (err) {
    console.warn("[kingOfDay] DropDock candidate step failed:", err);
  }

  // --- Waiting-on Gmail threads >7d old (Task 10.2 · score 35) ---
  // Below the calendar fallback in priority — when nothing else is
  // ahead, an ancient unanswered thread is still a more useful
  // headline than the next meeting, but it shouldn't routinely
  // displace P-tagged tasks.
  try {
    const accessToken = await getValidGoogleToken(userId);
    const waitingOn = await getGmailWaitingOn(accessToken, 50);
    const now = new Date();
    for (const row of waitingOn) {
      if (!isWaitingOnOlderThanThreshold(row, now)) continue;
      const ageDays = waitingOnAgeDays(row, now);
      const subjectRaw = typeof row?.subject === "string" ? row.subject : "";
      const subject = subjectRaw.trim() || "(no subject)";
      candidates.push({
        title: `Follow up: ${subject}`,
        reason:
          ageDays >= 14
            ? `${ageDays} days waiting on response · nudge or close it out`
            : `${ageDays} days waiting on response`,
        taskId: null,
        eventId: null,
        score: 35,
      });
    }
  } catch (err) {
    console.warn("[kingOfDay] Gmail waiting-on candidate step failed:", err);
  }

  // --- Google Calendar (first event of the day if no stronger pick) ---
  if (candidates.length === 0) {
    try {
      const accessToken = await getValidGoogleToken(userId);
      const events = await getGoogleCalendarEvents(accessToken, {
        daysAhead: 1,
        maxResults: 10,
      });
      const nowMs = Date.now();
      const firstUpcoming = events.find((e) => {
        const startIso = e.start?.dateTime ?? e.start?.date ?? null;
        if (!startIso) return false;
        const startMs = new Date(startIso).getTime();
        return !Number.isNaN(startMs) && startMs >= nowMs;
      });
      if (firstUpcoming?.summary) {
        const startIso =
          firstUpcoming.start?.dateTime ?? firstUpcoming.start?.date ?? "";
        const startLabel = startIso
          ? new Date(startIso).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })
          : "today";
        candidates.push({
          title: `Prep ${firstUpcoming.summary}`,
          reason: `first event · ${startLabel}`,
          taskId: null,
          eventId: firstUpcoming.id ?? null,
          score: 40,
        });
      }
    } catch (err) {
      console.warn("[kingOfDay] Google calendar selector step failed:", err);
    }
  }

  if (candidates.length === 0) {
    return {
      title: "nothing burning.",
      reason: "pick one thing and ship it.",
      taskId: null,
      eventId: null,
      source: "auto",
    };
  }

  candidates.sort((a, b) => b.score - a.score);

  // --- Optional AI layer ---
  // Gated by env flag AND a valid Anthropic integration. Always
  // falls through to the rules pick on any failure.
  if (isAiSelectorEnabled()) {
    try {
      const anthropic = await getIntegrationByProvider(userId, "anthropic");
      if (anthropic?.accessToken) {
        const auth = extractAnthropicAuth({
          accessToken: anthropic.accessToken,
          metadata: anthropic.metadata ?? null,
        });
        if (auth.accessToken) {
          const aiPick = await aiSelectKingOfDay({
            dateKey,
            anthropicApiKey: auth.accessToken,
            anthropicModel: auth.model ?? undefined,
            candidates: candidates.slice(0, 8) satisfies AiCandidate[],
          });
          if (aiPick) {
            return {
              title: aiPick.title,
              reason: aiPick.reason,
              taskId: aiPick.taskId,
              eventId: aiPick.eventId,
              source: "ai",
            };
          }
        }
      }
    } catch (err) {
      console.warn("[kingOfDay] AI selector step failed:", err);
    }
  }

  const picked = candidates[0];
  return {
    title: picked.title,
    reason: picked.reason,
    taskId: picked.taskId,
    eventId: picked.eventId,
    source: "auto",
  };
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */

async function ensureKing(
  userId: number,
  dateKey: string
): Promise<UserKingOfDay | null> {
  let existing = await getKingOfDay(userId, dateKey);

  // Task 10.2 — auto-unpin a manual king whose Todoist task has been
  // completed (or deleted). Without this, finishing the task you
  // pinned this morning leaves the hero stuck on a check-marked
  // headline until you remember to click Unpin. Limited to manual
  // (= user-pinned) rows because auto-selected ones already
  // re-derive on the next call. Best-effort: any failure of the
  // Todoist fetch falls through to "leave the existing king alone."
  if (existing && existing.source === "manual" && existing.taskId) {
    const taskIdToCheck = existing.taskId;
    try {
      const integration = await getIntegrationByProvider(userId, "todoist");
      if (integration?.accessToken) {
        const activeTasks = await getTodoistTasks(integration.accessToken);
        if (!isTodoistTaskStillActive(taskIdToCheck, activeTasks)) {
          await deleteKingOfDay(userId, dateKey);
          existing = null;
        }
      }
    } catch (err) {
      console.warn(
        "[kingOfDay] auto-unpin task-completion check failed:",
        err
      );
    }
  }

  if (existing) return existing;

  const picked = await selectKingOfDay(userId, dateKey);

  // The auto-persist is best-effort. If the DB write fails the hero
  // still renders from the returned `picked` values thanks to the
  // try/catch — we just re-select on the next call.
  try {
    const persisted = await upsertKingOfDay({
      userId,
      dateKey,
      source: picked.source,
      title: picked.title,
      reason: picked.reason,
      taskId: picked.taskId,
      eventId: picked.eventId,
    });
    if (persisted) return persisted;
  } catch (err) {
    console.warn("[kingOfDay] auto-persist failed:", err);
  }

  // Fallback: return an ephemeral row so the hero still renders.
  const now = new Date();
  return {
    id: `ephemeral-${userId}-${dateKey}`,
    userId,
    dateKey,
    source: picked.source,
    title: picked.title,
    reason: picked.reason,
    taskId: picked.taskId,
    eventId: picked.eventId,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  } satisfies UserKingOfDay;
}

export const kingOfDayRouter = router({
  get: protectedProcedure
    .input(z.object({ dateKey: z.string().regex(DATE_KEY_REGEX) }))
    .query(async ({ ctx, input }) => {
      return ensureKing(ctx.user.id, input.dateKey);
    }),

  pin: protectedProcedure
    .input(
      z.object({
        dateKey: z.string().regex(DATE_KEY_REGEX),
        title: z.string().min(1).max(200),
        reason: z.string().max(500).optional(),
        taskId: z.string().max(128).optional(),
        eventId: z.string().max(128).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return upsertKingOfDay({
        userId: ctx.user.id,
        dateKey: input.dateKey,
        source: "manual",
        title: input.title,
        reason: input.reason ?? null,
        taskId: input.taskId ?? null,
        eventId: input.eventId ?? null,
        pinned: true,
      });
    }),

  unpin: protectedProcedure
    .input(z.object({ dateKey: z.string().regex(DATE_KEY_REGEX) }))
    .mutation(async ({ ctx, input }) => {
      await deleteKingOfDay(ctx.user.id, input.dateKey);
      return { ok: true };
    }),
});

// Exported for unit tests.
export const __test__ = {
  selectKingOfDay,
  daysOverdue,
  // Task 10.2 helpers (also re-exported from the module's public
  // surface above, but routed through __test__ so test files only
  // pull from one place).
  dockItemKingTitle,
  parseEmailSentDateMs,
  isWaitingOnOlderThanThreshold,
  waitingOnAgeDays,
  isTodoistTaskStillActive,
};
