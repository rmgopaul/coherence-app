/**
 * SportsFeedCell — compact wire-feed for MN sports.
 *
 * Shows the next scheduled game (or live if one is on). Consumes the
 * same `trpc.sports.getGames` query the legacy SportsCard uses.
 * Field shapes mirror server/services/integrations/sports.ts GameInfo.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";

const THIRTY_SEC = 30_000;
const TEN_MIN = 10 * 60_000;

interface Props {
  updatedLabel: string;
}

function formatKickoffLabel(gameTime?: string | null): string {
  if (!gameTime) return "—";
  const d = new Date(gameTime);
  if (Number.isNaN(d.getTime())) return "—";
  return d
    .toLocaleString([], {
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    })
    .toUpperCase();
}

/**
 * Collapse the server-side broadcasts array into a terse display
 * string. ESPN returns channels + streaming services mixed together
 * ("ESPN", "ESPN+", "Prime Video") — we dedupe, uppercase, and cap
 * at 3 entries so the line doesn't wrap on narrow cells.
 */
function formatBroadcasts(broadcasts?: string[] | null): string {
  if (!broadcasts || broadcasts.length === 0) return "";
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of broadcasts) {
    const norm = raw.trim().toUpperCase();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    kept.push(norm);
    if (kept.length === 3) break;
  }
  return kept.join(" · ");
}

export function SportsFeedCell({ updatedLabel }: Props) {
  const { data } = trpc.sports.getGames.useQuery(undefined, {
    refetchInterval: (query) => {
      const games = query.state.data?.games ?? [];
      const hasLive = games.some(
        (g) => g.status === "in" || g.status === "halftime"
      );
      return hasLive ? THIRTY_SEC : TEN_MIN;
    },
  });

  const games = data?.games ?? [];

  // Split the feed into three useful buckets:
  //   1. A live game if one is in progress, else next upcoming
  //   2. Supporting list: other games today (up to 2 more rows)
  const { spotlight, supporting } = useMemo(() => {
    const empty = { spotlight: null, supporting: [] as typeof games };
    if (!Array.isArray(games) || games.length === 0) return empty;

    const withTime = games.map((g) => ({
      g,
      t: g.gameTime ? new Date(g.gameTime).getTime() : NaN,
    }));

    const live = withTime.find(
      ({ g }) => g.status === "in" || g.status === "halftime"
    );
    const now = Date.now();
    const upcoming = withTime
      .filter(
        ({ g, t }) =>
          !Number.isNaN(t) &&
          t >= now &&
          g.status !== "in" &&
          g.status !== "halftime"
      )
      .sort((a, b) => a.t - b.t);
    const finals = withTime
      .filter(({ g }) => g.status === "post")
      .sort((a, b) => b.t - a.t);

    const primary = live?.g ?? upcoming[0]?.g ?? finals[0]?.g ?? games[0];
    if (!primary) return empty;

    // Supporting list: other games today, not the primary.
    const others: typeof games = [];
    const push = (g: typeof primary | undefined) => {
      if (g && g.id !== primary.id && others.every((x) => x.id !== g.id)) {
        others.push(g);
      }
    };
    // Live first in supporting (if primary was upcoming and something went live),
    // then next upcoming, then most recent final.
    if (live && live.g.id !== primary.id) push(live.g);
    upcoming.forEach((u) => push(u.g));
    finals.forEach((f) => push(f.g));

    return { spotlight: primary, supporting: others.slice(0, 2) };
  }, [games]);

  if (!spotlight) {
    return (
      <article className="wire-card" data-tone="offline">
        <header className="wire-card__head">
          <span className="mono-label">SPORTS · MN</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">no games on the wire.</p>
        </div>
      </article>
    );
  }

  const isLive =
    spotlight.status === "in" || spotlight.status === "halftime";
  const isFinal = spotlight.status === "post";

  // Render home-team-first: "AWAY @ HOME" regardless of tracked team side.
  const homeAbbr = spotlight.isHome
    ? spotlight.teamAbbreviation
    : spotlight.opponentAbbreviation;
  const awayAbbr = spotlight.isHome
    ? spotlight.opponentAbbreviation
    : spotlight.teamAbbreviation;
  const headline = `${awayAbbr} @ ${homeAbbr}`;

  const spotlightBroadcast = formatBroadcasts(spotlight.broadcasts);
  const subtitleBase = isLive
    ? `LIVE · ${spotlight.statusDetail}`
    : isFinal
      ? `FINAL · ${spotlight.statusDetail}`
      : formatKickoffLabel(spotlight.gameTime);
  // Append broadcasts only when we have them and the game isn't
  // final (post-game channel info is not useful). Keeps the mono
  // subtitle single-line: kickoff label + " · ESPN · BSN".
  const subtitle =
    !isFinal && spotlightBroadcast
      ? `${subtitleBase} · ${spotlightBroadcast}`
      : subtitleBase;

  const scoreAvailable =
    spotlight.teamScore != null && spotlight.opponentScore != null;
  const homeScore = spotlight.isHome
    ? spotlight.teamScore
    : spotlight.opponentScore;
  const awayScore = spotlight.isHome
    ? spotlight.opponentScore
    : spotlight.teamScore;

  return (
    <article className="wire-card">
      <header className="wire-card__head">
        <span className="mono-label">
          SPORTS · {spotlight.league.toUpperCase()}
          {isLive ? " · LIVE" : ""}
        </span>
        <span className="mono-label wire-card__ts">
          UPDATED {updatedLabel}
        </span>
      </header>
      <div className="wire-card__body">
        <p className="wire-headline">{headline}</p>
        <p className="mono-label">{subtitle}</p>
        {scoreAvailable && (
          <p className="fp-stat-big wire-stat__score">
            {awayScore}–{homeScore}
          </p>
        )}
        {supporting.length > 0 && (
          <ul className="wire-list">
            {supporting.map((game) => {
              const gLive = game.status === "in" || game.status === "halftime";
              const gFinal = game.status === "post";
              const gHomeAbbr = game.isHome
                ? game.teamAbbreviation
                : game.opponentAbbreviation;
              const gAwayAbbr = game.isHome
                ? game.opponentAbbreviation
                : game.teamAbbreviation;
              const gScoreReady =
                game.teamScore != null && game.opponentScore != null;
              const gHomeScore = game.isHome
                ? game.teamScore
                : game.opponentScore;
              const gAwayScore = game.isHome
                ? game.opponentScore
                : game.teamScore;
              const gBroadcast = formatBroadcasts(game.broadcasts);
              const right = gLive
                ? gBroadcast
                  ? `LIVE · ${gBroadcast}`
                  : "LIVE"
                : gFinal && gScoreReady
                  ? `${gAwayScore}–${gHomeScore}`
                  : gBroadcast
                    ? `${formatKickoffLabel(game.gameTime)} · ${gBroadcast}`
                    : formatKickoffLabel(game.gameTime);
              return (
                <li key={game.id} className="wire-list__row">
                  <span className="mono-label">
                    {gAwayAbbr} @ {gHomeAbbr}
                  </span>
                  <span className="wire-list__val mono-label">{right}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </article>
  );
}
