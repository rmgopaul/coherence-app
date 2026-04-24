/**
 * Pairwise metric correlation. Pick metric A + metric B + window, view a
 * scatter plot and Pearson r. Computed client-side from metrics.getHistory
 * since we already fetch that range for the Trends tab.
 */

import { useMemo, useState } from "react";
import { AlertCircle } from "lucide-react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toErrorMessage } from "@/lib/helpers";
import { trpc } from "@/lib/trpc";
import {
  LabelledSelect,
  MetricBlock,
  formatMean,
} from "@/features/_shared/insights/InsightsLayout";
import {
  HEALTH_METRICS,
  METRIC_GROUPS,
  type HealthMetricKey,
} from "./health.constants";
import {
  formatMetricValue,
  meanAndStd,
  pairForCorrelation,
  pearsonR,
  pearsonStrength,
  topQuartileContrast,
} from "./health.helpers";
import { AskAiPanel } from "@/components/AskAiPanel";

const WINDOW_OPTIONS = [30, 90, 365] as const;

export function HealthInsightsPanel() {
  const [metricA, setMetricA] = useState<HealthMetricKey>("whoopRecoveryScore");
  const [metricB, setMetricB] = useState<HealthMetricKey>("whoopSleepHours");
  const [windowDays, setWindowDays] = useState<number>(90);

  const {
    data: history = [],
    isLoading,
    error: historyError,
    refetch: refetchHistory,
  } = trpc.metrics.getHistory.useQuery(
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
  const rSquared = useMemo(() => (r === null ? null : r * r), [r]);
  const strength = useMemo(() => pearsonStrength(r), [r]);
  const statsA = useMemo(() => meanAndStd(points.map((p) => p.x)), [points]);
  const statsB = useMemo(() => meanAndStd(points.map((p) => p.y)), [points]);
  const contrast = useMemo(() => topQuartileContrast(points), [points]);

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
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            {labelA} × {labelB}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {historyError ? (
            <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Couldn't load metrics history.</p>
                <p className="text-red-700">{toErrorMessage(historyError)}</p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={() => refetchHistory()}
              >
                Retry
              </Button>
            </div>
          ) : isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : points.length < 3 ? (
            <div className="space-y-1 text-sm">
              <p className="font-medium">Not enough data yet.</p>
              <p className="text-muted-foreground">
                Need at least 3 days where both metrics are present.
                Currently <span className="font-medium text-foreground">{points.length}</span>{" "}
                overlapping day{points.length === 1 ? "" : "s"} in this window.
              </p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <MetricBlock
                  label="Pearson r"
                  value={r === null ? "—" : r.toFixed(2)}
                  sample={strength}
                  tone="neutral"
                />
                <MetricBlock
                  label="Variance explained (r²)"
                  value={
                    rSquared === null
                      ? "—"
                      : `${Math.round(rSquared * 100)}%`
                  }
                  sample={rSquared === null ? "" : "of variance in Y"}
                  tone="neutral"
                />
                <MetricBlock
                  label="Sample"
                  value={`${points.length}`}
                  sample={`overlapping day${points.length === 1 ? "" : "s"}`}
                  tone="neutral"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <MetricBlock
                  label={labelA}
                  value={formatMean(statsA.mean)}
                  sample={
                    statsA.std === null
                      ? ""
                      : `± ${formatMean(statsA.std)} (std)`
                  }
                  tone="on"
                />
                <MetricBlock
                  label={labelB}
                  value={formatMean(statsB.mean)}
                  sample={
                    statsB.std === null
                      ? ""
                      : `± ${formatMean(statsB.std)} (std)`
                  }
                  tone="off"
                />
              </div>

              {contrast.topMean !== null &&
              contrast.overallMean !== null &&
              contrast.threshold !== null ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
                  <p className="font-medium">
                    On top-quartile {labelA} days (N = {contrast.topN}, ≥{" "}
                    {formatMetricValue(metricA, contrast.threshold)}),
                  </p>
                  <p className="text-muted-foreground">
                    {labelB} averaged{" "}
                    <span className="font-semibold text-foreground">
                      {formatMean(contrast.topMean)}
                    </span>{" "}
                    vs {formatMean(contrast.overallMean)} overall (Δ ={" "}
                    {formatDelta(contrast.topMean - contrast.overallMean)}).
                  </p>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="outline">{windowDays} day window</Badge>
                <Badge variant="outline">
                  direction{" "}
                  {r === null
                    ? "—"
                    : r > 0
                      ? "positive"
                      : r < 0
                        ? "negative"
                        : "zero"}
                </Badge>
              </div>

              <div style={{ width: "100%", height: 280 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart
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
                      formatter={(value: number, name: string) => [
                        value.toFixed(2),
                        name,
                      ]}
                    />
                    <Scatter
                      name={`${labelA} vs ${labelB}`}
                      data={points}
                      fill="#059669"
                    />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="health-insights"
        title="Ask AI about this correlation"
        contextGetter={() => ({
          metricA: labelA,
          metricB: labelB,
          windowDays,
          pearsonR: r,
          pearsonStrength: strength,
          varianceExplainedPct:
            rSquared === null ? null : Math.round(rSquared * 100),
          samplePairs: points.length,
          metricAMean: statsA.mean,
          metricAStd: statsA.std,
          metricBMean: statsB.mean,
          metricBStd: statsB.std,
          topQuartileContrast:
            contrast.topMean !== null &&
            contrast.overallMean !== null &&
            contrast.threshold !== null
              ? {
                  thresholdA: contrast.threshold,
                  topN: contrast.topN,
                  topMeanB: contrast.topMean,
                  overallMeanB: contrast.overallMean,
                }
              : null,
        })}
      />

      <p className="text-[10px] text-muted-foreground">
        Pearson r captures linear association only. Small samples are noisy;
        descriptive only.
      </p>
    </div>
  );
}

function formatDelta(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "±";
  return `${sign}${formatMean(Math.abs(value))}`;
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
