/**
 * Standalone Habits page.
 *
 * Mirrors the Supplements page pattern: summary strip + tabs.
 * Tabs: Today / Protocol / History / Sleep / Insights.
 */

import { useMemo, useState } from "react";
import { ArrowLeft, ListChecks } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { formatPercent } from "@/lib/helpers";
import {
  DEFAULT_TAB,
  HABITS_TABS,
  SECTION_ID,
  type HabitsTab,
} from "./habits.constants";
import {
  completionRate,
  countActive,
  longestStreak,
} from "./habits.helpers";
import { HabitsTodayPanel } from "./HabitsTodayPanel";
import { HabitsProtocolPanel } from "./HabitsProtocolPanel";
import { HabitsHistoryPanel } from "./HabitsHistoryPanel";
import { HabitsInsightsPanel } from "./HabitsInsightsPanel";
import { HabitsSleepReport } from "./HabitsSleepReport";

export default function Habits() {
  const { user } = useAuth();
  const [tab, setTab] = useState<HabitsTab>(DEFAULT_TAB);
  const utils = trpc.useUtils();

  const { data: habitsForToday = [] } = trpc.habits.getForDate.useQuery(
    undefined,
    { enabled: !!user, retry: false }
  );
  const { data: streaks = [] } = trpc.habits.getStreaks.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const { data: definitions = [] } = trpc.habits.listDefinitions.useQuery(
    undefined,
    { enabled: !!user, retry: false }
  );
  const { data: categories = [] } = trpc.habits.listCategories.useQuery(
    undefined,
    { enabled: !!user, retry: false }
  );

  const todayRate = useMemo(
    () => completionRate(habitsForToday),
    [habitsForToday]
  );
  const activeCount = useMemo(
    () => countActive(habitsForToday),
    [habitsForToday]
  );
  const topStreak = useMemo(() => longestStreak(streaks), [streaks]);

  function refetchAll() {
    void utils.habits.getForDate.invalidate();
    void utils.habits.getStreaks.invalidate();
    void utils.habits.listDefinitions.invalidate();
    void utils.habits.listCategories.invalidate();
    void utils.habits.getCompletionsRange.invalidate();
    void utils.habits.getSleepReport.invalidate();
    void utils.habits.getCorrelation.invalidate();
  }

  return (
    <div id={SECTION_ID} className="container max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <ListChecks className="h-5 w-5 text-emerald-600" />
          <h1 className="text-2xl font-semibold">Habits</h1>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to dashboard
        </Link>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Active today" value={String(activeCount)}>
          <span className="text-xs text-muted-foreground">
            of {habitsForToday.length} tracked
          </span>
        </SummaryCard>
        <SummaryCard
          label="Today's completion"
          value={formatPercent(todayRate * 100) || "—"}
        />
        <SummaryCard label="Longest streak" value={topStreak > 0 ? `${topStreak}d` : "—"} />
        <SummaryCard label="Categories" value={String(categories.length)} />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as HabitsTab)}>
        <TabsList>
          {HABITS_TABS.map((key) => (
            <TabsTrigger key={key} value={key} className="capitalize">
              {key}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="today" className="pt-4">
          <HabitsTodayPanel
            habits={habitsForToday}
            streaks={streaks}
            onChanged={refetchAll}
          />
        </TabsContent>

        <TabsContent value="protocol" className="pt-4">
          <HabitsProtocolPanel
            definitions={definitions}
            categories={categories}
            onChanged={refetchAll}
          />
        </TabsContent>

        <TabsContent value="history" className="pt-4">
          <HabitsHistoryPanel definitions={definitions} />
        </TabsContent>

        <TabsContent value="sleep" className="pt-4">
          <HabitsSleepReport />
        </TabsContent>

        <TabsContent value="insights" className="pt-4">
          <HabitsInsightsPanel definitions={definitions} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        <div className="text-xl font-semibold">{value}</div>
        {children}
      </CardContent>
    </Card>
  );
}
