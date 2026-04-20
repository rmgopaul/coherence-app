/**
 * Cross-data analytics for supplements.
 *
 * Lets the user pick a supplement + a health/productivity metric, optionally
 * apply a lag (0/+1/+2/+3 days, for effects that land on the following day),
 * and shows a supplement-on vs supplement-off comparison with effect size
 * and a small scatter of daily values.
 *
 * Intentionally descriptive, never prescriptive — no p-values, no medical
 * recommendations. We show Cohen's d (effect size) and sample counts so
 * the user can judge reliability themselves.
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
import type { SupplementDefinition } from "@/features/dashboard/types";

export const METRIC_OPTIONS = [
  { group: "Whoop", value: "whoopRecoveryScore", label: "Recovery score" },
  { group: "Whoop", value: "whoopDayStrain", label: "Day strain" },
  { group: "Whoop", value: "whoopSleepHours", label: "Sleep hours" },
  { group: "Whoop", value: "whoopHrvMs", label: "HRV (ms)" },
  { group: "Whoop", value: "whoopRestingHr", label: "Resting HR" },
  { group: "Samsung", value: "samsungSteps", label: "Steps" },
  { group: "Samsung", value: "samsungSleepHours", label: "Sleep hours" },
  { group: "Samsung", value: "samsungSpo2AvgPercent", label: "SpO₂ avg %" },
  { group: "Samsung", value: "samsungSleepScore", label: "Sleep score" },
  { group: "Samsung", value: "samsungEnergyScore", label: "Energy score" },
  { group: "Productivity", value: "todoistCompletedCount", label: "Tasks completed" },
] as const;

type MetricValue = (typeof METRIC_OPTIONS)[number]["value"];

const METRIC_GROUPS = Array.from(new Set(METRIC_OPTIONS.map((m) => m.group)));
const WINDOW_OPTIONS = [30, 90, 365] as const;
const LAG_OPTIONS = [0, 1, 2, 3] as const;

export interface SupplementsInsightsPanelProps {
  definitions: readonly SupplementDefinition[];
}

export function SupplementsInsightsPanel({
  definitions,
}: SupplementsInsightsPanelProps) {
  const [definitionId, setDefinitionId] = useState<string>(
    definitions[0]?.id ?? ""
  );
  const [metric, setMetric] = useState<MetricValue>("whoopRecoveryScore");
  const [windowDays, setWindowDays] = useState<number>(90);
  const [lagDays, setLagDays] = useState<number>(0);

  const enabled = !!definitionId;
  const { data, isLoading } = trpc.supplements.getCorrelation.useQuery(
    {
      definitionId,
      metric,
      windowDays,
      lagDays,
    },
    { enabled, retry: false }
  );

  const metricLabel =
    METRIC_OPTIONS.find((m) => m.value === metric)?.label ?? metric;

  const scatterData = useMemo(() => {
    if (!data) return { on: [], off: [] };
    const on = [];
    const off = [];
    for (const p of data.points) {
      const point = { dateKey: p.dateKey, value: p.value, x: p.logged ? 1 : 0 };
      if (p.logged) on.push(point);
      else off.push(point);
    }
    return { on, off };
  }, [data]);

  if (definitions.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-6 text-sm text-muted-foreground">
        Add a supplement first — insights need at least one tracked item.
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
          <LabelledSelect label="Supplement">
            <Select value={definitionId} onValueChange={setDefinitionId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {definitions.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledSelect>
          <LabelledSelect label="Metric">
            <Select
              value={metric}
              onValueChange={(v) => setMetric(v as MetricValue)}
            >
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
            <Select
              value={String(lagDays)}
              onValueChange={(v) => setLagDays(Number(v))}
            >
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
              Select a supplement to begin.
            </p>
          ) : data.insufficientData ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">Not enough data yet.</p>
              <p className="text-muted-foreground">
                Need at least 7 days in each group (on and off). Currently{" "}
                <span className="font-medium text-foreground">{data.onN}</span> logged
                and <span className="font-medium text-foreground">{data.offN}</span>{" "}
                unlogged in this window.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricBlock
                  label="On supplement"
                  value={formatMean(data.onMean)}
                  sample={`${data.onN} days`}
                  tone="on"
                />
                <MetricBlock
                  label="Off supplement"
                  value={formatMean(data.offMean)}
                  sample={`${data.offN} days`}
                  tone="off"
                />
                <MetricBlock
                  label="Effect size (Cohen's d)"
                  value={data.cohensD === null ? "—" : data.cohensD.toFixed(2)}
                  sample={cohensDLabel(data.cohensD)}
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
                  <Badge variant="outline">
                    Pearson r = {data.pearsonR.toFixed(2)}
                  </Badge>
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

      <p className="text-[10px] text-muted-foreground">
        Descriptive only. Small-sample effect sizes are fragile; use this to
        spot patterns worth exploring, not to make medical decisions.
      </p>
    </div>
  );
}

function LabelledSelect({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {children}
    </div>
  );
}

function MetricBlock({
  label,
  value,
  sample,
  tone,
}: {
  label: string;
  value: string;
  sample: string;
  tone: "on" | "off" | "neutral";
}) {
  const toneClass =
    tone === "on"
      ? "border-emerald-200 bg-emerald-50"
      : tone === "off"
        ? "border-slate-200 bg-slate-50"
        : "border-amber-200 bg-amber-50";
  return (
    <div className={`rounded-md border p-3 ${toneClass}`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{sample}</p>
    </div>
  );
}

function formatMean(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function cohensDLabel(d: number | null): string {
  if (d === null) return "no effect computed";
  const abs = Math.abs(d);
  if (abs < 0.2) return "negligible";
  if (abs < 0.5) return "small";
  if (abs < 0.8) return "medium";
  return "large";
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
          tickFormatter={(v: number) => (v === 1 ? "on" : "off")}
          tick={{ fontSize: 11 }}
        />
        <YAxis
          type="number"
          dataKey="value"
          name={yLabel}
          tick={{ fontSize: 11 }}
        />
        <Tooltip
          cursor={{ strokeDasharray: "3 3" }}
          formatter={(value: number) => [value.toFixed(2), yLabel]}
          labelFormatter={(_: unknown, payload: Array<{ payload?: { dateKey?: string } }>) => {
            const row = payload?.[0]?.payload;
            return row?.dateKey ?? "";
          }}
        />
        {offMean !== null ? (
          <ReferenceLine
            y={offMean}
            stroke="#94a3b8"
            strokeDasharray="4 4"
            label={{
              value: "off mean",
              position: "left",
              fill: "#64748b",
              fontSize: 10,
            }}
          />
        ) : null}
        {onMean !== null ? (
          <ReferenceLine
            y={onMean}
            stroke="#059669"
            strokeDasharray="4 4"
            label={{
              value: "on mean",
              position: "right",
              fill: "#059669",
              fontSize: 10,
            }}
          />
        ) : null}
        <Scatter name="off" data={offPoints} fill="#64748b" />
        <Scatter name="on" data={onPoints} fill="#059669" />
      </ScatterChart>
    </div>
  );
}
