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
import {
  daysAgoLabel,
  eventLocationLabel,
  extractName,
  formatEventTime,
  isTaskOverdue,
  taskPriorityOrder,
} from "./newsprint.helpers";

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
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Up Next — due tasks                                                */
/* ------------------------------------------------------------------ */

function UpNextColumn({
  tasks,
}: {
  tasks: NewsprintColumnsProps["tasks"];
}) {
  const sorted = [...tasks.dueToday]
    .sort((a, b) => {
      const overdueA = isTaskOverdue(a) ? 0 : 1;
      const overdueB = isTaskOverdue(b) ? 0 : 1;
      if (overdueA !== overdueB) return overdueA - overdueB;
      return taskPriorityOrder(a) - taskPriorityOrder(b);
    })
    .slice(0, 8);

  return (
    <section className="fp-col">
      <header className="fp-col__head">
        <h2 className="fp-col__title">UP NEXT</h2>
        <span className="mono-label">
          {tasks.completedCount} DONE · {tasks.dueToday.length} DUE
        </span>
      </header>
      {sorted.length === 0 ? (
        <p className="fp-empty">inbox zero for today.</p>
      ) : (
        <ol className="fp-col__list">
          {sorted.map((task) => {
            const overdue = isTaskOverdue(task);
            return (
              <li key={task.id} className="fp-row">
                <span className="fp-row__time mono-label">
                  P{5 - (task.priority ?? 1)}
                </span>
                <span className="fp-row__rule" aria-hidden="true" />
                <span
                  className={`fp-row__title${overdue ? " strike" : ""}`}
                >
                  {task.content}
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
                <span className="fp-row__time mono-label">
                  {name.slice(0, 14).toUpperCase()}
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
      <UpNextColumn tasks={tasks} />
      <WaitingOnColumn items={waitingOn} />
    </section>
  );
}
