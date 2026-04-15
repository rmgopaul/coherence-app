import {
  SEARCH_SCORE_EXACT,
  SEARCH_SCORE_PREFIX,
  SEARCH_SCORE_CONTAINS,
  SEARCH_SCORE_ALL_TOKENS,
} from "../../constants";
import { DEFAULT_OPENAI_MODEL } from "./constants";

// ---------------------------------------------------------------------------
// Generic utility functions
// ---------------------------------------------------------------------------

export function parseJsonMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function resolveOpenAIModel(metadata: string | null | undefined): string {
  const parsed = parseJsonMetadata(metadata);
  const model = parsed.model;
  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : DEFAULT_OPENAI_MODEL;
}

export function toNullableScore(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  return null;
}

export function getTodayDateKey(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function normalizeSearchQuery(value: string): string {
  return value.trim().toLowerCase();
}

export function truncateText(value: string, maxLength = 180): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}\u2026`;
}

export function scoreMatch(haystack: string, query: string): number {
  const text = normalizeSearchQuery(haystack);
  if (!text || !query) return 0;
  if (text === query) return SEARCH_SCORE_EXACT;
  if (text.startsWith(query)) return SEARCH_SCORE_PREFIX;
  if (text.includes(query)) return SEARCH_SCORE_CONTAINS;
  const tokens = query.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((token) => text.includes(token))) return SEARCH_SCORE_ALL_TOKENS;
  return 0;
}

export function safeIso(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export function computePearsonCorrelation(
  values: Array<{
    x: number | null;
    y: number | null;
  }>
): number | null {
  const points = values
    .filter((value) => value.x !== null && value.y !== null)
    .map((value) => ({ x: value.x as number, y: value.y as number }));
  if (points.length < 3) return null;

  const n = points.length;
  const sumX = points.reduce((acc, point) => acc + point.x, 0);
  const sumY = points.reduce((acc, point) => acc + point.y, 0);
  const sumXy = points.reduce((acc, point) => acc + point.x * point.y, 0);
  const sumX2 = points.reduce((acc, point) => acc + point.x * point.x, 0);
  const sumY2 = points.reduce((acc, point) => acc + point.y * point.y, 0);

  const numerator = n * sumXy - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  const correlation = numerator / denominator;
  if (!Number.isFinite(correlation)) return null;
  return Math.max(-1, Math.min(1, correlation));
}

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export function normalizeProgressPercent(currentStep: number, totalSteps: number): number {
  if (!Number.isFinite(totalSteps) || totalSteps <= 0) return 0;
  return clampPercent((currentStep / totalSteps) * 100);
}
