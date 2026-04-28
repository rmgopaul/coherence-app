/**
 * Task 5.4 vendor 7/16 — SolarLog (device-local) meter-reads on solar-rec.
 *
 * Team credential stores `{baseUrl|deviceUrl, password}`. Lists the
 * devices on the connected SolarLog appliance and runs single-device
 * lifetime-kWh snapshots. Credential lifecycle in Solar REC Settings →
 * Credentials.
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

export default function SolarLogMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.solarlog.getStatus.useQuery(undefined, {
    retry: false,
  });
  const listDevicesQuery = trpc.solarlog.listDevices.useQuery(undefined, {
    enabled: statusQuery.data?.connected === true,
    retry: false,
  });
  // Phase E (2026-04-28) — Test Connection probe times the
  // listDevicesQuery refetch as a lightweight credential check.
  const probeFn = useCallback(async () => {
    const r = await listDevicesQuery.refetch({ throwOnError: true });
    return r.data?.devices?.length ?? 0;
  }, [listDevicesQuery]);

  const snapshotMutation = trpc.solarlog.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [deviceId, setDeviceId] = useState("");
  const [anchorDate, setAnchorDate] = useState("");

  const runSnapshot = () => {
    const trimmed = deviceId.trim();
    if (!trimmed) {
      toast.error("Enter a device ID (or 'solar-log-1' for the default)");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({
      deviceId: trimmed,
      anchorDate: anchorDate || undefined,
    });
  };

  const [showPersist, setShowPersist] = useState(false);
  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">SolarLog</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s SolarLog appliance. Manage
          deviceUrl + password in Solar REC Settings → Credentials.
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
            {statusQuery.data?.connected
              ? `${statusQuery.data.connectionCount} team credential${
                  statusQuery.data.connectionCount === 1 ? "" : "s"
                } registered.`
              : "Ask an admin to register a SolarLog deviceUrl in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MeterReadConnectionProbe
            runProbe={probeFn}
            sampleNoun="devices"
            disabled={!statusQuery.data?.connected}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Devices</CardTitle>
              <CardDescription>
                Discover devices on the connected SolarLog appliance.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => listDevicesQuery.refetch()}
              disabled={!statusQuery.data?.connected || listDevicesQuery.isFetching}
            >
              {listDevicesQuery.isFetching ? (
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
          ) : listDevicesQuery.isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : listDevicesQuery.error ? (
            <p className="text-sm text-destructive">
              {listDevicesQuery.error.message}
            </p>
          ) : (listDevicesQuery.data?.devices ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No devices returned by the SolarLog appliance.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Device ID</TableHead>
                    <TableHead>Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listDevicesQuery.data?.devices.map((d) => (
                    <TableRow key={d.deviceId}>
                      <TableCell className="font-mono text-xs">
                        {d.deviceId}
                      </TableCell>
                      <TableCell>{d.name ?? "—"}</TableCell>
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
            Run a single-device lifetime-kWh snapshot for a given anchor date.
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
              <Label htmlFor="solarlog-device-id">Device ID</Label>
              <Input
                id="solarlog-device-id"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                placeholder="e.g., solar-log-1"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="solarlog-anchor-date">
                Anchor date (optional)
              </Label>
              <Input
                id="solarlog-anchor-date"
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
              !deviceId.trim() ||
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
              {result.name && (
                <p>
                  <span className="font-medium">Name:</span> {result.name}
                </p>
              )}
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
              providerKey="solarlog"
              providerLabel="SolarLog"
              rows={
                readMeterStatus(result) === "Found" && readMeterLifetimeKwh(result) != null
                  ? [{
                monitoring: "SolarLog",
                monitoring_system_id: String(deviceId),
                monitoring_system_name: readMeterName(result) ?? String(deviceId),
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
