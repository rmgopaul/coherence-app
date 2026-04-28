/**
 * Cross-domain insights — Anthropic joins the trailing 90 days of
 * `dailySnapshots` + `dailyReflections` and returns 3-5 plain-English
 * correlations. Cached for the day in `userInsights`; user can force
 * a regenerate via the tRPC mutation.
 *
 * Mirrors `weeklyReview.ts` structure: pure helpers for parsing /
 * prompt building (testable), defensive JSON extraction, always
 * upserts a row even on failure so the surface always has state.
 *
 * Triggers:
 *   1. tRPC `insights.generate` mutation runs this directly.
 *   2. (Future) cron — easy to bolt on once the prompt stabilizes.
 */

import { nanoid } from "nanoid";
import { dateKeysInRange } from "@shared/dateKey";
import { shiftIsoDate } from "../solar/helpers";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_API_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
export const INSIGHTS_PROMPT_VERSION = "v1";
const MIN_DAYS_REQUIRED = 14;
const WINDOW_DAYS = 90;

export interface InsightItem {
  title: string;
  body: string;
  confidence: "low" | "medium" | "high";
}

export type InsightsStatus = "ready" | "insufficient" | "failed" | "no-key";

export interface InsightsResult {
  status: InsightsStatus;
  insights: InsightItem[];
  daysAnalyzed: number;
  rangeStartKey: string;
  rangeEndKey: string;
  model: string;
  errorMessage?: string;
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

interface ReflectionLike {
  dateKey: string;
  energyLevel: number | null;
  wentWell: string | null;
  didntGo: string | null;
  tomorrowOneThing: string | null;
}

export interface DailyAggregate {
  dateKey: string;
  supplements: string[];
  habits: string[];
  whoopRecovery: number | null;
  whoopHrv: number | null;
  whoopSleepHours: number | null;
  whoopStrain: number | null;
  samsungEnergy: number | null;
  samsungSleepScore: number | null;
  samsungSleepHours: number | null;
  reflectionEnergy: number | null;
  reflectionWentWell: string | null;
  todoistCompleted: number | null;
}

function parseJsonSafe(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickNumber(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const value = (obj as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pickStringList(obj: unknown, key: string): string[] {
  if (!obj || typeof obj !== "object") return [];
  const value = (obj as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .slice(0, 30);
}

/**
 * Project per-day snapshots + reflections into a flat record per
 * dateKey. Only days with at least one signal beyond `dateKey` are
 * returned — empty days are dropped so the prompt stays dense.
 *
 * Pure function — exposed for unit testing.
 */
export function aggregateDays(
  snapshots: ReadonlyArray<SnapshotLike>,
  reflections: ReadonlyArray<ReflectionLike>
): DailyAggregate[] {
  const reflectionsByDate = new Map<string, ReflectionLike>();
  for (const r of reflections) reflectionsByDate.set(r.dateKey, r);

  const out: DailyAggregate[] = [];
  for (const snap of snapshots) {
    const whoop = parseJsonSafe(snap.whoopPayload);
    const samsung = parseJsonSafe(snap.samsungPayload);
    const supps = parseJsonSafe(snap.supplementsPayload);
    const habits = parseJsonSafe(snap.habitsPayload);
    const reflection = reflectionsByDate.get(snap.dateKey) ?? null;

    const samsungSleepMs = pickNumber(samsung, "sleepDurationMs");

    const day: DailyAggregate = {
      dateKey: snap.dateKey,
      supplements: pickStringList(supps, "names"),
      habits: pickStringList(habits, "names"),
      whoopRecovery: pickNumber(whoop, "recoveryScore"),
      whoopHrv: pickNumber(whoop, "hrvRmssdMilli"),
      whoopSleepHours: pickNumber(whoop, "sleepHours"),
      whoopStrain: pickNumber(whoop, "dayStrain"),
      samsungEnergy: pickNumber(samsung, "energyScore"),
      samsungSleepScore: pickNumber(samsung, "sleepScore"),
      samsungSleepHours:
        samsungSleepMs !== null ? samsungSleepMs / 3_600_000 : null,
      reflectionEnergy: reflection?.energyLevel ?? null,
      reflectionWentWell: reflection?.wentWell ?? null,
      todoistCompleted: snap.todoistCompletedCount,
    };

    const hasSignal =
      day.supplements.length > 0 ||
      day.habits.length > 0 ||
      day.whoopRecovery !== null ||
      day.samsungEnergy !== null ||
      day.reflectionEnergy !== null ||
      day.todoistCompleted !== null;
    if (hasSignal) out.push(day);
  }
  return out;
}

/**
 * Build the prompt fed to Anthropic. The user message includes a
 * compact JSON-ish table of the 90 days, NOT the raw payloads — this
 * keeps the token count manageable while preserving the columns
 * Anthropic actually needs to find correlations.
 *
 * Pure — exposed for testing.
 */
export function buildInsightsPrompt(
  days: ReadonlyArray<DailyAggregate>,
  userName?: string | null
): { system: string; user: string } {
  const subject = (userName ?? "").trim() || "the user";
  const system = [
    `You are ${subject}'s personal health-data analyst.`,
    `You are looking at ${days.length} days of joined biological + behavioral data.`,
    ``,
    `Find 3-5 ACTIONABLE correlations the user could change behavior on.`,
    `Bias toward surprising patterns and toward levers (supplements, habits, sleep timing).`,
    `Avoid trivial / tautological observations ("you have higher energy when you sleep more").`,
    `When a correlation has fewer than 5 supporting days, mark it confidence "low".`,
    ``,
    `Output STRICT JSON ONLY — no markdown, no prose before or after.`,
    `Schema: { "insights": [{ "title": string, "body": string, "confidence": "low"|"medium"|"high" }] }`,
    ``,
    `Style:`,
    `- title: <= 80 chars, single sentence, must lead with the lever ("On L-theanine days,...").`,
    `- body: 1-2 short sentences, plain English, surface the magnitude when you can.`,
    `- Never invent supplements, habits, or numbers not in the data.`,
    `- If no meaningful correlation exists, return { "insights": [] }.`,
  ].join("\n");

  // Compact table — JSON Lines, one day per line. Drops empty fields
  // to keep tokens down. Anthropic handles this format well.
  const rows = days.map((d) => {
    const row: Record<string, unknown> = { date: d.dateKey };
    if (d.supplements.length) row.supps = d.supplements;
    if (d.habits.length) row.habits = d.habits;
    if (d.whoopRecovery !== null) row.recovery = d.whoopRecovery;
    if (d.whoopHrv !== null) row.hrv = Math.round(d.whoopHrv);
    if (d.whoopSleepHours !== null)
      row.whoopSleep = Math.round(d.whoopSleepHours * 10) / 10;
    if (d.whoopStrain !== null) row.strain = Math.round(d.whoopStrain);
    if (d.samsungEnergy !== null) row.energy = d.samsungEnergy;
    if (d.samsungSleepScore !== null) row.sleepScore = d.samsungSleepScore;
    if (d.samsungSleepHours !== null)
      row.samsungSleep = Math.round(d.samsungSleepHours * 10) / 10;
    if (d.reflectionEnergy !== null) row.reflectE = d.reflectionEnergy;
    if (d.todoistCompleted !== null) row.tasksDone = d.todoistCompleted;
    return JSON.stringify(row);
  });

  const user = [
    `Daily records (most recent last):`,
    rows.join("\n"),
    ``,
    `Return JSON only.`,
  ].join("\n");

  return { system, user };
}

function extractJsonPayload(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/**
 * Parse an Anthropic response into typed insights. Drops malformed
 * items rather than failing the whole call. Pure — exposed for tests.
 */
export function parseInsightsResponse(text: string): InsightItem[] | null {
  const payload = extractJsonPayload(text);
  if (!payload) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const arr = (parsed as Record<string, unknown>).insights;
  if (!Array.isArray(arr)) return null;

  const out: InsightItem[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const body = typeof obj.body === "string" ? obj.body.trim() : "";
    const conf =
      typeof obj.confidence === "string"
        ? obj.confidence.trim().toLowerCase()
        : "medium";
    if (!title || !body) continue;
    const confidence: InsightItem["confidence"] =
      conf === "high" ? "high" : conf === "low" ? "low" : "medium";
    out.push({
      title: title.slice(0, 200),
      body: body.slice(0, 600),
      confidence,
    });
    if (out.length >= 5) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  HTTP                                                               */
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
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Anthropic ${response.status} ${response.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`
    );
  }
  const data = (await response.json()) as AnthropicMessagesResponse;
  return data.content?.find((c) => c.type === "text")?.text ?? null;
}

/* ------------------------------------------------------------------ */
/*  Public service                                                     */
/* ------------------------------------------------------------------ */

/**
 * Generate (or regenerate) cross-domain insights for one user. Always
 * upserts a row in `userInsights` keyed on (userId, today's dateKey)
 * so the dashboard surface has something to render even when
 * Anthropic fails or the user has no API key configured.
 */
export async function generateInsightsForUser(
  userId: number,
  todayDateKey: string
): Promise<InsightsResult> {
  const rangeEndKey = todayDateKey;
  const rangeStartKey = shiftIsoDate(todayDateKey, -(WINDOW_DAYS - 1));
  // Touch dateKeysInRange so this stays in sync with shared/dateKey
  // semantics; the value is only used for sanity checks in tests.
  void dateKeysInRange(rangeStartKey, rangeEndKey);

  const {
    listDailySnapshotsForRange,
    listRecentReflections,
    upsertUserInsight,
    getIntegrationByProvider,
  } = await import("../../db");
  const { extractAnthropicAuth } = await import(
    "../integrations/anthropicSelector"
  );

  const [snapshots, reflections] = await Promise.all([
    listDailySnapshotsForRange(userId, rangeStartKey, rangeEndKey),
    listRecentReflections(userId, WINDOW_DAYS),
  ]);
  const days = aggregateDays(snapshots, reflections);

  const id = nanoid();
  const now = new Date();
  const baseRow = {
    id,
    userId,
    dateKey: todayDateKey,
    rangeStartKey,
    rangeEndKey,
    daysAnalyzed: days.length,
    promptVersion: INSIGHTS_PROMPT_VERSION,
    generatedAt: now,
    updatedAt: now,
  };

  if (days.length < MIN_DAYS_REQUIRED) {
    const message = `Only ${days.length} day(s) of data in the trailing ${WINDOW_DAYS} — need at least ${MIN_DAYS_REQUIRED} for meaningful correlations.`;
    await upsertUserInsight({
      ...baseRow,
      model: "n/a",
      insightsJson: JSON.stringify([]),
      status: "failed",
      errorMessage: message,
    });
    return {
      status: "insufficient",
      insights: [],
      daysAnalyzed: days.length,
      rangeStartKey,
      rangeEndKey,
      model: "n/a",
      errorMessage: message,
    };
  }

  const anthropicIntegration = await getIntegrationByProvider(
    userId,
    "anthropic"
  );
  const auth = extractAnthropicAuth({
    accessToken: anthropicIntegration?.accessToken ?? null,
    metadata: anthropicIntegration?.metadata ?? null,
  });
  if (!auth.accessToken) {
    const message =
      "No Anthropic API key on file — connect Claude in Settings to generate insights.";
    await upsertUserInsight({
      ...baseRow,
      model: "n/a",
      insightsJson: JSON.stringify([]),
      status: "failed",
      errorMessage: message,
    });
    return {
      status: "no-key",
      insights: [],
      daysAnalyzed: days.length,
      rangeStartKey,
      rangeEndKey,
      model: "n/a",
      errorMessage: message,
    };
  }

  const model = auth.model ?? DEFAULT_MODEL;
  const { system, user } = buildInsightsPrompt(days);

  let raw: string | null;
  try {
    raw = await callAnthropic(auth.accessToken, model, system, user);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[insights] Anthropic call failed:", message);
    await upsertUserInsight({
      ...baseRow,
      model,
      insightsJson: JSON.stringify([]),
      status: "failed",
      errorMessage: message.slice(0, 500),
    });
    return {
      status: "failed",
      insights: [],
      daysAnalyzed: days.length,
      rangeStartKey,
      rangeEndKey,
      model,
      errorMessage: message,
    };
  }

  const insights = raw ? parseInsightsResponse(raw) : null;
  if (!insights) {
    const message = "Anthropic response did not parse as expected JSON.";
    await upsertUserInsight({
      ...baseRow,
      model,
      insightsJson: JSON.stringify([]),
      status: "failed",
      errorMessage: message,
    });
    return {
      status: "failed",
      insights: [],
      daysAnalyzed: days.length,
      rangeStartKey,
      rangeEndKey,
      model,
      errorMessage: message,
    };
  }

  await upsertUserInsight({
    ...baseRow,
    model,
    insightsJson: JSON.stringify(insights),
    status: "ready",
    errorMessage: null,
  });

  return {
    status: "ready",
    insights,
    daysAnalyzed: days.length,
    rangeStartKey,
    rangeEndKey,
    model,
  };
}
