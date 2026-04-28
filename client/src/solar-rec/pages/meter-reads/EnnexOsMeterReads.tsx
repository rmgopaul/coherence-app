/**
 * Task 5.4 vendor 11/16 — EnnexOS (SMA) meter-reads on solar-rec.
 *
 * Team credential stores `{accessToken, baseUrl}`. Lists plants and
 * runs single-plant lifetime-kWh snapshots.
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

export default function EnnexOsMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.ennexos.getStatus.useQuery(undefined, {
    retry: false,
  });
  const listPlantsQuery = trpc.ennexos.listPlants.useQuery(undefined, {
    enabled: statusQuery.data?.connected === true,
    retry: false,
  });
  const probeFn = useCallback(async () => {
    const r = await listPlantsQuery.refetch({ throwOnError: true });
    return r.data?.plants?.length ?? 0;
  }, [listPlantsQuery]);

  const snapshotMutation = trpc.ennexos.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [plantId, setPlantId] = useState("");
  const [anchorDate, setAnchorDate] = useState("");

  const runSnapshot = () => {
    const trimmed = plantId.trim();
    if (!trimmed) {
      toast.error("Enter a plant ID");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({
      plantId: trimmed,
      anchorDate: anchorDate || undefined,
    });
  };

  const [showPersist, setShowPersist] = useState(false);
  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">EnnexOS (SMA)</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s EnnexOS credential. Manage
          access token in Solar REC Settings → Credentials.
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
              : "Ask an admin to register an EnnexOS access token in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MeterReadConnectionProbe
            runProbe={probeFn}
            sampleNoun="plants"
            disabled={!statusQuery.data?.connected}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Plants</CardTitle>
              <CardDescription>
                Discover plants on the connected EnnexOS account.
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => listPlantsQuery.refetch()}
              disabled={!statusQuery.data?.connected || listPlantsQuery.isFetching}
            >
              {listPlantsQuery.isFetching ? (
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
          ) : listPlantsQuery.isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : listPlantsQuery.error ? (
            <p className="text-sm text-destructive">
              {listPlantsQuery.error.message}
            </p>
          ) : (listPlantsQuery.data?.plants ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No plants returned by EnnexOS.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Plant ID</TableHead>
                    <TableHead>Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listPlantsQuery.data?.plants.map((p) => (
                    <TableRow key={p.plantId}>
                      <TableCell className="font-mono text-xs">
                        {p.plantId}
                      </TableCell>
                      <TableCell>{p.name ?? "—"}</TableCell>
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
            Run a single-plant lifetime-kWh snapshot for a given anchor date.
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
              <Label htmlFor="ennexos-plant-id">Plant ID</Label>
              <Input
                id="ennexos-plant-id"
                value={plantId}
                onChange={(e) => setPlantId(e.target.value)}
                placeholder="e.g., abc123-..."
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ennexos-anchor-date">
                Anchor date (optional)
              </Label>
              <Input
                id="ennexos-anchor-date"
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
              !plantId.trim() ||
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
              providerKey="ennexos"
              providerLabel="ennexOS"
              rows={
                readMeterStatus(result) === "Found" && readMeterLifetimeKwh(result) != null
                  ? [{
                monitoring: "ennexOS",
                monitoring_system_id: String(plantId),
                monitoring_system_name: readMeterName(result) ?? String(plantId),
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
