/**
 * GitHub-contribution-style grid of daily adherence.
 *
 * One column per week, one cell per day. Color encodes
 * adherencePct = taken / expected for that day. Click a day to
 * notify the parent (for drill-downs later).
 */

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { adherencePct } from "@shared/supplements.math";

export interface AdherenceDay {
  dateKey: string;
  taken: number;
  expected: number;
}

export interface SupplementsAdherenceHeatmapProps {
  days: readonly AdherenceDay[];
  onDayClick?: (day: AdherenceDay) => void;
}

interface Cell {
  day: AdherenceDay | null;
  iso: string;
}

/**
 * Arrange days into a 7-row (Sun→Sat) × N-column grid starting with
 * the week that contains the first day. Missing cells before the first
 * day are filled with null placeholders.
 */
function buildGrid(days: readonly AdherenceDay[]): Cell[][] {
  if (days.length === 0) return [];

  const rows: Cell[][] = [[], [], [], [], [], [], []];
  const first = new Date(`${days[0].dateKey}T00:00:00`);
  const firstDow = first.getDay();

  // Pad the first column so the first day aligns with its weekday row.
  for (let i = 0; i < firstDow; i += 1) {
    rows[i].push({ day: null, iso: `pad-start-${i}` });
  }

  for (const day of days) {
    const parsed = new Date(`${day.dateKey}T00:00:00`);
    rows[parsed.getDay()].push({ day, iso: day.dateKey });
  }

  // Right-pad short rows so all rows have the same column count.
  const maxCols = Math.max(...rows.map((r) => r.length));
  for (let i = 0; i < rows.length; i += 1) {
    while (rows[i].length < maxCols) {
      rows[i].push({ day: null, iso: `pad-end-${i}-${rows[i].length}` });
    }
  }

  return rows;
}

function colorForPct(pct: number | null): string {
  if (pct === null) return "bg-transparent";
  if (pct <= 0) return "bg-muted";
  if (pct < 0.25) return "bg-emerald-100";
  if (pct < 0.5) return "bg-emerald-300";
  if (pct < 0.75) return "bg-emerald-500";
  if (pct < 1) return "bg-emerald-600";
  return "bg-emerald-700";
}

export function SupplementsAdherenceHeatmap({
  days,
  onDayClick,
}: SupplementsAdherenceHeatmapProps) {
  const grid = useMemo(() => buildGrid(days), [days]);

  if (days.length === 0) {
    return (
      <div className="rounded-md border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
        No data yet in the selected window.
      </div>
    );
  }

  return (
    <div className="inline-block space-y-2">
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
              const pct =
                cell.day.expected > 0
                  ? adherencePct(cell.day.taken, cell.day.expected)
                  : null;
              const title =
                pct === null
                  ? `${cell.day.dateKey} · no protocol`
                  : `${cell.day.dateKey} · ${cell.day.taken}/${cell.day.expected} (${Math.round(
                      pct * 100
                    )}%)`;
              return (
                <button
                  type="button"
                  key={cell.iso}
                  title={title}
                  onClick={() => onDayClick?.(cell.day!)}
                  className={cn(
                    "h-3 w-3 rounded-sm transition-transform hover:scale-125 focus:outline-none focus:ring-1 focus:ring-ring",
                    colorForPct(pct)
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span>less</span>
        <div className="h-3 w-3 rounded-sm bg-muted" />
        <div className="h-3 w-3 rounded-sm bg-emerald-100" />
        <div className="h-3 w-3 rounded-sm bg-emerald-300" />
        <div className="h-3 w-3 rounded-sm bg-emerald-500" />
        <div className="h-3 w-3 rounded-sm bg-emerald-700" />
        <span>more</span>
      </div>
    </div>
  );
}
