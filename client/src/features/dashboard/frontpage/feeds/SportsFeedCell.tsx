/**
 * SportsFeedCell — compact wire-feed for MN sports.
 *
 * Shows the next scheduled game (or live if one is on). Consumes the
 * same `trpc.sports.getGames` query the legacy SportsCard uses.
 * Field shapes mirror server/services/integrations/sports.ts GameInfo.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";

const FIVE_MIN = 5 * 60_000;

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

export function SportsFeedCell({ updatedLabel }: Props) {
  const { data } = trpc.sports.getGames.useQuery(undefined, {
    refetchInterval: FIVE_MIN,
  });

  const games = data?.games ?? [];

  const spotlight = useMemo(() => {
    if (!Array.isArray(games) || games.length === 0) return null;
    const live = games.find(
      (g) => g.status === "in" || g.status === "halftime"
    );
    if (live) return live;
    const now = Date.now();
    const upcoming = games
      .filter((g) => {
        const t = g.gameTime ? new Date(g.gameTime).getTime() : NaN;
        return !Number.isNaN(t) && t >= now;
      })
      .sort((a, b) => {
        const ta = new Date(a.gameTime).getTime();
        const tb = new Date(b.gameTime).getTime();
        return ta - tb;
      });
    return upcoming[0] ?? games[0] ?? null;
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

  const subtitle = isLive
    ? `LIVE · ${spotlight.statusDetail}`
    : isFinal
      ? `FINAL · ${spotlight.statusDetail}`
      : formatKickoffLabel(spotlight.gameTime);

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
      </div>
    </article>
  );
}
