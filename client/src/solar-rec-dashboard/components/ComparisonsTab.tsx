/**
 * Comparisons tab.
 *
 * Extracted from SolarRecDashboard.tsx (2026-04-14). Phase 7 of the
 * god-component decomposition. Owns:
 *   - 2 useMemos (comparisonInstallers, comparisonPlatforms)
 *   - 2 charts + 2 tables comparing reporting + delivery rates by
 *     installer and by monitoring platform
 */

import { memo, useMemo } from "react";
import { AskAiPanel } from "@/components/AskAiPanel";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
  formatNumber,
  toPercentValue,
} from "@/solar-rec-dashboard/lib/helpers";
import type { SystemRecord } from "@/solar-rec-dashboard/state/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ComparisonsTabProps {
  systems: SystemRecord[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default memo(function ComparisonsTab(props: ComparisonsTabProps) {
  const { systems } = props;

  const comparisonInstallers = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        total: number;
        reporting: number;
        totalValue: number;
        deliveredValue: number;
      }
    >();

    systems.forEach((sys) => {
      const name = sys.installerName || "Unknown";
      const g = groups.get(name) ?? {
        name,
        total: 0,
        reporting: 0,
        totalValue: 0,
        deliveredValue: 0,
      };
      g.total += 1;
      if (sys.isReporting) g.reporting += 1;
      g.totalValue += sys.contractedValue ?? 0;
      g.deliveredValue += sys.deliveredValue ?? 0;
      groups.set(name, g);
    });

    return Array.from(groups.values())
      .map((g) => ({
        ...g,
        reportingPercent: toPercentValue(g.reporting, g.total),
        deliveryPercent: toPercentValue(g.deliveredValue, g.totalValue),
      }))
      .sort((a, b) => b.total - a.total);
  }, [systems]);

  const comparisonPlatforms = useMemo(() => {
    const groups = new Map<
      string,
      {
        name: string;
        total: number;
        reporting: number;
        offline: number;
        offlineValue: number;
      }
    >();

    systems.forEach((sys) => {
      const name = sys.monitoringPlatform || "Unknown";
      const g = groups.get(name) ?? {
        name,
        total: 0,
        reporting: 0,
        offline: 0,
        offlineValue: 0,
      };
      g.total += 1;
      if (sys.isReporting) {
        g.reporting += 1;
      } else {
        g.offline += 1;
        g.offlineValue += sys.contractedValue ?? 0;
      }
      groups.set(name, g);
    });

    return Array.from(groups.values())
      .map((g) => ({
        ...g,
        reportingPercent: toPercentValue(g.reporting, g.total),
        offlinePercent: toPercentValue(g.offline, g.total),
      }))
      .sort((a, b) => b.total - a.total);
  }, [systems]);

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Installer Performance</CardTitle>
              <CardDescription>
                Systems grouped by installer with reporting rate and delivery metrics.
              </CardDescription>
            </div>
            {comparisonInstallers.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "installer",
                      "total_systems",
                      "reporting",
                      "reporting_percent",
                      "total_value",
                      "delivered_value",
                      "delivery_percent",
                    ],
                    comparisonInstallers.map((i) => ({
                      installer: i.name,
                      total_systems: i.total,
                      reporting: i.reporting,
                      reporting_percent:
                        i.reportingPercent !== null ? i.reportingPercent.toFixed(1) : "",
                      total_value: i.totalValue,
                      delivered_value: i.deliveredValue,
                      delivery_percent:
                        i.deliveryPercent !== null ? i.deliveryPercent.toFixed(1) : "",
                    })),
                  );
                  triggerCsvDownload(
                    `installer-performance-${timestampForCsvFileName()}.csv`,
                    csv,
                  );
                }}
              >
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {comparisonInstallers.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              No system data available.
            </p>
          ) : (
            <>
              <div className="h-64 rounded-md border border-slate-200 bg-white p-2 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={comparisonInstallers.slice(0, 15)}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                    <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                    <Bar dataKey="reportingPercent" fill="#16a34a" name="Reporting %" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Installer</TableHead>
                    <TableHead className="text-right">Systems</TableHead>
                    <TableHead className="text-right">Reporting</TableHead>
                    <TableHead className="text-right">Reporting %</TableHead>
                    <TableHead className="text-right">Contract Value</TableHead>
                    <TableHead className="text-right">Delivery %</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparisonInstallers.map((i) => (
                    <TableRow key={i.name}>
                      <TableCell className="font-medium">{i.name}</TableCell>
                      <TableCell className="text-right">{i.total}</TableCell>
                      <TableCell className="text-right">{i.reporting}</TableCell>
                      <TableCell className="text-right">
                        {i.reportingPercent !== null
                          ? `${i.reportingPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(i.totalValue)}
                      </TableCell>
                      <TableCell className="text-right">
                        {i.deliveryPercent !== null
                          ? `${i.deliveryPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Monitoring Platform Reliability</CardTitle>
              <CardDescription>
                Reporting rate and offline metrics by monitoring platform.
              </CardDescription>
            </div>
            {comparisonPlatforms.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  const csv = buildCsv(
                    [
                      "platform",
                      "total_systems",
                      "reporting",
                      "reporting_percent",
                      "offline",
                      "offline_value",
                    ],
                    comparisonPlatforms.map((p) => ({
                      platform: p.name,
                      total_systems: p.total,
                      reporting: p.reporting,
                      reporting_percent:
                        p.reportingPercent !== null ? p.reportingPercent.toFixed(1) : "",
                      offline: p.offline,
                      offline_value: p.offlineValue,
                    })),
                  );
                  triggerCsvDownload(
                    `platform-reliability-${timestampForCsvFileName()}.csv`,
                    csv,
                  );
                }}
              >
                Export CSV
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {comparisonPlatforms.length === 0 ? (
            <p className="text-sm text-slate-500 py-4 text-center">
              No system data available.
            </p>
          ) : (
            <>
              <div className="h-64 rounded-md border border-slate-200 bg-white p-2 mb-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={comparisonPlatforms.slice(0, 15)}
                    margin={{ top: 8, right: 12, left: 4, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="name"
                      tick={{ fontSize: 10 }}
                      angle={-35}
                      textAnchor="end"
                      height={60}
                    />
                    <YAxis tick={{ fontSize: 12 }} domain={[0, 100]} unit="%" />
                    <Tooltip formatter={(v: number) => `${v.toFixed(1)}%`} />
                    <Bar dataKey="reportingPercent" fill="#0ea5e9" name="Reporting %" />
                    <Bar dataKey="offlinePercent" fill="#ef4444" name="Offline %" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Platform</TableHead>
                    <TableHead className="text-right">Systems</TableHead>
                    <TableHead className="text-right">Reporting</TableHead>
                    <TableHead className="text-right">Reporting %</TableHead>
                    <TableHead className="text-right">Offline</TableHead>
                    <TableHead className="text-right">Offline Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {comparisonPlatforms.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="text-right">{p.total}</TableCell>
                      <TableCell className="text-right">{p.reporting}</TableCell>
                      <TableCell className="text-right">
                        {p.reportingPercent !== null
                          ? `${p.reportingPercent.toFixed(1)}%`
                          : "N/A"}
                      </TableCell>
                      <TableCell className="text-right">{p.offline}</TableCell>
                      <TableCell className="text-right">
                        ${formatNumber(p.offlineValue)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <AskAiPanel
        moduleKey="solar-rec-comparisons"
        title="Ask AI about installer + platform comparisons"
        contextGetter={() => ({
          totals: { systems: systems.length },
          installers: comparisonInstallers.slice(0, 30),
          platforms: comparisonPlatforms.slice(0, 30),
        })}
      />
    </div>
  );
});
