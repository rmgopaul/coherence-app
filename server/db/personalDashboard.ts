import { nanoid } from "nanoid";

import { and, eq, getDb, withDbRetry } from "./_core";
import {
  personalDashboardDailyState,
  type PersonalDashboardDailyState as PersonalDashboardDailyStateRow,
} from "../../drizzle/schema";
import type {
  PersonalDashboardCommitment,
  PersonalDashboardDailyBrief,
  PersonalDashboardDailyBriefStatus,
  PersonalDashboardDailyState,
  PersonalDashboardOutcome,
  PersonalDashboardTodayPlan,
  PersonalDashboardTodayPlanStatus,
} from "@shared/personalDashboard";

export type PersonalDashboardDailyStatePatch = {
  dailyBriefStatus?: PersonalDashboardDailyBriefStatus;
  dailyBrief?: PersonalDashboardDailyBrief | null;
  todayPlanStatus?: PersonalDashboardTodayPlanStatus;
  todayPlan?: PersonalDashboardTodayPlan | null;
  commitments?: PersonalDashboardCommitment[];
  outcomes?: PersonalDashboardOutcome[];
};

export async function getPersonalDashboardDailyStateRow(
  userId: number,
  dateKey: string
): Promise<PersonalDashboardDailyStateRow | null> {
  const db = await getDb();
  if (!db) return null;

  const rows = await withDbRetry(
    "get personal dashboard daily state",
    async () =>
      db
        .select()
        .from(personalDashboardDailyState)
        .where(
          and(
            eq(personalDashboardDailyState.userId, userId),
            eq(personalDashboardDailyState.dateKey, dateKey)
          )
        )
        .limit(1)
  );

  return rows[0] ?? null;
}

export async function getPersonalDashboardDailyState(
  userId: number,
  dateKey: string
): Promise<PersonalDashboardDailyState> {
  return normalizePersonalDashboardDailyState(
    await getPersonalDashboardDailyStateRow(userId, dateKey),
    dateKey
  );
}

export async function upsertPersonalDashboardDailyState(
  userId: number,
  dateKey: string,
  patch: PersonalDashboardDailyStatePatch
): Promise<PersonalDashboardDailyState> {
  const db = await getDb();
  if (!db) return getPersonalDashboardDailyState(userId, dateKey);

  const now = new Date();
  const values = patchToDbValues(patch, now);

  await withDbRetry("upsert personal dashboard daily state", async () => {
    await db
      .insert(personalDashboardDailyState)
      .values({
        id: nanoid(),
        userId,
        dateKey,
        ...values,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({
        set: values,
      });
  });

  return getPersonalDashboardDailyState(userId, dateKey);
}

export function normalizePersonalDashboardDailyState(
  row: PersonalDashboardDailyStateRow | null,
  dateKey: string
): PersonalDashboardDailyState {
  if (!row) {
    return {
      dateKey,
      dailyBriefStatus: "not_started",
      dailyBrief: null,
      todayPlanStatus: "not_started",
      todayPlan: null,
      commitments: [],
      outcomes: [],
      updatedAt: null,
    };
  }

  return {
    dateKey: row.dateKey,
    dailyBriefStatus: row.dailyBriefStatus,
    dailyBrief: parseJson<PersonalDashboardDailyBrief | null>(
      row.dailyBriefJson,
      null
    ),
    todayPlanStatus: row.todayPlanStatus,
    todayPlan: parseJson<PersonalDashboardTodayPlan | null>(
      row.todayPlanJson,
      null
    ),
    commitments: parseJson<PersonalDashboardCommitment[]>(
      row.commitmentsJson,
      []
    ),
    outcomes: parseJson<PersonalDashboardOutcome[]>(row.outcomesJson, []),
    updatedAt: toIso(row.updatedAt),
  };
}

function patchToDbValues(patch: PersonalDashboardDailyStatePatch, now: Date) {
  return {
    ...(patch.dailyBriefStatus !== undefined
      ? { dailyBriefStatus: patch.dailyBriefStatus }
      : {}),
    ...(patch.dailyBrief !== undefined
      ? { dailyBriefJson: stringifyNullable(patch.dailyBrief) }
      : {}),
    ...(patch.todayPlanStatus !== undefined
      ? { todayPlanStatus: patch.todayPlanStatus }
      : {}),
    ...(patch.todayPlan !== undefined
      ? { todayPlanJson: stringifyNullable(patch.todayPlan) }
      : {}),
    ...(patch.commitments !== undefined
      ? { commitmentsJson: JSON.stringify(patch.commitments) }
      : {}),
    ...(patch.outcomes !== undefined
      ? { outcomesJson: JSON.stringify(patch.outcomes) }
      : {}),
    updatedAt: now,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringifyNullable(value: unknown): string | null {
  return value === null ? null : JSON.stringify(value);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
