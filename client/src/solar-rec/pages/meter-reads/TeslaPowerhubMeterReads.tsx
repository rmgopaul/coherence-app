/**
 * Task 5.4 vendor 14/16 — Tesla Powerhub on solar-rec.
 *
 * Tesla Powerhub uses a single bulk endpoint that returns daily /
 * weekly / monthly / yearly / lifetime kWh for every site in a group.
 * Both `listSites` and `getSiteSnapshot` invoke that same endpoint
 * (which is server-side cached for 5 minutes per group). The single-
 * site snapshot picks the matching site from the bulk result.
 *
 * Team credential row stores `clientSecret` in the row's accessToken
 * column and `{clientId, groupId, tokenUrl, apiBaseUrl, portalBaseUrl}`
 * in the metadata JSON. Lifecycle is admin-managed in Settings.
 */

import { useState } from "react";
import { PersistConfirmation, readMeterLifetimeKwh, readMeterName, readMeterStatus } from "../../components/PersistConfirmation";
import { solarRecTrpc as trpc } from "../../solarRecTrpc";
import { useSolarRecPermission } from "../../hooks/useSolarRecPermission";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export default function TeslaPowerhubMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.teslaPowerhub.getStatus.useQuery(undefined, {
    retry: false,
  });
  const listSitesQuery = trpc.teslaPowerhub.listSites.useQuery(undefined, {
    enabled: statusQuery.data?.connected === true,
    retry: false,
  });
  const snapshotMutation = trpc.teslaPowerhub.getSiteSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [siteId, setSiteId] = useState("");

  const runSnapshot = () => {
    const trimmed = siteId.trim();
    if (!trimmed) {
      toast.error("Enter a site ID");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({ siteId: trimmed });
  };

  const [showPersist, setShowPersist] = useState(false);
  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Tesla Powerhub</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s Tesla Powerhub credential.
          The vendor returns daily / weekly / monthly / yearly / lifetime
          kWh for every site in a group from a single bulk call. Manage
          clientId / clientSecret / groupId in Solar REC Settings →
          Credentials.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Connection</span>
            {statusQuery.data?.connected ? (
              <Badge variant="default">Connected</Badge>
            ) : (
              <Badge variant="outline">Not connected</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {statusQuery.data?.connected ? (
              <>
                {statusQuery.data.connectionCount} team credential
                {statusQuery.data.connectionCount === 1 ? "" : "s"} registered.
                {statusQuery.data.groupId && (
                  <>
                    {" "}
                    Group ID:{" "}
                    <code className="font-mono text-xs">
                      {statusQuery.data.groupId}
                    </code>
                  </>
                )}
              </>
            ) : (
              "Ask an admin to register Tesla Powerhub OAuth credentials + group ID in Settings → Credentials."
            )}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>
                Discover sites in the connected Powerhub group. The bulk
                endpoint is cached for 5 minutes per group.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => listSitesQuery.refetch()}
              disabled={!statusQuery.data?.connected || listSitesQuery.isFetching}
            >
              {listSitesQuery.isFetching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
              )}
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!statusQuery.data?.connected ? (
            <p className="text-sm text-muted-foreground">
              Connect a credential first.
            </p>
          ) : listSitesQuery.isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : listSitesQuery.error ? (
            <p className="text-sm text-destructive">
              {listSitesQuery.error.message}
            </p>
          ) : (listSitesQuery.data?.sites ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sites returned by Powerhub.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Site ID</TableHead>
                    <TableHead>Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listSitesQuery.data?.sites.map((s) => (
                    <TableRow key={s.siteId}>
                      <TableCell className="font-mono text-xs">
                        {s.siteId}
                      </TableCell>
                      <TableCell>{s.siteName ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Site Snapshot</CardTitle>
          <CardDescription>
            Pull the daily / weekly / monthly / yearly / lifetime kWh for a
            specific site. Backed by the same bulk call as the site list (so
            the first request after the cache expires takes a minute or two).
            {!canEdit && (
              <span className="ml-1 text-amber-700">
                You have read-only access; running a snapshot requires{" "}
                <code>edit</code> on <code>meter-reads</code>.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="tesla-site-id">Site ID</Label>
            <Input
              id="tesla-site-id"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              placeholder="e.g., site-abc-123"
            />
          </div>
          <Button
            onClick={runSnapshot}
            disabled={
              !canEdit ||
              !siteId.trim() ||
              snapshotMutation.isPending ||
              !statusQuery.data?.connected
            }
          >
            {snapshotMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run snapshot
          </Button>
          {result && (
            <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
              <p>
                <span className="font-medium">Status:</span>{" "}
                <Badge
                  variant={
                    result.status === "Found"
                      ? "default"
                      : result.status === "Not Found"
                        ? "outline"
                        : "destructive"
                  }
                >
                  {result.status}
                </Badge>
              </p>
              {result.siteName && (
                <p>
                  <span className="font-medium">Name:</span> {result.siteName}
                </p>
              )}
              {result.lifetimeKwh !== null &&
                result.lifetimeKwh !== undefined && (
                  <p>
                    <span className="font-medium">Lifetime kWh:</span>{" "}
                    {result.lifetimeKwh.toLocaleString()}
                  </p>
                )}
              {result.yearlyKwh !== null &&
                result.yearlyKwh !== undefined && (
                  <p>
                    <span className="font-medium">Year:</span>{" "}
                    {result.yearlyKwh.toLocaleString()} kWh
                  </p>
                )}
              {result.monthlyKwh !== null &&
                result.monthlyKwh !== undefined && (
                  <p>
                    <span className="font-medium">Month:</span>{" "}
                    {result.monthlyKwh.toLocaleString()} kWh
                  </p>
                )}
              {result.weeklyKwh !== null &&
                result.weeklyKwh !== undefined && (
                  <p>
                    <span className="font-medium">Week:</span>{" "}
                    {result.weeklyKwh.toLocaleString()} kWh
                  </p>
                )}
              {result.dailyKwh !== null && result.dailyKwh !== undefined && (
                <p>
                  <span className="font-medium">Day:</span>{" "}
                  {result.dailyKwh.toLocaleString()} kWh
                </p>
              )}
              {result.dataSource && (
                <p className="text-xs text-muted-foreground">
                  Data source: <code>{result.dataSource}</code>
                </p>
              )}
              {result.error && (
                <p className="text-destructive">
                  <span className="font-medium">Error:</span> {result.error}
                </p>
              )}
            </div>
          )}
        
          {result && showPersist && (
            <PersistConfirmation
              providerKey="tesla-powerhub"
              providerLabel="Tesla Powerhub"
              rows={
                readMeterStatus(result) === "Found" && readMeterLifetimeKwh(result) != null
                  ? [{
                monitoring: "Tesla Powerhub",
                monitoring_system_id: String(siteId),
                monitoring_system_name: readMeterName(result) ?? String(siteId),
                lifetime_meter_read_wh: String(Math.round((readMeterLifetimeKwh(result) ?? 0) * 1000)),
                read_date: new Date().toISOString().slice(0, 10),
                status: "",
                alert_severity: ""
                    }]
                  : []
              }
              onDiscard={() => setShowPersist(false)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
