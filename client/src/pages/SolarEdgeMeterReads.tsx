import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const DEFAULT_BASE_URL = "https://monitoringapi.solaredge.com/v2";
const TIME_UNIT_OPTIONS = ["QUARTER_OF_AN_HOUR", "HOUR", "DAY", "WEEK", "MONTH", "YEAR"] as const;

type TimeUnit = (typeof TIME_UNIT_OPTIONS)[number];

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

export default function SolarEdgeMeterReads() {
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
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [timeUnit, setTimeUnit] = useState<TimeUnit>("DAY");
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const statusQuery = trpc.solarEdge.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const sitesQuery = trpc.solarEdge.listSites.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.solarEdge.connect.useMutation();
  const disconnectMutation = trpc.solarEdge.disconnect.useMutation();
  const overviewMutation = trpc.solarEdge.getOverview.useMutation();
  const detailsMutation = trpc.solarEdge.getDetails.useMutation();
  const energyMutation = trpc.solarEdge.getEnergy.useMutation();
  const productionReadsMutation = trpc.solarEdge.getProductionMeterReadings.useMutation();
  const metersMutation = trpc.solarEdge.getMeters.useMutation();

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
    const apiKey = apiKeyInput.trim();

    if (!apiKey) {
      toast.error("Enter your SolarEdge API key.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        apiKey,
        baseUrl: baseUrlInput.trim(),
      });
      await trpcUtils.solarEdge.getStatus.invalidate();
      await trpcUtils.solarEdge.listSites.invalidate();
      toast.success("SolarEdge connected.");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.solarEdge.getStatus.invalidate();
      await trpcUtils.solarEdge.listSites.invalidate();
      setSelectedSiteId("");
      toast.success("SolarEdge disconnected.");
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
          <h1 className="text-2xl font-bold text-slate-900">SolarEdge Monitoring API</h1>
          <p className="text-sm text-slate-600 mt-1">
            API key connection for current SolarEdge monitoring endpoints.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect SolarEdge</CardTitle>
            <CardDescription>
              Save API key and optional base URL, then load sites.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="solaredge-api-key">API Key</Label>
                <Input
                  id="solaredge-api-key"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="SolarEdge monitoring API key"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="solaredge-base-url">Base API URL (advanced)</Label>
                <Input
                  id="solaredge-base-url"
                  value={baseUrlInput}
                  onChange={(e) => setBaseUrlInput(e.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                />
              </div>
            </div>

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
                Connect
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
            <CardTitle>2) Select Site + Date Range</CardTitle>
            <CardDescription>
              Pick a site from `/sites/list` or paste one manually, then fetch endpoint responses.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2 md:col-span-1">
                <Label>Site</Label>
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
                <Label htmlFor="manual-site-id">Manual Site ID (optional)</Label>
                <Input
                  id="manual-site-id"
                  value={selectedSiteId}
                  onChange={(e) => setSelectedSiteId(e.target.value.trim())}
                  placeholder="Paste site ID to bypass list loading"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="solaredge-time-unit">Time Unit</Label>
                <Select value={timeUnit} onValueChange={(value) => setTimeUnit(value as TimeUnit)}>
                  <SelectTrigger id="solaredge-time-unit">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIME_UNIT_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {option}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="start-date">Start Date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
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

            {sitesQuery.isLoading && <div className="text-sm text-slate-600">Loading sites...</div>}

            {sitesError && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Sites load error: {sitesError}
              </div>
            )}

            {!sitesQuery.isLoading && !sitesError && isConnected && sites.length === 0 && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                No sites were returned for this API key.
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Overview", () =>
                    overviewMutation.mutateAsync({
                      siteId: selectedSiteId,
                    })
                  )
                }
              >
                Fetch Site Overview
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Details", () =>
                    detailsMutation.mutateAsync({
                      siteId: selectedSiteId,
                    })
                  )
                }
              >
                Fetch Site Details
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Energy", () =>
                    energyMutation.mutateAsync({
                      siteId: selectedSiteId,
                      startDate,
                      endDate,
                      timeUnit,
                    })
                  )
                }
              >
                Fetch Site Energy
              </Button>
              <Button
                variant="outline"
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Production Meter Readings", () =>
                    productionReadsMutation.mutateAsync({
                      siteId: selectedSiteId,
                      startDate,
                      endDate,
                      timeUnit,
                    })
                  )
                }
              >
                Fetch Production Meter Readings
              </Button>
              <Button
                disabled={!selectedSiteId || isRunningAction}
                onClick={() =>
                  runAction("Site Meters", () =>
                    metersMutation.mutateAsync({
                      siteId: selectedSiteId,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch Site Meters
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
      </main>
    </div>
  );
}
