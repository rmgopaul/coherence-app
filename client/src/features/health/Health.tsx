/**
 * Standalone Health page. Unifies Whoop + Samsung + sleep + cross-metric
 * correlation. Mirrors the Supplements / Habits page layout.
 */

import { useState } from "react";
import { ArrowLeft, HeartPulse } from "lucide-react";
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
import {
  DEFAULT_TAB,
  HEALTH_TABS,
  SECTION_ID,
  type HealthTab,
} from "./health.constants";
import { formatMetricValue } from "./health.helpers";
import { HealthTodayPanel } from "./HealthTodayPanel";
import { HealthTrendsPanel } from "./HealthTrendsPanel";
import { HealthSleepPanel } from "./HealthSleepPanel";
import { HealthInsightsPanel } from "./HealthInsightsPanel";

export default function Health() {
  const { user } = useAuth();
  const [tab, setTab] = useState<HealthTab>(DEFAULT_TAB);

  // Summary strip pulls the most recent dailyHealthMetrics row.
  const { data: history = [] } = trpc.metrics.getHistory.useQuery(
    { limit: 1 },
    { enabled: !!user, retry: false }
  );
  const latest = history[0];

  return (
    <div id={SECTION_ID} className="container max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <HeartPulse className="h-5 w-5 text-rose-600" />
          <h1 className="text-2xl font-semibold">Health</h1>
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
        <SummaryCard
          label="Recovery"
          value={formatMetricValue(
            "whoopRecoveryScore",
            latest?.whoopRecoveryScore ?? null
          )}
        />
        <SummaryCard
          label="Sleep"
          value={formatMetricValue(
            "whoopSleepHours",
            latest?.whoopSleepHours ??
              (latest?.samsungSleepHours !== null &&
              latest?.samsungSleepHours !== undefined
                ? Number(latest.samsungSleepHours)
                : null)
          )}
        />
        <SummaryCard
          label="HRV"
          value={formatMetricValue("whoopHrvMs", latest?.whoopHrvMs ?? null)}
        />
        <SummaryCard
          label="Strain"
          value={formatMetricValue(
            "whoopDayStrain",
            latest?.whoopDayStrain ?? null
          )}
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as HealthTab)}>
        <TabsList>
          {HEALTH_TABS.map((key) => (
            <TabsTrigger key={key} value={key} className="capitalize">
              {key}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="today" className="pt-4">
          <HealthTodayPanel />
        </TabsContent>

        <TabsContent value="trends" className="pt-4">
          <HealthTrendsPanel />
        </TabsContent>

        <TabsContent value="sleep" className="pt-4">
          <HealthSleepPanel />
        </TabsContent>

        <TabsContent value="insights" className="pt-4">
          <HealthInsightsPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
