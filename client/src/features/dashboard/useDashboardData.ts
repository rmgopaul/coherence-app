/**
 * useDashboardData — shared query hook for the front-page dashboard.
 *
 * Consolidates the tRPC queries `FrontPageDashboard` and its children
 * need. Matches the cadence in handoff/web-spec.md:
 *   - tasks / inbox / calendar · 60s
 *   - whoop                    · 5m
 *   - markets                  · 5m (4m staleTime)
 *
 * `dailyBrief` stays `null` in Phase B — the hero falls back to
 * client-side headline derivation from `todayTasks`. Phase C replaces
 * this with `trpc.kingOfDay.get`. Phase D adds `weather`, `news`, and
 * `waitingOn` — stubs are wired here so call sites can reference them
 * without churn when the routers ship.
 *
 * Do NOT duplicate these queries inside feed components — pull from
 * this hook or pass the slice down.
 */
import { useMemo } from "react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import type { DailyBrief } from "@/lib/dailyBrief";

const ONE_MIN = 60_000;
const FIVE_MIN = 5 * 60_000;

function formatTodayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function useDashboardData() {
  const { user } = useAuth();
  const todayKey = formatTodayKey(new Date());
  const timezoneOffsetMinutes = new Date().getTimezoneOffset();

  const { data: preferences } = trpc.preferences.get.useQuery(undefined, {
    staleTime: 30 * ONE_MIN,
  });

  const { data: dueTodayTasks } = trpc.todoist.getTasks.useQuery(
    { filter: "today" },
    { refetchInterval: ONE_MIN }
  );

  const { data: completedData } = trpc.todoist.getCompletedCount.useQuery(
    { dateKey: todayKey, timezoneOffsetMinutes },
    { refetchInterval: ONE_MIN }
  );

  const { data: calendarEvents } = trpc.google.getCalendarEvents.useQuery(
    undefined,
    { refetchInterval: ONE_MIN }
  );

  const { data: gmailMessages } = trpc.google.getGmailMessages.useQuery(
    { maxResults: 50 },
    { refetchInterval: ONE_MIN }
  );

  // `getGmailWaitingOn` already exists on the google router — the
  // Phase D §4 "server-side detection" deviation is already shipped.
  // We just consume it.
  const { data: gmailWaitingOn } = trpc.google.getGmailWaitingOn.useQuery(
    { maxResults: 25 },
    { refetchInterval: FIVE_MIN }
  );

  const { data: whoopSummary } = trpc.whoop.getSummary.useQuery(undefined, {
    refetchInterval: FIVE_MIN,
  });

  const { data: marketData } = trpc.marketDashboard.getMarketData.useQuery(
    undefined,
    { refetchInterval: FIVE_MIN, staleTime: 4 * ONE_MIN }
  );

  const unreadGmailCount = useMemo(() => {
    if (!Array.isArray(gmailMessages)) return 0;
    return gmailMessages.filter(
      (m) => Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD")
    ).length;
  }, [gmailMessages]);

  const userName = preferences?.displayName || user?.name?.split(" ")[0] || null;

  // Phase C / D placeholders — keep the shape stable so call sites can
  // destructure today and not change when the real routers ship.
  const dailyBrief: DailyBrief | null = null;

  // Phase C — server-picked King of the Day. Falls back to the hero's
  // client-side headline derivation while loading or on error.
  const { data: kingOfDayServer } = trpc.kingOfDay.get.useQuery(
    { dateKey: todayKey },
    { refetchInterval: ONE_MIN, staleTime: 30_000 }
  );
  const kingOfDay = kingOfDayServer ?? null;

  // Phase D — weather + news. Both routers degrade gracefully when
  // the relevant env var isn't set, returning an offline payload /
  // empty array so the WireFeedsGrid renders its "NO FEED CONFIGURED"
  // state without errors.
  const { data: weatherData } = trpc.weather.getCurrent.useQuery(
    undefined,
    { refetchInterval: 15 * ONE_MIN, staleTime: 10 * ONE_MIN }
  );
  const weather = weatherData ?? null;

  const { data: newsData } = trpc.news.getHeadlines.useQuery(
    { count: 6 },
    { refetchInterval: 10 * ONE_MIN, staleTime: 5 * ONE_MIN }
  );
  // Fallback payload preserves the `{ items, reason }` shape when the
  // query is still loading or errored so NewsCell doesn't have to
  // discriminate between "undefined" and "reason: fetch-failed".
  const news = newsData ?? { items: [], reason: "fetch-failed" as const };

  return {
    user,
    userName,
    preferences,
    todayKey,

    tasks: {
      dueToday: dueTodayTasks ?? [],
      completedCount: completedData?.count ?? 0,
    },
    calendar: calendarEvents ?? [],
    inbox: gmailMessages ?? [],
    waitingOn: gmailWaitingOn ?? [],
    unreadGmailCount,
    health: { whoop: whoopSummary ?? null },
    market: marketData ?? null,

    // Phase C / D — see docstring.
    dailyBrief,
    kingOfDay,
    weather,
    news,
  };
}

export type DashboardData = ReturnType<typeof useDashboardData>;
