/**
 * Task 5.4 — Generac (PWRview) meter-reads page on solar-rec.
 *
 * Minimal first-vendor migration: runs against team credentials managed
 * in Solar REC Settings → Credentials rather than per-user integrations.
 * Credential lifecycle lives in Settings; this page only RUNS API calls.
 *
 * Permission: `meter-reads` (read for status/list, edit to actually run
 * a snapshot against the vendor quota).
 */

import { useState } from "react";
import { solarRecTrpc as trpc } from "../../solarRecTrpc";
import { PermissionGate } from "../../components/PermissionGate";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Play, RefreshCw } from "lucide-react";
import { toast } from "sonner";

export default function GeneracMeterReads() {
  return (
    <PermissionGate moduleKey="meter-reads">
      <GeneracMeterReadsImpl />
    </PermissionGate>
  );
}

function GeneracMeterReadsImpl() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.generac.getStatus.useQuery(undefined, {
    retry: false,
  });
  const listSystemsQuery = trpc.generac.listSystems.useQuery(undefined, {
    enabled: statusQuery.data?.connected === true,
    retry: false,
  });
  const snapshotMutation = trpc.generac.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [systemId, setSystemId] = useState("");
  const [anchorDate, setAnchorDate] = useState("");

  const runSnapshot = () => {
    const trimmed = systemId.trim();
    if (!trimmed) {
      toast.error("Enter a system ID");
      return;
    }
    snapshotMutation.mutate({
      systemId: trimmed,
      anchorDate: anchorDate || undefined,
    });
  };

  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Generac PWRview</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s Generac PWRview credential.
          Manage API keys in Solar REC Settings → Credentials.
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
              : "Ask an admin to register a Generac API key in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">Systems</CardTitle>
              <CardDescription>
                Discover systems on the connected Generac account.
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
              No systems returned by Generac.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>System ID</TableHead>
                    <TableHead>Name</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listSystemsQuery.data?.systems.map((s) => (
                    <TableRow key={s.systemId}>
                      <TableCell className="font-mono text-xs">{s.systemId}</TableCell>
                      <TableCell>{s.name ?? "—"}</TableCell>
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
            Run a single-system lifetime-kWh snapshot for a given anchor date.
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
              <Label htmlFor="generac-system-id">System ID</Label>
              <Input
                id="generac-system-id"
                value={systemId}
                onChange={(e) => setSystemId(e.target.value)}
                placeholder="e.g., 1234567"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="generac-anchor-date">Anchor date (optional)</Label>
              <Input
                id="generac-anchor-date"
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
            <div className="rounded-md border bg-muted/40 p-3 text-sm">
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
        </CardContent>
      </Card>
    </div>
  );
}
