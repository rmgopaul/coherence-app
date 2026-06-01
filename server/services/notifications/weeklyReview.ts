/**
 * Phase E (2026-04-28) — AI Weekly Review.
 * Upgraded 2026-06-01 — deeper, multi-source, Opus-powered.
 *
 * Generates an in-depth review of the user's last 7 days by joining
 * every personal data source we capture:
 *
 *   - `dailyHealthMetrics` — the canonical normalized numeric source
 *     (WHOOP recovery / strain / HRV / resting-HR / sleep, Samsung
 *     sleep-hours / sleep-score / energy-score / steps / SpO2,
 *     Todoist completions). Read for BOTH the target week and the
 *     prior week so the model can reason about week-over-week deltas.
 *   - `dailySnapshots` — for supplements actually logged
 *     (`{definitions, logs}`) and habit completion (array of
 *     `{name, completed}`), which the metrics table doesn't carry.
 *   - `dailyReflections` — the user's nightly qualitative journal
 *     (energy 1-10, what went well / didn't, tomorrow's one thing).
 *     This is the only source of *why*, and it's where the richest
 *     correlations come from.
 *
 * The model is pinned to Claude Opus 4.8 (override via the
 * `WEEKLY_REVIEW_MODEL` env var) — the review is a weekly, low-volume
 * call where depth matters far more than latency or cost, so we do
 * NOT fall back to the user's cheaper configured chat model.
 *
 * Wraps the Anthropic call with strict JSON output + defensive
 * parsing; on any failure we still write a row so the cron is
 * idempotent and the dashboard surface always has something to
 * render. The wire/DB shape stays `{ headline, contentMarkdown }`
 * for backward compatibility with both the Android `WeeklyReviewScreen`
 * and the web `WeeklyReviewCard` — `contentMarkdown` simply carries a
 * far richer, multi-section markdown document now.
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
import { shiftIsoDate } from "../solar/helpers";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
/**
 * Pinned to Opus 4.8 — the weekly review is a deep, once-a-week
 * synthesis where model quality dominates. Overridable via env for
 * ops, but intentionally NOT driven by the user's per-account chat
 * model (which is usually a cheaper Haiku).
 */
const DEFAULT_MODEL = (
  process.env.WEEKLY_REVIEW_MODEL || "claude-opus-4-8"
).trim();
/** Opus writes a much longer document than the old 4-8 bullet review. */
const MAX_OUTPUT_TOKENS = 4096;
/** Opus is slower than Haiku; give the deeper synthesis room. */
const REQUEST_TIMEOUT_MS = 120_000;
const MIN_DAYS_REQUIRED = 3;
export const WEEKLY_REVIEW_PROMPT_VERSION = "v2-opus-deep";

export type WeeklyReviewStatus =
  | "pending"
  | "ready"
  | "insufficient"
  | "failed";

export interface WeeklyReviewMetrics {
  daysWithData: number;
  /* ---- backward-compatible fields the dashboard cards read ---- */
  todoistCompletedTotal: number | null;
  /** `null` when the user has no WHOOP recovery scores in the window. */
  whoopRecoveryAvg: number | null;
  whoopRecoverySamples: number;
  /** Average sleep duration in hours (WHOOP, falling back to Samsung). */
  sleepHoursAvg: number | null;
  sleepSamples: number;
  /** Distinct supplement-log rows across the window. */
  supplementsLogged: number;
  /** Habit completions across the window. */
  habitsCompleted: number;
  /* ---- new, deeper signals ---- */
  whoopHrvAvg: number | null;
  whoopHrvSamples: number;
  whoopStrainAvg: number | null;
  whoopStrainSamples: number;
  whoopRestingHrAvg: number | null;
  whoopRestingHrSamples: number;
  stepsAvg: number | null;
  stepsSamples: number;
  samsungEnergyAvg: number | null;
  samsungEnergySamples: number;
  samsungSleepScoreAvg: number | null;
  samsungSleepScoreSamples: number;
  reflectionEnergyAvg: number | null;
  reflectionEnergySamples: number;
  /** Total habit slots offered across the window (habits × days). */
  habitOpportunities: number;
  /** completed / opportunities, 0-100, or null when no habits tracked. */
  habitConsistencyPct: number | null;
  /** Count of distinct supplements logged at least once this week. */
  distinctSupplements: number;
}

export interface WeeklyReviewSummary {
  headline: string;
  contentMarkdown: string;
}

/* ------------------------------------------------------------------ */
/*  Input row shapes (mirrors the DB selects; kept narrow for tests)  */
/* ------------------------------------------------------------------ */

interface MetricRowLike {
  dateKey: string;
  whoopRecoveryScore: number | null;
  whoopDayStrain: number | null;
  whoopSleepHours: number | null;
  whoopHrvMs: number | null;
  whoopRestingHr: number | null;
  samsungSteps: number | null;
  samsungSleepHours: number | null;
  samsungSpo2AvgPercent: number | null;
  samsungSleepScore: number | null;
  samsungEnergyScore: number | null;
  todoistCompletedCount: number | null;
}

interface SnapshotLike {
  dateKey: string;
  supplementsPayload: string | null;
  habitsPayload: string | null;
  todoistCompletedCount: number | null;
}

interface ReflectionLike {
  dateKey: string;
  energyLevel: number | null;
  wentWell: string | null;
  didntGo: string | null;
  tomorrowOneThing: string | null;
}

/** One fully-joined day, the unit the prompt reasons over. */
export interface WeekDayRecord {
  dateKey: string;
  recovery: number | null;
  hrv: number | null;
  strain: number | null;
  restingHr: number | null;
  sleepHours: number | null;
  samsungSleepScore: number | null;
  samsungEnergy: number | null;
  steps: number | null;
  spo2: number | null;
  tasksDone: number | null;
  supplements: string[];
  habitsDone: string[];
  habitsTotal: number;
  reflectionEnergy: number | null;
  wentWell: string | null;
  didntGo: string | null;
  tomorrowOneThing: string | null;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers — exposed for tests                                   */
/* ------------------------------------------------------------------ */

function parseJsonSafe(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pull the supplement names logged on a day. The snapshot stores
 * `{ definitions, logs }`; each log row carries its own `name`.
 */
function supplementNamesFromPayload(raw: string | null): string[] {
  const parsed = parseJsonSafe(raw);
  if (!parsed || typeof parsed !== "object") return [];
  const logs = (parsed as Record<string, unknown>).logs;
  if (!Array.isArray(logs)) return [];
  const names: string[] = [];
  for (const log of logs) {
    if (log && typeof log === "object") {
      const name = (log as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) names.push(name.trim());
    }
  }
  return names;
}

/**
 * Pull habit completion from a day's snapshot. The payload is an
 * array of `{ id, name, color, completed }`. Returns the names of
 * completed habits plus the total number of habits tracked that day.
 */
function habitsFromPayload(raw: string | null): {
  done: string[];
  total: number;
} {
  const parsed = parseJsonSafe(raw);
  if (!Array.isArray(parsed)) return { done: [], total: 0 };
  const done: string[] = [];
  let total = 0;
  for (const habit of parsed) {
    if (!habit || typeof habit !== "object") continue;
    total += 1;
    const obj = habit as Record<string, unknown>;
    if (obj.completed === true) {
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      done.push(name || "habit");
    }
  }
  return { done, total };
}

/**
 * Join the three sources into one record per day. A day is included
 * only when it carries at least one usable signal — empty days are
 * dropped so the prompt stays dense and `daysWithData` reflects real
 * data, not calendar days.
 *
 * Pure — exposed for unit testing.
 */
export function buildWeekRecords(
  metrics: ReadonlyArray<MetricRowLike>,
  snapshots: ReadonlyArray<SnapshotLike>,
  reflections: ReadonlyArray<ReflectionLike>
): WeekDayRecord[] {
  const metricByDate = new Map<string, MetricRowLike>();
  for (const m of metrics) metricByDate.set(m.dateKey, m);
  const snapByDate = new Map<string, SnapshotLike>();
  for (const s of snapshots) snapByDate.set(s.dateKey, s);
  const reflByDate = new Map<string, ReflectionLike>();
  for (const r of reflections) reflByDate.set(r.dateKey, r);

  const dateKeys = new Set<string>(
    Array.from(metricByDate.keys())
      .concat(Array.from(snapByDate.keys()))
      .concat(Array.from(reflByDate.keys()))
  );

  const out: WeekDayRecord[] = [];
  for (const dateKey of Array.from(dateKeys).sort()) {
    const m = metricByDate.get(dateKey);
    const s = snapByDate.get(dateKey);
    const r = reflByDate.get(dateKey);

    const supplements = supplementNamesFromPayload(
      s?.supplementsPayload ?? null
    );
    const habits = habitsFromPayload(s?.habitsPayload ?? null);

    const sleepHours = num(m?.whoopSleepHours) ?? num(m?.samsungSleepHours);
    const tasksDone =
      num(m?.todoistCompletedCount) ?? num(s?.todoistCompletedCount);

    const day: WeekDayRecord = {
      dateKey,
      recovery: num(m?.whoopRecoveryScore),
      hrv: num(m?.whoopHrvMs),
      strain: num(m?.whoopDayStrain),
      restingHr: num(m?.whoopRestingHr),
      sleepHours,
      samsungSleepScore: num(m?.samsungSleepScore),
      samsungEnergy: num(m?.samsungEnergyScore),
      steps: num(m?.samsungSteps),
      spo2: num(m?.samsungSpo2AvgPercent),
      tasksDone,
      supplements,
      habitsDone: habits.done,
      habitsTotal: habits.total,
      reflectionEnergy: num(r?.energyLevel),
      wentWell: r?.wentWell?.trim() || null,
      didntGo: r?.didntGo?.trim() || null,
      tomorrowOneThing: r?.tomorrowOneThing?.trim() || null,
    };

    const hasSignal =
      day.recovery !== null ||
      day.hrv !== null ||
      day.strain !== null ||
      day.sleepHours !== null ||
      day.samsungEnergy !== null ||
      day.tasksDone !== null ||
      day.supplements.length > 0 ||
      day.habitsTotal > 0 ||
      day.reflectionEnergy !== null ||
      day.wentWell !== null ||
      day.didntGo !== null;
    if (hasSignal) out.push(day);
  }
  return out;
}

/** Mean of the non-null numbers, or null when none exist. */
function avg(values: ReadonlyArray<number | null>): {
  mean: number | null;
  samples: number;
} {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v !== null) {
      sum += v;
      n += 1;
    }
  }
  return { mean: n > 0 ? sum / n : null, samples: n };
}

/**
 * Roll up joined day records into the metrics object the UI renders
 * as trend chips and the prompt summarizes. Pure — exposed for tests.
 */
export function summarizeWeek(
  records: ReadonlyArray<WeekDayRecord>
): WeeklyReviewMetrics {
  const recovery = avg(records.map(d => d.recovery));
  const hrv = avg(records.map(d => d.hrv));
  const strain = avg(records.map(d => d.strain));
  const restingHr = avg(records.map(d => d.restingHr));
  const sleep = avg(records.map(d => d.sleepHours));
  const steps = avg(records.map(d => d.steps));
  const energy = avg(records.map(d => d.samsungEnergy));
  const sleepScore = avg(records.map(d => d.samsungSleepScore));
  const reflectionEnergy = avg(records.map(d => d.reflectionEnergy));

  let todoistTotal = 0;
  let todoistDays = 0;
  let supplementsLogged = 0;
  const distinctSupps = new Set<string>();
  let habitsCompleted = 0;
  let habitOpportunities = 0;
  for (const d of records) {
    if (d.tasksDone !== null) {
      todoistTotal += d.tasksDone;
      todoistDays += 1;
    }
    supplementsLogged += d.supplements.length;
    for (const s of d.supplements) distinctSupps.add(s.toLowerCase());
    habitsCompleted += d.habitsDone.length;
    habitOpportunities += d.habitsTotal;
  }

  return {
    daysWithData: records.length,
    todoistCompletedTotal: todoistDays > 0 ? todoistTotal : null,
    whoopRecoveryAvg: recovery.mean,
    whoopRecoverySamples: recovery.samples,
    sleepHoursAvg: sleep.mean,
    sleepSamples: sleep.samples,
    supplementsLogged,
    habitsCompleted,
    whoopHrvAvg: hrv.mean,
    whoopHrvSamples: hrv.samples,
    whoopStrainAvg: strain.mean,
    whoopStrainSamples: strain.samples,
    whoopRestingHrAvg: restingHr.mean,
    whoopRestingHrSamples: restingHr.samples,
    stepsAvg: steps.mean,
    stepsSamples: steps.samples,
    samsungEnergyAvg: energy.mean,
    samsungEnergySamples: energy.samples,
    samsungSleepScoreAvg: sleepScore.mean,
    samsungSleepScoreSamples: sleepScore.samples,
    reflectionEnergyAvg: reflectionEnergy.mean,
    reflectionEnergySamples: reflectionEnergy.samples,
    habitOpportunities,
    habitConsistencyPct:
      habitOpportunities > 0
        ? (habitsCompleted / habitOpportunities) * 100
        : null,
    distinctSupplements: distinctSupps.size,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Format a this-week-vs-last-week delta for the prompt, e.g.
 *  "72 (▲ +5 vs prior 67)". Returns just the value when no prior. */
function withDelta(
  label: string,
  current: number | null,
  prior: number | null,
  digits = 0
): string | null {
  if (current === null) return null;
  const fmt = (v: number) =>
    digits > 0 ? v.toFixed(digits) : String(Math.round(v));
  if (prior === null) return `${label}: ${fmt(current)}`;
  const diff = current - prior;
  const arrow = diff > 0.05 ? "▲" : diff < -0.05 ? "▼" : "▬";
  const sign = diff >= 0 ? "+" : "";
  return `${label}: ${fmt(current)} (${arrow} ${sign}${fmt(diff)} vs prior ${fmt(prior)})`;
}

/**
 * Build the system + user prompts for the LLM call. The user message
 * carries (a) a week-over-week metrics block with deltas, (b) a
 * compact per-day JSON-Lines table of every signal, and (c) the
 * user's nightly reflections verbatim — the raw material for the
 * model to surface correlations and patterns.
 *
 * Pure — exposed for testability.
 */
export function buildWeeklyReviewPrompts(
  weekKey: string,
  range: { startDateKey: string; endDateKey: string },
  records: ReadonlyArray<WeekDayRecord>,
  metrics: WeeklyReviewMetrics,
  priorMetrics: WeeklyReviewMetrics | null
): { system: string; user: string } {
  const system = [
    `You are a rigorous personal-performance analyst writing a private weekly review.`,
    `You are given a week of joined biometric (WHOOP, Samsung Health), behavioral`,
    `(supplements, habits, completed tasks) and self-reported (nightly reflections)`,
    `data, plus the prior week's aggregates for comparison.`,
    ``,
    `Your job is to produce a DEEP, specific review — not a flat list of averages.`,
    `Do all of the following:`,
    `- Open with the single most important signal of the week.`,
    `- Surface concrete WINS and WATCH-OUTS, each tied to a number or delta.`,
    `- Find CORRELATIONS and PATTERNS across domains: e.g. how sleep/HRV tracked`,
    `  recovery, whether supplement-logged days differed from skipped days, how`,
    `  habit consistency moved with self-reported energy, weekday-vs-weekend splits,`,
    `  and lagged effects (last night's sleep → today's strain/energy).`,
    `- Quote the user's own reflections (what went well / didn't) when they explain`,
    `  a number, and connect qualitative notes to the quantitative trend.`,
    `- Compare to the prior week explicitly where deltas exist.`,
    `- End with 2-4 specific, testable recommendations for next week.`,
    ``,
    `Output STRICT JSON ONLY — no markdown fences, no prose before or after.`,
    `Schema:`,
    `  {`,
    `    "headline": string,        // 1 sentence, <=240 chars, an editorial`,
    `                               //   observation+implication, not a title`,
    `    "contentMarkdown": string  // a rich markdown document, see below`,
    `  }`,
    ``,
    `contentMarkdown format:`,
    `- Use level-2 markdown headings ("## Wins", "## Watch-outs",`,
    `  "## Correlations & patterns", "## Week over week", "## Next week") to`,
    `  organize the review. Include the sections that the data supports.`,
    `- Under each heading, 2-5 concise bullets ("- ..."). Bold the key metric`,
    `  in each bullet with **double asterisks**.`,
    `- Aim for substance over length: every bullet must reference a real number,`,
    `  delta, supplement, habit, or reflection from the input.`,
    ``,
    `Hard rules:`,
    `- NEVER invent data. If a metric is null/absent, omit it — do not guess.`,
    `- Quantify whenever possible ("recovery 72, up 5 from 67"; "supplements`,
    `  logged 5 of 7 days"). Avoid vague phrasing like "was inconsistent".`,
    `- Mark a correlation as tentative when it rests on fewer than ~4 days.`,
    `- No emoji. No exclamation marks. No second-person ("you"); write in the`,
    `  third person or impersonally ("recovery climbed", "the week opened with").`,
  ].join("\n");

  const summaryLines: string[] = [
    `Week: ${weekKey} (${range.startDateKey} → ${range.endDateKey})`,
    `Days with data: ${metrics.daysWithData}`,
    ``,
    `Aggregate metrics (this week, with week-over-week deltas where available):`,
  ];
  const p = priorMetrics;
  const pushes: Array<string | null> = [
    withDelta(
      "WHOOP recovery avg",
      metrics.whoopRecoveryAvg,
      p?.whoopRecoveryAvg ?? null
    ),
    withDelta(
      "WHOOP HRV avg (ms)",
      metrics.whoopHrvAvg,
      p?.whoopHrvAvg ?? null
    ),
    withDelta(
      "WHOOP day strain avg",
      metrics.whoopStrainAvg,
      p?.whoopStrainAvg ?? null,
      1
    ),
    withDelta(
      "Resting HR avg (bpm)",
      metrics.whoopRestingHrAvg,
      p?.whoopRestingHrAvg ?? null
    ),
    withDelta(
      "Sleep avg (h)",
      metrics.sleepHoursAvg,
      p?.sleepHoursAvg ?? null,
      1
    ),
    withDelta(
      "Samsung sleep score avg",
      metrics.samsungSleepScoreAvg,
      p?.samsungSleepScoreAvg ?? null
    ),
    withDelta(
      "Samsung energy avg",
      metrics.samsungEnergyAvg,
      p?.samsungEnergyAvg ?? null,
      1
    ),
    withDelta("Steps avg", metrics.stepsAvg, p?.stepsAvg ?? null),
    withDelta(
      "Self-rated energy avg (1-10)",
      metrics.reflectionEnergyAvg,
      p?.reflectionEnergyAvg ?? null,
      1
    ),
    withDelta(
      "Tasks completed (total)",
      metrics.todoistCompletedTotal,
      p?.todoistCompletedTotal ?? null
    ),
    withDelta(
      "Habit consistency (%)",
      metrics.habitConsistencyPct,
      p?.habitConsistencyPct ?? null
    ),
  ];
  for (const line of pushes) if (line) summaryLines.push(`- ${line}`);
  summaryLines.push(
    `- Supplement logs: ${metrics.supplementsLogged} (${metrics.distinctSupplements} distinct)`
  );
  summaryLines.push(
    `- Habit completions: ${metrics.habitsCompleted} of ${metrics.habitOpportunities} opportunities`
  );

  // Compact per-day table — JSON Lines, one day per line, null fields
  // dropped to keep tokens down.
  const rows = records.map(d => {
    const row: Record<string, unknown> = { date: d.dateKey };
    if (d.recovery !== null) row.recovery = Math.round(d.recovery);
    if (d.hrv !== null) row.hrv = Math.round(d.hrv);
    if (d.strain !== null) row.strain = round1(d.strain);
    if (d.restingHr !== null) row.rhr = Math.round(d.restingHr);
    if (d.sleepHours !== null) row.sleepH = round1(d.sleepHours);
    if (d.samsungSleepScore !== null)
      row.sleepScore = Math.round(d.samsungSleepScore);
    if (d.samsungEnergy !== null) row.energy = round1(d.samsungEnergy);
    if (d.steps !== null) row.steps = Math.round(d.steps);
    if (d.spo2 !== null) row.spo2 = round1(d.spo2);
    if (d.tasksDone !== null) row.tasks = d.tasksDone;
    if (d.supplements.length) row.supps = d.supplements;
    if (d.habitsTotal > 0)
      row.habits = `${d.habitsDone.length}/${d.habitsTotal}`;
    if (d.habitsDone.length) row.habitsDone = d.habitsDone;
    if (d.reflectionEnergy !== null) row.reflEnergy = d.reflectionEnergy;
    return JSON.stringify(row);
  });

  // Reflections verbatim — the qualitative "why". Only days that have
  // any free text are included.
  const reflectionBlocks: string[] = [];
  for (const d of records) {
    const parts: string[] = [];
    if (d.wentWell) parts.push(`went well: ${d.wentWell}`);
    if (d.didntGo) parts.push(`didn't go: ${d.didntGo}`);
    if (d.tomorrowOneThing)
      parts.push(`tomorrow's one thing: ${d.tomorrowOneThing}`);
    if (parts.length)
      reflectionBlocks.push(`${d.dateKey} — ${parts.join("; ")}`);
  }

  const userParts: string[] = [
    summaryLines.join("\n"),
    ``,
    `Per-day records (most recent last):`,
    rows.join("\n"),
  ];
  if (reflectionBlocks.length) {
    userParts.push(
      ``,
      `Nightly reflections (verbatim):`,
      reflectionBlocks.join("\n")
    );
  }
  userParts.push(
    ``,
    `Write the review now. Return JSON only, schema as specified.`
  );

  return { system, user: userParts.join("\n") };
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
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Anthropic ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as AnthropicMessagesResponse;
  const block = data.content?.find(c => c.type === "text");
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
  model?: string;
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
    listDailyMetricsForRange,
    listReflectionsForRange,
    upsertWeeklyReview,
    getIntegrationByProvider,
  } = await import("../../db");
  const { extractAnthropicAuth } = await import(
    "../integrations/anthropicSelector"
  );

  // Prior-week range for week-over-week deltas (7 days before start).
  const priorStart = shiftIsoDate(range.startDateKey, -7);
  const priorEnd = shiftIsoDate(range.endDateKey, -7);

  const [snapshots, metricRows, reflections, priorMetricRows] =
    await Promise.all([
      listDailySnapshotsForRange(userId, range.startDateKey, range.endDateKey),
      listDailyMetricsForRange(userId, range.startDateKey, range.endDateKey),
      listReflectionsForRange(userId, range.startDateKey, range.endDateKey),
      listDailyMetricsForRange(userId, priorStart, priorEnd),
    ]);

  const records = buildWeekRecords(metricRows, snapshots, reflections);
  const metrics = summarizeWeek(records);
  // Prior week: metrics only (we don't render its narrative), so an
  // empty supplements/habits/reflections set is fine.
  const priorRecords = buildWeekRecords(priorMetricRows, [], []);
  const priorMetrics =
    priorRecords.length > 0 ? summarizeWeek(priorRecords) : null;

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

  // Pinned to Opus 4.8 (env-overridable). We deliberately ignore the
  // user's per-account chat model here — the weekly review wants depth.
  const model = DEFAULT_MODEL;
  const { system, user } = buildWeeklyReviewPrompts(
    weekKey,
    range,
    records,
    metrics,
    priorMetrics
  );

  let raw: string | null = null;
  try {
    raw = await callAnthropic(auth.accessToken, model, system, user);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[weeklyReview] Anthropic call failed:", message);
    await upsertWeeklyReview({
      ...baseRow,
      status: "failed",
      headline: null,
      contentMarkdown: null,
      model,
      generatedAt: null,
      errorMessage: message.slice(0, 500),
      createdAt: now,
    });
    return { status: "failed", weekKey, metrics, model, errorMessage: message };
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
    return { status: "failed", weekKey, metrics, model, errorMessage };
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
  return { status: "ready", weekKey, summary: parsed, metrics, model };
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
      if (result.status === "ready" || result.status === "insufficient")
        ok += 1;
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
    whoopHrvAvg: null,
    whoopHrvSamples: 0,
    whoopStrainAvg: null,
    whoopStrainSamples: 0,
    whoopRestingHrAvg: null,
    whoopRestingHrSamples: 0,
    stepsAvg: null,
    stepsSamples: 0,
    samsungEnergyAvg: null,
    samsungEnergySamples: 0,
    samsungSleepScoreAvg: null,
    samsungSleepScoreSamples: 0,
    reflectionEnergyAvg: null,
    reflectionEnergySamples: 0,
    habitOpportunities: 0,
    habitConsistencyPct: null,
    distinctSupplements: 0,
  };
}

// Touch dateKeysInRange so this module stays bound to the shared
// dateKey semantics it relies on for range expansion in callers/tests.
void dateKeysInRange;
