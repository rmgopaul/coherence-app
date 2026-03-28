import { trpc } from "@/lib/trpc";
import { DashboardWidget } from "./DashboardWidget";
import { Sun, User, Zap, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function SolarReadingsCard() {
  const { data, isLoading, error, refetch } = trpc.solarReadings.summary.useQuery(
    undefined,
    { refetchInterval: 60_000 }
  );

  const hasData = data && data.totalReadings > 0;

  return (
    <DashboardWidget
      title="SunPower Readings"
      icon={Sun}
      category="energy"
      isLoading={isLoading}
      error={error?.message ?? null}
      onRetry={() => refetch()}
      lastUpdated={hasData ? new Date() : null}
      collapsible
      storageKey="solar-readings"
    >
      {!hasData ? (
        <div className="flex flex-col items-center gap-2 py-4 text-center">
          <Sun className="size-8 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No readings submitted yet. Waiting for customers to use the
            SunPower Reader app.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Summary stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Zap className="size-3" />
                Total Readings
              </div>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {data.totalReadings}
              </p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <User className="size-3" />
                Customers
              </div>
              <p className="mt-1 text-2xl font-bold tabular-nums">
                {data.uniqueCustomers}
              </p>
            </div>
          </div>

          {/* Recent readings */}
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Recent Submissions
            </p>
            <div className="space-y-2">
              {data.latestReadings.slice(0, 5).map((r: any) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">
                      {r.nonId || r.customerEmail}
                    </p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="size-3" />
                      {formatRelativeDate(r.readAt)}
                    </div>
                  </div>
                  <Badge variant="secondary" className="ml-2 shrink-0 tabular-nums">
                    {Number(r.lifetimeKwh).toLocaleString(undefined, {
                      maximumFractionDigits: 1,
                    })}{" "}
                    kWh
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </DashboardWidget>
  );
}
