/**
 * FocusModeRail — shown below the hero while focus mode is ON.
 *
 * Single-purpose strip: the next calendar event + a live countdown.
 * Zero noise — no tasks, no inbox, no markets. If nothing is scheduled
 * next, render the empty state in Instrument Serif italic so the
 * absence reads as a signal, not a bug.
 *
 * Spec: handoff/focus-mode.md §"On" state.
 */
import { useEffect, useState } from "react";
import type { CalendarEvent } from "../types";
import { countdownLabel } from "./newsprint.helpers";

interface FocusModeRailProps {
  calendar: CalendarEvent[];
}

function nextEvent(events: CalendarEvent[]): CalendarEvent | null {
  const now = Date.now();
  return (
    events
      .map((e) => {
        const startIso = e.start?.dateTime ?? e.start?.date ?? null;
        const startMs = startIso ? new Date(startIso).getTime() : NaN;
        return { event: e, startMs };
      })
      .filter(({ startMs }) => !Number.isNaN(startMs) && startMs >= now)
      .sort((a, b) => a.startMs - b.startMs)[0]?.event ?? null
  );
}

export function FocusModeRail({ calendar }: FocusModeRailProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  // `tick` only exists to force a re-render.
  void tick;

  const event = nextEvent(calendar);
  if (!event) {
    return (
      <section className="fp-focus-rail fp-focus-rail--empty" aria-live="polite">
        <p className="fp-empty fp-focus-rail__empty">
          nothing scheduled next. the rest of the day is yours.
        </p>
      </section>
    );
  }

  const startIso = event.start?.dateTime ?? event.start?.date ?? null;
  const title = event.summary ?? "(untitled)";
  const location = event.location ?? null;

  return (
    <section className="fp-focus-rail" aria-live="polite">
      <div className="fp-focus-rail__meta mono-label">NEXT UP</div>
      <div className="fp-focus-rail__title">{title}</div>
      <div className="fp-focus-rail__count mono-label">
        IN {countdownLabel(startIso)}
      </div>
      {location && (
        <div className="fp-focus-rail__loc mono-label">{location}</div>
      )}
    </section>
  );
}
