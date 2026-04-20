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
