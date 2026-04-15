/**
 * Alerts tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Owns:
 *   - 2 useMemos (alerts, alertSummary)
 *   - The alert detection logic (offline > 90d, delivery pace below 80%,
 *     zero delivered with active contract, stale datasets)
 *
 * Receives `systems` and the raw datasets bag from the parent. Computes
 * `trendDeliveryPace` internally via the shared `buildTrendDeliveryPace`
 * helper — same call the TrendsTab makes.
 *
 * The parent's `alertSummary.total > 0 ? ` (${alertSummary.total})` : ""`
 * badge in the TabsList no longer fires when off this tab (the alerts
 * memo previously returned [] when off-tab too, so this is no behavior
 * change — the badge was only ever populated while the user was on the
 * Alerts tab).
 */

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildCsv,
  timestampForCsvFileName,
  triggerCsvDownload,
} from "@/solar-rec-dashboard/lib/csvIo";
import {
  buildTrendDeliveryPace,
  formatNumber,
} from "@/solar-rec-dashboard/lib/helpers";
import type {
  AlertItem,
  CsvDataset,
  DatasetKey,
  SystemRecord,
} from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AlertsTabProps {
  systems: SystemRecord[];
  datasets: Partial<Record<DatasetKey, CsvDataset>>;
  /** Schedule B base CSV — drives the delivery pace alert. */
  deliveryScheduleBase: CsvDataset | null;
  /** GATS transfer lookup, for the delivery pace alert. */
  transferDeliveryLookup: Map<string, Map<number, number>>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const OFFLINE_DAYS_THRESHOLD = 90;
const PACE_THRESHOLD = 0.8;
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 } as const;

export default function AlertsTab(props: AlertsTabProps) {
  const { systems, datasets, deliveryScheduleBase, transferDeliveryLookup } = props;

  // Local trend delivery pace — same calculation TrendsTab makes, called
  // here independently because the alert detection needs it.
  const trendDeliveryPace = useMemo(
    () =>
      buildTrendDeliveryPace(
        deliveryScheduleBase?.rows ?? [],
        transferDeliveryLookup,
      ),
    [deliveryScheduleBase, transferDeliveryLookup],
  );

  const alerts = useMemo<AlertItem[]>(() => {
    const items: AlertItem[] = [];
    const now = new Date();

    // Offline > 90 days
    systems.forEach((sys) => {
      if (sys.isReporting) return;
      if (!sys.latestReportingDate) {
        items.push({
          id: `offline-never-${sys.key}`,
          severity: "critical",
          type: "Offline",
          system: sys.systemName,
          message: "Never reported any generation data",
          action: "Check monitoring connection",
        });
        return;
      }
      const daysOffline = Math.floor(
        (now.getTime() - sys.latestReportingDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysOffline > OFFLINE_DAYS_THRESHOLD) {
        items.push({
          id: `offline-${sys.key}`,
          severity: daysOffline > 180 ? "critical" : "warning",
          type: "Offline",
          system: sys.systemName,
          message: `Offline for ${daysOffline} days (last: ${sys.latestReportingDate.toLocaleDateString()})`,
          action: "Verify monitoring access",
        });
      }
    });

    // Delivery pace below 80%
    trendDeliveryPace.forEach((p) => {
      if (p.expectedPace > 10 && p.actualPace / p.expectedPace < PACE_THRESHOLD) {
        items.push({
          id: `pace-${p.contract}`,
          severity: p.actualPace / p.expectedPace < 0.5 ? "critical" : "warning",
          type: "Delivery Pace",
          system: p.contract,
          message: `Delivery at ${p.actualPace.toFixed(0)}% vs expected ${p.expectedPace.toFixed(0)}%`,
          action: "Review contract delivery",
        });
      }
    });

    // Zero delivered with active contract
    systems.forEach((sys) => {
      if (
        (sys.contractedRecs ?? 0) > 0 &&
        (sys.deliveredRecs ?? 0) === 0 &&
        !sys.isTerminated
      ) {
        items.push({
          id: `zero-delivered-${sys.key}`,
          severity: "warning",
          type: "Zero Delivery",
          system: sys.systemName,
          message: `${formatNumber(sys.contractedRecs)} RECs contracted but 0 delivered`,
          action: "Check generation and REC issuance",
        });
      }
    });

    // Stale datasets
    const DATASET_KEYS = Object.keys(datasets) as Array<keyof typeof datasets>;
    DATASET_KEYS.forEach((key) => {
      const ds = datasets[key];
      if (!ds || !ds.uploadedAt) return;
      const ageDays = Math.floor(
        (now.getTime() - ds.uploadedAt.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (ageDays > 14) {
        items.push({
          id: `stale-${key}`,
          severity: ageDays > 30 ? "warning" : "info",
          type: "Stale Data",
          system: String(key),
          message: `Last updated ${ageDays} days ago`,
          action: "Upload fresh data",
        });
      }
    });

    return items.sort(
      (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
    );
  }, [systems, trendDeliveryPace, datasets]);

  const alertSummary = useMemo(
    () => ({
      critical: alerts.filter((a) => a.severity === "critical").length,
      warning: alerts.filter((a) => a.severity === "warning").length,
      info: alerts.filter((a) => a.severity === "info").length,
      total: alerts.length,
    }),
    [alerts],
  );

  return (
    <div className="space-y-4 mt-4">
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-rose-200 bg-rose-50/50">
          <CardHeader>
            <CardDescription>Critical</CardDescription>
            <CardTitle className="text-2xl text-rose-800">{alertSummary.critical}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-amber-200 bg-amber-50/50">
          <CardHeader>
            <CardDescription>Warning</CardDescription>
            <CardTitle className="text-2xl text-amber-800">{alertSummary.warning}</CardTitle>
          </CardHeader>
        </Card>
        <Card className="border-sky-200 bg-sky-50/50">
          <CardHeader>
            <CardDescription>Info</CardDescription>
            <CardTitle className="text-2xl text-sky-800">{alertSummary.info}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">All Alerts</CardTitle>
              <CardDescription>
                {alerts.length} alerts detected across your portfolio.
              </CardDescription>
            </div>
            {alerts.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    ["severity", "type", "system", "message", "action"],
                    alerts.map((a) => ({
                      severity: a.severity,
                      type: a.type,
                      system: a.system,
                      message: a.message,
                      action: a.action,
                    })),
                  );
                  triggerCsvDownload(`alerts-${timestampForCsvFileName()}.csv`, csv);
                }}
              >
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {alerts.length === 0 ? (
            <p className="text-sm text-emerald-600 py-4 text-center">
              No alerts. Your portfolio looks healthy.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Severity</TableHead>
                  <TableHead className="w-32">Type</TableHead>
                  <TableHead>System / Contract</TableHead>
                  <TableHead>Details</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {alerts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Badge
                        variant={
                          a.severity === "critical"
                            ? "destructive"
                            : a.severity === "warning"
                              ? "secondary"
                              : "outline"
                        }
                      >
                        {a.severity}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{a.type}</TableCell>
                    <TableCell className="font-medium text-sm">{a.system}</TableCell>
                    <TableCell className="text-sm text-slate-600">{a.message}</TableCell>
                    <TableCell className="text-sm text-slate-500">{a.action}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
