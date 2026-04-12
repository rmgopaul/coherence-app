import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { toErrorMessage } from "@/lib/helpers";
import { ArrowLeft, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const DEFAULT_BASE_URL = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const HISTORY_KINDS = ["energy", "power"] as const;
const HISTORY_PERIODS = ["day", "week", "month", "year", "lifetime"] as const;

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function TeslaSolarApi() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);
  const defaultStartDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 30);
    return formatDateInput(date);
  }, []);

  const [accessTokenInput, setAccessTokenInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [historyKind, setHistoryKind] = useState<(typeof HISTORY_KINDS)[number]>("energy");
  const [historyPeriod, setHistoryPeriod] = useState<(typeof HISTORY_PERIODS)[number]>("day");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const statusQuery = trpc.teslaSolar.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const sitesQuery = trpc.teslaSolar.listSites.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });
  const productsQuery = trpc.teslaSolar.listProducts.useQuery(undefined, {
    enabled: false,
    retry: false,
  });

  const connectMutation = trpc.teslaSolar.connect.useMutation();
  const disconnectMutation = trpc.teslaSolar.disconnect.useMutation();
  const liveStatusMutation = trpc.teslaSolar.getLiveStatus.useMutation();
  const siteInfoMutation = trpc.teslaSolar.getSiteInfo.useMutation();
  const historyMutation = trpc.teslaSolar.getHistory.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.baseUrl) setBaseUrlInput(statusQuery.data.baseUrl);
  }, [statusQuery.data]);

  useEffect(() => {
    const firstSite = sitesQuery.data?.sites?.[0];
    if (!firstSite) return;
    if (!selectedSiteId) {
      setSelectedSiteId(firstSite.siteId);
    }
  }, [sitesQuery.data, selectedSiteId]);

  const handleConnect = async () => {
    const accessToken = accessTokenInput.trim();
    if (!accessToken) {
      toast.error("Enter your Tesla access token.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        accessToken,
        baseUrl: baseUrlInput.trim(),
      });
      await trpcUtils.teslaSolar.getStatus.invalidate();
      await trpcUtils.teslaSolar.listSites.invalidate();
      setAccessTokenInput("");
      toast.success("Tesla Solar connected.");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.teslaSolar.getStatus.invalidate();
      await trpcUtils.teslaSolar.listSites.invalidate();
      setSelectedSiteId("");
      toast.success("Tesla Solar disconnected.");
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

  const sites = sitesQuery.data?.sites ?? [];
  const isConnected = Boolean(statusQuery.data?.connected);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;
  const sitesError = sitesQuery.error ? toErrorMessage(sitesQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Tesla Solar API</h1>
          <p className="text-sm text-slate-600 mt-1">
            Connect Tesla Fleet API, list energy sites, and fetch live status/history by site.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Tesla Solar</CardTitle>
            <CardDescription>
              Save your Tesla bearer access token and optional API base URL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tesla-access-token">Access Token</Label>
                <Input
                  id="tesla-access-token"
                  type="password"
                  value={accessTokenInput}
                  onChange={(event) => setAccessTokenInput(event.target.value)}
                  placeholder="Tesla bearer token"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-base-url">Base API URL (advanced)</Label>
                <Input
                  id="tesla-base-url"
                  value={baseUrlInput}
                  onChange={(event) => setBaseUrlInput(event.target.value)}
                  placeholder={DEFAULT_BASE_URL}
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
              <Button
                variant="ghost"
                onClick={() => {
                  statusQuery.refetch();
                  sitesQuery.refetch();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-slate-600">
                Status: {isConnected ? "Connected" : "Not connected"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Tesla Site Actions</CardTitle>
            <CardDescription>
              Select an energy site and run product/site endpoints.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label>Energy Site</Label>
                <Select value={selectedSiteId} onValueChange={setSelectedSiteId} disabled={!sites.length}>
                  <SelectTrigger>
                    <SelectValue placeholder={sites.length ? "Select a site" : "No sites loaded"} />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.siteId} value={site.siteId}>
                        {site.siteName} ({site.siteId})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>History Kind</Label>
                <Select value={historyKind} onValueChange={(value) => setHistoryKind(value as (typeof HISTORY_KINDS)[number])}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HISTORY_KINDS.map((kind) => (
                      <SelectItem key={kind} value={kind}>
                        {kind}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>History Period</Label>
                <Select
                  value={historyPeriod}
                  onValueChange={(value) => setHistoryPeriod(value as (typeof HISTORY_PERIODS)[number])}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HISTORY_PERIODS.map((period) => (
                      <SelectItem key={period} value={period}>
                        {period}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tesla-start-date">Start Date</Label>
                <Input
                  id="tesla-start-date"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-end-date">End Date</Label>
                <Input
                  id="tesla-end-date"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
            </div>

            {sitesQuery.isLoading ? <div className="text-sm text-slate-600">Loading sites...</div> : null}
            {sitesError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Sites error: {sitesError}
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={isRunningAction || !isConnected}
                onClick={() =>
                  runAction("Products", async () => {
                    const result = await productsQuery.refetch();
                    if (result.error) throw result.error;
                    return result.data ?? {};
                  })
                }
              >
                Fetch Products
              </Button>
              <Button
                variant="outline"
                disabled={isRunningAction || !selectedSiteId}
                onClick={() =>
                  runAction("Site Info", () =>
                    siteInfoMutation.mutateAsync({
                      siteId: selectedSiteId,
                    })
                  )
                }
              >
                Fetch Site Info
              </Button>
              <Button
                variant="outline"
                disabled={isRunningAction || !selectedSiteId}
                onClick={() =>
                  runAction("Live Status", () =>
                    liveStatusMutation.mutateAsync({
                      siteId: selectedSiteId,
                    })
                  )
                }
              >
                Fetch Live Status
              </Button>
              <Button
                disabled={isRunningAction || !selectedSiteId}
                onClick={() =>
                  runAction("History", () =>
                    historyMutation.mutateAsync({
                      siteId: selectedSiteId,
                      kind: historyKind,
                      period: historyPeriod,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch History
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) Raw API Response</CardTitle>
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
