/**
 * Masthead — broadsheet front-page header.
 *
 * Two stacked rows:
 *
 *   1. Nameplate strip (inverted, ink background) —
 *      ● PRODUCTIVITY HUB · VOL XIV · ISSUE 109     SUN · APR 19 · 2026 · CST
 *      followed by a 3px double rule.
 *   2. Live row (paper background) — short date · weather · LAST UPDATED · FOCUS toggle.
 *
 * VOL/ISSUE math lives in masthead.helpers.ts so it's unit-testable.
 *
 * Spec: handoff/web-spec.md §"Masthead.tsx" + handoff D1 wireframe §STRIP.
 */
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useFocusMode } from "@/contexts/FocusModeContext";
import {
  computeIssueNumber,
  computeVolume,
  formatBroadsheetDate,
  getTimezoneAbbreviation,
} from "./masthead.helpers";

interface WeatherLike {
  tempF?: number | null;
  description?: string | null;
  city?: string | null;
}

interface MastheadProps {
  dateKey: string; // YYYY-MM-DD
  weather?: WeatherLike | null;
  /** ISO string or Date — used to derive the ISSUE number. Optional. */
  accountCreatedAt?: string | Date | null;
  lastUpdated?: Date;
  className?: string;
}

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTH_NAMES = [
  "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
  "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

function formatDateLabel(dateKey: string): string {
  // dateKey = YYYY-MM-DD — render in local time, not UTC.
  const [y, m, d] = dateKey.split("-").map(Number);
  if (!y || !m || !d) return dateKey;
  const dt = new Date(y, m - 1, d);
  return `${DAY_NAMES[dt.getDay()]} · ${MONTH_NAMES[dt.getMonth()]} ${d} · ${y}`;
}

function formatTime(d: Date): string {
  return d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
}

export function Masthead({
  dateKey,
  weather,
  accountCreatedAt,
  lastUpdated,
  className,
}: MastheadProps) {
  const { focusMode, toggle } = useFocusMode();
  // Refresh the "LAST UPDATED" minute tick every 30s so it doesn't
  // look frozen when the user returns to the tab.
  const [now, setNow] = useState<Date>(() => lastUpdated ?? new Date());
  useEffect(() => {
    if (lastUpdated) {
      setNow(lastUpdated);
      return;
    }
    const id = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(id);
  }, [lastUpdated]);

  // VOL/ISSUE only need to recompute when the day changes — derive from
  // `dateKey` (YYYY-MM-DD) so we don't tick every 30s for nothing.
  const nameplate = useMemo(() => {
    const [y, m, d] = dateKey.split("-").map(Number);
    const dayDate = y && m && d ? new Date(y, m - 1, d) : new Date();
    return {
      vol: computeVolume(dayDate),
      issue: computeIssueNumber(dayDate, accountCreatedAt ?? null),
      longDate: formatBroadsheetDate(dayDate),
      tz: getTimezoneAbbreviation(dayDate),
    };
  }, [dateKey, accountCreatedAt]);

  const weatherLabel =
    weather && typeof weather.tempF === "number"
      ? [
          `${Math.round(weather.tempF)}°F`,
          weather.description ?? null,
          weather.city ?? null,
        ]
          .filter(Boolean)
          .join(" · ")
      : "WEATHER · OFFLINE";

  return (
    <header
      className={cn("fp-masthead", className)}
      data-focus={focusMode ? "1" : "0"}
    >
      {/* --- Nameplate (broadsheet header strip) --- */}
      <div
        className="fp-masthead__nameplate"
        role="presentation"
      >
        <div className="fp-masthead__nameplate-left">
          <span aria-hidden="true" className="fp-masthead__dot" />
          PRODUCTIVITY HUB · VOL {nameplate.vol} · ISSUE {nameplate.issue}
        </div>
        <div className="fp-masthead__nameplate-right">
          {nameplate.longDate} · {nameplate.tz}
        </div>
      </div>

      {/* 3px double rule between nameplate and live row. The rule is a
          pure :before on the live row — keeps the DOM tree small. */}
      <div className="fp-masthead__live">
        <div className="fp-masthead__left mono-label">
          {formatDateLabel(dateKey)}
        </div>

        <div className="fp-masthead__mid mono-label" aria-live="polite">
          {weatherLabel}
        </div>

        <div className="fp-masthead__right">
          <span className="mono-label">LAST UPDATED {formatTime(now)}</span>
          <button
            type="button"
            className="fp-focus-toggle mono-label"
            aria-pressed={focusMode}
            aria-label={focusMode ? "Exit focus mode" : "Enter focus mode"}
            onClick={toggle}
            title="Press F to toggle"
          >
            FOCUS {focusMode ? "[■]" : "[ ]"}
          </button>
        </div>
      </div>
    </header>
  );
}
