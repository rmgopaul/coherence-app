/**
 * WireFeedsGrid — 4×2 grid of feed cards below the newsprint columns.
 *
 * Each card shares the brutalist shell:
 *   ┌──────────────────────────┐
 *   │ MONO · LABEL   UPDATED   │
 *   │                          │
 *   │ …body…                   │
 *   └──────────────────────────┘
 *
 * Phase B scope: Health (Whoop), Markets (top quote), Weather
 * (placeholder until Phase D), News (placeholder until Phase D).
 * Solar / Supplements / Habits / Sports remain legacy-dashboard
 * residents — the spec asks us to reskin them, but wrapping the
 * existing card internals is deferred to Phase B.2 so this commit
 * stays scoped.
 *
 * Spec: handoff/web-spec.md §"WireFeedsGrid.tsx"
 */
import type { ReactNode } from "react";
import type { DashboardData } from "../useDashboardData";
import { SolarFeedCell } from "./feeds/SolarFeedCell";
import { SupplementsFeedCell } from "./feeds/SupplementsFeedCell";
import { HabitsFeedCell } from "./feeds/HabitsFeedCell";
import { SportsFeedCell } from "./feeds/SportsFeedCell";

/* ------------------------------------------------------------------ */
/*  Shared shell                                                       */
/* ------------------------------------------------------------------ */

interface WireCardProps {
  label: string;
  updated?: string;
  tone?: "default" | "offline" | "placeholder";
  children: ReactNode;
}

function WireCard({
  label,
  updated,
  tone = "default",
  children,
}: WireCardProps) {
  return (
    <article className="wire-card" data-tone={tone}>
      <header className="wire-card__head">
        <span className="mono-label">{label}</span>
        {updated && (
          <span className="mono-label wire-card__ts">UPDATED {updated}</span>
        )}
      </header>
      <div className="wire-card__body">{children}</div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/*  Feed cells                                                         */
/* ------------------------------------------------------------------ */

function nowShort(): string {
  return new Date()
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toUpperCase();
}

function HealthCell({ whoop }: { whoop: DashboardData["health"]["whoop"] }) {
  if (!whoop) {
    return (
      <WireCard label="HEALTH · WHOOP" tone="offline">
        <p className="fp-empty">no recovery data yet.</p>
      </WireCard>
    );
  }
  const recovery = whoop.recoveryScore ?? null;
  const sleep = whoop.sleepHours ?? null;
  const strain = whoop.dayStrain ?? null;
  return (
    <WireCard label="HEALTH · WHOOP" updated={nowShort()}>
      <div className="wire-stat-row">
        <div className="wire-stat">
          <span className="mono-label">RECOVERY</span>
          <span className="fp-stat-big">
            {recovery !== null ? recovery : "—"}
          </span>
        </div>
        <div className="wire-stat">
          <span className="mono-label">SLEEP</span>
          <span className="fp-stat-big">
            {sleep !== null ? `${sleep.toFixed(1)}h` : "—"}
          </span>
        </div>
        <div className="wire-stat">
          <span className="mono-label">STRAIN</span>
          <span className="fp-stat-big">
            {strain !== null ? strain.toFixed(1) : "—"}
          </span>
        </div>
      </div>
    </WireCard>
  );
}

function MarketsCell({ market }: { market: DashboardData["market"] }) {
  const quotes = market?.quotes ?? [];
  if (quotes.length === 0) {
    return (
      <WireCard label="MARKETS" tone="offline">
        <p className="fp-empty">markets offline.</p>
      </WireCard>
    );
  }
  const top = [...quotes].slice(0, 4);
  return (
    <WireCard label="MARKETS" updated={nowShort()}>
      <ol className="wire-ticker">
        {top.map((q) => {
          const changeClass =
            q.changePercent >= 0 ? "wire-ticker__up" : "wire-ticker__down";
          return (
            <li key={q.symbol} className="wire-ticker__row">
              <span className="wire-ticker__sym mono-label">{q.symbol}</span>
              <span className="wire-ticker__px">
                ${q.price.toFixed(q.price < 10 ? 4 : 2)}
              </span>
              <span className={`wire-ticker__pct mono-label ${changeClass}`}>
                {q.changePercent >= 0 ? "▲" : "▼"}{" "}
                {Math.abs(q.changePercent).toFixed(2)}%
              </span>
            </li>
          );
        })}
      </ol>
    </WireCard>
  );
}

function WeatherCell() {
  // Phase D lights this up — router not yet on appRouter.
  return (
    <WireCard label="WEATHER" tone="offline">
      <p className="fp-empty">no feed configured.</p>
      <p className="mono-label wire-card__hint">
        ADD OPENWEATHERMAP KEY · PHASE D
      </p>
    </WireCard>
  );
}

function NewsCell() {
  return (
    <WireCard label="NEWS · AP" tone="offline">
      <p className="fp-empty">no feed configured.</p>
      <p className="mono-label wire-card__hint">
        AP RSS · PHASE D
      </p>
    </WireCard>
  );
}

/* ------------------------------------------------------------------ */
/*  Grid                                                               */
/* ------------------------------------------------------------------ */

interface WireFeedsGridProps {
  data: DashboardData;
}

export function WireFeedsGrid({ data }: WireFeedsGridProps) {
  const updatedLabel = nowShort();
  return (
    <section
      aria-label="Wire feeds"
      className="fp-wire-grid"
    >
      <HealthCell whoop={data.health.whoop} />
      <MarketsCell market={data.market} />
      <NewsCell />
      <WeatherCell />
      <SolarFeedCell updatedLabel={updatedLabel} />
      <SupplementsFeedCell updatedLabel={updatedLabel} />
      <HabitsFeedCell updatedLabel={updatedLabel} />
      <SportsFeedCell updatedLabel={updatedLabel} />
    </section>
  );
}
