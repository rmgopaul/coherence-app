/**
 * Standalone Supplements page.
 *
 * Surfaces the full curated protocol, today's logging panel, and (as history
 * + insights are built out) analytics. Phase 1 ships `Today` and `Protocol`;
 * `History` and `Insights` tabs are present but show a friendly placeholder.
 */

import { useMemo, useState } from "react";
import { ArrowLeft, Download, Pill } from "lucide-react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import {
  downloadTextFile,
  formatCurrency,
  toLocalDateKey,
} from "@/lib/helpers";
import type {
  SupplementDefinition,
  SupplementLog,
} from "@/features/dashboard/types";
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
import { SupplementsAdherenceHeatmap } from "./SupplementsAdherenceHeatmap";
import { SupplementsInsightsPanel } from "./SupplementsInsightsPanel";
import { SupplementsRestockCard } from "./SupplementsRestockCard";
import { SupplementsExperiments } from "./SupplementsExperiments";

type HistoryWindow = 30 | 90 | 365;
const HISTORY_WINDOW_OPTIONS: HistoryWindow[] = [30, 90, 365];

export default function Supplements() {
  const { user } = useAuth();
  const [tab, setTab] = useState<SupplementsTab>(DEFAULT_TAB);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindow>(90);
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
  const { data: adherenceRange } = trpc.supplements.getAdherenceRange.useQuery(
    { windowDays: historyWindow },
    { enabled: !!user && tab === "history", retry: false }
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

        <TabsContent value="protocol" className="pt-4 space-y-4">
          <SupplementsProtocolTable
            rows={rows}
            adherenceWindowDays={DEFAULT_PAGE_ADHERENCE_WINDOW_DAYS}
            onRowSelect={setSelectedDefinitionId}
          />
          <SupplementsRestockCard definitions={activeDefinitions} />
        </TabsContent>

        <TabsContent value="history" className="pt-4">
          <HistoryPanel
            windowDays={historyWindow}
            onWindowChange={setHistoryWindow}
            days={adherenceRange?.days ?? []}
            definitions={activeDefinitions}
            todayLogs={todayLogs}
          />
        </TabsContent>

        <TabsContent value="insights" className="pt-4 space-y-4">
          <SupplementsExperiments definitions={activeDefinitions} />
          <SupplementsInsightsPanel definitions={activeDefinitions} />
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

interface HistoryPanelProps {
  windowDays: HistoryWindow;
  onWindowChange: (next: HistoryWindow) => void;
  days: readonly { dateKey: string; taken: number; expected: number }[];
  definitions: readonly SupplementDefinition[];
  todayLogs: readonly SupplementLog[];
}

function HistoryPanel({
  windowDays,
  onWindowChange,
  days,
  definitions,
  todayLogs,
}: HistoryPanelProps) {
  function handleExportProtocol() {
    const payload = JSON.stringify(definitions, null, 2);
    downloadTextFile(
      `supplement-protocol-${toLocalDateKey()}.json`,
      payload,
      "application/json;charset=utf-8"
    );
  }

  function handleExportLogs() {
    const header = [
      "dateKey",
      "timing",
      "name",
      "dose",
      "doseUnit",
      "autoLogged",
      "definitionId",
      "takenAt",
    ].join(",");
    const rows = todayLogs.map((log) =>
      [
        log.dateKey,
        log.timing,
        csvEscape(log.name),
        csvEscape(log.dose),
        log.doseUnit,
        log.autoLogged ? "true" : "false",
        log.definitionId ?? "",
        new Date(log.takenAt).toISOString(),
      ].join(",")
    );
    const content = `\uFEFF${[header, ...rows].join("\n")}`;
    downloadTextFile(
      `supplement-logs-today-${toLocalDateKey()}.csv`,
      content,
      "text/csv;charset=utf-8"
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Window</span>
          <Select
            value={String(windowDays)}
            onValueChange={(v) => onWindowChange(Number(v) as HistoryWindow)}
          >
            <SelectTrigger className="h-8 w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HISTORY_WINDOW_OPTIONS.map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {d} days
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExportProtocol}>
            <Download className="mr-1 h-3 w-3" />
            Protocol (JSON)
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportLogs}>
            <Download className="mr-1 h-3 w-3" />
            Today's logs (CSV)
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Adherence heatmap</CardTitle>
        </CardHeader>
        <CardContent>
          <SupplementsAdherenceHeatmap days={days} />
        </CardContent>
      </Card>
    </div>
  );
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
