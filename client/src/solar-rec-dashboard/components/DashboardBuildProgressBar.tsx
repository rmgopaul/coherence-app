/**
 * Inline progress bar for dashboard "Rebuild table" actions.
 *
 * Renders the server's real per-step progress (currentStep /
 * totalSteps / percent / message / factTable) instead of the flat
 * "Building…" placeholder the rebuild buttons used to show. Source
 * of truth is `useDashboardBuildControl.buildProgress`, which
 * polls the build status row every 2 s.
 *
 * Visible while `isBuildRunning` is true; returns null otherwise
 * (no DOM produced). The five tabs that mount a "Rebuild table"
 * button (Alerts / ChangeOwnership / Comparisons / OfflineMonitoring /
 * Ownership) all render this component below the button.
 */

import type { DashboardBuildProgressSnapshot } from "@/solar-rec-dashboard/hooks/useDashboardBuildControl";
import { Progress } from "@/components/ui/progress";
import { Loader2 } from "lucide-react";

export interface DashboardBuildProgressBarProps {
  /** Whether the build is currently running. The bar hides itself when false. */
  isBuildRunning: boolean;
  /** Real-time progress snapshot from the server, or null if the build hasn't started reporting yet. */
  progress: DashboardBuildProgressSnapshot | null;
}

export function DashboardBuildProgressBar({
  isBuildRunning,
  progress,
}: DashboardBuildProgressBarProps) {
  if (!isBuildRunning) return null;

  // Clamp percent client-side — server `parseProgress` already
  // does this but treat the wire shape defensively.
  const rawPercent = progress?.percent;
  const percent =
    typeof rawPercent === "number" && Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, Math.round(rawPercent)))
      : null;

  // The runner reports null `factTable` between steps + on the
  // final "Build complete" tick; fall back to the message string
  // when factTable is absent so the user still sees what stage
  // they're in.
  const stageLabel =
    progress?.factTable ?? progress?.message ?? "Preparing build";

  // 2026-05-13 — clamp `currentStep + 1` to `totalSteps`. The
  // server runner writes `currentStep: i` mid-loop (0-based) but
  // bumps to `currentStep: totalSteps` on the final "Build complete"
  // tick, so the raw `currentStep + 1` would render "Step 6 of 5"
  // for the brief window between that tick and the status flip to
  // `succeeded` (when the bar unmounts).
  const displayStep =
    progress && progress.totalSteps > 0
      ? Math.min(progress.currentStep + 1, progress.totalSteps)
      : null;

  return (
    // aria-live="polite" announces stage / percent changes to
    // screen readers without interrupting their focus.
    <div
      className="mt-2 space-y-1.5 rounded-md border border-sky-200 bg-sky-50/70 px-3 py-2"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3 text-xs text-sky-900">
        <span className="flex items-center gap-2 font-medium">
          <Loader2
            className="size-3.5 animate-spin text-sky-700"
            aria-hidden
          />
          {stageLabel}
        </span>
        <span className="tabular-nums">{percent ?? "—"}%</span>
      </div>
      <Progress value={percent ?? 0} className="h-2 bg-sky-100" />
      {progress && displayStep !== null ? (
        <p className="text-xs text-sky-900/80">
          Step {displayStep} of {progress.totalSteps}
          {progress.message ? ` · ${progress.message}` : null}
        </p>
      ) : null}
    </div>
  );
}
