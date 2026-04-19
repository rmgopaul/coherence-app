/**
 * Standalone Supplements page.
 *
 * Surfaces the full curated protocol, today's logging panel, and (as history
 * + insights are built out) analytics. Phase 1 ships `Today` and `Protocol`;
 * `History` and `Insights` tabs are present but show a friendly placeholder.
 */

import { useMemo, useState } from "react";
import { ArrowLeft, Pill } from "lucide-react";
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
import { formatCurrency, toLocalDateKey } from "@/lib/helpers";
import type { SupplementDefinition } from "@/features/dashboard/types";
import {
  DEFAULT_PAGE_ADHERENCE_WINDOW_DAYS,
  DEFAULT_TAB,
  SECTION_ID,
  SUPPLEMENTS_TABS,
  type SupplementsTab,
} from "./supplements.constants";
import { buildProtocolRows } from "./supplements.helpers";
import { SupplementsProtocolTable } from "./SupplementsProtocolTable";
import { SupplementsTodayPanel } from "./SupplementsTodayPanel";
import { SupplementDetailSheet } from "./SupplementDetailSheet";

export default function Supplements() {
  const { user } = useAuth();
  const [tab, setTab] = useState<SupplementsTab>(DEFAULT_TAB);
  const [selectedDefinitionId, setSelectedDefinitionId] = useState<string | null>(
    null
  );
  const todayKey = toLocalDateKey();

  const utils = trpc.useUtils();

  const { data: definitions = [] } = trpc.supplements.listDefinitions.useQuery(
    undefined,
    { enabled: !!user, retry: false }
  );
  const { data: todayLogs = [] } = trpc.supplements.getLogs.useQuery(
    { dateKey: todayKey, limit: 100 },
    { enabled: !!user, retry: false }
  );
  const { data: adherence = [] } = trpc.supplements.getAdherenceStats.useQuery(
    { windowDays: DEFAULT_PAGE_ADHERENCE_WINDOW_DAYS },
    { enabled: !!user, retry: false }
  );
  const { data: costSummary } = trpc.supplements.getCostSummary.useQuery(
    undefined,
    { enabled: !!user, retry: false }
  );

  const activeDefinitions = useMemo(
    () => definitions.filter((d) => d.isActive),
    [definitions]
  );

  const rows = useMemo(
    () => buildProtocolRows(activeDefinitions, todayLogs, adherence),
    [activeDefinitions, todayLogs, adherence]
  );

  const selectedDefinition = useMemo<SupplementDefinition | null>(() => {
    if (!selectedDefinitionId) return null;
    return definitions.find((d) => d.id === selectedDefinitionId) ?? null;
  }, [definitions, selectedDefinitionId]);

  function refetchAll() {
    void utils.supplements.listDefinitions.invalidate();
    void utils.supplements.getLogs.invalidate();
    void utils.supplements.getAdherenceStats.invalidate();
    void utils.supplements.getCostSummary.invalidate();
    void utils.supplements.listPriceLogs.invalidate();
  }

  return (
    <div id={SECTION_ID} className="container max-w-6xl space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <Pill className="h-5 w-5 text-emerald-600" />
          <h1 className="text-2xl font-semibold">Supplements</h1>
        </div>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" />
          Back to dashboard
        </Link>
      </header>

      <SummaryStrip
        monthlyCost={costSummary?.monthlyProtocolCost ?? 0}
        lockedCount={costSummary?.lockedCount ?? 0}
        activeCount={costSummary?.activeCount ?? 0}
        averageCostPerDose={costSummary?.averageCostPerDose ?? null}
        cheapest={costSummary?.cheapest ?? null}
        mostExpensive={costSummary?.mostExpensive ?? null}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as SupplementsTab)}>
        <TabsList>
          {SUPPLEMENTS_TABS.map((key) => (
            <TabsTrigger key={key} value={key} className="capitalize">
              {key}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="today" className="pt-4">
          <SupplementsTodayPanel
            definitions={activeDefinitions}
            logs={todayLogs}
            onChanged={refetchAll}
          />
        </TabsContent>

        <TabsContent value="protocol" className="pt-4">
          <SupplementsProtocolTable
            rows={rows}
            adherenceWindowDays={DEFAULT_PAGE_ADHERENCE_WINDOW_DAYS}
            onRowSelect={setSelectedDefinitionId}
          />
        </TabsContent>

        <TabsContent value="history" className="pt-4">
          <div className="rounded-md border bg-muted/40 p-6 text-sm text-muted-foreground">
            History view is coming next — adherence heatmap and per-supplement
            price trends will live here.
          </div>
        </TabsContent>

        <TabsContent value="insights" className="pt-4">
          <div className="rounded-md border bg-muted/40 p-6 text-sm text-muted-foreground">
            Insights — correlate supplements with Whoop, Samsung, and Todoist
            data — arriving in a later phase.
          </div>
        </TabsContent>
      </Tabs>

      <SupplementDetailSheet
        definition={selectedDefinition}
        logs={todayLogs}
        onClose={() => setSelectedDefinitionId(null)}
        onMutated={refetchAll}
      />
    </div>
  );
}

interface SummaryStripProps {
  monthlyCost: number;
  lockedCount: number;
  activeCount: number;
  averageCostPerDose: number | null;
  cheapest: { definitionId: string; name: string; costPerDose: number } | null;
  mostExpensive: { definitionId: string; name: string; costPerDose: number } | null;
}

function SummaryStrip({
  monthlyCost,
  lockedCount,
  activeCount,
  averageCostPerDose,
  cheapest,
  mostExpensive,
}: SummaryStripProps) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <SummaryCard label="Monthly cost" value={formatCurrency(monthlyCost)}>
        <span className="text-xs text-muted-foreground">
          {lockedCount} locked · {activeCount} active
        </span>
      </SummaryCard>
      <SummaryCard
        label="Avg $/dose (locked)"
        value={averageCostPerDose === null ? "—" : formatCurrency(averageCostPerDose)}
      />
      <SummaryCard
        label="Cheapest"
        value={cheapest ? formatCurrency(cheapest.costPerDose) : "—"}
      >
        <span className="text-xs text-muted-foreground truncate">
          {cheapest?.name ?? "—"}
        </span>
      </SummaryCard>
      <SummaryCard
        label="Most expensive"
        value={mostExpensive ? formatCurrency(mostExpensive.costPerDose) : "—"}
      >
        <span className="text-xs text-muted-foreground truncate">
          {mostExpensive?.name ?? "—"}
        </span>
      </SummaryCard>
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
