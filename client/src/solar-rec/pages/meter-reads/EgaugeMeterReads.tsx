/**
 * Task 5.4 vendor 16/16 — eGauge (final vendor).
 *
 * Each `solarRecTeamCredentials[provider='egauge']` row IS a meter
 * profile (baseUrl + accessType + optional username/password/meterId
 * stored inside the metadata blob — the team credentials form puts
 * everything there). Admins manage the list of profiles in Solar REC
 * Settings → Credentials with the existing dynamic form.
 *
 * Unlike every other vendor, eGauge has no central "list devices"
 * call: each saved profile is the device. This page lets users pick
 * a profile and run a single-meter production snapshot, with an
 * optional meter ID override and anchor date.
 */

import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Play } from "lucide-react";
import { toast } from "sonner";

const ACCESS_TYPE_LABEL: Record<string, string> = {
  public: "Public",
  user_login: "User Login",
  site_login: "Site Login",
  portfolio_login: "Portfolio Login",
};

export default function EgaugeMeterReads() {
  const { canEdit } = useSolarRecPermission("meter-reads");
  const statusQuery = trpc.egauge.getStatus.useQuery(undefined, {
    retry: false,
  });
  const snapshotMutation = trpc.egauge.getProductionSnapshot.useMutation({
    onError: (err) => toast.error(err.message),
  });

  const profiles = statusQuery.data?.profiles ?? [];
  const [credentialId, setCredentialId] = useState<string>("");
  const [meterIdOverride, setMeterIdOverride] = useState("");
  const [anchorDate, setAnchorDate] = useState(() =>
    new Date().toISOString().slice(0, 10)
  );

  // Pre-select the first profile once status loads.
  useEffect(() => {
    if (!credentialId && profiles.length > 0) {
      setCredentialId(profiles[0].credentialId);
    }
  }, [profiles, credentialId]);

  const selectedProfile =
    profiles.find((p) => p.credentialId === credentialId) ?? null;
  const effectiveMeterId =
    meterIdOverride.trim() || selectedProfile?.defaultMeterId || "";

  const runSnapshot = () => {
    if (!credentialId) {
      toast.error("Pick a credential profile.");
      return;
    }
    if (!effectiveMeterId) {
      toast.error("Enter a meter ID, or set a default on the credential.");
      return;
    }
    setShowPersist(true);
    snapshotMutation.mutate({
      credentialId,
      meterId: meterIdOverride.trim() || undefined,
      anchorDate: anchorDate || undefined,
    });
  };

  const [showPersist, setShowPersist] = useState(false);
  const result = snapshotMutation.data;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">eGauge</h1>
        <p className="text-sm text-muted-foreground">
          Run meter reads against the team&rsquo;s eGauge credentials. Each
          credential is one meter profile (baseUrl + accessType + optional
          username/password/meterId). Manage the list in Solar REC
          Settings → Credentials.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            <span>Saved Profiles</span>
            {statusQuery.data?.connected ? (
              <Badge variant="default">
                {statusQuery.data.connectionCount} profile
                {statusQuery.data.connectionCount === 1 ? "" : "s"}
              </Badge>
            ) : (
              <Badge variant="outline">No profiles</Badge>
            )}
          </CardTitle>
          <CardDescription>
            {statusQuery.data?.connected
              ? "Pick a profile below to run a snapshot."
              : "Ask an admin to register an eGauge profile in Settings → Credentials."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusQuery.isLoading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : profiles.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No eGauge profiles configured.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Base URL</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead>Username</TableHead>
                    <TableHead>Default meter</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profiles.map((p) => (
                    <TableRow key={p.credentialId}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {p.baseUrl}
                      </TableCell>
                      <TableCell className="text-xs">
                        {ACCESS_TYPE_LABEL[p.accessType] ?? p.accessType}
                      </TableCell>
                      <TableCell className="text-xs">
                        {p.username ?? "—"}
                        {p.accessType !== "public" && !p.hasPassword && (
                          <span className="ml-1 text-amber-700">
                            (missing password)
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs font-mono">
                        {p.defaultMeterId ?? "—"}
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
            Pick a profile, optionally override the meter ID, and run a
            single-meter snapshot. The anchor date defaults to today.
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
              <Label htmlFor="egauge-credential">Profile</Label>
              <Select
                value={credentialId}
                onValueChange={setCredentialId}
                disabled={profiles.length === 0}
              >
                <SelectTrigger id="egauge-credential">
                  <SelectValue placeholder="Pick a profile" />
                </SelectTrigger>
                <SelectContent>
                  {profiles.map((p) => (
                    <SelectItem key={p.credentialId} value={p.credentialId}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="egauge-meter">
                Meter ID
                {selectedProfile?.defaultMeterId && (
                  <span className="ml-1 text-xs text-muted-foreground">
                    (defaults to{" "}
                    <code>{selectedProfile.defaultMeterId}</code>)
                  </span>
                )}
              </Label>
              <Input
                id="egauge-meter"
                value={meterIdOverride}
                onChange={(e) => setMeterIdOverride(e.target.value)}
                placeholder={
                  selectedProfile?.defaultMeterId ?? "e.g. egauge12345"
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="egauge-anchor-date">Anchor date</Label>
              <Input
                id="egauge-anchor-date"
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
              !credentialId ||
              !effectiveMeterId ||
              snapshotMutation.isPending ||
              profiles.length === 0
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
                <span className="font-medium">Meter:</span>{" "}
                <code>{result.meterId}</code>
              </p>
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
              <p>
                <span className="font-medium">Anchor date:</span>{" "}
                {result.anchorDate}
              </p>
              {result.lifetimeKwh !== null &&
                result.lifetimeKwh !== undefined && (
                  <p>
                    <span className="font-medium">Lifetime kWh:</span>{" "}
                    {result.lifetimeKwh.toLocaleString(undefined, {
                      maximumFractionDigits: 3,
                    })}
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
              providerKey="egauge"
              providerLabel="eGauge"
              rows={
                readMeterStatus(result) === "Found" && readMeterLifetimeKwh(result) != null
                  ? [{
                monitoring: "eGauge",
                monitoring_system_id: String(meterIdOverride || credentialId),
                monitoring_system_name: readMeterName(result) ?? String(meterIdOverride || credentialId),
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
