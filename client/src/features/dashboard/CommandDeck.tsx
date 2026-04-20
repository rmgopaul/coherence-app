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
import "./command-deck.css";

const VIEWS = [
  { key: "1", path: "/dashboard", label: "Front Page" },
  { key: "2", path: "/dashboard/one-thing", label: "One Thing" },
  { key: "3", path: "/dashboard/river", label: "River" },
  { key: "4", path: "/dashboard/canvas", label: "Canvas" },
  { key: "5", path: "/dashboard/command", label: "Command Deck" },
] as const;

function clockLabel(now: Date): string {
  return now
    .toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .toUpperCase();
}

export default function CommandDeck() {
  const data = useDashboardData();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  const quotes = data.market?.quotes ?? [];
  const tickerItems = quotes.slice(0, 8);
  const overdueCount = data.tasks.dueToday.filter((t) => {
    const due = t.due?.date;
    if (!due) return false;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : due.slice(0, 10);
    return dateOnly < new Date().toISOString().slice(0, 10);
  }).length;

  const headline =
    data.kingOfDay?.title ??
    data.tasks.dueToday[0]?.content ??
    "ALL CLEAR";
  const headlineReason =
    data.kingOfDay?.reason ??
    (overdueCount > 0
      ? `${overdueCount} overdue — fix the bleed first.`
      : "ship something small.");

  const next = data.calendar.find((e) => {
    const startIso = e.start?.dateTime ?? e.start?.date ?? null;
    if (!startIso) return false;
    return new Date(startIso).getTime() > Date.now();
  });
  const nextStart = next?.start?.dateTime ?? next?.start?.date ?? null;
  const minsUntil = nextStart
    ? Math.max(0, Math.round((new Date(nextStart).getTime() - Date.now()) / 60_000))
    : null;

  return (
    <div className="fp-cmd-root">
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
                {data.calendar
                  .filter((e) => {
                    const s = e.start?.dateTime ?? e.start?.date ?? null;
                    if (!s || e.id === next.id) return false;
                    return new Date(s).getTime() > Date.now();
                  })
                  .slice(0, 4)
                  .map((e) => {
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

        <footer className="fp-cmd__foot">
          <span>SWITCH VIEW</span>
          {VIEWS.map((v) => (
            <a
              key={v.key}
              href={v.path}
              className={
                location.pathname === v.path
                  ? "fp-cmd__view fp-cmd__view--on"
                  : "fp-cmd__view"
              }
            >
              <kbd>{v.key}</kbd> {v.label}
            </a>
          ))}
        </footer>
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
