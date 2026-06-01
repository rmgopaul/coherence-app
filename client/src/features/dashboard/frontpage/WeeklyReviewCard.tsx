/**
 * Phase E (2026-04-28) — AI Weekly Review card.
 *
 * Lives below the wire feeds on the front page. Renders the most
 * recent persisted review (`weeklyReview.getLatest`) with four
 * possible states:
 *
 *   - `null`           — no row yet. Empty card with copy explaining
 *                        the cron schedule.
 *   - `pending`        — row written but generator hasn't fired
 *                        (cron interleave). Spinner-style loading hint.
 *   - `insufficient`   — fewer than 3 days of data in the window.
 *                        Empty-state copy nudges the user to keep
 *                        capturing snapshots.
 *   - `failed`         — generation errored (Anthropic key missing,
 *                        rate limit, etc.). Shows the error + a
 *                        "Retry" button that calls `regenerate`.
 *   - `ready`          — headline + content. Lightweight markdown
 *                        rendering (line splits, bullet bullets) so
 *                        we don't pull in a full markdown parser
 *                        just for this card.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCcw, Sparkles } from "lucide-react";

interface WeeklyReviewMetricsShape {
  daysWithData?: number;
  todoistCompletedTotal?: number | null;
  whoopRecoveryAvg?: number | null;
  whoopRecoverySamples?: number;
  sleepHoursAvg?: number | null;
  sleepSamples?: number;
  supplementsLogged?: number;
  habitsCompleted?: number;
  whoopHrvAvg?: number | null;
  whoopStrainAvg?: number | null;
  whoopRestingHrAvg?: number | null;
  samsungEnergyAvg?: number | null;
  reflectionEnergyAvg?: number | null;
  habitConsistencyPct?: number | null;
  distinctSupplements?: number;
}

function parseMetrics(json: string | null): WeeklyReviewMetricsShape {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as WeeklyReviewMetricsShape)
      : {};
  } catch {
    return {};
  }
}

/** Render inline `**bold**` (and `*italic*`) markdown to React nodes.
 *  The Opus weekly review bolds the key metric in each bullet, so we
 *  need at least this much inline formatting. */
function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Split on **bold** and *italic* spans, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  parts.forEach((part, i) => {
    if (!part) return;
    if (part.startsWith("**") && part.endsWith("**")) {
      out.push(
        <strong key={i} className="font-semibold">
          {part.slice(2, -2)}
        </strong>
      );
    } else if (part.startsWith("*") && part.endsWith("*")) {
      out.push(
        <em key={i} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    } else {
      out.push(part);
    }
  });
  return out;
}

/** Lightweight markdown rendering for the weekly review: `##`/`###`
 *  section headings, `-`/`*` bullets, `---` rules, paragraphs, and
 *  inline bold/italic. Kept small so we don't pull in a full parser. */
function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split(/\r?\n/);
  const out: React.ReactNode[] = [];
  let bulletBuf: string[] = [];
  function flushBullets() {
    if (bulletBuf.length === 0) return;
    out.push(
      <ul key={`ul-${out.length}`} className="list-disc pl-5 space-y-1 text-sm">
        {bulletBuf.map((b, i) => (
          <li key={i}>{renderInline(b)}</li>
        ))}
      </ul>
    );
    bulletBuf = [];
  }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      continue;
    }
    if (/^#{1,6}\s+/.test(trimmed)) {
      flushBullets();
      const text = trimmed.replace(/^#{1,6}\s+/, "");
      out.push(
        <p
          key={`h-${out.length}`}
          className="text-sm font-semibold mt-2 first:mt-0"
        >
          {renderInline(text)}
        </p>
      );
    } else if (/^([-*_])\1{2,}$/.test(trimmed)) {
      flushBullets();
      out.push(<hr key={`hr-${out.length}`} className="my-2 border-muted" />);
    } else if (/^[-*]\s+/.test(trimmed)) {
      bulletBuf.push(trimmed.replace(/^[-*]\s+/, ""));
    } else {
      flushBullets();
      out.push(
        <p key={`p-${out.length}`} className="text-sm">
          {renderInline(trimmed)}
        </p>
      );
    }
  }
  flushBullets();
  return out;
}

export function WeeklyReviewCard() {
  const utils = trpc.useUtils();
  const latestQuery = trpc.weeklyReview.getLatest.useQuery();
  const regenerate = trpc.weeklyReview.regenerate.useMutation({
    onSuccess: res => {
      void utils.weeklyReview.getLatest.invalidate();
      toast.success(
        res.status === "ready"
          ? "Weekly review regenerated"
          : `Regenerate finished with status: ${res.status}`
      );
    },
    onError: err => toast.error(err.message),
  });

  const review = latestQuery.data;
  const metrics = useMemo(
    () => parseMetrics(review?.metricsJson ?? null),
    [review?.metricsJson]
  );

  function handleRetry() {
    if (!review?.weekKey) return;
    regenerate.mutate({ weekKey: review.weekKey });
  }

  return (
    <Card className="mx-auto mt-6 max-w-3xl">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              Weekly review
              {review?.weekKey && (
                <Badge variant="outline" className="text-xs font-mono">
                  {review.weekKey}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {review?.weekStartDateKey && review?.weekEndDateKey ? (
                <>
                  {review.weekStartDateKey} → {review.weekEndDateKey}
                </>
              ) : (
                "Auto-generated each Monday from your daily snapshots."
              )}
            </CardDescription>
          </div>
          {review &&
            (review.status === "failed" || review.status === "ready") && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleRetry}
                disabled={regenerate.isPending}
              >
                {regenerate.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                ) : (
                  <RefreshCcw className="h-3.5 w-3.5 mr-1" />
                )}
                {review.status === "failed" ? "Retry" : "Regenerate"}
              </Button>
            )}
        </div>
      </CardHeader>
      <CardContent>
        {latestQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !review ? (
          <p className="text-sm text-muted-foreground">
            No review yet. The cron generates one each Monday from the prior
            week's daily snapshots.
          </p>
        ) : review.status === "pending" ? (
          <p className="text-sm text-muted-foreground">
            Generation in progress…
          </p>
        ) : review.status === "insufficient" ? (
          <p className="text-sm text-muted-foreground">
            Only {review.daysWithData} day(s) of data in this week — need at
            least 3 to write a meaningful review. Keep capturing daily
            snapshots.
          </p>
        ) : review.status === "failed" ? (
          <div className="space-y-2">
            <p className="text-sm text-destructive">
              {review.errorMessage ?? "Generation failed."}
            </p>
            <p className="text-xs text-muted-foreground">
              Click Retry to regenerate this week. Anthropic API key issues fix
              in Settings → Integrations.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {review.headline && (
              <p className="text-base font-semibold leading-tight">
                {review.headline}
              </p>
            )}
            {review.contentMarkdown && (
              <div className="space-y-2">
                {renderMarkdown(review.contentMarkdown)}
              </div>
            )}
            <div className="pt-2 border-t flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              {metrics.daysWithData !== undefined && (
                <span>{metrics.daysWithData} days</span>
              )}
              {metrics.whoopRecoveryAvg !== null &&
                metrics.whoopRecoveryAvg !== undefined && (
                  <span>Recovery {Math.round(metrics.whoopRecoveryAvg)}</span>
                )}
              {metrics.sleepHoursAvg !== null &&
                metrics.sleepHoursAvg !== undefined && (
                  <span>Sleep {metrics.sleepHoursAvg.toFixed(1)}h</span>
                )}
              {metrics.whoopHrvAvg !== null &&
                metrics.whoopHrvAvg !== undefined && (
                  <span>HRV {Math.round(metrics.whoopHrvAvg)}</span>
                )}
              {metrics.whoopStrainAvg !== null &&
                metrics.whoopStrainAvg !== undefined && (
                  <span>Strain {metrics.whoopStrainAvg.toFixed(1)}</span>
                )}
              {metrics.samsungEnergyAvg !== null &&
                metrics.samsungEnergyAvg !== undefined && (
                  <span>Energy {metrics.samsungEnergyAvg.toFixed(1)}</span>
                )}
              {metrics.habitConsistencyPct !== null &&
                metrics.habitConsistencyPct !== undefined && (
                  <span>Habits {Math.round(metrics.habitConsistencyPct)}%</span>
                )}
              {metrics.todoistCompletedTotal !== null &&
                metrics.todoistCompletedTotal !== undefined && (
                  <span>{metrics.todoistCompletedTotal} Todoist completed</span>
                )}
              {review.model && (
                <span className="font-mono">model: {review.model}</span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
