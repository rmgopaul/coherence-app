/**
 * CommandDeck — D5 view (Phase F9).
 *
 * Route: /dashboard/command
 *
 * A force-dark, dense, kbd-driven view: top ticker → hero on the left
 * → two stacked panels on the right (Tasks + Markets). Pure data
 * surface; intended for "I just want to see everything" sessions
 * rather than the editorial /dashboard.
 *
 * Switches to other dashboard views via 1–5 digit shortcuts (handled
 * in components/layout/KeyboardShortcuts.tsx when on /dashboard*).
 *
 * Spec: handoff/Productivity Hub Reimagined (2).html §D5
 */
import { useEffect, useState } from "react";
import { useDashboardData } from "./useDashboardData";
import { DashboardViewsNav } from "./DashboardViewsNav";
import {
  clockLabel,
  deriveCommandHeadline,
  pickNextEvent,
  pickUpcomingAfter,
} from "./command/command.helpers";
import "./command-deck.css";
import "./frontpage/dashboard.css";

export default function CommandDeck() {
  const data = useDashboardData();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const quotes = data.market?.quotes ?? [];
  const tickerItems = quotes.slice(0, 8);

  const { headline, reason: headlineReason } = deriveCommandHeadline({
    kingOfDay: data.kingOfDay,
    tasks: data.tasks.dueToday,
  });
  const { event: next, minsUntil } = pickNextEvent(data.calendar);

  return (
    <div className="fp-cmd-root">
      <DashboardViewsNav />
      <div className="fp-cmd">
        <div className="fp-cmd__top">
          <div className="fp-cmd__top-l">
            <span className="fp-cmd__live">●</span> COMMAND DECK · LIVE
          </div>
          <div className="fp-cmd__top-c">DASHBOARD · D5</div>
          <div className="fp-cmd__top-r">{clockLabel(now)}</div>
        </div>

        {/* Ticker */}
        <div className="fp-cmd__ticker" aria-label="Markets ticker">
          {tickerItems.length === 0 ? (
            <span className="fp-cmd__ticker-empty">MARKETS · OFFLINE</span>
          ) : (
            tickerItems.map((q) => (
              <span key={q.symbol} className="fp-cmd__ticker-item">
                <b>{q.symbol}</b> {Number(q.price ?? 0).toFixed(2)}{" "}
                <em
                  className={
                    Number(q.changePercent ?? 0) >= 0
                      ? "fp-cmd__delta--up"
                      : "fp-cmd__delta--down"
                  }
                >
                  {Number(q.changePercent ?? 0) >= 0 ? "▲" : "▼"}{" "}
                  {Math.abs(Number(q.changePercent ?? 0)).toFixed(2)}%
                </em>
              </span>
            ))
          )}
        </div>

        {/* Grid: hero + 2 panels */}
        <div className="fp-cmd__grid">
          <section className="fp-cmd__hero">
            <div className="fp-cmd__slot">
              SLOT 01 · <b>HEADLINE</b>
            </div>
            <h1 className="fp-cmd__head">
              {headline}
            </h1>
            <p className="fp-cmd__deck">{headlineReason}</p>
            <div className="fp-cmd__stats">
              <Stat label="OPEN TASKS" value={data.tasks.dueToday.length} variant="red" />
              <Stat label="UNREAD" value={data.unreadGmailCount} variant="yel" />
              <Stat label="WAITING ON" value={data.waitingOn.length} variant="grn" />
            </div>
          </section>

          <section className="fp-cmd__panel">
            <h5>TASKS · TODAY</h5>
            {data.tasks.dueToday.length === 0 ? (
              <p className="fp-cmd__empty">no open tasks.</p>
            ) : (
              data.tasks.dueToday.slice(0, 6).map((t) => {
                const p = t.priority ?? 1;
                const due = t.due?.date ?? "";
                const time = /T\d{2}:\d{2}/.test(due)
                  ? new Date(due)
                      .toLocaleTimeString([], {
                        hour: "numeric",
                        minute: "2-digit",
                      })
                      .toUpperCase()
                  : "—";
                const titleClass =
                  p === 4 ? "fp-cmd__feed-title--bad" : p === 3 ? "fp-cmd__feed-title--hi" : "";
                return (
                  <div key={t.id} className="fp-cmd__feed-item">
                    <time>{time}</time>
                    <div>
                      <h4 className={titleClass}>{t.content}</h4>
                      <p>P{5 - p}</p>
                    </div>
                  </div>
                );
              })
            )}
          </section>

          <section className="fp-cmd__panel">
            <h5>NEXT UP · CALENDAR</h5>
            {!next ? (
              <p className="fp-cmd__empty">nothing else scheduled today.</p>
            ) : (
              <>
                <div className="fp-cmd__feed-item">
                  <time>T–{minsUntil}m</time>
                  <div>
                    <h4 className="fp-cmd__feed-title--hi">
                      {next.summary ?? "(untitled)"}
                    </h4>
                    <p>{next.location ?? "no room"}</p>
                  </div>
                </div>
                {pickUpcomingAfter(data.calendar, next.id, Date.now(), 4).map((e) => {
                    const startIso = e.start?.dateTime ?? e.start?.date ?? null;
                    const time = startIso
                      ? new Date(startIso)
                          .toLocaleTimeString([], {
                            hour: "numeric",
                            minute: "2-digit",
                          })
                          .toUpperCase()
                      : "—";
                    return (
                      <div key={e.id ?? startIso ?? Math.random()} className="fp-cmd__feed-item">
                        <time>{time}</time>
                        <div>
                          <h4>{e.summary ?? "(untitled)"}</h4>
                          {e.location && <p>{e.location}</p>}
                        </div>
                      </div>
                    );
                  })}
              </>
            )}
          </section>
        </div>

      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant: "red" | "yel" | "grn" | "";
}) {
  return (
    <div className="fp-cmd__stat">
      <div className={`fp-cmd__stat-v${variant ? ` fp-cmd__stat-v--${variant}` : ""}`}>
        {value}
      </div>
      <div className="fp-cmd__stat-l">{label}</div>
    </div>
  );
}
