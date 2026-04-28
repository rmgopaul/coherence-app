/**
 * King of the Day — Phase C
 *
 * `get`   — returns the persisted headline for (user, dateKey) or
 *           auto-selects, persists, and returns.
 * `pin`   — upserts a `manual` row (replaces any `auto` pick).
 * `unpin` — deletes the row; next `.get()` re-runs the selector.
 *
 * The rules-based selector (`selectKingOfDay`) looks at overdue
 * Todoist tasks, today's P1s, and the first calendar event of the
 * day. Simplified from the spec — no business-hours or attachment
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
  // Task 10.2 (2026-04-28): pinned dock items as candidate source.
  listDockItems,
} from "../db";
import type { UserKingOfDay } from "../../drizzle/schema";
import { getValidGoogleToken } from "../helpers/tokenRefresh";
import {
  getTodoistTasks,
  // Task 10.2 (2026-04-28): used by `ensureKing` to auto-unpin a
  // King whose linked Todoist task has been completed.
  isTodoistTaskCompletedById,
  type TodoistTask,
} from "../services/integrations/todoist";
import {
  getGoogleCalendarEvents,
  // Task 10.2 (2026-04-28): waiting-on >7d as candidate source.
  getGmailWaitingOn,
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

  // --- Pinned dock items (Task 10.2) ---
  // Score 50 — between Todoist P1-due-today (80) and P2 (60). The
  // intent is "if you bothered pinning it to the dock, it deserves
  // to surface as a King candidate." Failure here is non-fatal; a
  // missing dock or DB hiccup falls through to the other sources.
  try {
    const dock = await listDockItems(userId, 50);
    for (const item of dock) {
      if (!item.pinnedAt) continue;
      const ageMs = Date.now() - new Date(item.pinnedAt).getTime();
      const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
      const title = item.title?.trim() || item.url;
      candidates.push({
        title,
        reason:
          ageDays > 0
            ? `pinned to dock · ${ageDays}d ago`
            : "pinned to dock today",
        // dock items aren't tasks/events — leave both linkage fields
        // null so the King chip doesn't try to deep-link to a task
        // that doesn't exist.
        taskId: null,
        eventId: null,
        score: 50,
      });
    }
  } catch (err) {
    console.warn("[kingOfDay] Dock candidate step failed:", err);
  }

  // --- Waiting-on emails older than 7 days (Task 10.2) ---
  // Score 35 — between calendar-prep (40) and the empty-state
  // floor. Only runs when no stronger candidate exists, because
  // `getGmailWaitingOn` is the slowest source we have (multi-page
  // Gmail thread scan). Skipping it when there's already a P2+
  // candidate keeps the dashboard's `kingOfDay.get` under the 1.5s
  // budget the page expects.
  if (
    candidates.length === 0 ||
    candidates.every((c) => c.score < 36)
  ) {
    try {
      const accessToken = await getValidGoogleToken(userId);
      const waiting = await getGmailWaitingOn(accessToken, 25);
      const sevenDaysAgoMs = Date.now() - 7 * 86_400_000;
      type WaitingRow = {
        id: string;
        threadId: string;
        subject: string;
        date: string;
        url: string;
      };
      for (const raw of waiting) {
        const row = raw as WaitingRow;
        const sentMs = new Date(row.date || 0).getTime();
        if (!Number.isFinite(sentMs) || sentMs > sevenDaysAgoMs) continue;
        const days = Math.floor(
          (Date.now() - sentMs) / 86_400_000
        );
        candidates.push({
          title: `Follow up: ${row.subject || "(no subject)"}`,
          reason: `waiting ${days}d for reply`,
          taskId: null,
          eventId: null,
          score: 35,
        });
      }
    } catch (err) {
      console.warn("[kingOfDay] Waiting-on candidate step failed:", err);
    }
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

/**
 * Task 10.2 (2026-04-28) — auto-unpin a King whose linked Todoist
 * task has been completed.
 *
 * Returns true when the King was unpinned (so the caller knows to
 * re-select). Throttled by `staleAfterMs` so we don't burn a
 * Todoist API call on every dashboard render — the user's task
 * list is stable enough that a 60s cache is fine; the worst-case
 * UX is the King hangs around for one extra polling cycle after
 * the task is checked off.
 *
 * Only fires when the King is taskId-bound. Manual pins of
 * non-Todoist items (calendar events, dock chips, free-text)
 * stay until the user unpins them explicitly.
 *
 * Best-effort: any failure (network, DB hiccup) leaves the
 * existing King in place — failing OPEN here is the right
 * default since "King hangs around" is far less disruptive than
 * "King unexpectedly disappears."
 */
async function unpinIfCompletedTodoistKing(
  userId: number,
  dateKey: string,
  existing: UserKingOfDay,
  staleAfterMs = 60_000
): Promise<boolean> {
  if (!existing.taskId) return false;
  // Throttle: only re-check after the row's `updatedAt` is older
  // than `staleAfterMs`. Callers that need to force a check can
  // pass `staleAfterMs: 0`.
  const updatedAt = existing.updatedAt
    ? new Date(existing.updatedAt).getTime()
    : 0;
  if (Date.now() - updatedAt < staleAfterMs) return false;
  try {
    const integration = await getIntegrationByProvider(userId, "todoist");
    if (!integration?.accessToken) return false;
    const isCompleted = await isTodoistTaskCompletedById(
      integration.accessToken,
      existing.taskId
    );
    if (!isCompleted) return false;
    await deleteKingOfDay(userId, dateKey);
    return true;
  } catch (err) {
    console.warn("[kingOfDay] auto-unpin check failed:", err);
    return false;
  }
}

async function ensureKing(
  userId: number,
  dateKey: string
): Promise<UserKingOfDay | null> {
  const existing = await getKingOfDay(userId, dateKey);
  if (existing) {
    // Task 10.2: if the King is a Todoist task that's been
    // completed, unpin it and fall through to re-select. If the
    // helper returns false (most common path) we return the
    // persisted row directly.
    const wasUnpinned = await unpinIfCompletedTodoistKing(
      userId,
      dateKey,
      existing
    );
    if (!wasUnpinned) return existing;
  }

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
  unpinIfCompletedTodoistKing,
};
