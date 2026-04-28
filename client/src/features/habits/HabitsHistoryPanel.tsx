/**
 * Per-habit completion heatmap grid. One mini-heatmap per habit, with a
 * shared window selector (30/90/365 days). Reuses the completion-grid
 * builder in habits.helpers.ts.
 */

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { toLocalDateKey } from "@/lib/helpers";
import { trpc } from "@/lib/trpc";
import type { HabitDefinition } from "@/features/dashboard/types";
import {
  HISTORY_WINDOW_OPTIONS,
  type HistoryWindow,
} from "./habits.constants";
import { buildCompletionGrid, colorForCompletion } from "./habits.helpers";

export interface HabitsHistoryPanelProps {
  definitions: readonly HabitDefinition[];
}

function daysAgoKey(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toLocalDateKey(d);
}

export function HabitsHistoryPanel({ definitions }: HabitsHistoryPanelProps) {
  const [windowDays, setWindowDays] = useState<HistoryWindow>(90);

  const startDateKey = useMemo(() => daysAgoKey(windowDays - 1), [windowDays]);
  const endDateKey = useMemo(() => toLocalDateKey(), []);

  const activeDefs = definitions.filter((d) => d.isActive);

  // Phase E (2026-04-28) — single bulk query across every habit
  // for the selected window. Replaces the prior N+1 pattern where
  // each `<HabitHistoryCard />` issued its own
  // `getCompletionsRange.useQuery`. With ~10 habits that was 10
  // round-trips per render; now it's 1.
  const { data: bulk } = trpc.habits.getCompletionsRangeBulk.useQuery(
    { startDateKey, endDateKey },
    { retry: false, enabled: activeDefs.length > 0 }
  );
  const rowsByHabitId = bulk?.byHabitId ?? {};

  if (activeDefs.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        No active habits. Add one in the Protocol tab.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-muted-foreground">Window</span>
        <Select
          value={String(windowDays)}
          onValueChange={(v) => setWindowDays(Number(v) as HistoryWindow)}
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {activeDefs.map((def) => (
          <HabitHistoryCard
            key={def.id}
            definition={def}
            startDateKey={startDateKey}
            endDateKey={endDateKey}
            rows={rowsByHabitId[def.id] ?? []}
          />
        ))}
      </div>
    </div>
  );
}

interface HabitHistoryCardProps {
  definition: HabitDefinition;
  startDateKey: string;
  endDateKey: string;
  /** Phase E (2026-04-28): rows passed in from the parent's bulk
   *  query rather than each card fetching its own. */
  rows: ReadonlyArray<{ dateKey: string; completed: boolean }>;
}

function HabitHistoryCard({
  definition,
  startDateKey,
  endDateKey,
  rows,
}: HabitHistoryCardProps) {
  // Fill missing days with { completed: false } so the grid shows the full window.
  const fullRange = useMemo(() => {
    const byKey = new Map(rows.map((r) => [r.dateKey, r.completed]));
    const result: { dateKey: string; completed: boolean }[] = [];
    const start = new Date(`${startDateKey}T00:00:00`);
    const end = new Date(`${endDateKey}T00:00:00`);
    const cursor = new Date(start);
    while (cursor <= end) {
      const key = toLocalDateKey(cursor);
      result.push({ dateKey: key, completed: byKey.get(key) ?? false });
      cursor.setDate(cursor.getDate() + 1);
    }
    return result;
  }, [rows, startDateKey, endDateKey]);

  const grid = useMemo(() => buildCompletionGrid(fullRange), [fullRange]);
  const completedCount = fullRange.filter((d) => d.completed).length;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="text-sm">{definition.name}</CardTitle>
        <span className="text-xs text-muted-foreground">
          {completedCount}/{fullRange.length}
        </span>
      </CardHeader>
      <CardContent>
        <div className="flex gap-1">
          {grid[0]?.map((_, colIdx) => (
            <div key={`col-${colIdx}`} className="flex flex-col gap-1">
              {grid.map((row, rowIdx) => {
                const cell = row[colIdx];
                if (!cell || !cell.day) {
                  return (
                    <div
                      key={cell?.iso ?? `${rowIdx}-${colIdx}`}
                      className="h-3 w-3 rounded-sm"
                    />
                  );
                }
                return (
                  <div
                    key={cell.iso}
                    title={`${cell.day.dateKey} — ${cell.day.completed ? "✓" : "—"}`}
                    className={cn(
                      "h-3 w-3 rounded-sm",
                      colorForCompletion(cell.day)
                    )}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
