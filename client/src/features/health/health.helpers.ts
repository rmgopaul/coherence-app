/**
 * Pure display helpers for the Health feature.
 */

import { HEALTH_METRICS, type HealthMetricKey } from "./health.constants";

/** Per-metric value formatting with unit suffix. `null` → `—`. */
export function formatMetricValue(
  key: HealthMetricKey,
  value: number | null | undefined
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const meta = HEALTH_METRICS.find((m) => m.key === key);
  const unit = meta?.unit ?? "";
  // Steps want thousands separators, nothing else needs them.
  if (key === "samsungSteps") return value.toLocaleString("en-US");
  // Hours should show one decimal.
  if (unit === "h") return `${value.toFixed(1)}h`;
  if (unit === "%") return `${Math.round(value)}%`;
  if (unit === "ms" || unit === "bpm") return `${Math.round(value)} ${unit}`;
  return value.toFixed(1);
}

/**
 * Parse a comma-separated `tags` column into a trimmed, deduped list.
 */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(t);
  }
  return out;
}

/** Serialise a tag list back into the comma-separated column format. */
export function stringifyTags(tags: readonly string[]): string | null {
  const cleaned = parseTags(tags.join(","));
  return cleaned.length > 0 ? cleaned.join(", ") : null;
}

/**
 * Split a set of dateKey/value pairs into a trimmed numeric series fit
 * for Pearson correlation — drops rows where either side is null.
 */
export function pairForCorrelation(
  rows: readonly { dateKey: string; a: number | null; b: number | null }[]
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const r of rows) {
    if (r.a === null || r.b === null) continue;
    if (!Number.isFinite(r.a) || !Number.isFinite(r.b)) continue;
    out.push({ x: r.a, y: r.b });
  }
  return out;
}

/** Pearson r for an already-trimmed series. Client-side sibling of the server helper. */
export function pearsonR(points: readonly { x: number; y: number }[]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  let sumX = 0;
  let sumY = 0;
  let sumXy = 0;
  let sumX2 = 0;
  let sumY2 = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
    sumXy += p.x * p.y;
    sumX2 += p.x * p.x;
    sumY2 += p.y * p.y;
  }
  const num = n * sumXy - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (!Number.isFinite(den) || den <= 0) return null;
  const r = num / den;
  if (!Number.isFinite(r)) return null;
  return Math.max(-1, Math.min(1, r));
}

/**
 * Qualitative strength bucket for |Pearson r|. Thresholds mirror the
 * conventions used in the Supplements/Habits insights modules.
 */
export function pearsonStrength(r: number | null): "—" | "negligible" | "weak" | "moderate" | "strong" {
  if (r === null) return "—";
  const abs = Math.abs(r);
  if (abs < 0.1) return "negligible";
  if (abs < 0.3) return "weak";
  if (abs < 0.5) return "moderate";
  return "strong";
}

/**
 * Sample mean + population std dev (n divisor, matches `variance` in
 * server/services/supplements/correlation.ts so visual numbers line up
 * with the on/off-style modules).
 */
export function meanAndStd(values: readonly number[]): {
  mean: number | null;
  std: number | null;
} {
  if (values.length === 0) return { mean: null, std: null };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  let sumSq = 0;
  for (const v of values) {
    const d = v - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / values.length);
  return { mean, std };
}

/**
 * Contrast metric B's mean on days where metric A is in its top quartile
 * vs overall. Mirrors the "on vs off" split used in the Supplements and
 * Habits insights modules, but adapted for continuous × continuous data.
 * Returns null values when the top-quartile slice has < MIN_CONTRAST_N
 * points.
 */
export const MIN_CONTRAST_N = 5;

export function topQuartileContrast(
  points: readonly { x: number; y: number }[]
): {
  threshold: number | null;
  topN: number;
  topMean: number | null;
  overallMean: number | null;
} {
  if (points.length < MIN_CONTRAST_N * 2) {
    return { threshold: null, topN: 0, topMean: null, overallMean: null };
  }
  const xs = points.map((p) => p.x).slice().sort((a, b) => a - b);
  const q3Index = Math.floor(xs.length * 0.75);
  const threshold = xs[q3Index] ?? null;
  if (threshold === null) {
    return { threshold: null, topN: 0, topMean: null, overallMean: null };
  }
  const topY: number[] = [];
  const allY: number[] = [];
  for (const p of points) {
    allY.push(p.y);
    if (p.x >= threshold) topY.push(p.y);
  }
  if (topY.length < MIN_CONTRAST_N) {
    return { threshold, topN: topY.length, topMean: null, overallMean: null };
  }
  return {
    threshold,
    topN: topY.length,
    topMean: meanAndStd(topY).mean,
    overallMean: meanAndStd(allY).mean,
  };
}
