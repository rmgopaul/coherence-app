/**
 * Phase E (2026-04-28) — AI Weekly Review.
 *
 * Generates a one-pager summary of the user's last 7 days from the
 * `dailySnapshots` row table. Wraps an Anthropic call with strict
 * JSON output + defensive parsing; on any failure we still write a
 * row so the cron is idempotent and the dashboard surface always
 * has something to render.
 *
 * Triggers:
 *   1. Cron (Monday 7am via the `weekly-review` daily-job claim)
 *      runs `generateWeeklyReviewForAllUsers(prevWeekKey)`.
 *   2. tRPC mutation `weeklyReviews.regenerate({weekKey})` calls
 *      `generateWeeklyReviewForUser(userId, weekKey)` directly.
 *
 * Both paths funnel through `generateWeeklyReviewForUser` so
 * behavior is identical regardless of trigger.
 */

import { nanoid } from "nanoid";
import {
  toIsoWeekKey,
  weekRangeFromKey,
  dateKeysInRange,
} from "@shared/dateKey";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const MIN_DAYS_REQUIRED = 3;

export type WeeklyReviewStatus =
  | "pending"
  | "ready"
  | "insufficient"
  | "failed";

export interface WeeklyReviewMetrics {
  daysWithData: number;
  todoistCompletedTotal: number | null;
  /** `null` when the user has no Whoop integration, no payloads, or
   *  no recovery scores in the window. */
  whoopRecoveryAvg: number | null;
  whoopRecoverySamples: number;
  /** Average sleep duration in hours, derived from Samsung payloads
   *  when present. `null` otherwise. */
  sleepHoursAvg: number | null;
  sleepSamples: number;
  /** Total supplement log rows in the window. */
  supplementsLogged: number;
  /** Habit completions in the window. */
  habitsCompleted: number;
}

export interface WeeklyReviewSummary {
  headline: string;
  contentMarkdown: string;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers — exposed for tests                                   */
/* ------------------------------------------------------------------ */

interface SnapshotLike {
  dateKey: string;
  whoopPayload: string | null;
  samsungPayload: string | null;
  supplementsPayload: string | null;
  habitsPayload: string | null;
  todoistCompletedCount: number | null;
}

function parseJsonSafe(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Roll up the per-day snapshots into a single metrics object the
 * UI can render without re-parsing payload JSON. Pure — exposed for
 * testability.
 *
 * Each payload field is best-effort: if it doesn't parse or doesn't
 * contain the expected shape we count it as zero data and move on.
 * This is intentional — the dashboard can show partial data when
 * (say) Whoop is connected but Samsung isn't.
 */
export function summarizeSnapshots(
  snapshots: ReadonlyArray<SnapshotLike>
): WeeklyReviewMetrics {
  let todoistTotal = 0;
  let whoopRecSum = 0;
  let whoopRecCount = 0;
  let sleepHoursSum = 0;
  let sleepCount = 0;
  let supplementsLogged = 0;
  let habitsCompleted = 0;
  for (const snap of snapshots) {
    if (typeof snap.todoistCompletedCount === "number") {
      todoistTotal += snap.todoistCompletedCount;
    }

    const whoop = parseJsonSafe(snap.whoopPayload);
    if (whoop && typeof whoop === "object") {
      const score = (whoop as Record<string, unknown>).recoveryScore;
      if (typeof score === "number" && Number.isFinite(score)) {
        whoopRecSum += score;
        whoopRecCount += 1;
      }
    }

    const samsung = parseJsonSafe(snap.samsungPayload);
    if (samsung && typeof samsung === "object") {
      const sleepMs = (samsung as Record<string, unknown>).sleepDurationMs;
      if (typeof sleepMs === "number" && Number.isFinite(sleepMs) && sleepMs > 0) {
        sleepHoursSum += sleepMs / 3_600_000;
        sleepCount += 1;
      }
    }

    const supps = parseJsonSafe(snap.supplementsPayload);
    if (supps && typeof supps === "object") {
      const count = (supps as Record<string, unknown>).logCount;
      if (typeof count === "number" && Number.isFinite(count)) {
        supplementsLogged += count;
      }
    }

    const habits = parseJsonSafe(snap.habitsPayload);
    if (habits && typeof habits === "object") {
      const count = (habits as Record<string, unknown>).completedCount;
      if (typeof count === "number" && Number.isFinite(count)) {
        habitsCompleted += count;
      }
    }
  }
  return {
    daysWithData: snapshots.length,
    todoistCompletedTotal: snapshots.length > 0 ? todoistTotal : null,
    whoopRecoveryAvg:
      whoopRecCount > 0 ? whoopRecSum / whoopRecCount : null,
    whoopRecoverySamples: whoopRecCount,
    sleepHoursAvg: sleepCount > 0 ? sleepHoursSum / sleepCount : null,
    sleepSamples: sleepCount,
    supplementsLogged,
    habitsCompleted,
  };
}

/** Build the system + user prompts for the LLM call. Pure — exposed
 *  for testability so the prompt copy is verifiable independently of
 *  the HTTP layer. */
export function buildWeeklyReviewPrompts(
  weekKey: string,
  range: { startDateKey: string; endDateKey: string },
  metrics: WeeklyReviewMetrics
): { system: string; user: string } {
  const system = [
    `You are an editorial weekly-review writer for a personal productivity dashboard.`,
    `The user's daily snapshots include sleep, recovery, supplements, habits, and Todoist completions.`,
    ``,
    `Output STRICT JSON ONLY — no markdown fences, no prose before or after.`,
    `Schema:`,
    `  {`,
    `    "headline": string,         // 1 sentence, <=240 chars, observation+implication`,
    `    "contentMarkdown": string   // 4-8 short markdown bullets — wins, concerns, signals`,
    `  }`,
    ``,
    `Style rules:`,
    `- Headline reads like an editorial pull-quote, not a summary header.`,
    `  ("Sleep crept down 30 min. Recovery followed." good.`,
    `   "Weekly Health Summary" bad.)`,
    `- Bullets are 1-2 lines each. Lead with the metric, end with the takeaway.`,
    `- Never invent data. If a metric is null/zero in the input, omit it from the review.`,
    `- Mention specific deltas where the data supports them ("supplements logged: 14 of 21" vs "supplements were inconsistent").`,
    `- No emoji. No exclamation marks. No second-person ("you").`,
  ].join("\n");

  const lines = [
    `Week: ${weekKey} (${range.startDateKey} → ${range.endDateKey})`,
    `Days with snapshots: ${metrics.daysWithData}`,
  ];
  if (metrics.todoistCompletedTotal !== null) {
    lines.push(`Todoist completed: ${metrics.todoistCompletedTotal}`);
  }
  if (metrics.whoopRecoveryAvg !== null) {
    lines.push(
      `Whoop recovery avg: ${Math.round(metrics.whoopRecoveryAvg)} (${metrics.whoopRecoverySamples} samples)`
    );
  }
  if (metrics.sleepHoursAvg !== null) {
    lines.push(
      `Sleep avg: ${metrics.sleepHoursAvg.toFixed(1)}h (${metrics.sleepSamples} samples)`
    );
  }
  if (metrics.supplementsLogged > 0) {
    lines.push(`Supplements logged: ${metrics.supplementsLogged}`);
  }
  if (metrics.habitsCompleted > 0) {
    lines.push(`Habits completed: ${metrics.habitsCompleted}`);
  }
  lines.push(``);
  lines.push(`Return JSON only, schema as specified.`);

  return { system, user: lines.join("\n") };
}

/** Strip optional ```json fences and find the balanced JSON object. */
function extractJsonPayload(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/** Validate + extract `{headline, contentMarkdown}` from an LLM
 *  response string. Returns `null` for any failure. Pure. */
export function parseWeeklyReviewResponse(
  text: string
): WeeklyReviewSummary | null {
  const payload = extractJsonPayload(text);
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const headline =
      typeof parsed.headline === "string" ? parsed.headline.trim() : "";
    const contentMarkdown =
      typeof parsed.contentMarkdown === "string"
        ? parsed.contentMarkdown.trim()
        : "";
    if (!headline || !contentMarkdown) return null;
    return {
      headline: headline.slice(0, 280),
      contentMarkdown,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  HTTP layer                                                         */
/* ------------------------------------------------------------------ */

interface AnthropicMessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

async function callAnthropic(
  apiKey: string,
  model: string,
  system: string,
  user: string
): Promise<string | null> {
  const response = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Anthropic ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as AnthropicMessagesResponse;
  const block = data.content?.find((c) => c.type === "text");
  return block?.text ?? null;
}

/* ------------------------------------------------------------------ */
/*  Public service                                                     */
/* ------------------------------------------------------------------ */

export interface GenerateWeeklyReviewResult {
  status: WeeklyReviewStatus;
  weekKey: string;
  /** When status is `ready`. */
  summary?: WeeklyReviewSummary;
  metrics: WeeklyReviewMetrics;
  errorMessage?: string;
}

/**
 * Generate (or regenerate) the weekly review for one user. Always
 * upserts a row into `weeklyReviews` so the dashboard's getLatest
 * query has something to render even on insufficient/failed
 * outcomes.
 *
 * Returns the same shape regardless of how it was triggered (cron
 * vs manual mutation) so callers can render the result inline.
 */
export async function generateWeeklyReviewForUser(
  userId: number,
  weekKey: string
): Promise<GenerateWeeklyReviewResult> {
  const range = weekRangeFromKey(weekKey);
  if (!range) {
    return {
      status: "failed",
      weekKey,
      metrics: zeroMetrics(),
      errorMessage: `Invalid weekKey: ${weekKey}`,
    };
  }

  const {
    listDailySnapshotsForRange,
    upsertWeeklyReview,
    getIntegrationByProvider,
  } = await import("../../db");
  const { extractAnthropicAuth } = await import(
    "../integrations/anthropicSelector"
  );

  const dateKeys = dateKeysInRange(range.startDateKey, range.endDateKey);
  const snapshots = await listDailySnapshotsForRange(
    userId,
    range.startDateKey,
    range.endDateKey
  );
  const metrics = summarizeSnapshots(snapshots);

  const id = nanoid();
  const now = new Date();
  const baseRow = {
    id,
    userId,
    weekKey,
    weekStartDateKey: range.startDateKey,
    weekEndDateKey: range.endDateKey,
    daysWithData: metrics.daysWithData,
    metricsJson: JSON.stringify(metrics),
    updatedAt: now,
  };

  if (metrics.daysWithData < MIN_DAYS_REQUIRED) {
    await upsertWeeklyReview({
      ...baseRow,
      status: "insufficient",
      headline: null,
      contentMarkdown: null,
      model: null,
      generatedAt: null,
      errorMessage: `Only ${metrics.daysWithData} day(s) of data — need at least ${MIN_DAYS_REQUIRED}.`,
      createdAt: now,
    });
    return {
      status: "insufficient",
      weekKey,
      metrics,
      errorMessage: `Only ${metrics.daysWithData} day(s) of data — need at least ${MIN_DAYS_REQUIRED}.`,
    };
  }

  const integration = await getIntegrationByProvider(userId, "anthropic");
  const auth = extractAnthropicAuth({
    accessToken: integration?.accessToken ?? null,
    metadata: integration?.metadata ?? null,
  });
  if (!auth.accessToken) {
    await upsertWeeklyReview({
      ...baseRow,
      status: "failed",
      headline: null,
      contentMarkdown: null,
      model: null,
      generatedAt: null,
      errorMessage: "Anthropic API key not configured.",
      createdAt: now,
    });
    return {
      status: "failed",
      weekKey,
      metrics,
      errorMessage: "Anthropic API key not configured.",
    };
  }

  const model = auth.model ?? DEFAULT_MODEL;
  const { system, user } = buildWeeklyReviewPrompts(weekKey, range, metrics);

  let raw: string | null = null;
  try {
    raw = await callAnthropic(auth.accessToken, model, system, user);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await upsertWeeklyReview({
      ...baseRow,
      status: "failed",
      headline: null,
      contentMarkdown: null,
      model,
      generatedAt: null,
      errorMessage: message,
      createdAt: now,
    });
    return { status: "failed", weekKey, metrics, errorMessage: message };
  }

  const parsed = raw ? parseWeeklyReviewResponse(raw) : null;
  if (!parsed) {
    const errorMessage = "Anthropic response was empty or unparseable.";
    await upsertWeeklyReview({
      ...baseRow,
      status: "failed",
      headline: null,
      contentMarkdown: null,
      model,
      generatedAt: null,
      errorMessage,
      createdAt: now,
    });
    return { status: "failed", weekKey, metrics, errorMessage };
  }

  await upsertWeeklyReview({
    ...baseRow,
    status: "ready",
    headline: parsed.headline,
    contentMarkdown: parsed.contentMarkdown,
    model,
    generatedAt: now,
    errorMessage: null,
    createdAt: now,
  });
  return { status: "ready", weekKey, summary: parsed, metrics };

  // Reference dateKeys to silence the unused-import lint when the
  // helper grows new branches that don't enumerate them. Cheap.
  void dateKeys;
}

/**
 * Cron entry point — runs `generateWeeklyReviewForUser` for every
 * user in the system. Errors are caught per-user so one user's
 * failure (e.g. expired Anthropic key) doesn't abort the rest.
 */
export async function generateWeeklyReviewForAllUsers(
  weekKey: string
): Promise<{ ok: number; failed: number }> {
  const { listUsers } = await import("../../db");
  const users = await listUsers();
  let ok = 0;
  let failed = 0;
  for (const user of users) {
    try {
      const result = await generateWeeklyReviewForUser(user.id, weekKey);
      if (result.status === "ready" || result.status === "insufficient") ok += 1;
      else failed += 1;
    } catch (err) {
      console.warn(
        `[weeklyReview] generateWeeklyReviewForUser ${user.id} failed:`,
        err instanceof Error ? err.message : err
      );
      failed += 1;
    }
  }
  return { ok, failed };
}

/**
 * Convenience: ISO week key for last week (relative to `now`). The
 * cron uses this on Monday morning to summarize the week that just
 * ended.
 */
export function previousWeekKey(now: Date = new Date()): string {
  const d = new Date(now);
  d.setDate(d.getDate() - 7);
  return toIsoWeekKey(d);
}

function zeroMetrics(): WeeklyReviewMetrics {
  return {
    daysWithData: 0,
    todoistCompletedTotal: null,
    whoopRecoveryAvg: null,
    whoopRecoverySamples: 0,
    sleepHoursAvg: null,
    sleepSamples: 0,
    supplementsLogged: 0,
    habitsCompleted: 0,
  };
}
