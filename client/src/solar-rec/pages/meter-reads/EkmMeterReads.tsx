/**
 * Task 5.4 vendor 9/16 — EKM (push API) meter-reads on solar-rec.
 *
 * Team credential stores `{apiKey, baseUrl}`. EKM has no list-meters
 * endpoint, so users supply a meter number directly.
 */

import { useState } from "react";
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
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

export default function EkmMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.ekm.getStatus.useQuery(undefined, {
    retry: false,
  });
  const snapshotMutation = trpc.ekm.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const [meterNumber, setMeterNumber] = useState("");
  const [anchorDate, setAnchorDate] = useState("");

  const runSnapshot = () => {
    const trimmed = meterNumber.trim();
    if (!trimmed) {
      toast.error("Enter a meter number");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({
      meterNumber: trimmed,
      anchorDate: anchorDate || undefined,
    });
  };

  const [showPersist, setShowPersist] = useState(false);
  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">EKM</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s EKM credential. EKM
          doesn&rsquo;t expose a list-meters endpoint, so you&rsquo;ll need
          the meter number from your EKM dashboard. Manage API key in Solar
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
            {statusQuery.data?.connected
              ? `${statusQuery.data.connectionCount} team credential${
                  statusQuery.data.connectionCount === 1 ? "" : "s"
                } registered.`
              : "Ask an admin to register an EKM API key in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Production Snapshot</CardTitle>
          <CardDescription>
            Run a single-meter lifetime-kWh snapshot for a given anchor date.
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
              <Label htmlFor="ekm-meter-number">Meter number</Label>
              <Input
                id="ekm-meter-number"
                value={meterNumber}
                onChange={(e) => setMeterNumber(e.target.value)}
                placeholder="e.g., 000000123456"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ekm-anchor-date">Anchor date (optional)</Label>
              <Input
                id="ekm-anchor-date"
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
              !meterNumber.trim() ||
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
        
          {result && (result as any).status === "Found" && (result as any).lifetimeKwh != null && showPersist && (
            <PersistConfirmation
              providerKey="ekm"
              providerLabel="EKM"
              rows={[{
                monitoring: "EKM",
                monitoring_system_id: String(meterNumber),
                monitoring_system_name: String((result as any).name || (result as any).systemName || meterNumber),
                lifetime_meter_read_wh: String(Math.round(Number((result as any).lifetimeKwh) * 1000)),
                read_date: typeof anchorDate !== 'undefined' && anchorDate ? anchorDate : new Date().toISOString().slice(0, 10),
                status: "",
                alert_severity: ""
              }]}
              onDiscard={() => setShowPersist(false)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
