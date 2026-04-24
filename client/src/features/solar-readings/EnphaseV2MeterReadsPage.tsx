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
import { formatDateInput } from "@shared/dateKey";

const DEFAULT_BASE_URL = "https://api.enphaseenergy.com/api/v2";

export default function EnphaseV2MeterReadsPage() {
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
  const [userIdInput, setUserIdInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [selectedSystemId, setSelectedSystemId] = useState("");
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const statusQuery = trpc.enphaseV2.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const systemsQuery = trpc.enphaseV2.listSystems.useQuery(undefined, {
    enabled: !!user && !!statusQuery.data?.connected,
    retry: false,
  });

  const connectMutation = trpc.enphaseV2.connect.useMutation();
  const disconnectMutation = trpc.enphaseV2.disconnect.useMutation();
  const summaryMutation = trpc.enphaseV2.getSummary.useMutation();
  const energyLifetimeMutation = trpc.enphaseV2.getEnergyLifetime.useMutation();
  const rgmStatsMutation = trpc.enphaseV2.getRgmStats.useMutation();
  const productionReadsMutation = trpc.enphaseV2.getProductionMeterReadings.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.userId) setUserIdInput(statusQuery.data.userId);
    if (statusQuery.data.baseUrl) setBaseUrlInput(statusQuery.data.baseUrl);
  }, [statusQuery.data]);

  useEffect(() => {
    const firstSystem = systemsQuery.data?.systems?.[0];
    if (!firstSystem) return;
    if (!selectedSystemId) {
      setSelectedSystemId(firstSystem.systemId);
    }
  }, [systemsQuery.data, selectedSystemId]);

  const handleConnect = async () => {
    const apiKey = apiKeyInput.trim();
    const userId = userIdInput.trim();

    if (!apiKey) {
      toast.error("Enter your Enphase API key.");
      return;
    }
    if (!userId) {
      toast.error("Enter your Enphase user ID.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        apiKey,
        userId,
        baseUrl: baseUrlInput.trim() || undefined,
      });
      await trpcUtils.enphaseV2.getStatus.invalidate();
      await trpcUtils.enphaseV2.listSystems.invalidate();
      toast.success("Enphase V2 connected.");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.enphaseV2.getStatus.invalidate();
      await trpcUtils.enphaseV2.listSystems.invalidate();
      setSelectedSystemId("");
      toast.success("Enphase V2 disconnected.");
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
          <h1 className="text-2xl font-bold text-slate-900">Enphase V2 Meter Reads</h1>
          <p className="text-sm text-slate-600 mt-1">
            Key-based V2 API connection: API key + user ID. No OAuth required.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Enphase V2</CardTitle>
            <CardDescription>
              Enter your Enphase developer API key and user ID to connect.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="enphase-v2-api-key">API Key</Label>
                <Input
                  id="enphase-v2-api-key"
                  type="password"
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder="API key from Enphase developer portal"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="enphase-v2-user-id">User ID</Label>
                <Input
                  id="enphase-v2-user-id"
                  value={userIdInput}
                  onChange={(e) => setUserIdInput(e.target.value)}
                  placeholder="Enphase user/owner ID"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="enphase-v2-base-url">Base URL (optional)</Label>
                <Input
                  id="enphase-v2-base-url"
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
                  systemsQuery.refetch();
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-slate-600">
                Status: {isConnected ? "Connected" : "Not connected"}
                {isConnected && statusQuery.data?.userId && (
                  <span className="ml-1 text-slate-400">(user: {statusQuery.data.userId})</span>
                )}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Select System + Date Range</CardTitle>
            <CardDescription>
              Choose a system from the V2 systems list, then fetch data.
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
                    {systems.map((system: { systemId: string; systemName: string }) => (
                      <SelectItem key={system.systemId} value={system.systemId}>
                        {system.systemName} ({system.systemId})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="v2-start-date">Start Date</Label>
                <Input
                  id="v2-start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="v2-end-date">End Date</Label>
                <Input
                  id="v2-end-date"
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

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!selectedSystemId || isRunningAction}
                onClick={() =>
                  runAction("System Summary", () =>
                    summaryMutation.mutateAsync({ systemId: selectedSystemId })
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
                  runAction("Production Meter Readings", () =>
                    productionReadsMutation.mutateAsync({
                      systemId: selectedSystemId,
                      startDate,
                      endDate,
                    })
                  )
                }
              >
                Fetch Production Meter Readings
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
