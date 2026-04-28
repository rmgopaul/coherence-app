/**
 * Task 5.4 vendor 12/16 — Enphase V4 (OAuth refresh) on solar-rec.
 *
 * Team credential row stores `{apiKey, clientId, clientSecret, baseUrl}`
 * in metadata + accessToken/refreshToken/expiresAt columns. The server
 * refreshes the access token automatically when it's within 5 min of
 * expiry, persisting the new token back to the row so subsequent
 * requests skip the refresh round-trip.
 *
 * Anchor date is required for the snapshot (Enphase needs an explicit
 * window to compute lifetime kWh).
 */

import { useCallback, useState } from "react";
import { MeterReadConnectionProbe } from "../../components/MeterReadConnectionProbe";
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

export default function EnphaseV4MeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.enphaseV4.getStatus.useQuery(undefined, {
    retry: false,
  });
  const listSystemsQuery = trpc.enphaseV4.listSystems.useQuery(undefined, {
    enabled: statusQuery.data?.connected === true,
    retry: false,
  });
  // Phase E (2026-04-28) — Test Connection probe times the
  // listSystemsQuery refetch as a lightweight credential check.
  const probeFn = useCallback(async () => {
    const r = await listSystemsQuery.refetch({ throwOnError: true });
    return r.data?.systems?.length ?? 0;
  }, [listSystemsQuery]);

  const snapshotMutation = trpc.enphaseV4.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [systemId, setSystemId] = useState("");
  const [anchorDate, setAnchorDate] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });

  const runSnapshot = () => {
    const trimmed = systemId.trim();
    if (!trimmed) {
      toast.error("Enter a system ID");
      return;
    }
    if (!anchorDate) {
      toast.error("Anchor date is required for Enphase V4 snapshots");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({
      systemId: trimmed,
      anchorDate,
      systemName: null,
    });
  };

  const [showPersist, setShowPersist] = useState(false);
  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Enphase V4</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s Enphase V4 credential.
          Manage apiKey + clientId + clientSecret + OAuth tokens in Solar
          REC Settings → Credentials.
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
                {statusQuery.data.expiresAt && (
                  <>
                    {" "}
                    Token expires{" "}
                    {new Date(statusQuery.data.expiresAt).toLocaleString()}.
                  </>
                )}
                {!statusQuery.data.hasRefreshToken && (
                  <span className="ml-1 text-amber-700">
                    No refresh token stored — re-connect when the access token
                    expires.
                  </span>
                )}
              </>
            ) : (
              "Ask an admin to register an Enphase V4 connection in Settings → Credentials."
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MeterReadConnectionProbe
            runProbe={probeFn}
            sampleNoun="systems"
            disabled={!statusQuery.data?.connected}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Systems</CardTitle>
              <CardDescription>
                Discover systems on the connected Enphase account.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => listSystemsQuery.refetch()}
              disabled={!statusQuery.data?.connected || listSystemsQuery.isFetching}
            >
              {listSystemsQuery.isFetching ? (
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
          ) : listSystemsQuery.isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : listSystemsQuery.error ? (
            <p className="text-sm text-destructive">
              {listSystemsQuery.error.message}
            </p>
          ) : (listSystemsQuery.data?.systems ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No systems returned by Enphase.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listSystemsQuery.data?.systems.map((s) => (
                    <TableRow key={s.systemId}>
                      <TableCell className="font-mono text-xs">
                        {s.systemId}
                      </TableCell>
                      <TableCell>{s.systemName ?? "—"}</TableCell>
                      <TableCell className="text-xs">
                        {s.status ?? "—"}
                      </TableCell>
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
          <CardTitle className="text-base">Production Snapshot</CardTitle>
          <CardDescription>
            Run a single-system lifetime-kWh snapshot. Enphase V4 requires an
            explicit anchor date.
            {!canEdit && (
              <span className="ml-1 text-amber-700">
                You have read-only access; running a snapshot requires{" "}
                <code>edit</code> on <code>meter-reads</code>.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="enphase-system-id">System ID</Label>
              <Input
                id="enphase-system-id"
                value={systemId}
                onChange={(e) => setSystemId(e.target.value)}
                placeholder="e.g., 123456"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="enphase-anchor-date">Anchor date</Label>
              <Input
                id="enphase-anchor-date"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
              />
            </div>
          </div>
          <Button
            onClick={runSnapshot}
            disabled={
              !canEdit ||
              !systemId.trim() ||
              !anchorDate ||
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
              {result.lifetimeKwh !== null &&
                result.lifetimeKwh !== undefined && (
                  <p>
                    <span className="font-medium">Lifetime kWh:</span>{" "}
                    {result.lifetimeKwh.toLocaleString()}
                  </p>
                )}
              {"errorMessage" in result &&
                typeof (result as { errorMessage?: unknown }).errorMessage ===
                  "string" &&
                (result as { errorMessage: string }).errorMessage && (
                  <p className="text-destructive">
                    <span className="font-medium">Error:</span>{" "}
                    {(result as { errorMessage: string }).errorMessage}
                  </p>
                )}
            </div>
          )}
        
          {result && showPersist && (
            <PersistConfirmation
              providerKey="enphase-v4"
              providerLabel="Enphase V4"
              rows={
                readMeterStatus(result) === "Found" && readMeterLifetimeKwh(result) != null
                  ? [{
                monitoring: "Enphase V4",
                monitoring_system_id: String(systemId),
                monitoring_system_name: readMeterName(result) ?? String(systemId),
                lifetime_meter_read_wh: String(Math.round((readMeterLifetimeKwh(result) ?? 0) * 1000)),
                read_date: anchorDate || new Date().toISOString().slice(0, 10),
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
