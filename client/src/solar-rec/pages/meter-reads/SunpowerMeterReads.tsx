/**
 * Task 5.4 vendor 15/16 — SunPower (DB-backed mobile readings).
 *
 * Different shape from every credential-backed vendor: there is no
 * upstream API. Customer readings are submitted by the SunPower Reader
 * Expo app to `solarReadings.submit` on the main router (HMAC-signed,
 * hardcoded URL in the mobile app — must NOT move) and stored in
 * `productionReadings`. This page is the team-side dashboard view.
 *
 * Server side: `solarRecTrpc.sunpower.summary` and
 * `solarRecTrpc.sunpower.list`, both gated on `meter-reads` read.
 */

import { useState } from "react";
import { solarRecTrpc as trpc } from "../../solarRecTrpc";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sun,
  Zap,
  Users,
  Clock,
  Search,
  RefreshCw,
  Download,
} from "lucide-react";

function formatDate(dateStr: string | Date) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function SunpowerMeterReads() {
  const [emailFilter, setEmailFilter] = useState("");
  const [nonIdFilter, setNonIdFilter] = useState("");

  const { data: summary, isLoading: summaryLoading } =
    trpc.sunpower.summary.useQuery(undefined, { retry: false });

  const {
    data: readings,
    isLoading: listLoading,
    refetch,
  } = trpc.sunpower.list.useQuery(
    {
      limit: 200,
      email: emailFilter || undefined,
      nonId: nonIdFilter || undefined,
    },
    { placeholderData: (prev) => prev, retry: false }
  );

  function handleExportCsv() {
    if (!readings || readings.length === 0) return;
    const header =
      "Email,NONID,Lifetime kWh,Meter Serial,Firmware,PVS Serial,Read At\n";
    const rows = readings.map((r) =>
      [
        r.customerEmail,
        r.nonId || "",
        r.lifetimeKwh,
        r.meterSerial || "",
        r.firmwareVersion || "",
        r.pvsSerial5 || "",
        r.readAt,
      ].join(",")
    );
    const csv = header + rows.join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sunpower-readings-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="container mx-auto space-y-6 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SunPower Readings</h1>
          <p className="text-sm text-muted-foreground">
            Production readings submitted from the SunPower Reader mobile app
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={!readings || readings.length === 0}
          >
            <Download className="mr-1.5 size-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="rounded-lg bg-blue-50 p-3 dark:bg-blue-950">
              <Zap className="size-5 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Total Readings</p>
              {summaryLoading ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <p className="text-2xl font-bold tabular-nums">
                  {summary?.totalReadings ?? 0}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="rounded-lg bg-green-50 p-3 dark:bg-green-950">
              <Users className="size-5 text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Unique Customers</p>
              {summaryLoading ? (
                <Skeleton className="h-7 w-16" />
              ) : (
                <p className="text-2xl font-bold tabular-nums">
                  {summary?.uniqueCustomers ?? 0}
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex items-center gap-4 pt-6">
            <div className="rounded-lg bg-amber-50 p-3 dark:bg-amber-950">
              <Clock className="size-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Latest Reading</p>
              {summaryLoading ? (
                <Skeleton className="h-7 w-32" />
              ) : summary?.latestReadings?.[0] ? (
                <p className="text-sm font-medium">
                  {formatDate(summary.latestReadings[0].readAt)}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">None yet</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="size-4" />
            Filter Readings
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Input
              placeholder="Filter by email..."
              value={emailFilter}
              onChange={(e) => setEmailFilter(e.target.value)}
              className="sm:max-w-xs"
            />
            <Input
              placeholder="Filter by NONID..."
              value={nonIdFilter}
              onChange={(e) => setNonIdFilter(e.target.value)}
              className="sm:max-w-xs"
            />
            {(emailFilter || nonIdFilter) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEmailFilter("");
                  setNonIdFilter("");
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Readings Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sun className="size-4" />
            All Readings
            {readings && (
              <Badge variant="secondary" className="ml-2">
                {readings.length}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {listLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : !readings || readings.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Sun className="size-10 text-muted-foreground/30" />
              <p className="text-sm text-muted-foreground">
                {emailFilter || nonIdFilter
                  ? "No readings match your filters."
                  : "No readings submitted yet. Waiting for customers to use the SunPower Reader app."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground uppercase tracking-wider">
                    <th className="pb-2 pr-4 font-medium">Customer</th>
                    <th className="pb-2 pr-4 font-medium">NONID</th>
                    <th className="pb-2 pr-4 font-medium text-right">
                      Lifetime kWh
                    </th>
                    <th className="pb-2 pr-4 font-medium">Meter</th>
                    <th className="pb-2 font-medium">Read At</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {readings.map((r) => (
                    <tr key={r.id} className="hover:bg-muted/30">
                      <td className="py-2.5 pr-4">
                        <span className="font-medium">{r.customerEmail}</span>
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground">
                        {r.nonId || "—"}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums font-semibold">
                        {Number(r.lifetimeKwh).toLocaleString(undefined, {
                          maximumFractionDigits: 1,
                        })}
                      </td>
                      <td className="py-2.5 pr-4 text-muted-foreground text-xs">
                        {r.meterSerial || "—"}
                      </td>
                      <td className="py-2.5 text-muted-foreground text-xs">
                        {formatDate(r.readAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
