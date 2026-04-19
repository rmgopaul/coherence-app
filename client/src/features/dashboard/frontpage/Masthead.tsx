/**
 * Masthead — 56px strip across the top of the front-page dashboard.
 *
 * Left:   date in JetBrains Mono, uppercase, letter-spaced.
 * Middle: weather (falls back to "WEATHER · OFFLINE" until Phase D).
 * Right:  last-updated timestamp + FOCUS toggle.
 *
 * Spec: handoff/web-spec.md §"Masthead.tsx"
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useFocusMode } from "@/contexts/FocusModeContext";

interface WeatherLike {
  tempF?: number | null;
  description?: string | null;
  city?: string | null;
}

interface MastheadProps {
  dateKey: string; // YYYY-MM-DD
  weather?: WeatherLike | null;
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
      <div className="fp-masthead__left mono-label">
        {formatDateLabel(dateKey)}
      </div>

      <div className="fp-masthead__mid mono-label" aria-live="polite">
        {weatherLabel}
      </div>

      <div className="fp-masthead__right">
        <span className="mono-label">
          LAST UPDATED {formatTime(now)}
        </span>
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
    </header>
  );
}
