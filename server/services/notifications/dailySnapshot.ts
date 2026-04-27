import { nanoid } from "nanoid";
import { formatTodayKey } from "@shared/dateKey";
import {
  getDailyMetricByDate,
  getIntegrationByProvider,
  getLatestSamsungSyncPayload,
  getHabitCompletionsByDate,
  listHabitDefinitions,
  listSupplementDefinitions,
  listSupplementLogs,
  listUsers,
  upsertDailyMetric,
  upsertDailySnapshot,
} from "../../db";
import { getValidWhoopToken } from "../../helpers/tokenRefresh";
import { getTodoistCompletedTaskCount } from "../integrations/todoist";
import { getWhoopSummary } from "../integrations/whoop";

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

function pickNumber(incoming: number | null, fallback: number | null | undefined): number | null {
  return incoming ?? fallback ?? null;
}

export async function captureDailySnapshotForUser(userId: number, dateKey = formatTodayKey()) {
  const existingMetric = await getDailyMetricByDate(userId, dateKey);

  let whoopPayload: Record<string, unknown> | null = null;
  let whoopRecoveryScore: number | null = null;
  let whoopDayStrain: number | null = null;
  let whoopSleepHours: number | null = null;
  let whoopHrvMs: number | null = null;
  let whoopRestingHr: number | null = null;

  const whoopIntegration = await getIntegrationByProvider(userId, "whoop");
  if (whoopIntegration?.accessToken) {
    try {
      const accessToken = await getValidWhoopToken(userId);
      const whoop = await getWhoopSummary(accessToken);
      whoopPayload = whoop as unknown as Record<string, unknown>;
      whoopRecoveryScore = asNumber(whoop.recoveryScore);
      whoopDayStrain = asNumber(whoop.dayStrain);
      whoopSleepHours = asNumber(whoop.sleepHours);
      whoopHrvMs = asNumber(whoop.hrvRmssdMilli);
      whoopRestingHr = asNumber(whoop.restingHeartRate);
    } catch (error) {
      console.error(`[Nightly Snapshot] WHOOP capture failed for user ${userId}:`, error);
    }
  }

  let samsungSteps: number | null = null;
  let samsungSleepHours: number | null = null;
  let samsungSpo2AvgPercent: number | null = null;
  let samsungSleepScore: number | null = null;
  let samsungEnergyScore: number | null = null;
  let samsungPayload: Record<string, unknown> | null = null;

  const latestSamsungRaw = await getLatestSamsungSyncPayload(userId, dateKey);
  if (latestSamsungRaw?.payload) {
    samsungPayload = parseJsonRecord(latestSamsungRaw.payload);
  }

  const samsungIntegration = await getIntegrationByProvider(userId, "samsung-health");
  if (samsungIntegration?.metadata) {
    const metadata = parseJsonRecord(samsungIntegration.metadata);
    const summary =
      metadata.summary && typeof metadata.summary === "object"
        ? (metadata.summary as Record<string, unknown>)
        : {};
    const manualScores =
      metadata.manualScores && typeof metadata.manualScores === "object"
        ? (metadata.manualScores as Record<string, unknown>)
        : {};

    const sleepMinutes = asNumber(summary.sleepTotalMinutes);
    samsungSteps = asNumber(summary.steps);
    samsungSleepHours = sleepMinutes !== null ? Number((sleepMinutes / 60).toFixed(1)) : null;
    samsungSpo2AvgPercent = asNumber(summary.spo2AvgPercent);
    samsungSleepScore = asNumber(manualScores.sleepScore) ?? asNumber(summary.sleepScore);
    samsungEnergyScore = asNumber(manualScores.energyScore) ?? asNumber(summary.energyScore);

    if (!samsungPayload) {
      samsungPayload = metadata;
    }
  }

  let todoistCompletedCount: number | null = null;
  const todoistIntegration = await getIntegrationByProvider(userId, "todoist");
  if (todoistIntegration?.accessToken) {
    try {
      todoistCompletedCount = await getTodoistCompletedTaskCount(todoistIntegration.accessToken, dateKey);
    } catch (error) {
      console.error(`[Nightly Snapshot] Todoist capture failed for user ${userId}:`, error);
    }
  }

  await upsertDailyMetric({
    id: nanoid(),
    userId,
    dateKey,
    whoopRecoveryScore: pickNumber(whoopRecoveryScore, existingMetric?.whoopRecoveryScore),
    whoopDayStrain: pickNumber(whoopDayStrain, existingMetric?.whoopDayStrain),
    whoopSleepHours: pickNumber(whoopSleepHours, existingMetric?.whoopSleepHours),
    whoopHrvMs: pickNumber(whoopHrvMs, existingMetric?.whoopHrvMs),
    whoopRestingHr: pickNumber(whoopRestingHr, existingMetric?.whoopRestingHr),
    samsungSteps: pickNumber(samsungSteps, existingMetric?.samsungSteps),
    samsungSleepHours: pickNumber(samsungSleepHours, existingMetric?.samsungSleepHours),
    samsungSpo2AvgPercent: pickNumber(samsungSpo2AvgPercent, existingMetric?.samsungSpo2AvgPercent),
    samsungSleepScore: pickNumber(samsungSleepScore, existingMetric?.samsungSleepScore),
    samsungEnergyScore: pickNumber(samsungEnergyScore, existingMetric?.samsungEnergyScore),
    todoistCompletedCount: pickNumber(todoistCompletedCount, existingMetric?.todoistCompletedCount),
  });

  const [supplements, supplementDefinitions, habits, completions] = await Promise.all([
    listSupplementLogs(userId, dateKey, 1000),
    listSupplementDefinitions(userId),
    listHabitDefinitions(userId),
    getHabitCompletionsByDate(userId, dateKey),
  ]);

  const completionMap = new Map(completions.map((completion) => [completion.habitId, Boolean(completion.completed)]));
  const habitsPayload = habits.map((habit) => ({
    id: habit.id,
    name: habit.name,
    color: habit.color,
    completed: completionMap.get(habit.id) ?? false,
  }));

  await upsertDailySnapshot({
    id: nanoid(),
    userId,
    dateKey,
    capturedAt: new Date(),
    whoopPayload: whoopPayload ? JSON.stringify(whoopPayload) : null,
    samsungPayload: samsungPayload ? JSON.stringify(samsungPayload) : null,
    supplementsPayload: JSON.stringify({
      definitions: supplementDefinitions,
      logs: supplements,
    }),
    habitsPayload: JSON.stringify(habitsPayload),
    todoistCompletedCount,
  });

  // Task 6.1: pre-compute the supplement-vs-metric correlation grid
  // for this user. Runs on the just-upserted `dailyHealthMetrics`
  // row so the dashboard's top-signals card reads fresh numbers.
  // Wrapped in try/catch so a correlation failure can't break the
  // rest of the snapshot — the user's data still gets captured even
  // if the stats step has a problem.
  let correlationsWritten = 0;
  try {
    const { runNightlySupplementCorrelationsForUser } = await import(
      "../supplements/correlationNightly"
    );
    const out = await runNightlySupplementCorrelationsForUser(userId);
    correlationsWritten = out.slicesWritten;
  } catch (error) {
    console.error(
      `[Nightly Snapshot] Supplement correlation compute failed for user ${userId}:`,
      error
    );
  }

  return {
    userId,
    dateKey,
    todoistCompletedCount,
    whoopCaptured: Boolean(whoopPayload),
    samsungCaptured: Boolean(samsungPayload),
    supplementLogCount: supplements.length,
    habitCount: habits.length,
    correlationsWritten,
  };
}

export async function captureDailySnapshotForAllUsers(dateKey = formatTodayKey()) {
  const users = await listUsers();
  const results = [];
  for (const user of users) {
    try {
      const result = await captureDailySnapshotForUser(user.id, dateKey);
      results.push(result);
    } catch (error) {
      console.error(`[Nightly Snapshot] User ${user.id} failed:`, error);
      results.push({
        userId: user.id,
        dateKey,
        error: (error as Error).message,
      });
    }
  }
  return results;
}

export function getTodayDateKey() {
  return formatTodayKey();
}
