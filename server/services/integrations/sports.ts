/**
 * Sports scores & schedule service.
 * Uses ESPN's public site API (no key required) for NBA, MLB, NFL.
 * Fetches today's games for Minnesota Timberwolves, Twins, and Vikings.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/*  Team config                                                        */
/* ------------------------------------------------------------------ */

interface TeamConfig {
  name: string;
  abbreviation: string;
  espnId: string;
  league: "nba" | "mlb" | "nfl";
  sport: string;
  color: string;
}

const MN_TEAMS: TeamConfig[] = [
  {
    name: "Timberwolves",
    abbreviation: "MIN",
    espnId: "16",
    league: "nba",
    sport: "basketball",
    color: "#0C2340",
  },
  {
    name: "Twins",
    abbreviation: "MIN",
    espnId: "9",
    league: "mlb",
    sport: "baseball",
    color: "#002B5C",
  },
  {
    name: "Vikings",
    abbreviation: "MIN",
    espnId: "16",
    league: "nfl",
    sport: "football",
    color: "#4F2683",
  },
];

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

export interface GameInfo {
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
  /** ISO date-time string */
  gameTime: string;
  /** Human-readable time, e.g. "7:00 PM CT" */
  gameTimeFormatted: string;
  /** pre | in | post | delayed | postponed */
  status: "pre" | "in" | "post" | "delayed" | "postponed" | "halftime";
  /** e.g. "3rd Quarter", "Top 5th", "Final", "7:00 PM CT" */
  statusDetail: string;
  /** Current period/inning detail when live */
  period: string;
  /** Game clock when live, e.g. "4:32" */
  clock: string;
  teamScore: number | null;
  opponentScore: number | null;
  /** Broadcast networks, e.g. ["ESPN", "BSN"] */
  broadcasts: string[];
  /** true if team is winning or won */
  teamWinning: boolean;
}

/* ------------------------------------------------------------------ */
/*  ESPN API fetcher                                                   */
/* ------------------------------------------------------------------ */

async function fetchEspnScoreboard(
  sport: string,
  league: string,
): Promise<any> {
  // ESPN scoreboard returns today's games by default
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard`;
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`ESPN ${league} API returned ${res.status}`);
  }
  return res.json();
}

/* ------------------------------------------------------------------ */
/*  Parse ESPN event into GameInfo                                     */
/* ------------------------------------------------------------------ */

type EspnCompetitor = {
  team?: {
    id?: string | number;
    displayName?: string;
    shortDisplayName?: string;
    name?: string;
    abbreviation?: string;
    logo?: string;
    color?: string;
    location?: string;
  };
  score?: string | number;
  homeAway?: string;
  records?: Array<{ type?: string; summary?: string }>;
};

type EspnEvent = {
  id: string;
  competitions?: Array<{
    competitors?: EspnCompetitor[];
    venue?: { fullName?: string; address?: { city?: string; state?: string } };
    broadcasts?: Array<{ names?: string[] }>;
    geoBroadcasts?: Array<{ media?: { shortName?: string } }>;
    date?: string;
  }>;
  status?: {
    type?: {
      name?: string;
      completed?: boolean;
      shortDetail?: string;
      detail?: string;
      description?: string;
    };
    period?: number;
    displayClock?: string;
  };
  date: string;
};

function parseEvent(
  event: EspnEvent,
  team: TeamConfig,
): GameInfo | null {
  try {
    const competition = event.competitions?.[0];
    if (!competition) return null;

    const competitors = competition.competitors ?? [];
    // Find which competitor is our team
    const ourTeam = competitors.find(
      (c: EspnCompetitor) => String(c.team?.id) === team.espnId,
    );
    if (!ourTeam) return null;

    const opponent = competitors.find(
      (c: EspnCompetitor) => String(c.team?.id) !== team.espnId,
    );
    if (!opponent) return null;

    const isHome = ourTeam.homeAway === "home";
    const venue = competition.venue;

    // Status
    const statusObj = event.status?.type;
    let status: GameInfo["status"] = "pre";
    if (statusObj?.name === "STATUS_IN_PROGRESS" || statusObj?.name === "STATUS_PLAY_IN_PROGRESS") {
      status = "in";
    } else if (statusObj?.name === "STATUS_HALFTIME") {
      status = "halftime";
    } else if (statusObj?.name === "STATUS_FINAL" || statusObj?.name === "STATUS_END_PERIOD" || statusObj?.completed) {
      status = "post";
    } else if (statusObj?.name === "STATUS_DELAYED") {
      status = "delayed";
    } else if (statusObj?.name === "STATUS_POSTPONED") {
      status = "postponed";
    }

    // Period / clock
    const period = event.status?.period
      ? formatPeriod(event.status.period, team.league)
      : "";
    const clock = event.status?.displayClock ?? "";

    // Score
    const teamScore =
      status !== "pre" && ourTeam.score != null
        ? Number(ourTeam.score)
        : null;
    const opponentScore =
      status !== "pre" && opponent.score != null
        ? Number(opponent.score)
        : null;

    // Broadcasts
    const broadcasts: string[] = [];
    for (const broadcast of competition.broadcasts ?? []) {
      for (const name of broadcast.names ?? []) {
        if (!broadcasts.includes(name)) broadcasts.push(name);
      }
    }
    // Also check geoBroadcasts for streaming
    for (const geo of competition.geoBroadcasts ?? []) {
      const name = geo.media?.shortName;
      if (name && !broadcasts.includes(name)) broadcasts.push(name);
    }

    // Game time
    const gameDate = new Date(event.date);
    const gameTimeFormatted = gameDate.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/Chicago",
      timeZoneName: "short",
    });

    const teamWinning =
      teamScore !== null && opponentScore !== null
        ? teamScore > opponentScore
        : false;

    return {
      id: event.id,
      league: team.league,
      teamName: team.name,
      teamAbbreviation: ourTeam.team?.abbreviation ?? team.abbreviation,
      teamLogo: ourTeam.team?.logo ?? "",
      teamColor: team.color,
      teamRecord: ourTeam.records?.[0]?.summary ?? "",
      opponentName: opponent.team?.displayName ?? opponent.team?.name ?? "TBD",
      opponentAbbreviation: opponent.team?.abbreviation ?? "",
      opponentLogo: opponent.team?.logo ?? "",
      opponentRecord: opponent.records?.[0]?.summary ?? "",
      isHome,
      venue: venue?.fullName ?? "",
      city: venue?.address?.city
        ? `${venue.address.city}, ${venue.address.state ?? ""}`
        : "",
      gameTime: event.date,
      gameTimeFormatted,
      status,
      statusDetail: statusObj?.shortDetail ?? statusObj?.detail ?? "",
      period,
      clock,
      teamScore,
      opponentScore,
      broadcasts,
      teamWinning,
    };
  } catch (err) {
    console.warn(`[Sports] Failed to parse event for ${team.name}:`, err);
    return null;
  }
}

function formatPeriod(period: number, league: string): string {
  if (league === "nba") {
    if (period <= 4) return `Q${period}`;
    return `OT${period - 4}`;
  }
  if (league === "nfl") {
    if (period <= 4) return `Q${period}`;
    return "OT";
  }
  if (league === "mlb") {
    return `Inning ${period}`;
  }
  return `P${period}`;
}

/* ------------------------------------------------------------------ */
/*  Main fetch function                                                */
/* ------------------------------------------------------------------ */

export async function fetchMNSportsGames(): Promise<GameInfo[]> {
  // Group teams by sport/league to minimize API calls
  const leagueMap = new Map<string, TeamConfig[]>();
  for (const team of MN_TEAMS) {
    const key = `${team.sport}/${team.league}`;
    if (!leagueMap.has(key)) leagueMap.set(key, []);
    leagueMap.get(key)!.push(team);
  }

  const results = await Promise.allSettled(
    Array.from(leagueMap.entries()).map(async ([key, teams]) => {
      const [sport, league] = key.split("/");
      const data = await fetchEspnScoreboard(sport, league);
      const events = data?.events ?? [];
      const games: GameInfo[] = [];

      for (const team of teams) {
        for (const event of events) {
          const game = parseEvent(event, team);
          if (game) games.push(game);
        }
      }
      return games;
    }),
  );

  const allGames: GameInfo[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allGames.push(...result.value);
    } else {
      console.warn("[Sports] League fetch failed:", result.reason);
    }
  }

  // Sort: live games first, then upcoming, then completed
  const statusOrder = { in: 0, halftime: 0, delayed: 1, pre: 2, post: 3, postponed: 4 };
  allGames.sort((a, b) => {
    const orderDiff = (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9);
    if (orderDiff !== 0) return orderDiff;
    return new Date(a.gameTime).getTime() - new Date(b.gameTime).getTime();
  });

  return allGames;
}
