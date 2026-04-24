/**
 * Pure correlation analysis for supplement-on vs supplement-off day splits
 * across a single health/productivity metric.
 *
 * Isolated from DB + tRPC so it can be unit-tested without fixtures. The
 * caller is responsible for fetching the supplement log dates and the
 * metric values for the analysis window.
 *
 * Framing note: this returns Cohen's d (effect size) and Pearson r
 * (logged=0/1 vs value), not p-values. Users have small-n personal data;
 * effect sizes + sample counts are more honest here. We also gate results
 * behind a minimum sample threshold so small random splits don't read as
 * signal.
 */
import { toDateKey } from "@shared/dateKey";

/** Minimum samples required in BOTH on and off groups for a result. */
export const MIN_GROUP_SIZE = 7;

export interface CorrelationInput {
  /** Date the supplement was logged (dateKey `YYYY-MM-DD`). */
  suppLogDates: ReadonlySet<string>;
  /** Per-day metric rows for the analysis window, any order. */
  metrics: ReadonlyArray<{ dateKey: string; value: number | null }>;
  /**
   * Days to lag the supplement effect forward. `lagDays = 1` means "today's
   * supplement intake is compared to tomorrow's metric" (useful for e.g.
   * sleep supplements that should influence the NEXT morning's recovery).
   * Accepts 0..3. Values outside are clamped.
   */
  lagDays: number;
}

export interface CorrelationPoint {
  dateKey: string;
  logged: boolean;
  value: number;
}

export interface CorrelationResult {
  insufficientData: boolean;
  onN: number;
  offN: number;
  onMean: number | null;
  offMean: number | null;
  /** Cohen's d using pooled standard deviation. Null when either group is empty. */
  cohensD: number | null;
  /** Pearson r between `logged` (0/1) and `value`. Null when <3 valid points. */
  pearsonR: number | null;
  /** Per-day scatter data for the UI. */
  points: CorrelationPoint[];
}

function shiftDateKey(dateKey: string, deltaDays: number): string {
  // Keep this self-contained; mirror the simple date math we use elsewhere.
  const parts = dateKey.split("-");
  if (parts.length !== 3) return dateKey;
  const d = new Date(
    Number(parts[0]),
    Number(parts[1]) - 1,
    Number(parts[2])
  );
  if (Number.isNaN(d.getTime())) return dateKey;
  d.setDate(d.getDate() + deltaDays);
  return toDateKey(d);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Population variance (n, not n-1) so Cohen's d pooling behaves sanely on small n. */
function variance(values: readonly number[], m: number): number {
  if (values.length === 0) return 0;
  let sumSq = 0;
  for (const v of values) {
    const delta = v - m;
    sumSq += delta * delta;
  }
  return sumSq / values.length;
}

function cohensD(onValues: readonly number[], offValues: readonly number[]): number | null {
  if (onValues.length === 0 || offValues.length === 0) return null;
  const onMean = mean(onValues)!;
  const offMean = mean(offValues)!;
  const pooled = Math.sqrt(
    (variance(onValues, onMean) + variance(offValues, offMean)) / 2
  );
  if (!Number.isFinite(pooled) || pooled === 0) return null;
  return (onMean - offMean) / pooled;
}

function pearson(points: readonly CorrelationPoint[]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXy = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const p of points) {
    const x = p.logged ? 1 : 0;
    const y = p.value;
    sumX += x;
    sumY += y;
    sumXy += x * y;
    sumX2 += x * x;
    sumY2 += y * y;
  }
  const numerator = n * sumXy - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const r = numerator / denominator;
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}

export function analyzeCorrelation(input: CorrelationInput): CorrelationResult {
  const lag = Math.max(0, Math.min(3, Math.floor(input.lagDays)));

  const points: CorrelationPoint[] = [];
  for (const row of input.metrics) {
    if (row.value === null || !Number.isFinite(row.value)) continue;
    const checkDate = lag === 0 ? row.dateKey : shiftDateKey(row.dateKey, -lag);
    points.push({
      dateKey: row.dateKey,
      logged: input.suppLogDates.has(checkDate),
      value: row.value,
    });
  }

  const onValues: number[] = [];
  const offValues: number[] = [];
  for (const p of points) {
    if (p.logged) onValues.push(p.value);
    else offValues.push(p.value);
  }

  const insufficientData =
    onValues.length < MIN_GROUP_SIZE || offValues.length < MIN_GROUP_SIZE;

  return {
    insufficientData,
    onN: onValues.length,
    offN: offValues.length,
    onMean: mean(onValues),
    offMean: mean(offValues),
    cohensD: cohensD(onValues, offValues),
    pearsonR: pearson(points),
    points,
  };
}
