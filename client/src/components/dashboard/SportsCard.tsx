import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { DashboardWidget } from "./DashboardWidget";
import { Trophy, MapPin, Tv, Clock, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface GameInfo {
  id: string;
  league: "nba" | "mlb" | "nfl";
  teamName: string;
  teamAbbreviation: string;
  teamLogo: string;
  teamColor: string;
  teamRecord: string;
  opponentName: string;
  opponentAbbreviation: string;
  opponentLogo: string;
  opponentRecord: string;
  isHome: boolean;
  venue: string;
  city: string;
  gameTime: string;
  gameTimeFormatted: string;
  status: "pre" | "in" | "post" | "delayed" | "postponed" | "halftime";
  statusDetail: string;
  period: string;
  clock: string;
  teamScore: number | null;
  opponentScore: number | null;
  broadcasts: string[];
  teamWinning: boolean;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const LEAGUE_LABELS: Record<string, string> = {
  nba: "NBA",
  mlb: "MLB",
  nfl: "NFL",
};

function StatusBadge({ game }: { game: GameInfo }) {
  if (game.status === "in" || game.status === "halftime") {
    return (
      <Badge
        variant="default"
        className="bg-red-600 text-white animate-pulse text-xs font-semibold"
      >
        {game.status === "halftime" ? "HALFTIME" : "LIVE"}
      </Badge>
    );
  }
  if (game.status === "post") {
    return (
      <Badge variant="secondary" className="text-xs font-medium">
        FINAL
      </Badge>
    );
  }
  if (game.status === "delayed") {
    return (
      <Badge variant="outline" className="text-yellow-600 border-yellow-400 text-xs font-medium">
        DELAYED
      </Badge>
    );
  }
  if (game.status === "postponed") {
    return (
      <Badge variant="outline" className="text-muted-foreground text-xs font-medium">
        POSTPONED
      </Badge>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Single Game Card                                                    */
/* ------------------------------------------------------------------ */

function GameCard({ game }: { game: GameInfo }) {
  const isLive = game.status === "in" || game.status === "halftime";
  const isFinished = game.status === "post";
  const isUpcoming = game.status === "pre";

  return (
    <div
      className={cn(
        "rounded-lg border p-4 space-y-3 transition-all",
        isLive && "border-red-300 bg-red-50/50 dark:border-red-800 dark:bg-red-950/30",
        isFinished && "border-border bg-muted/30",
        isUpcoming && "border-border bg-card",
        !isLive && !isFinished && !isUpcoming && "border-border bg-card",
      )}
    >
      {/* Header: League + Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className="text-xs font-semibold"
            style={{ borderColor: game.teamColor, color: game.teamColor }}
          >
            {LEAGUE_LABELS[game.league] ?? game.league.toUpperCase()}
          </Badge>
          {isLive && game.statusDetail && (
            <span className="text-xs font-medium text-red-600 dark:text-red-400">
              {game.statusDetail}
            </span>
          )}
        </div>
        <StatusBadge game={game} />
      </div>

      {/* Matchup */}
      <div className="flex items-center justify-between gap-3">
        {/* Team */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {game.teamLogo ? (
            <img
              src={game.teamLogo}
              alt={game.teamName}
              className="h-8 w-8 object-contain flex-shrink-0"
            />
          ) : (
            <div
              className="h-8 w-8 rounded-full flex-shrink-0 flex items-center justify-center text-white text-xs font-bold"
              style={{ backgroundColor: game.teamColor }}
            >
              {game.teamAbbreviation.slice(0, 3)}
            </div>
          )}
          <div className="min-w-0">
            <p className={cn(
              "text-sm font-semibold truncate",
              (isFinished || isLive) && game.teamWinning && "text-emerald-700 dark:text-emerald-400",
            )}>
              {game.teamName}
            </p>
            {game.teamRecord && (
              <p className="text-xs text-muted-foreground">{game.teamRecord}</p>
            )}
          </div>
        </div>

        {/* Score or VS */}
        <div className="flex-shrink-0 text-center px-2">
          {(isLive || isFinished) && game.teamScore !== null && game.opponentScore !== null ? (
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  "text-xl font-bold tabular-nums",
                  game.teamWinning
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {game.teamScore}
              </span>
              <span className="text-muted-foreground text-sm">-</span>
              <span
                className={cn(
                  "text-xl font-bold tabular-nums",
                  !game.teamWinning
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {game.opponentScore}
              </span>
            </div>
          ) : (
            <span className="text-sm font-medium text-muted-foreground">
              {game.isHome ? "vs" : "@"}
            </span>
          )}
        </div>

        {/* Opponent */}
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end text-right">
          <div className="min-w-0">
            <p className={cn(
              "text-sm font-semibold truncate",
              (isFinished || isLive) && !game.teamWinning && game.teamScore !== game.opponentScore && "text-emerald-700 dark:text-emerald-400",
            )}>
              {game.opponentName}
            </p>
            {game.opponentRecord && (
              <p className="text-xs text-muted-foreground">{game.opponentRecord}</p>
            )}
          </div>
          {game.opponentLogo ? (
            <img
              src={game.opponentLogo}
              alt={game.opponentName}
              className="h-8 w-8 object-contain flex-shrink-0"
            />
          ) : (
            <div className="h-8 w-8 rounded-full flex-shrink-0 bg-muted flex items-center justify-center text-xs font-bold text-muted-foreground">
              {game.opponentAbbreviation.slice(0, 3)}
            </div>
          )}
        </div>
      </div>

      {/* Details row: Time, Venue, Broadcast */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {/* Time */}
        {isUpcoming && (
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {game.gameTimeFormatted}
          </span>
        )}

        {/* Venue */}
        {game.venue && (
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {game.venue}
          </span>
        )}

        {/* Broadcast */}
        {game.broadcasts.length > 0 && (
          <span className="flex items-center gap-1">
            <Tv className="h-3 w-3" />
            {game.broadcasts.join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                      */
/* ------------------------------------------------------------------ */

export default function SportsCard() {
  const { data, isLoading, error, refetch } = trpc.sports.getGames.useQuery(
    undefined,
    {
      staleTime: 30_000,
      refetchInterval: (query) => {
        // Poll every 30s if any game is live, otherwise every 10 min
        const games = query.state.data?.games ?? [];
        const hasLive = games.some(
          (g: GameInfo) => g.status === "in" || g.status === "halftime",
        );
        return hasLive ? 30_000 : 10 * 60_000;
      },
      refetchOnWindowFocus: false,
    },
  );

  const games = data?.games ?? [];

  // Don't render the card at all if no MN teams play today
  if (!isLoading && games.length === 0) {
    return null;
  }

  const hasLive = games.some(
    (g) => g.status === "in" || g.status === "halftime",
  );

  return (
    <DashboardWidget
      title={hasLive ? "MN Sports — LIVE" : "MN Sports Today"}
      icon={Trophy}
      isLoading={isLoading}
      error={error?.message ?? null}
      onRetry={() => refetch()}
      lastUpdated={data?.fetchedAt ? new Date(data.fetchedAt) : null}
      collapsible
      storageKey="sports-card-collapsed"
    >
      <div className="space-y-3">
        {games.map((game) => (
          <GameCard key={game.id} game={game} />
        ))}
      </div>
    </DashboardWidget>
  );
}
