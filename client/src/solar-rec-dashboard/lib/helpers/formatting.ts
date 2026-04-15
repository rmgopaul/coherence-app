/**
 * Display-formatting helpers. Turn numbers and dates into
 * human-readable strings for the dashboard UI. Pure functions only.
 */

import { NUMBER_FORMATTER } from "@/solar-rec-dashboard/lib/constants";

export function formatDate(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatMonthYear(value: Date | null): string {
  if (!value) return "N/A";
  return value.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });
}

export function formatNumber(
  value: number | null,
  digits = 0,
): string {
  if (value === null) return "N/A";
  if (digits > 0) return value.toFixed(digits);
  return NUMBER_FORMATTER.format(value);
}

export function formatKwh(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

export function formatCapacityKw(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 3,
  });
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function toPercentValue(
  numerator: number,
  denominator: number,
): number | null {
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  )
    return null;
  return (numerator / denominator) * 100;
}

export function formatSignedNumber(value: number): string {
  if (!Number.isFinite(value)) return "N/A";
  if (value > 0) return `+${NUMBER_FORMATTER.format(value)}`;
  if (value < 0) return `-${NUMBER_FORMATTER.format(Math.abs(value))}`;
  return "0";
}
