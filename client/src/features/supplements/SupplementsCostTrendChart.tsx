/**
 * Price-per-bottle trend for a single supplement. Backed by
 * `supplements.listPriceLogs`, which already returns ordered history.
 *
 * Tiny responsive Recharts line chart. Shows an empty state when there
 * are fewer than 2 points (a trend needs at least two snapshots).
 */

import { useMemo } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "@/lib/helpers";

export interface PricePoint {
  capturedAt: Date | string;
  pricePerBottle: number;
}

export interface SupplementsCostTrendChartProps {
  points: readonly PricePoint[];
  height?: number;
}

interface ChartRow {
  dateLabel: string;
  price: number;
  iso: string;
}

export function SupplementsCostTrendChart({
  points,
  height = 140,
}: SupplementsCostTrendChartProps) {
  const rows = useMemo<ChartRow[]>(() => {
    const mapped = points.map((p) => {
      const parsed = new Date(p.capturedAt);
      return {
        iso: parsed.toISOString(),
        dateLabel: parsed.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        price: p.pricePerBottle,
      };
    });
    // The procedure returns DESC; reverse so the chart reads left→right oldest→newest.
    return mapped.slice().reverse();
  }, [points]);

  if (rows.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        Need at least two price snapshots to show a trend.
      </p>
    );
  }

  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="dateLabel" tick={{ fontSize: 10 }} />
          <YAxis
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => formatCurrency(v)}
            width={64}
          />
          <Tooltip
            formatter={(value: number) => [formatCurrency(value), "$/bottle"]}
            labelFormatter={(label) => `captured ${label}`}
          />
          <Line
            type="monotone"
            dataKey="price"
            stroke="#059669"
            strokeWidth={2}
            dot={{ r: 3 }}
            name="$/bottle"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
