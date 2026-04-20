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
import { ApprovalFeedCell } from "./feeds/ApprovalFeedCell";
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
  const hrv = whoop.hrvRmssdMilli ?? null;
  const rhr = whoop.restingHeartRate ?? null;

  const recoveryBucket =
    recovery == null
      ? null
      : recovery >= 67
        ? "GREEN"
        : recovery >= 34
          ? "YELLOW"
          : "RED";

  // Two-column layout: recovery headline on the left, four supporting
  // metrics (sleep, strain, HRV, RHR) in a 2×2 grid on the right.
  // Sleep + strain get large display numerals so they read as
  // primary signals alongside recovery; HRV + RHR sit one tier
  // smaller because their bpm/ms units eat horizontal space.
  return (
    <WireCard label="HEALTH · WHOOP" updated={nowShort()}>
      <div className="wire-health">
        <div className="wire-health__headline">
          <span className="mono-label">
            RECOVERY{recoveryBucket ? ` · ${recoveryBucket}` : ""}
          </span>
          <span className="fp-stat-big">
            {recovery !== null ? recovery : "—"}
          </span>
        </div>
        <div className="wire-health__grid">
          <div className="wire-health__cell">
            <span className="mono-label">SLEEP</span>
            <span className="wire-health__num">
              {sleep !== null ? sleep.toFixed(1) : "—"}
              {sleep !== null && <span className="wire-health__unit">h</span>}
            </span>
          </div>
          <div className="wire-health__cell">
            <span className="mono-label">STRAIN</span>
            <span className="wire-health__num">
              {strain !== null ? strain.toFixed(1) : "—"}
            </span>
          </div>
          <div className="wire-health__cell">
            <span className="mono-label">HRV</span>
            <span className="wire-health__num wire-health__num--sm">
              {hrv !== null ? Math.round(hrv) : "—"}
              {hrv !== null && <span className="wire-health__unit">ms</span>}
            </span>
          </div>
          <div className="wire-health__cell">
            <span className="mono-label">RHR</span>
            <span className="wire-health__num wire-health__num--sm">
              {rhr !== null ? Math.round(rhr) : "—"}
              {rhr !== null && (
                <span className="wire-health__unit">bpm</span>
              )}
            </span>
          </div>
        </div>
      </div>
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
  // Split gainers / losers and sort each bucket by magnitude so the
  // biggest movers land at the top and bottom of the card. Flat
  // changes (exact 0%) sort with the gainers (neutral bias toward
  // "up"). A thin rule between the groups reads as a newspaper
  // table divider — clearer than a single sorted list.
  const gainers = quotes
    .filter((q) => q.changePercent >= 0)
    .slice()
    .sort((a, b) => b.changePercent - a.changePercent);
  const losers = quotes
    .filter((q) => q.changePercent < 0)
    .slice()
    .sort((a, b) => a.changePercent - b.changePercent);

  // Two-column layout (gainers left, losers right). Rows only show
  // symbol + % so each column fits without truncation. Clicking the
  // cell header still jumps to the markets page (unchanged).
  const renderRow = (q: (typeof quotes)[number]) => {
    const changeClass =
      q.changePercent >= 0 ? "wire-ticker__up" : "wire-ticker__down";
    const displaySymbol = q.symbol.replace("-USD", "");
    return (
      <li key={q.symbol} className="wire-ticker2__row">
        <span className="wire-ticker2__sym mono-label">{displaySymbol}</span>
        <span className="wire-ticker2__px">{formatMarketPrice(q.price)}</span>
        <span className={`mono-label wire-ticker2__pct ${changeClass}`}>
          {q.changePercent >= 0 ? "▲" : "▼"}{" "}
          {Math.abs(q.changePercent).toFixed(2)}%
        </span>
      </li>
    );
  };

  return (
    <WireCard label="MARKETS" updated={nowShort()}>
      <div className="wire-ticker2">
        <div className="wire-ticker2__col">
          <div className="mono-label wire-ticker2__colhead wire-ticker__up">
            GAINERS
          </div>
          {gainers.length > 0 ? (
            <ol className="wire-ticker2__list">{gainers.map(renderRow)}</ol>
          ) : (
            <p className="mono-label wire-ticker2__empty">—</p>
          )}
        </div>
        <div className="wire-ticker2__col">
          <div className="mono-label wire-ticker2__colhead wire-ticker__down">
            LOSERS
          </div>
          {losers.length > 0 ? (
            <ol className="wire-ticker2__list">{losers.map(renderRow)}</ol>
          ) : (
            <p className="mono-label wire-ticker2__empty">—</p>
          )}
        </div>
      </div>
    </WireCard>
  );
}

function WeatherCell({ weather }: { weather: DashboardData["weather"] }) {
  if (!weather || weather.offline || typeof weather.tempF !== "number") {
    const reason =
      (weather && "reason" in weather
        ? (weather as { reason?: string | null }).reason
        : null) ?? null;

    // Switch mirrors the NewsCell pattern — explicit case per reason
    // code, distinct empty-state copy, ordered so no case is
    // shadowed by a catch-all. The prior ternary chain had a dead
    // branch because `.startsWith("upstream-")` caught
    // `upstream-timeout` before the explicit timeout case could
    // match, producing "OPENWEATHERMAP timeout" (lowercase).
    const { headline, hint } = (() => {
      switch (reason) {
        case "no-api-key":
          return {
            headline: "no feed configured.",
            hint: "SET OPENWEATHER_API_KEY IN PROD ENV",
          };
        case "upstream-401":
          return {
            headline: "key rejected.",
            hint: "401 UNAUTHORIZED · ROTATE KEY",
          };
        case "upstream-429":
          return {
            headline: "rate limited.",
            hint: "429 · RETRY IN A MINUTE",
          };
        case "upstream-timeout":
          return {
            headline: "feed timed out.",
            hint: "OPENWEATHERMAP · TIMEOUT · RETRY 15m",
          };
        case "fetch-failed":
          return {
            headline: "feed went dark.",
            hint: "NETWORK · FETCH FAILED",
          };
        default:
          return {
            headline: "no feed configured.",
            hint: "ADD OPENWEATHER_API_KEY · PHASE D",
          };
      }
    })();
    return (
      <WireCard label="WEATHER" tone="offline">
        <p className="fp-empty">{headline}</p>
        <p className="mono-label wire-card__hint">{hint}</p>
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
  const items = news?.items ?? [];
  const reason = news?.reason ?? "fetch-failed";

  // Reason distinguishes five empty-state cases so the copy matches the
  // underlying cause — "slow news morning" reads differently from
  // "fetch failed". Config hints (the mono line) only show for states
  // the operator can act on.
  if (items.length === 0) {
    const { headline, hint, label } = (() => {
      switch (reason) {
        case "off":
          return {
            label: "NEWS",
            headline: "news feed disabled.",
            hint: "NEWS_FEED_MODE=off",
          };
        case "no-api-key":
          return {
            label: "NEWS · NEWSAPI",
            headline: "no key configured.",
            hint: "SET NEWSAPI_KEY IN PROD ENV",
          };
        case "upstream-401":
          return {
            label: "NEWS · NEWSAPI",
            headline: "key rejected.",
            hint: "401 UNAUTHORIZED · ROTATE KEY",
          };
        case "upstream-429":
          return {
            label: "NEWS · NEWSAPI",
            headline: "rate limited.",
            hint: "429 · RETRY IN 10m",
          };
        case "upstream-timeout":
          return {
            label: "NEWS · AP",
            headline: "feed timed out.",
            hint: "UPSTREAM TIMEOUT · RETRY 10m",
          };
        case "fetch-failed":
          return {
            label: "NEWS · AP",
            headline: "wire went dark.",
            hint: "FETCH FAILED · RETRY 10m",
          };
        case "no-items":
        default:
          // AP RSS legitimately returned zero items — not an error,
          // just a quiet news cycle. Editorial copy fits the paper.
          return {
            label: "NEWS · AP",
            headline: "slow news morning.",
            hint: null,
          };
      }
    })();
    return (
      <WireCard label={label} tone="offline">
        <p className="fp-empty">{headline}</p>
        {hint && <p className="mono-label wire-card__hint">{hint}</p>}
      </WireCard>
    );
  }

  const top = items.slice(0, 4);
  const sourceLabel = top[0]?.src?.toUpperCase() === "AP" ? "AP" : "NEWS";
  return (
    <WireCard label={`NEWS · ${sourceLabel}`} updated={nowShort()}>
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
      <ApprovalFeedCell updatedLabel={updatedLabel} />
      <SupplementsFeedCell updatedLabel={updatedLabel} />
      <HabitsFeedCell updatedLabel={updatedLabel} />
      <SportsFeedCell updatedLabel={updatedLabel} />
    </section>
  );
}
