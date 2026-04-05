import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { buildConvertedReadRow, pushConvertedReadsToRecDashboard } from "@/lib/convertedReads";
import { toErrorMessage, downloadTextFile } from "@/lib/helpers";
import { ArrowLeft, ExternalLink, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const DEFAULT_BASE_URL = "https://api.enphaseenergy.com/api/v4";
const DEFAULT_REDIRECT_URI = "https://api.enphaseenergy.com/oauth/redirect_uri";

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function EnphaseV4MeterReads() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);
  const defaultStartDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return formatDateInput(date);
  }, []);

  const [apiKeyInput, setApiKeyInput] = useState("");
  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [authorizationCodeInput, setAuthorizationCodeInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [redirectUriInput, setRedirectUriInput] = useState(DEFAULT_REDIRECT_URI);
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const statusQuery = trpc.enphaseV4.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const systemsQuery = trpc.enphaseV4.listSystems.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.enphaseV4.connect.useMutation();
  const disconnectMutation = trpc.enphaseV4.disconnect.useMutation();
  const summaryMutation = trpc.enphaseV4.getSummary.useMutation();
  const energyLifetimeMutation = trpc.enphaseV4.getEnergyLifetime.useMutation();
  const rgmStatsMutation = trpc.enphaseV4.getRgmStats.useMutation();
  const productionReadsMutation = trpc.enphaseV4.getProductionMeterReadings.useMutation();
  const bulkSnapshotsMutation = trpc.enphaseV4.getProductionSnapshots.useMutation();
  const getRemoteDataset = trpc.solarRecDashboard.getDataset.useMutation();
  const saveRemoteDataset = trpc.solarRecDashboard.saveDataset.useMutation();

  const [bulkSystemIdsCsv, setBulkSystemIdsCsv] = useState("");
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  type BulkSnapshotRow = { systemId: string; systemName: string | null; status: string; found: boolean; lifetimeKwh: number | null; anchorDate: string; error: string | null };
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.clientId) setClientIdInput(statusQuery.data.clientId);
    if (statusQuery.data.baseUrl) setBaseUrlInput(statusQuery.data.baseUrl);
    if (statusQuery.data.redirectUri) setRedirectUriInput(statusQuery.data.redirectUri);
  }, [statusQuery.data]);

  useEffect(() => {
    const firstSystem = systemsQuery.data?.systems?.[0];
    if (!firstSystem) return;
    if (!selectedSystemId) {
      setSelectedSystemId(firstSystem.systemId);
    }
  }, [systemsQuery.data, selectedSystemId]);

  const authUrl = useMemo(() => {
    const clientId = clientIdInput.trim();
    const redirectUri = redirectUriInput.trim() || DEFAULT_REDIRECT_URI;
    if (!clientId) return "";
    const url = new URL("https://api.enphaseenergy.com/oauth/authorize");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    return url.toString();
  }, [clientIdInput, redirectUriInput]);

  const handleConnect = async () => {
    const apiKey = apiKeyInput.trim();
    const clientId = clientIdInput.trim();
    const clientSecret = clientSecretInput.trim();
    const authorizationCode = authorizationCodeInput.trim();

    if (!apiKey) {
      toast.error("Enter your Enphase API key.");
      return;
    }
    if (!clientId) {
      toast.error("Enter your Enphase client ID.");
      return;
    }
    if (!clientSecret) {
      toast.error("Enter your Enphase client secret.");
      return;
    }
    if (!authorizationCode) {
      toast.error("Enter your Enphase authorization code.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        apiKey,
        clientId,
        clientSecret,
        authorizationCode,
        redirectUri: redirectUriInput.trim(),
        baseUrl: baseUrlInput.trim(),
      });
      await trpcUtils.enphaseV4.getStatus.invalidate();
      await trpcUtils.enphaseV4.listSystems.invalidate();
      toast.success("Enphase v4 connected.");
      setAuthorizationCodeInput("");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.enphaseV4.getStatus.invalidate();
      await trpcUtils.enphaseV4.listSystems.invalidate();
      setSelectedSystemId("");
      toast.success("Enphase v4 disconnected.");
    } catch (error) {
      toast.error(`Failed to disconnect: ${toErrorMessage(error)}`);
    }
  };

  const runAction = async (title: string, action: () => Promise<unknown>) => {
    setIsRunningAction(true);
    try {
      const payload = await action();
      setResultTitle(title);
      setResultText(JSON.stringify(payload, null, 2));
      toast.success(`${title} loaded.`);
    } catch (error) {
      toast.error(toErrorMessage(error));
    } finally {
      setIsRunningAction(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  const systems = systemsQuery.data?.systems ?? [];
  const isConnected = Boolean(statusQuery.data?.connected);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const systemsError = systemsQuery.error ? toErrorMessage(systemsQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Enphase v4 Meter Reads</h1>
          <p className="text-sm text-slate-600 mt-1">
            OAuth-based v4 connection: API key + client credentials + authorization code.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Enphase v4</CardTitle>
            <CardDescription>
              Exchange an authorization code for access/refresh tokens and save the connection.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="enphase-api-key">API Key</Label>
                <Input
                  id="enphase-api-key"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="App API key from Enphase developer portal"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="enphase-client-id">Client ID</Label>
                <Input
                  id="enphase-client-id"
                  value={clientIdInput}
                  onChange={(e) => setClientIdInput(e.target.value)}
                  placeholder="Client ID from Enphase app"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="enphase-client-secret">Client Secret</Label>
                <Input
                  id="enphase-client-secret"
                  type="password"
                  value={clientSecretInput}
                  onChange={(e) => setClientSecretInput(e.target.value)}
                  placeholder="Client secret from Enphase app"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="enphase-auth-code">Authorization Code</Label>
                <Input
                  id="enphase-auth-code"
                  value={authorizationCodeInput}
                  onChange={(e) => setAuthorizationCodeInput(e.target.value)}
                  placeholder="Paste ?code=... from Enphase OAuth redirect"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="enphase-redirect-uri">Redirect URI</Label>
                <Input
                  id="enphase-redirect-uri"
                  value={redirectUriInput}
                  onChange={(e) => setRedirectUriInput(e.target.value)}
                  placeholder={DEFAULT_REDIRECT_URI}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="enphase-base-url">Base API URL (advanced)</Label>
                <Input
                  id="enphase-base-url"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                />
              </div>
            </div>

            {authUrl && (
              <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
                Get authorization code by opening:{" "}
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline break-all"
                >
                  {authUrl}
                </a>
              </div>
            )}

            {statusError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Status error: {statusError}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleConnect} disabled={connectMutation.isPending}>
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <PlugZap className="h-4 w-4 mr-2" />
                )}
                Exchange Code + Connect
              </Button>
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnectMutation.isPending || !isConnected}
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4 mr-2" />
                )}
                Disconnect
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  statusQuery.refetch();
                  systemsQuery.refetch();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              {authUrl && (
                <Button variant="ghost" asChild>
                  <a href={authUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Open Auth URL
                  </a>
                </Button>
              )}
              <span className="text-sm text-slate-600">
                Status: {isConnected ? "Connected" : "Not connected"}
              </span>
            </div>

            {isConnected && (
              <p className="text-xs text-slate-500">
                Connected client ID <strong>{statusQuery.data?.clientId}</strong> at{" "}
                <code>{statusQuery.data?.baseUrl || DEFAULT_BASE_URL}</code>
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Select System + Date Range</CardTitle>
            <CardDescription>
              Choose a system from `/api/v4/systems`, or paste one manually, then fetch data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-1">
                <Label>System</Label>
                <Select value={selectedSystemId} onValueChange={setSelectedSystemId} disabled={!systems.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={systems.length ? "Select a system" : "No systems loaded"} />
                  </SelectTrigger>
                  <SelectContent>
                    {systems.map((system) => (
                      <SelectItem key={system.systemId} value={system.systemId}>
                        {system.systemName} ({system.systemId})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="manual-system-id">Manual System ID (optional)</Label>
                <Input
                  id="manual-system-id"
                  value={selectedSystemId}
                  onChange={(e) => setSelectedSystemId(e.target.value.trim())}
                  placeholder="Paste system/site ID to bypass list loading"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="end-date">End Date</Label>
                <Input
                  id="end-date"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {systemsQuery.isLoading && <div className="text-sm text-slate-600">Loading systems...</div>}

            {systemsError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Systems load error: {systemsError}
              </div>
            )}

            {!systemsQuery.isLoading && !systemsError && isConnected && systems.length === 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                <div>No systems were returned for this key/token combination.</div>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto px-0 py-0 mt-1 text-amber-800 underline"
                  onClick={() => {
                    setResultTitle("Raw Systems Payload");
                    setResultText(JSON.stringify(systemsQuery.data?.raw ?? {}, null, 2));
                  }}
                >
                  Show raw systems response
                </Button>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!selectedSystemId || isRunningAction}
                onClick={() =>
                  runAction("System Summary", () =>
                    summaryMutation.mutateAsync({
                      systemId: selectedSystemId,
                    })
                  )
                }
              >
                Fetch Summary
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSystemId || isRunningAction}
                onClick={() =>
                  runAction("Energy Lifetime", () =>
                    energyLifetimeMutation.mutateAsync({
                      systemId: selectedSystemId,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch Energy Lifetime
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSystemId || isRunningAction}
                onClick={() =>
                  runAction("RGM Stats", () =>
                    rgmStatsMutation.mutateAsync({
                      systemId: selectedSystemId,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch RGM Stats
              </Button>
              <Button
                disabled={!selectedSystemId || isRunningAction}
                onClick={() =>
                  runAction("Production Meter Telemetry", () =>
                    productionReadsMutation.mutateAsync({
                      systemId: selectedSystemId,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch Production Meter Telemetry
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) API Response</CardTitle>
            <CardDescription>{resultTitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-slate-950 text-slate-100 rounded-md p-4 overflow-auto max-h-[480px]">
              {resultText}
            </pre>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>4) Bulk Production Snapshots</CardTitle>
            <CardDescription>
              Paste or upload system IDs (one per line) to fetch lifetime production for each system. Results auto-push to the Solar REC Dashboard Converted Reads.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>System IDs (one per line)</Label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                value={bulkSystemIdsCsv}
                onChange={(e) => setBulkSystemIdsCsv(e.target.value)}
                placeholder={"123456\n789012\n345678"}
                disabled={bulkIsRunning}
              />
            </div>
            <div className="flex gap-2">
              <Button
                onClick={async () => {
                  const ids = bulkSystemIdsCsv
                    .split(/[\n,]+/)
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                  if (ids.length === 0) {
                    toast.error("Enter at least one system ID.");
                    return;
                  }
                  setBulkIsRunning(true);
                  setBulkRows([]);
                  try {
                    const result = await bulkSnapshotsMutation.mutateAsync({ systemIds: ids });
                    setBulkRows(result.rows);
                    toast.success(
                      `Completed Enphase bulk snapshots: ${result.found} found, ${result.notFound} not found, ${result.errored} errors.`
                    );

                    // Auto-push Converted Reads.
                    const readRows = result.rows
                      .filter((row) => row.found && row.lifetimeKwh != null)
                      .map((row) =>
                        buildConvertedReadRow("Enphase", row.systemId, row.systemName ?? "", row.lifetimeKwh!, row.anchorDate)
                      );
                    const pushResult = await pushConvertedReadsToRecDashboard(
                      (input) => getRemoteDataset.mutateAsync(input),
                      (input) => saveRemoteDataset.mutateAsync(input),
                      readRows,
                      "Enphase"
                    );
                    if (pushResult.pushed > 0) {
                      toast.success(`Pushed ${pushResult.pushed} Enphase rows to Solar REC Dashboard Converted Reads.${pushResult.skipped > 0 ? ` ${pushResult.skipped} duplicates skipped.` : ""}`);
                    } else if (pushResult.skipped > 0) {
                      toast.message(`All ${pushResult.skipped} Enphase Converted Reads rows already exist.`);
                    }
                  } catch (error) {
                    toast.error(`Bulk snapshots failed: ${toErrorMessage(error)}`);
                  } finally {
                    setBulkIsRunning(false);
                  }
                }}
                disabled={bulkIsRunning || !statusQuery.data?.connected}
              >
                {bulkIsRunning ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running...
                  </>
                ) : (
                  "Run Bulk Snapshots"
                )}
              </Button>
              {bulkRows.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const headers = ["system_id", "system_name", "status", "lifetime_kwh", "anchor_date", "error"];
                    const csvLines = [
                      headers.join(","),
                      ...bulkRows.map((row) =>
                        [row.systemId, `"${(row.systemName ?? "").replace(/"/g, '""')}"`, row.status, row.lifetimeKwh ?? "", row.anchorDate, `"${(row.error ?? "").replace(/"/g, '""')}"`].join(",")
                      ),
                    ];
                    downloadTextFile(
                      `enphase-bulk-snapshots-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`,
                      csvLines.join("\n")
                    );
                  }}
                >
                  Download CSV
                </Button>
              )}
            </div>
            {bulkRows.length > 0 && (
              <div className="overflow-auto max-h-[400px]">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-background">
                    <tr className="border-b">
                      <th className="text-left p-2">System ID</th>
                      <th className="text-left p-2">System Name</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Lifetime (kWh)</th>
                      <th className="text-left p-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((row) => (
                      <tr key={row.systemId} className="border-b">
                        <td className="p-2 font-mono">{row.systemId}</td>
                        <td className="p-2">{row.systemName ?? "N/A"}</td>
                        <td className="p-2">{row.status}</td>
                        <td className="p-2">{row.lifetimeKwh != null ? row.lifetimeKwh.toLocaleString() : "N/A"}</td>
                        <td className="p-2 text-xs text-slate-500">{row.error ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
