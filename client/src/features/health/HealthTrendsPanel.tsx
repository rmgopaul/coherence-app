/**
 * Multi-metric trend chart. Pulls `metrics.getTrendSeries` (which already
 * computes 6 series + 2 correlations) and renders a Recharts line chart
 * with per-series toggles.
 */

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";

// 3650 = 10 years — matches the server's upper bound on
// `metrics.getTrendSeries.days` and lets a long-term Samsung Health
// user with the full CSV import (~3000 days) view their entire
// history. UI label maps "3650" to "All time" since "3650 days" is a
// confusing way to spell "as much as you've got".
const WINDOW_OPTIONS = [30, 90, 365, 3650] as const;
const WINDOW_LABEL: Record<number, string> = {
  30: "30 days",
  90: "90 days",
  365: "1 year",
  3650: "All time",
};

interface SeriesMeta {
  key: string;
  label: string;
  color: string;
}

const SERIES: SeriesMeta[] = [
  { key: "recovery", label: "Recovery", color: "#059669" },
  { key: "sleepHours", label: "Sleep (h)", color: "#2563eb" },
  { key: "strain", label: "Strain", color: "#f97316" },
  { key: "hrvMs", label: "HRV (ms)", color: "#7c3aed" },
  { key: "steps", label: "Steps", color: "#64748b" },
  { key: "tasksCompleted", label: "Tasks", color: "#db2777" },
];

export function HealthTrendsPanel() {
  const [days, setDays] = useState<number>(90);
  const [visible, setVisible] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(SERIES.map((s) => [s.key, true]))
  );

  const { data, isLoading, error } = trpc.metrics.getTrendSeries.useQuery(
    { days },
    { retry: false }
  );

  const rows = useMemo(() => {
    if (!data) return [];
    // series is an object keyed by series name, each an array of
    // { dateKey, value }. We pivot into one row per dateKey.
    const anyKey = Object.keys(data.series)[0];
    const reference = anyKey
      ? (data.series as Record<string, { dateKey: string; value: number | null }[]>)[anyKey]
      : [];
    return reference.map((row) => {
      const out: Record<string, number | string | null> = { dateKey: row.dateKey };
      for (const series of SERIES) {
        const values = (
          data.series as Record<string, { dateKey: string; value: number | null }[]>
        )[series.key];
        const match = values?.find((v) => v.dateKey === row.dateKey);
        out[series.key] = match?.value ?? null;
      }
      return out;
    });
  }, [data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
          <CardTitle className="text-sm">Trends</CardTitle>
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPTIONS.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {WINDOW_LABEL[n] ?? `${n} days`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {SERIES.map((s) => (
              <Button
                key={s.key}
                variant="outline"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs",
                  !visible[s.key] && "opacity-40"
                )}
                onClick={() =>
                  setVisible((prev) => ({ ...prev, [s.key]: !prev[s.key] }))
                }
              >
                <span
                  className="mr-1 inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: s.color }}
                />
                {s.label}
              </Button>
            ))}
          </div>

          {error ? (
            <p className="text-xs text-red-700">
              Couldn't load trends: {error.message}
            </p>
          ) : isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">No metrics captured in this window.</p>
          ) : (
            <div style={{ width: "100%", height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={rows} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="dateKey" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend />
                  {SERIES.filter((s) => visible[s.key]).map((s) => (
                    <Line
                      key={s.key}
                      type="monotone"
                      dataKey={s.key}
                      stroke={s.color}
                      strokeWidth={2}
                      dot={false}
                      name={s.label}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {data?.correlations ? (
            <div className="flex flex-wrap gap-2 pt-1">
              {data.correlations.recoveryVsSleep !== null ? (
                <Badge variant="outline">
                  Recovery × Sleep r = {data.correlations.recoveryVsSleep.toFixed(2)}
                </Badge>
              ) : null}
              {data.correlations.recoveryVsTasksCompleted !== null ? (
                <Badge variant="outline">
                  Recovery × Tasks r =
                  {" "}
                  {data.correlations.recoveryVsTasksCompleted.toFixed(2)}
                </Badge>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
