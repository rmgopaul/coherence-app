/**
 * Determinate progress bar + stage label, rendered while a
 * dashboard tab aggregator is recomputing on a cold cache (Phase
 * B2 — 2026-05-12).
 *
 * Pure presentation — driven by the snapshot returned from
 * `useDashboardAggregatorProgress`. Consumer mounts it inline at
 * the top of the tab while the main query is loading.
 */

import type { AggregatorProgressSnapshot } from "@/solar-rec-dashboard/hooks/useDashboardAggregatorProgress";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { AlertCircle, Loader2 } from "lucide-react";

export function AggregatorProgressOverlay({
  progress,
}: {
  progress: AggregatorProgressSnapshot;
}) {
  const percent = Math.round(progress.fractionComplete * 100);

  const tone =
    progress.state === "failed"
      ? {
          card: "border-rose-200 bg-rose-50/70",
          label: "text-rose-900",
          bar: "bg-rose-100",
          icon: <AlertCircle className="size-4 text-rose-700" aria-hidden />,
        }
      : {
          card: "border-sky-200 bg-sky-50/70",
          label: "text-sky-900",
          bar: "bg-sky-100",
          icon: (
            <Loader2
              className="size-4 animate-spin text-sky-700"
              aria-hidden
            />
          ),
        };

  return (
    <Card className={tone.card}>
      <CardContent className="space-y-2 px-4 py-3">
        <div className={`flex items-center justify-between gap-3 text-sm ${tone.label}`}>
          <span className="flex items-center gap-2 font-medium">
            {tone.icon}
            {progress.stageLabel}
          </span>
          <span className="tabular-nums">{percent}%</span>
        </div>
        <Progress value={percent} className={`h-2 ${tone.bar}`} />
        {progress.current != null &&
        progress.total != null &&
        progress.unitLabel ? (
          <p className={`text-xs ${tone.label}/80`}>
            {progress.current.toLocaleString()} of {progress.total.toLocaleString()}{" "}
            {progress.unitLabel}
          </p>
        ) : null}
        {progress.state === "failed" && progress.errorMessage ? (
          <p className="text-xs text-rose-700">
            Error: {progress.errorMessage}. The dashboard will retry on the next
            tab activation.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
