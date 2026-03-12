import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Download, Loader2, PlugZap, RefreshCw, Search, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const DEFAULT_TOKEN_URL = "https://gridlogic-api.sn.tesla.services/v1/auth/token";
const DEFAULT_API_BASE_URL = "https://gridlogic-api.sn.tesla.services/v2";
const DEFAULT_PORTAL_BASE_URL = "https://powerhub.energy.tesla.com";
const DEFAULT_GROUP_URL = "https://powerhub.energy.tesla.com/group/b4b6a137-0387-4f5a-bfd0-82638a119472";
const DEFAULT_SIGNAL = "solar_energy_exported";
const PAGE_SIZE = 50;

const COUNT_FORMATTER = new Intl.NumberFormat("en-US");
const KWH_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

type SiteProductionRow = {
  siteId: string;
  siteName: string | null;
  dailyKwh: number;
  weeklyKwh: number;
  monthlyKwh: number;
  yearlyKwh: number;
  lifetimeKwh: number;
};

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function normalizeGroupId(raw: string): string {
  const trimmed = clean(raw);
  if (!trimmed) return "";
  const match = trimmed.match(/\/group\/([a-zA-Z0-9-]+)/i);
  return match?.[1]?.trim() || trimmed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

function downloadTextFile(fileName: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function formatKwh(value: number): string {
  return KWH_FORMATTER.format(Number.isFinite(value) ? value : 0);
}

export default function TeslaPowerhubApi() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const [clientIdInput, setClientIdInput] = useState("");
  const [clientSecretInput, setClientSecretInput] = useState("");
  const [groupIdInput, setGroupIdInput] = useState("");
  const [tokenUrlInput, setTokenUrlInput] = useState(DEFAULT_TOKEN_URL);
  const [apiBaseUrlInput, setApiBaseUrlInput] = useState(DEFAULT_API_BASE_URL);
  const [portalBaseUrlInput, setPortalBaseUrlInput] = useState(DEFAULT_PORTAL_BASE_URL);
  const [endpointUrlInput, setEndpointUrlInput] = useState("");
  const [signalInput, setSignalInput] = useState(DEFAULT_SIGNAL);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");

  const statusQuery = trpc.teslaPowerhub.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const connectMutation = trpc.teslaPowerhub.connect.useMutation();
  const disconnectMutation = trpc.teslaPowerhub.disconnect.useMutation();
  const productionMutation = trpc.teslaPowerhub.getGroupProductionMetrics.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.clientId) setClientIdInput(statusQuery.data.clientId);
    if (statusQuery.data.tokenUrl) setTokenUrlInput(statusQuery.data.tokenUrl);
    if (statusQuery.data.apiBaseUrl) setApiBaseUrlInput(statusQuery.data.apiBaseUrl);
    if (statusQuery.data.portalBaseUrl) setPortalBaseUrlInput(statusQuery.data.portalBaseUrl);
  }, [statusQuery.data]);

  useEffect(() => {
    setPage(1);
  }, [search, productionMutation.data?.sites.length]);

  const handleConnect = async () => {
    const clientId = clean(clientIdInput);
    const clientSecret = clean(clientSecretInput);
    if (!clientId) {
      toast.error("Enter your Tesla Powerhub client ID.");
      return;
    }
    if (!clientSecret) {
      toast.error("Enter your Tesla Powerhub client secret.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        clientId,
        clientSecret: clientSecret || undefined,
        tokenUrl: clean(tokenUrlInput),
        apiBaseUrl: clean(apiBaseUrlInput),
        portalBaseUrl: clean(portalBaseUrlInput),
      });
      setClientSecretInput("");
      await trpcUtils.teslaPowerhub.getStatus.invalidate();
      toast.success("Tesla Powerhub credentials saved.");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.teslaPowerhub.getStatus.invalidate();
      productionMutation.reset();
      toast.success("Tesla Powerhub disconnected.");
    } catch (error) {
      toast.error(`Failed to disconnect: ${toErrorMessage(error)}`);
    }
  };

  const handleFetchProduction = async () => {
    const groupId = normalizeGroupId(groupIdInput);
    if (!groupId) {
      toast.error("Enter a group ID.");
      return;
    }

    try {
      const payload = await productionMutation.mutateAsync({
        groupId,
        endpointUrl: clean(endpointUrlInput) || undefined,
        signal: clean(signalInput) || undefined,
      });
      setResultTitle(`Site Production Metrics (${payload.sites.length})`);
      setResultText(JSON.stringify(payload.debug, null, 2));
      toast.success("Production metrics loaded.");
    } catch (error) {
      toast.error(`Failed to load production metrics: ${toErrorMessage(error)}`);
    }
  };

  const rows: SiteProductionRow[] = productionMutation.data?.sites ?? [];
  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => {
      const haystack = `${row.siteId} ${row.siteName ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [rows, search]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, totalPages);
  const pagedRows = useMemo(() => {
    const start = (clampedPage - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, clampedPage]);

  const totals = useMemo(() => {
    let daily = 0;
    let weekly = 0;
    let monthly = 0;
    let yearly = 0;
    let lifetime = 0;
    for (const row of filteredRows) {
      daily += row.dailyKwh;
      weekly += row.weeklyKwh;
      monthly += row.monthlyKwh;
      yearly += row.yearlyKwh;
      lifetime += row.lifetimeKwh;
    }
    return { daily, weekly, monthly, yearly, lifetime };
  }, [filteredRows]);

  const exportMetricsCsv = () => {
    if (filteredRows.length === 0) {
      toast.error("No rows to export.");
      return;
    }
    const headers = [
      "site_id",
      "site_name",
      "daily_kwh",
      "weekly_kwh",
      "monthly_kwh",
      "yearly_kwh",
      "lifetime_kwh",
    ];
    const lines = [
      headers.join(","),
      ...filteredRows.map((row) =>
        [
          row.siteId,
          row.siteName,
          row.dailyKwh,
          row.weeklyKwh,
          row.monthlyKwh,
          row.yearlyKwh,
          row.lifetimeKwh,
        ]
          .map((value) => csvEscape(value))
          .join(",")
      ),
    ];
    const fileName = `tesla-powerhub-site-production-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, lines.join("\n"), "text/csv;charset=utf-8");
  };

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) return null;

  const isConnected = Boolean(statusQuery.data?.connected);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const mutationError = productionMutation.error ? toErrorMessage(productionMutation.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Tesla Powerhub API</h1>
          <p className="text-sm text-slate-600 mt-1">
            Fetch per-site production from a Tesla Powerhub group for daily, weekly, monthly, yearly, and lifetime kWh.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Tesla Powerhub</CardTitle>
            <CardDescription>
              Save client ID/client secret and API base settings. Group ID is entered per request.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-client-id">Client ID</Label>
                <Input
                  id="tesla-powerhub-client-id"
                  value={clientIdInput}
                  onChange={(event) => setClientIdInput(event.target.value)}
                  placeholder="Tesla app client ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-client-secret">Client Secret</Label>
                <Input
                  id="tesla-powerhub-client-secret"
                  type="password"
                  value={clientSecretInput}
                  onChange={(event) => setClientSecretInput(event.target.value)}
                  placeholder={
                    statusQuery.data?.hasClientSecret
                      ? "Leave blank to keep saved secret"
                      : "Tesla app client secret"
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-token-url">Token URL</Label>
                <Input
                  id="tesla-powerhub-token-url"
                  value={tokenUrlInput}
                  onChange={(event) => setTokenUrlInput(event.target.value)}
                  placeholder={DEFAULT_TOKEN_URL}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-api-base">API Base URL</Label>
                <Input
                  id="tesla-powerhub-api-base"
                  value={apiBaseUrlInput}
                  onChange={(event) => setApiBaseUrlInput(event.target.value)}
                  placeholder={DEFAULT_API_BASE_URL}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-portal-base">Portal Base URL</Label>
                <Input
                  id="tesla-powerhub-portal-base"
                  value={portalBaseUrlInput}
                  onChange={(event) => setPortalBaseUrlInput(event.target.value)}
                  placeholder={DEFAULT_PORTAL_BASE_URL}
                />
              </div>
            </div>

            {statusError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Status error: {statusError}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={handleConnect} disabled={connectMutation.isPending}>
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <PlugZap className="h-4 w-4 mr-2" />
                )}
                Connect
              </Button>
              <Button variant="outline" onClick={handleDisconnect} disabled={disconnectMutation.isPending || !isConnected}>
                {disconnectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Unplug className="h-4 w-4 mr-2" />
                )}
                Disconnect
              </Button>
              <Button variant="ghost" onClick={() => statusQuery.refetch()}>
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-slate-600">Status: {isConnected ? "Connected" : "Not connected"}</span>
              <span className="text-sm text-slate-600">
                Client secret: {statusQuery.data?.hasClientSecret ? "Saved" : "Not saved"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Site Production Metrics</CardTitle>
            <CardDescription>
              Pull per-site kWh from your group. Use the group ID from your Tesla URL and keep the signal as{" "}
              <code>{DEFAULT_SIGNAL}</code> unless your Tesla setup uses another production signal.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-group-id-query">Group ID</Label>
                <Input
                  id="tesla-powerhub-group-id-query"
                  value={groupIdInput}
                  onChange={(event) => setGroupIdInput(event.target.value)}
                  placeholder="b4b6a137-0387-4f5a-bfd0-82638a119472"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-signal">Signal</Label>
                <Input
                  id="tesla-powerhub-signal"
                  value={signalInput}
                  onChange={(event) => setSignalInput(event.target.value)}
                  placeholder={DEFAULT_SIGNAL}
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="tesla-powerhub-endpoint-override">Endpoint Override (optional)</Label>
                <Input
                  id="tesla-powerhub-endpoint-override"
                  value={endpointUrlInput}
                  onChange={(event) => setEndpointUrlInput(event.target.value)}
                  placeholder={DEFAULT_GROUP_URL}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <Button onClick={handleFetchProduction} disabled={productionMutation.isPending || !isConnected}>
                {productionMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Fetch Site Production
              </Button>
              <div className="space-y-1">
                <Label htmlFor="tesla-powerhub-search">
                  <span className="inline-flex items-center gap-1">
                    <Search className="h-4 w-4" />
                    Search Sites
                  </span>
                </Label>
                <Input
                  id="tesla-powerhub-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="site name or site ID"
                />
              </div>
              <Button variant="outline" onClick={exportMetricsCsv} disabled={filteredRows.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>

            {mutationError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Request error: {mutationError}
              </div>
            ) : null}

            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Sites</p>
                <p className="text-xl font-semibold">{COUNT_FORMATTER.format(filteredRows.length)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Daily kWh</p>
                <p className="text-xl font-semibold">{formatKwh(totals.daily)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Weekly kWh</p>
                <p className="text-xl font-semibold">{formatKwh(totals.weekly)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Monthly kWh</p>
                <p className="text-xl font-semibold">{formatKwh(totals.monthly)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Yearly kWh</p>
                <p className="text-xl font-semibold">{formatKwh(totals.yearly)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Lifetime kWh</p>
                <p className="text-xl font-semibold">{formatKwh(totals.lifetime)}</p>
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site ID</TableHead>
                  <TableHead>Site Name</TableHead>
                  <TableHead className="text-right">Daily kWh</TableHead>
                  <TableHead className="text-right">Weekly kWh</TableHead>
                  <TableHead className="text-right">Monthly kWh</TableHead>
                  <TableHead className="text-right">Yearly kWh</TableHead>
                  <TableHead className="text-right">Lifetime kWh</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedRows.map((row) => (
                  <TableRow key={row.siteId}>
                    <TableCell className="font-medium">{row.siteId}</TableCell>
                    <TableCell>{row.siteName ?? "N/A"}</TableCell>
                    <TableCell className="text-right">{formatKwh(row.dailyKwh)}</TableCell>
                    <TableCell className="text-right">{formatKwh(row.weeklyKwh)}</TableCell>
                    <TableCell className="text-right">{formatKwh(row.monthlyKwh)}</TableCell>
                    <TableCell className="text-right">{formatKwh(row.yearlyKwh)}</TableCell>
                    <TableCell className="text-right">{formatKwh(row.lifetimeKwh)}</TableCell>
                  </TableRow>
                ))}
                {pagedRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-slate-500">
                      No sites to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-slate-600">
                Showing {pagedRows.length === 0 ? 0 : (clampedPage - 1) * PAGE_SIZE + 1}-
                {Math.min(clampedPage * PAGE_SIZE, filteredRows.length)} of {COUNT_FORMATTER.format(filteredRows.length)}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clampedPage <= 1}
                  onClick={() => setPage((previous) => Math.max(1, previous - 1))}
                >
                  Previous
                </Button>
                <span className="text-sm text-slate-600">
                  Page {clampedPage} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={clampedPage >= totalPages}
                  onClick={() => setPage((previous) => Math.min(totalPages, previous + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) Raw API Debug</CardTitle>
            <CardDescription>{resultTitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-slate-950 text-slate-100 rounded-md p-4 overflow-auto max-h-[480px]">
              {resultText}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
