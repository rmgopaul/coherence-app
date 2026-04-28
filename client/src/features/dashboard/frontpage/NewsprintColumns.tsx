/**
 * NewsprintColumns — three broadsheet columns under the hero.
 *
 *   TODAY           UP NEXT           WAITING ON
 *   (calendar)      (tasks)           (sent-no-reply inbox)
 *
 * Each column uses the same newspaper-rule header. Empty states are
 * intentionally voicey — an empty "Waiting On" column reads
 * "nothing waiting." in Instrument Serif italic, per the spec.
 *
 * Spec: handoff/web-spec.md §"NewsprintColumns.tsx"
 */
import type { CalendarEvent, TodoistTask, GmailWaitingOnItem } from "../types";
// Task 10.3 (2026-04-28): "📎 N linked notes" badge for calendar
// events that have notes attached via the Notebook→Calendar handoff.
import { LinkedNotesBadge } from "./LinkedNotesBadge";
import { trpc } from "@/lib/trpc";
import { useMemo } from "react";
import {
  daysAgoLabel,
  eventLocationLabel,
  extractName,
  formatEventTime,
} from "./newsprint.helpers";
import { TasksTriage } from "./TasksTriage";

interface NewsprintColumnsProps {
  calendar: CalendarEvent[];
  tasks: {
    dueToday: TodoistTask[];
    completedCount: number;
  };
  waitingOn: GmailWaitingOnItem[];
}

/* ------------------------------------------------------------------ */
/*  Today — next events                                                */
/* ------------------------------------------------------------------ */

function TodayColumn({ events }: { events: CalendarEvent[] }) {
  const upcoming = events
    .filter((e) => {
      const startIso = e.start?.dateTime ?? e.start?.date ?? null;
      if (!startIso) return false;
      const startMs = new Date(startIso).getTime();
      return !Number.isNaN(startMs) && startMs >= Date.now() - 5 * 60_000;
    })
    .slice(0, 6);

  // Task 10.3: batched note-count query so the 📎 badge renders
  // without N separate listForExternal calls per event in the
  // column. One round-trip serves the whole list.
  const eventIds = useMemo(
    () => upcoming.map((e) => e.id ?? "").filter(Boolean),
    [upcoming]
  );
  const noteCountsQuery = trpc.notes.countLinksByExternalIds.useQuery(
    { linkType: "google_calendar_event" as const, externalIds: eventIds },
    { enabled: eventIds.length > 0, staleTime: 60_000 }
  );
  const noteCountsByEventId = noteCountsQuery.data?.counts ?? {};

  return (
    <section className="fp-col">
      <header className="fp-col__head">
        <h2 className="fp-col__title">TODAY</h2>
      </header>
      {upcoming.length === 0 ? (
        <p className="fp-empty">nothing on the calendar.</p>
      ) : (
        <ol className="fp-col__list">
          {upcoming.map((event, i) => {
            const startIso = event.start?.dateTime ?? event.start?.date ?? null;
            const loc = eventLocationLabel(event);
            const title = event.summary ?? "(untitled)";
            return (
              <li
                key={event.id ?? `${startIso}-${i}`}
                className="fp-row"
                data-first={i === 0 ? "1" : undefined}
              >
                <span className="fp-row__time mono-label">
                  {formatEventTime(startIso)}
                </span>
                <span className="fp-row__rule" aria-hidden="true" />
                <span className="fp-row__title">
                  {i === 0 ? <mark className="hl">{title}</mark> : title}
                </span>
                {loc && (
                  <span className="fp-row__meta mono-label">{loc}</span>
                )}
                {/* Task 10.3: 📎 N linked notes badge — only renders
                    when the count is > 0 and the event has a stable
                    id (synthetic-id rows skip the lookup). */}
                {event.id && (
                  <LinkedNotesBadge
                    linkType="google_calendar_event"
                    externalId={event.id}
                    count={noteCountsByEventId[event.id]}
                  />
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Up Next — replaced in F4 by TasksTriage (priority-banded view).    */
/*  See ./TasksTriage.tsx                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Waiting On — sent-no-reply                                         */
/* ------------------------------------------------------------------ */

function WaitingOnColumn({ items }: { items: GmailWaitingOnItem[] }) {
  const top = items.slice(0, 6);

  return (
    <section className="fp-col">
      <header className="fp-col__head">
        <h2 className="fp-col__title">WAITING ON</h2>
      </header>
      {top.length === 0 ? (
        <p className="fp-empty">nothing waiting.</p>
      ) : (
        <ol className="fp-col__list">
          {top.map((item) => {
            const name = extractName(item.to || item.from || "");
            const subject = item.subject || "(no subject)";
            return (
              <li key={item.id} className="fp-row">
                <span
                  className="fp-row__time mono-label"
                  title={name}
                >
                  {name.toUpperCase()}
                </span>
                <span className="fp-row__rule" aria-hidden="true" />
                <span className="fp-row__title">{subject}</span>
                <span className="fp-row__meta mono-label">
                  {daysAgoLabel(item.date)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Container                                                          */
/* ------------------------------------------------------------------ */

export function NewsprintColumns({
  calendar,
  tasks,
  waitingOn,
}: NewsprintColumnsProps) {
  return (
    <section
      aria-label="Today, up next, and waiting on"
      className="fp-newsprint"
    >
      <TodayColumn events={calendar} />
      <TasksTriage tasks={tasks} />
      <WaitingOnColumn items={waitingOn} />
    </section>
  );
}
