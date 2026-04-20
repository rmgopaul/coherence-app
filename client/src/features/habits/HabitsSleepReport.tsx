/**
 * Hard-wired sleep-habits correlation report.
 *
 * For every active habit × every sleep metric (whoopSleepHours, whoopHrvMs,
 * samsungSleepScore, samsungSleepHours), shows Cohen's d + magnitude +
 * sample size. One-shot load — server does the matrix in O(habits × metrics)
 * in-memory.
 */

import { useState } from "react";
import { Moon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { SLEEP_REPORT_METRICS } from "./habits.constants";
import { cohensDMagnitude } from "./habits.helpers";

const WINDOWS = [30, 90, 365] as const;

export function HabitsSleepReport() {
  const [windowDays, setWindowDays] = useState<number>(90);

  const { data: report = [], isLoading, error } =
    trpc.habits.getSleepReport.useQuery({ windowDays }, { retry: false });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Moon className="h-4 w-4 text-indigo-600" />
          Habits × sleep
        </CardTitle>
        <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v))}>
          <SelectTrigger className="h-8 w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Effect size (Cohen's d) of each habit on sleep metrics over the last
          {` ${windowDays} `}days. Positive = sleep metric is higher on days
          the habit was done. Descriptive only — small samples are fragile.
        </p>

        {error ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            Couldn't load the sleep report.
          </div>
        ) : isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : report.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active habits.</p>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Habit</TableHead>
                  {SLEEP_REPORT_METRICS.map((m) => (
                    <TableHead key={m.key} className="text-right">
                      {m.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.map((row) => (
                  <TableRow key={row.habitId}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    {SLEEP_REPORT_METRICS.map((m) => {
                      const cell = row.correlations.find((c) => c.metric === m.key);
                      if (!cell || cell.insufficientData) {
                        return (
                          <TableCell
                            key={m.key}
                            className="text-right text-xs text-muted-foreground"
                          >
                            —
                          </TableCell>
                        );
                      }
                      const tone =
                        cell.cohensD === null
                          ? "text-muted-foreground"
                          : cell.cohensD >= 0.5
                            ? "text-emerald-700 font-semibold"
                            : cell.cohensD <= -0.5
                              ? "text-red-700 font-semibold"
                              : "text-foreground";
                      return (
                        <TableCell
                          key={m.key}
                          className={cn("text-right text-xs", tone)}
                          title={`on ${cell.onN} / off ${cell.offN}`}
                        >
                          {cell.cohensD === null ? "—" : cell.cohensD.toFixed(2)}
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            ({cohensDMagnitude(cell.cohensD)})
                          </span>
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
