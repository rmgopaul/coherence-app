/**
 * OneThing — D2 view (Phase F6).
 *
 * Route: /dashboard/one-thing
 *
 * Strips the dashboard down to a single 120pt headline and the
 * smallest possible support cast: a deck line, time/link chips,
 * the next three calendar items as "after that", and a tiny
 * right-rail of section counts so the user knows what's waiting.
 *
 * Distinct from focus mode (which lives at /dashboard with the
 * masthead + hero) because this is a navigable URL — bookmarkable,
 * shareable, the literal expression of "the one thing today".
 *
 * Spec: handoff/Productivity Hub Reimagined (2).html §D2
 */
import { useMemo } from "react";
import { useDashboardData } from "./useDashboardData";
import { DashboardViewsNav } from "./DashboardViewsNav";
import { isTaskOverdue, taskPriorityOrder } from "./frontpage/newsprint.helpers";
import "./frontpage/dashboard.css";

interface DerivedHeadline {
  title: string;
  reason: string;
  meta: { dueLabel: string | null; sourceLabel: string };
}

function deriveOneThing(data: ReturnType<typeof useDashboardData>): DerivedHeadline {
  // 1. Server-picked king is authoritative when present.
  if (data.kingOfDay?.title) {
    return {
      title: data.kingOfDay.title,
      reason: data.kingOfDay.reason ?? "today's headline",
      meta: {
        dueLabel: null,
        sourceLabel:
          data.kingOfDay.source === "manual"
            ? "PINNED"
            : data.kingOfDay.source === "ai"
              ? "AI · KING OF DAY"
              : "AUTO · KING OF DAY",
      },
    };
  }

  // 2. Fall back to the most-overdue / highest-priority task.
  const sorted = [...data.tasks.dueToday].sort(
    (a, b) => taskPriorityOrder(a) - taskPriorityOrder(b)
  );
  const overdue = sorted.find((t) => isTaskOverdue(t));
  const top = overdue ?? sorted[0];
  if (top) {
    return {
      title: top.content,
      reason: overdue
        ? "overdue — finish this first."
        : "P1 today — start here.",
      meta: { dueLabel: top.due?.date ?? null, sourceLabel: "TODOIST" },
    };
  }

  // 3. Empty state — say so loudly.
  return {
    title: "nothing burning.",
    reason: "pick one and ship it.",
    meta: { dueLabel: null, sourceLabel: "EMPTY" },
  };
}

export default function OneThing() {
  const data = useDashboardData();
  const headline = useMemo(() => deriveOneThing(data), [data]);

  // "After that" — next 3 calendar events that haven't started yet.
  const afterThat = useMemo(() => {
    const now = Date.now();
    return [...data.calendar]
      .filter((e) => {
        const startIso = e.start?.dateTime ?? e.start?.date ?? null;
        if (!startIso) return false;
        const t = new Date(startIso).getTime();
        return !Number.isNaN(t) && t > now;
      })
      .sort((a, b) => {
        const aT = new Date(a.start?.dateTime ?? a.start?.date ?? 0).getTime();
        const bT = new Date(b.start?.dateTime ?? b.start?.date ?? 0).getTime();
        return aT - bT;
      })
      .slice(0, 3);
  }, [data.calendar]);

  // Section counts for the right rail.
  const counts = {
    tasks: data.tasks.dueToday.length,
    inbox: data.unreadGmailCount,
    waiting: data.waitingOn.length,
    events: data.calendar.length,
  };

  return (
    <div className="fp-root fp-onething-root">
      <DashboardViewsNav />
      <div className="fp-onething">
        <article className="fp-onething__main">
          <div className="fp-onething__eyebrow mono-label">
            01 · YOUR ONE TODAY ·{" "}
            <strong className="fp-onething__source">{headline.meta.sourceLabel}</strong>
          </div>
          <h1 className="fp-onething__head">
            {headline.title}
          </h1>
          <p className="fp-onething__deck">{headline.reason}</p>

          <div className="fp-onething__chips">
            {headline.meta.dueLabel && (
              <span className="fp-onething__when">
                DUE {String(headline.meta.dueLabel).slice(0, 16).toUpperCase()}
              </span>
            )}
            <a
              href="/dashboard"
              className="fp-onething__link"
              title="Back to the full dashboard"
            >
              ← OPEN FULL DASHBOARD
            </a>
          </div>

          <div className="fp-onething__after">
            <h3 className="fp-onething__after-head mono-label">AFTER THAT</h3>
            {afterThat.length === 0 ? (
              <p className="fp-empty">no other meetings today.</p>
            ) : (
              <div className="fp-onething__after-grid">
                {afterThat.map((e) => {
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
                    <div key={e.id ?? startIso ?? Math.random()} className="fp-onething__after-slot">
                      <div className="mono-label">{time}</div>
                      <h4>{e.summary ?? "(untitled)"}</h4>
                      {e.location && (
                        <p>{e.location.length > 60 ? `${e.location.slice(0, 57)}…` : e.location}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </article>

        <aside className="fp-onething__rail" aria-label="Counts">
          <h5 className="fp-onething__rail-head mono-label">RIGHT NOW</h5>
          <RailRow value={counts.tasks} valueClass="red" label="OPEN TASKS" sub="due today" />
          <RailRow value={counts.inbox} valueClass="blue" label="UNREAD" sub="important + flagged" />
          <RailRow value={counts.waiting} valueClass="green" label="WAITING ON" sub="sent, no reply" />
          <RailRow value={counts.events} valueClass="" label="EVENTS" sub="today's calendar" />
        </aside>
      </div>
    </div>
  );
}

function RailRow({
  value,
  valueClass,
  label,
  sub,
}: {
  value: number;
  valueClass: "" | "red" | "blue" | "green";
  label: string;
  sub: string;
}) {
  return (
    <div className="fp-onething__rail-row">
      <div
        className={`fp-onething__rail-n${
          valueClass ? ` fp-onething__rail-n--${valueClass}` : ""
        }`}
      >
        {value}
      </div>
      <div className="fp-onething__rail-meta">
        <div className="fp-onething__rail-lbl">{label}</div>
        <div className="fp-onething__rail-sub">{sub}</div>
      </div>
    </div>
  );
}
