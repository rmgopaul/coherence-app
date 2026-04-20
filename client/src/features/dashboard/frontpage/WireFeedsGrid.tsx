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
import { WorkFeedCell } from "./feeds/WorkFeedCell";
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

  // Condensed layout: one headline stat (RECOVERY) + a compact mono
  // row for sleep + strain. Lets the cell breathe at 4-col desktop
  // widths without clipping.
  const recoveryBucket =
    recovery == null
      ? null
      : recovery >= 67
        ? "GREEN"
        : recovery >= 34
          ? "YELLOW"
          : "RED";

  return (
    <WireCard label="HEALTH · WHOOP" updated={nowShort()}>
      <div className="wire-stat">
        <span className="mono-label">
          RECOVERY{recoveryBucket ? ` · ${recoveryBucket}` : ""}
        </span>
        <span className="fp-stat-big">
          {recovery !== null ? recovery : "—"}
        </span>
      </div>
      <p className="mono-label wire-card__hint">
        {sleep !== null ? `${sleep.toFixed(1)}H SLEEP` : "NO SLEEP"}
        {" · "}
        {strain !== null ? `${strain.toFixed(1)} STRAIN` : "NO STRAIN"}
      </p>
    </WireCard>
  );
}

// Always renders 2 decimals (cents). Adds thousands separators once
// values cross $1,000 so crypto prices like BTC stay readable without
// overflowing the cell. Intentionally drops the thousandths/millionths
// precision that was previously shown for sub-$10 tickers.
function formatMarketPrice(value: number): string {
  if (value >= 1000) {
    return `$${value.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  return `$${value.toFixed(2)}`;
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
  // Show every configured ticker (stocks + crypto) — the server already
  // combines both into `quotes`. Prior cap of 4 was hiding configured
  // symbols.
  return (
    <WireCard label="MARKETS" updated={nowShort()}>
      <ol className="wire-ticker">
        {quotes.map((q) => {
          const changeClass =
            q.changePercent >= 0 ? "wire-ticker__up" : "wire-ticker__down";
          return (
            <li key={q.symbol} className="wire-ticker__row">
              <span className="wire-ticker__sym mono-label">{q.symbol}</span>
              <span className="wire-ticker__px">
                {formatMarketPrice(q.price)}
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

function WeatherCell({ weather }: { weather: DashboardData["weather"] }) {
  if (!weather || weather.offline || typeof weather.tempF !== "number") {
    return (
      <WireCard label="WEATHER" tone="offline">
        <p className="fp-empty">no feed configured.</p>
        <p className="mono-label wire-card__hint">
          ADD OPENWEATHERMAP_API_KEY · PHASE D
        </p>
      </WireCard>
    );
  }
  const label = weather.label ?? "Home";
  const desc = weather.description ?? "";
  const hiLo =
    typeof weather.hiF === "number" && typeof weather.loF === "number"
      ? `${weather.hiF}° / ${weather.loF}°`
      : null;
  return (
    <WireCard label={`WEATHER · ${label.toUpperCase()}`} updated={nowShort()}>
      <div className="wire-stat">
        <span className="mono-label">NOW</span>
        <span className="fp-stat-big">{weather.tempF}°</span>
      </div>
      <p className="mono-label wire-card__hint">
        {desc ? desc.toUpperCase() : "—"}
        {hiLo ? ` · ${hiLo}` : ""}
      </p>
    </WireCard>
  );
}

function relativeTimeLabel(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diff = Date.now() - d.getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function NewsCell({ news }: { news: DashboardData["news"] }) {
  if (!Array.isArray(news) || news.length === 0) {
    return (
      <WireCard label="NEWS · AP" tone="offline">
        <p className="fp-empty">no feed configured.</p>
        <p className="mono-label wire-card__hint">
          NEWS_FEED_MODE=ap-rss · PHASE D
        </p>
      </WireCard>
    );
  }
  const top = news.slice(0, 4);
  return (
    <WireCard label="NEWS · AP" updated={nowShort()}>
      <ol className="wire-newsfeed">
        {top.map((item) => (
          <li key={item.url} className="wire-newsfeed__row">
            <span className="mono-label wire-newsfeed__src">
              {(item.src ?? "AP").toUpperCase()}
            </span>
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="wire-newsfeed__title"
            >
              {item.title}
            </a>
            <span className="mono-label wire-newsfeed__ts">
              {relativeTimeLabel(item.publishedAt)}
            </span>
          </li>
        ))}
      </ol>
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
      <NewsCell news={data.news} />
      <WeatherCell weather={data.weather} />
      <WorkFeedCell updatedLabel={updatedLabel} />
      <SupplementsFeedCell updatedLabel={updatedLabel} />
      <HabitsFeedCell updatedLabel={updatedLabel} />
      <SportsFeedCell updatedLabel={updatedLabel} />
    </section>
  );
}
