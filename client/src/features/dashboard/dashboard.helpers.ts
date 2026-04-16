/**
 * Pure helper functions for the Dashboard page.
 *
 * Extracted from Dashboard.tsx during refactoring. Stateless — no React
 * hooks, no component-local state. All functions are byte-identical to
 * the originals.
 */

import type { CalendarEvent } from "./types";
import { IGNORED_ALL_DAY_SUMMARIES, WEATHER_CODE_LABELS } from "./dashboard.constants";

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export const getWeatherLabel = (code?: number): string => {
  if (typeof code !== "number") return "Weather unavailable";
  return WEATHER_CODE_LABELS[code] || "Weather unavailable";
};

// ---------------------------------------------------------------------------
// HTML / text
// ---------------------------------------------------------------------------

export const decodeHtmlEntities = (content: string): string => {
  if (typeof window === "undefined") return content.replace(/&nbsp;/gi, " ");
  const textarea = document.createElement("textarea");
  textarea.innerHTML = content;
  return textarea.value;
};

export const toPlainText = (content: string): string =>
  decodeHtmlEntities(
    content
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const normalizeEventText = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------

export const formatCalendarEventLabel = (event: CalendarEvent): string => {
  const summary = String(event?.summary || "Untitled event").trim() || "Untitled event";
  const startDateTime = event?.start?.dateTime;
  const startDate = event?.start?.date;
  const raw = startDateTime || startDate;
  if (!raw) return summary;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return summary;

  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  if (startDateTime) {
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${summary} · ${weekday} ${time}`;
  }
  return `${summary} · ${weekday} all-day`;
};

/** Returns true if the event is a non-actionable all-day status marker (e.g. "Home"). */
export const isIgnoredStatusEvent = (event: CalendarEvent): boolean => {
  const summary = (event?.summary || "").trim().toLowerCase();
  if (!summary) return false;
  const isAllDay = !event?.start?.dateTime && !!event?.start?.date;
  return isAllDay && IGNORED_ALL_DAY_SUMMARIES.has(summary);
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

export const isSameLocalDay = (dateA: Date, dateB: Date): boolean => {
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
};
