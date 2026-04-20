/**
 * Pairwise metric correlation. Pick metric A + metric B + window, view a
 * scatter plot and Pearson r. Computed client-side from metrics.getHistory
 * since we already fetch that range for the Trends tab.
 */

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import {
  HEALTH_METRICS,
  METRIC_GROUPS,
  type HealthMetricKey,
} from "./health.constants";
import { pairForCorrelation, pearsonR } from "./health.helpers";

const WINDOW_OPTIONS = [30, 90, 365] as const;

export function HealthInsightsPanel() {
  const [metricA, setMetricA] = useState<HealthMetricKey>("whoopRecoveryScore");
  const [metricB, setMetricB] = useState<HealthMetricKey>("whoopSleepHours");
  const [windowDays, setWindowDays] = useState<number>(90);

  const { data: history = [], isLoading } = trpc.metrics.getHistory.useQuery(
    { limit: windowDays },
    { retry: false }
  );

  const points = useMemo(() => {
    const pairs = history.map((row) => {
      const a = (row as Record<string, unknown>)[metricA];
      const b = (row as Record<string, unknown>)[metricB];
      const toNum = (v: unknown): number | null => {
        if (v === null || v === undefined) return null;
        const n = typeof v === "number" ? v : Number(v);
        return Number.isFinite(n) ? n : null;
      };
      return { dateKey: row.dateKey, a: toNum(a), b: toNum(b) };
    });
    return pairForCorrelation(pairs);
  }, [history, metricA, metricB]);

  const r = useMemo(() => pearsonR(points), [points]);

  const labelA =
    HEALTH_METRICS.find((m) => m.key === metricA)?.label ?? metricA;
  const labelB =
    HEALTH_METRICS.find((m) => m.key === metricB)?.label ?? metricB;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Pairwise correlation</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <LabelledSelect label="X axis">
            <MetricPicker value={metricA} onChange={setMetricA} />
          </LabelledSelect>
          <LabelledSelect label="Y axis">
            <MetricPicker value={metricB} onChange={setMetricB} />
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
                {WINDOW_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} days
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </LabelledSelect>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">
            {labelA} vs {labelB}
          </CardTitle>
          <div className="flex items-center gap-2">
            {r !== null ? (
              <Badge variant="outline">Pearson r = {r.toFixed(2)}</Badge>
            ) : (
              <Badge variant="outline">r = —</Badge>
            )}
            <Badge variant="outline">{points.length} days</Badge>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : points.length < 3 ? (
            <p className="text-xs text-muted-foreground">
              Need at least 3 days with both metrics present.
            </p>
          ) : (
            <div style={{ width: "100%", height: 280 }}>
              <ScatterChart
                width={600}
                height={280}
                margin={{ top: 10, right: 16, left: 10, bottom: 10 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={labelA}
                  tick={{ fontSize: 11 }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={labelB}
                  tick={{ fontSize: 11 }}
                />
                <Tooltip
                  cursor={{ strokeDasharray: "3 3" }}
                  formatter={(value: number, name: string) => [value.toFixed(2), name]}
                />
                <Scatter name={`${labelA} vs ${labelB}`} data={points} fill="#059669" />
              </ScatterChart>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-[10px] text-muted-foreground">
        Pearson r captures linear association only. Small samples are noisy;
        descriptive only.
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

function MetricPicker({
  value,
  onChange,
}: {
  value: HealthMetricKey;
  onChange: (v: HealthMetricKey) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as HealthMetricKey)}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {METRIC_GROUPS.map((group) => (
          <SelectGroup key={group}>
            <SelectLabel>{group}</SelectLabel>
            {HEALTH_METRICS.filter((m) => m.group === group).map((m) => (
              <SelectItem key={m.key} value={m.key}>
                {m.label}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
