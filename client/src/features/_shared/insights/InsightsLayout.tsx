/**
 * Shared layout primitives for the Insights panels across Supplements,
 * Habits, and Health. Extracted after the third copy-paste surfaced
 * the triplicate — see the three-strikes rule in
 * `.claude/plans/twinkling-prancing-gizmo.md`.
 *
 * Keep this module presentation-only. Domain-specific math lives next
 * to each feature (e.g. `habits.helpers.ts`, `health.helpers.ts`) and
 * the server-side Phase 3 correlation helper.
 */

import type React from "react";

/** Vertical stack with a tiny uppercase label above the control. */
export function LabelledSelect({
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

/**
 * Tinted summary tile used in the Insights result rows.
 *
 * Tones:
 *  - `on`: emerald — the "in-group" / "supplement taken" / "metric A" slot
 *  - `off`: slate — the "out-group" / "supplement not taken" / "metric B" slot
 *  - `neutral`: amber — effect-size / sample / r² — numbers that don't
 *    belong to either group
 */
export function MetricBlock({
  label,
  value,
  sample,
  tone,
}: {
  label: string;
  value: string;
  sample?: string;
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
      {sample ? (
        <p className="text-xs text-muted-foreground">{sample}</p>
      ) : null}
    </div>
  );
}

/**
 * Domain-agnostic "mean-ish" formatting used in the Insights result
 * tiles. Not the same as `formatCurrency` in `lib/helpers.ts` — callers
 * explicitly want "—" for null and decimal-only output.
 */
export function formatMean(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
