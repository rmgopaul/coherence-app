/**
 * Task 5.4 vendor 13/16 — SolarEdge meter-reads on solar-rec.
 *
 * Team credential stores `{apiKey, baseUrl}`. SolarEdge uniquely
 * exposes three snapshot types — production, meter inventory, inverter
 * inventory — that the legacy meter-reads page surfaces. This page
 * keeps that distinction so fleet operators can hit each endpoint
 * without dropping back to the main app.
 *
 * Bulk multi-site CSV processing is deferred; the page runs single-
 * site snapshots only.
 */

import { useCallback, useState } from "react";
import { MeterReadConnectionProbe } from "../../components/MeterReadConnectionProbe";
import { PersistConfirmation } from "../../components/PersistConfirmation";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type SnapshotKind = "production" | "meter" | "inverter";

export default function SolarEdgeMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.solaredge.getStatus.useQuery(undefined, {
    retry: false,
  });
  const listSitesQuery = trpc.solaredge.listSites.useQuery(undefined, {
    enabled: statusQuery.data?.connected === true,
    retry: false,
  });
  // Phase E (2026-04-28) — Test Connection probe times the
  // listSitesQuery refetch as a lightweight credential check.
  const probeFn = useCallback(async () => {
    const r = await listSitesQuery.refetch({ throwOnError: true });
    return r.data?.sites?.length ?? 0;
  }, [listSitesQuery]);

  const productionMutation =
    trpc.solaredge.getProductionSnapshot.useMutation({
      onError: (err) => toast.error(err.message),
    });
  const meterMutation = trpc.solaredge.getMeterSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });
  const inverterMutation = trpc.solaredge.getInverterSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [siteId, setSiteId] = useState("");
  const [anchorDate, setAnchorDate] = useState("");
  const [snapshotKind, setSnapshotKind] = useState<SnapshotKind>("production");

  const activeMutation =
    snapshotKind === "production"
      ? productionMutation
      : snapshotKind === "meter"
        ? meterMutation
        : inverterMutation;

  const runSnapshot = () => {
    const trimmed = siteId.trim();
    if (!trimmed) {
      toast.error("Enter a site ID");
      return;
    }
    if (snapshotKind === "production") {
      productionMutation.mutate({
        siteId: trimmed,
        anchorDate: anchorDate || undefined,
      });
    } else if (snapshotKind === "meter") {
      meterMutation.mutate({ siteId: trimmed });
    } else {
      inverterMutation.mutate({
        siteId: trimmed,
        anchorDate: anchorDate || undefined,
      });
    }
  };

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">SolarEdge</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s SolarEdge credential.
          Manage API key in Solar REC Settings → Credentials.
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
              : "Ask an admin to register a SolarEdge API key in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MeterReadConnectionProbe
            runProbe={probeFn}
            sampleNoun="sites"
            disabled={!statusQuery.data?.connected}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Sites</CardTitle>
              <CardDescription>
                Discover sites on the connected SolarEdge account.
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
              No sites returned by SolarEdge.
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
          <CardTitle className="text-base">Snapshot</CardTitle>
          <CardDescription>
            Run a single-site SolarEdge snapshot. Production gives lifetime
            kWh; meter inventory lists production/consumption meters;
            inverter snapshot reports the latest inverter telemetry.
            {!canEdit && (
              <span className="ml-1 text-amber-700">
                You have read-only access; running a snapshot requires{" "}
                <code>edit</code> on <code>meter-reads</code>.
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label htmlFor="solaredge-site-id">Site ID</Label>
              <Input
                id="solaredge-site-id"
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                placeholder="e.g., 1234567"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="solaredge-snapshot-kind">Snapshot type</Label>
              <Select
                value={snapshotKind}
                onValueChange={(v) => setSnapshotKind(v as SnapshotKind)}
              >
                <SelectTrigger id="solaredge-snapshot-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="production">Production</SelectItem>
                  <SelectItem value="meter">Meter inventory</SelectItem>
                  <SelectItem value="inverter">Inverter snapshot</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="solaredge-anchor-date">
                Anchor date (production / inverter)
              </Label>
              <Input
                id="solaredge-anchor-date"
                type="date"
                value={anchorDate}
                onChange={(e) => setAnchorDate(e.target.value)}
                disabled={snapshotKind === "meter"}
              />
            </div>
          </div>
          <Button
            onClick={runSnapshot}
            disabled={
              !canEdit ||
              !siteId.trim() ||
              activeMutation.isPending ||
              !statusQuery.data?.connected
            }
          >
            {activeMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run snapshot
          </Button>

          {snapshotKind === "production" && productionMutation.data && (
            <SnapshotResultPanel data={productionMutation.data} />
          )}
          {snapshotKind === "meter" && meterMutation.data && (
            <MeterResultPanel data={meterMutation.data} />
          )}
          {snapshotKind === "inverter" && inverterMutation.data && (
            <InverterResultPanel data={inverterMutation.data} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "Found"
          ? "default"
          : status === "Not Found"
            ? "outline"
            : "destructive"
      }
    >
      {status}
    </Badge>
  );
}

function SnapshotResultPanel({
  data,
}: {
  data: { status: string; lifetimeKwh?: number | null; error?: string | null };
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
      <p>
        <span className="font-medium">Status:</span>{" "}
        <StatusBadge status={data.status} />
      </p>
      {data.lifetimeKwh !== null && data.lifetimeKwh !== undefined && (
        <p>
          <span className="font-medium">Lifetime kWh:</span>{" "}
          {data.lifetimeKwh.toLocaleString()}
        </p>
      )}
      {data.error && (
        <p className="text-destructive">
          <span className="font-medium">Error:</span> {data.error}
        </p>
      )}
    </div>
  );
}

function MeterResultPanel({
  data,
}: {
  data: {
    status: string;
    meterCount: number | null;
    productionMeters: number | null;
    consumptionMeters: number | null;
    meterTypes: string[];
    error: string | null;
  };
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
      <p>
        <span className="font-medium">Status:</span>{" "}
        <StatusBadge status={data.status} />
      </p>
      {data.meterCount !== null && (
        <p>
          <span className="font-medium">Meters:</span> {data.meterCount}
          {data.productionMeters !== null &&
            ` (${data.productionMeters} production, ${
              data.consumptionMeters ?? 0
            } consumption)`}
        </p>
      )}
      {data.meterTypes && data.meterTypes.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Types: {data.meterTypes.join(", ")}
        </p>
      )}
      {data.error && (
        <p className="text-destructive">
          <span className="font-medium">Error:</span> {data.error}
        </p>
      )}
    </div>
  );
}

function InverterResultPanel({
  data,
}: {
  data: {
    status: string;
    inverterCount: number | null;
    invertersWithTelemetry: number | null;
    inverterLatestPowerKw: number | null;
    inverterLatestEnergyKwh: number | null;
    error: string | null;
  };
}) {
  return (
    <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
      <p>
        <span className="font-medium">Status:</span>{" "}
        <StatusBadge status={data.status} />
      </p>
      {data.inverterCount !== null && (
        <p>
          <span className="font-medium">Inverters:</span> {data.inverterCount}
          {data.invertersWithTelemetry !== null &&
            ` (${data.invertersWithTelemetry} reporting telemetry)`}
        </p>
      )}
      {data.inverterLatestPowerKw !== null && (
        <p>
          <span className="font-medium">Latest power:</span>{" "}
          {data.inverterLatestPowerKw.toLocaleString()} kW
        </p>
      )}
      {data.inverterLatestEnergyKwh !== null && (
        <p>
          <span className="font-medium">Latest energy:</span>{" "}
          {data.inverterLatestEnergyKwh.toLocaleString()} kWh
        </p>
      )}
      {data.error && (
        <p className="text-destructive">
          <span className="font-medium">Error:</span> {data.error}
        </p>
      )}
    </div>
  );
}
