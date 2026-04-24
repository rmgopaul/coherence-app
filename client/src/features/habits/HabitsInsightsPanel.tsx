/**
 * Habit × health-metric correlation canvas. Mirrors SupplementsInsightsPanel
 * in shape: pick a habit + metric + window + lag, view on/off means +
 * Cohen's d + scatter.
 */

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ReferenceLine,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import type { HabitDefinition } from "@/features/dashboard/types";
import { METRIC_OPTIONS } from "@/features/supplements/SupplementsInsightsPanel";
import {
  LabelledSelect,
  MetricBlock,
  formatMean,
} from "@/features/_shared/insights/InsightsLayout";
import { cohensDMagnitude } from "./habits.helpers";
import { AskAiPanel } from "@/components/AskAiPanel";

type MetricValue = (typeof METRIC_OPTIONS)[number]["value"];
const METRIC_GROUPS = Array.from(new Set(METRIC_OPTIONS.map((m) => m.group)));

const WINDOW_OPTIONS = [30, 90, 365] as const;
const LAG_OPTIONS = [0, 1, 2, 3] as const;

export interface HabitsInsightsPanelProps {
  definitions: readonly HabitDefinition[];
}

export function HabitsInsightsPanel({ definitions }: HabitsInsightsPanelProps) {
  const activeDefs = definitions.filter((d) => d.isActive);
  const [habitId, setHabitId] = useState<string>(activeDefs[0]?.id ?? "");
  const [metric, setMetric] = useState<MetricValue>("whoopRecoveryScore");
  const [windowDays, setWindowDays] = useState<number>(90);
  const [lagDays, setLagDays] = useState<number>(0);

  const { data, isLoading } = trpc.habits.getCorrelation.useQuery(
    { habitId, metric, windowDays, lagDays },
    { enabled: !!habitId, retry: false }
  );

  const metricLabel =
    METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? metric;

  const scatterData = useMemo(() => {
    if (!data) return { on: [], off: [] };
    const on: { x: number; value: number; dateKey: string }[] = [];
    const off: { x: number; value: number; dateKey: string }[] = [];
    for (const p of data.points) {
      const point = { dateKey: p.dateKey, value: p.value, x: p.logged ? 1 : 0 };
      if (p.logged) on.push(point);
      else off.push(point);
    }
    return { on, off };
  }, [data]);

  if (activeDefs.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-6 text-sm text-muted-foreground">
        Add at least one habit to run correlations.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Correlate</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <LabelledSelect label="Habit">
            <Select value={habitId} onValueChange={setHabitId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {activeDefs.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledSelect>
          <LabelledSelect label="Metric">
            <Select value={metric} onValueChange={(v) => setMetric(v as MetricValue)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METRIC_GROUPS.map((group) => (
                  <SelectGroup key={group}>
                    <SelectLabel>{group}</SelectLabel>
                    {METRIC_OPTIONS.filter((m) => m.group === group).map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </LabelledSelect>
          <LabelledSelect label="Window">
            <Select
              value={String(windowDays)}
              onValueChange={(v) => setWindowDays(Number(v))}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOW_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledSelect>
          <LabelledSelect label="Lag (days)">
            <Select value={String(lagDays)} onValueChange={(v) => setLagDays(Number(v))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAG_OPTIONS.map((d) => (
                  <SelectItem key={d} value={String(d)}>
                    {d === 0 ? "same day" : `+${d} day${d === 1 ? "" : "s"}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledSelect>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Result</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !data ? (
            <p className="text-sm text-muted-foreground">
              Select a habit to begin.
            </p>
          ) : data.insufficientData ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">Not enough data yet.</p>
              <p className="text-muted-foreground">
                Need at least 7 days in each group (completed / not completed).
                Currently <span className="font-medium text-foreground">{data.onN}</span>{" "}
                completed and <span className="font-medium text-foreground">{data.offN}</span>{" "}
                skipped in this window.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricBlock label="On days" value={formatMean(data.onMean)} sample={`${data.onN} days`} tone="on" />
                <MetricBlock label="Off days" value={formatMean(data.offMean)} sample={`${data.offN} days`} tone="off" />
                <MetricBlock
                  label="Effect size (Cohen's d)"
                  value={data.cohensD === null ? "—" : data.cohensD.toFixed(2)}
                  sample={cohensDMagnitude(data.cohensD)}
                  tone="neutral"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{metricLabel}</Badge>
                <Badge variant="outline">{windowDays} day window</Badge>
                <Badge variant="outline">
                  lag {lagDays === 0 ? "same day" : `+${lagDays}`}
                </Badge>
                {data.pearsonR !== null ? (
                  <Badge variant="outline">Pearson r = {data.pearsonR.toFixed(2)}</Badge>
                ) : null}
              </div>

              <ScatterPlot
                onPoints={scatterData.on}
                offPoints={scatterData.off}
                yLabel={metricLabel}
                offMean={data.offMean}
                onMean={data.onMean}
              />
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="habits-insights"
        title="Ask AI about this correlation"
        contextGetter={() => {
          const def = activeDefs.find((d) => d.id === habitId);
          if (!data) {
            return {
              habit: def?.name ?? null,
              metric: metricLabel,
              windowDays,
              lagDays,
              status: "no data loaded yet",
            };
          }
          return {
            habit: def?.name ?? null,
            metric: metricLabel,
            windowDays,
            lagDays,
            insufficientData: data.insufficientData,
            onMean: data.onMean,
            onN: data.onN,
            offMean: data.offMean,
            offN: data.offN,
            cohensD: data.cohensD,
            cohensDLabel: cohensDMagnitude(data.cohensD),
            pearsonR: data.pearsonR,
            sampleCount: data.points.length,
          };
        }}
      />

      <p className="text-[10px] text-muted-foreground">
        Descriptive only. Small-sample effect sizes are fragile; use this to
        spot patterns worth exploring, not to make medical decisions.
      </p>
    </div>
  );
}

function ScatterPlot({
  onPoints,
  offPoints,
  yLabel,
  offMean,
  onMean,
}: {
  onPoints: { x: number; value: number; dateKey: string }[];
  offPoints: { x: number; value: number; dateKey: string }[];
  yLabel: string;
  offMean: number | null;
  onMean: number | null;
}) {
  if (onPoints.length + offPoints.length === 0) return null;
  return (
    <div style={{ width: "100%", height: 220 }}>
      <ScatterChart
        width={600}
        height={220}
        margin={{ top: 10, right: 20, left: 10, bottom: 10 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis
          type="number"
          dataKey="x"
          domain={[-0.5, 1.5]}
          ticks={[0, 1]}
          tickFormatter={(v: number) => (v === 1 ? "done" : "skipped")}
          tick={{ fontSize: 11 }}
        />
        <YAxis type="number" dataKey="value" name={yLabel} tick={{ fontSize: 11 }} />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(value: number) => [value.toFixed(2), yLabel]}
          labelFormatter={(_: unknown, payload: Array<{ payload?: { dateKey?: string } }>) => {
            return payload?.[0]?.payload?.dateKey ?? "";
          }}
        />
        {offMean !== null ? (
          <ReferenceLine y={offMean} stroke="#94a3b8" strokeDasharray="4 4" />
        ) : null}
        {onMean !== null ? (
          <ReferenceLine y={onMean} stroke="#059669" strokeDasharray="4 4" />
        ) : null}
        <Scatter name="skipped" data={offPoints} fill="#64748b" />
        <Scatter name="done" data={onPoints} fill="#059669" />
      </ScatterChart>
    </div>
  );
}
