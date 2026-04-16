/**
 * Shared utility functions used across multiple pages.
 *
 * Extracted to avoid the ~200 lines of duplication where toErrorMessage(),
 * clean(), formatKwh(), downloadTextFile(), etc. were copy-pasted into
 * 9+ page components independently.
 */

/* ------------------------------------------------------------------ */
/*  String helpers                                                      */
/* ------------------------------------------------------------------ */

/** Trim a value to a string, treating null/undefined as empty. */
export function clean(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/** Extract a human-readable message from an unknown error. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

/* ------------------------------------------------------------------ */
/*  Number formatting                                                   */
/* ------------------------------------------------------------------ */

const CURRENCY_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");

const KWH_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "$0.00";
  return CURRENCY_FORMATTER.format(value);
}

export function formatCount(value: number): string {
  return COUNT_FORMATTER.format(value);
}

export function formatKwh(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0 kWh";
  return `${KWH_FORMATTER.format(value)} kWh`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return `${PERCENT_FORMATTER.format(value)}%`;
}

/* ------------------------------------------------------------------ */
/*  File download                                                       */
/* ------------------------------------------------------------------ */

/** Trigger a browser download of a text file. */
export function downloadTextFile(fileName: string, content: string, mimeType = "text/csv;charset=utf-8"): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  Date/time helpers                                                   */
/* ------------------------------------------------------------------ */

/** Format an ISO string to locale date-time. */
export function formatDateTime(iso: string | null | undefined): string {
  const parsed = clean(iso);
  if (!parsed) return "";
  const date = new Date(parsed);
  if (Number.isNaN(date.getTime())) return parsed;
  return date.toLocaleString("en-US");
}

/**
 * Format a Date as a local-time `YYYY-MM-DD` string. Does NOT use UTC —
 * uses the local timezone, so the resulting key matches what the user
 * sees on their calendar that day.
 */
export function toLocalDateKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Format milliseconds to HH:MM:SS. */
export function formatDuration(valueMs: number | null | undefined): string {
  if (valueMs === null || valueMs === undefined || !Number.isFinite(valueMs) || valueMs < 0) {
    return "-";
  }
  const totalSeconds = Math.floor(valueMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
