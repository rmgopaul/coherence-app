/**
 * Client-side display + assembly helpers for the Habits feature.
 * Pure functions only (no React, no tRPC).
 */

import { adherencePct } from "@shared/supplements.math";
import type { HabitEntry, HabitStreakRow } from "@/features/dashboard/types";

/** Format a streak as a short label: `🔥 7` or `—` when zero. */
export function formatStreak(streak: number): string {
  if (!Number.isFinite(streak) || streak <= 0) return "—";
  return `🔥 ${streak}`;
}

/**
 * Completion rate across a list of habit entries for a single day.
 * Returns 0..1 (divide-by-zero safe).
 */
export function completionRate(habits: readonly HabitEntry[]): number {
  if (habits.length === 0) return 0;
  const done = habits.filter((h) => h.completed).length;
  return adherencePct(done, habits.length);
}

/** Count currently-active habits (treats undefined isActive as active). */
export function countActive(habits: readonly HabitEntry[]): number {
  return habits.filter((h) => h.isActive !== false).length;
}

/** Longest streak across all habits (0 when list is empty). */
export function longestStreak(rows: readonly HabitStreakRow[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((acc, r) => (r.streak > acc ? r.streak : acc), 0);
}

// ────────────────────────────────────────────────────────────────────
// Heatmap grid builder (copied from SupplementsAdherenceHeatmap.tsx).
// Extract to a shared module when a 3rd caller appears.
// ────────────────────────────────────────────────────────────────────

export interface CompletionDay {
  dateKey: string;
  completed: boolean;
}

interface Cell {
  day: CompletionDay | null;
  iso: string;
}

/**
 * Arrange days into a 7-row (Sun→Sat) × N-column grid starting with the
 * week that contains the first day. Missing cells before the first day
 * and after the last day are filled with null placeholders so all rows
 * have the same column count.
 */
export function buildCompletionGrid(days: readonly CompletionDay[]): Cell[][] {
  if (days.length === 0) return [];

  const rows: Cell[][] = [[], [], [], [], [], [], []];
  const first = new Date(`${days[0].dateKey}T00:00:00`);
  const firstDow = first.getDay();

  for (let i = 0; i < firstDow; i += 1) {
    rows[i].push({ day: null, iso: `pad-start-${i}` });
  }

  for (const day of days) {
    const parsed = new Date(`${day.dateKey}T00:00:00`);
    rows[parsed.getDay()].push({ day, iso: day.dateKey });
  }

  const maxCols = Math.max(...rows.map((r) => r.length));
  for (let i = 0; i < rows.length; i += 1) {
    while (rows[i].length < maxCols) {
      rows[i].push({ day: null, iso: `pad-end-${i}-${rows[i].length}` });
    }
  }

  return rows;
}

/**
 * Color class for a completion cell. Domain-specific — not extracted yet
 * because the color scale differs from the supplements adherence grid.
 */
export function colorForCompletion(day: CompletionDay | null): string {
  if (!day) return "bg-transparent";
  if (!day.completed) return "bg-muted";
  return "bg-emerald-600";
}

/** Label used for Cohen's d magnitude in the Sleep report. */
export function cohensDMagnitude(d: number | null): "negligible" | "small" | "medium" | "large" | "—" {
  if (d === null) return "—";
  const abs = Math.abs(d);
  if (abs < 0.2) return "negligible";
  if (abs < 0.5) return "small";
  if (abs < 0.8) return "medium";
  return "large";
}
