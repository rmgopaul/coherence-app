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

const DEFAULT_BASE_URL = "https://egauge.net";

type EgaugeAccessType = "public" | "user_login" | "site_login";

const ACCESS_TYPE_LABELS: Record<EgaugeAccessType, string> = {
  public: "Public Link",
  user_login: "User Login",
  site_login: "Site Login",
};

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function EGaugeApi() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const today = useMemo(() => formatDateInput(new Date()), []);
  const defaultStartDate = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() - 7);
    return formatDateInput(date);
  }, []);

  const [baseUrlInput, setBaseUrlInput] = useState(DEFAULT_BASE_URL);
  const [accessType, setAccessType] = useState<EgaugeAccessType>("public");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");

  const [registerInput, setRegisterInput] = useState("");
  const [includeRate, setIncludeRate] = useState(false);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [intervalMinutes, setIntervalMinutes] = useState("15");

  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const statusQuery = trpc.egauge.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const connectMutation = trpc.egauge.connect.useMutation();
  const disconnectMutation = trpc.egauge.disconnect.useMutation();
  const getSystemInfoMutation = trpc.egauge.getSystemInfo.useMutation();
  const getLocalDataMutation = trpc.egauge.getLocalData.useMutation();
  const getRegisterLatestMutation = trpc.egauge.getRegisterLatest.useMutation();
  const getRegisterHistoryMutation = trpc.egauge.getRegisterHistory.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.baseUrl) {
      setBaseUrlInput(statusQuery.data.baseUrl);
    }
    if (statusQuery.data.accessType) {
      setAccessType(statusQuery.data.accessType as EgaugeAccessType);
    }
    if (statusQuery.data.username) {
      setUsernameInput(statusQuery.data.username);
    }
  }, [statusQuery.data]);

  const requiresCredentials = accessType !== "public";

  const handleConnect = async () => {
    const baseUrl = baseUrlInput.trim();
    if (!baseUrl) {
      toast.error("Enter your eGauge URL.");
      return;
    }

    const username = usernameInput.trim();
    const password = passwordInput.trim();

    if (requiresCredentials && (!username || !password)) {
      toast.error("Username and password are required for user/site login.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        baseUrl,
        accessType,
        username: requiresCredentials ? username : undefined,
        password: requiresCredentials ? password : undefined,
      });

      await trpcUtils.egauge.getStatus.invalidate();
      setPasswordInput("");
      toast.success("eGauge connection saved.");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.egauge.getStatus.invalidate();
      toast.success("eGauge disconnected.");
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

  const isConnected = Boolean(statusQuery.data?.connected);
  const statusError = statusQuery.error ? toErrorMessage(statusQuery.error) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">eGauge API</h1>
          <p className="text-sm text-slate-600 mt-1">
            Supports public links, user logins, and site logins.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect eGauge</CardTitle>
            <CardDescription>
              Choose access type and save your eGauge URL + credentials (if required).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="egauge-base-url">eGauge URL</Label>
                <Input
                  id="egauge-base-url"
                  value={baseUrlInput}
                  onChange={(event) => setBaseUrlInput(event.target.value)}
                  placeholder={DEFAULT_BASE_URL}
                />
              </div>
              <div className="space-y-2">
                <Label>Access Type</Label>
                <Select value={accessType} onValueChange={(value) => setAccessType(value as EgaugeAccessType)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select access type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public Link</SelectItem>
                    <SelectItem value="user_login">User Login</SelectItem>
                    <SelectItem value="site_login">Site Login</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="egauge-username">Username</Label>
                <Input
                  id="egauge-username"
                  value={usernameInput}
                  onChange={(event) => setUsernameInput(event.target.value)}
                  placeholder="Required for user/site login"
                  disabled={!requiresCredentials}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="egauge-password">Password</Label>
                <Input
                  id="egauge-password"
                  type="password"
                  value={passwordInput}
                  onChange={(event) => setPasswordInput(event.target.value)}
                  placeholder="Required for user/site login"
                  disabled={!requiresCredentials}
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
                Save Connection
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
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-slate-600">
                Status: {isConnected ? "Connected" : "Not connected"}
              </span>
              <span className="text-sm text-slate-600">
                Mode: {ACCESS_TYPE_LABELS[(statusQuery.data?.accessType as EgaugeAccessType) ?? accessType]}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) eGauge Data Actions</CardTitle>
            <CardDescription>
              Fetch system info, local readings, and register data.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="egauge-register">Register (optional)</Label>
                <Input
                  id="egauge-register"
                  value={registerInput}
                  onChange={(event) => setRegisterInput(event.target.value)}
                  placeholder="Example: use /api/register default if blank"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="egauge-history-start">History Start</Label>
                <Input
                  id="egauge-history-start"
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="egauge-history-end">History End</Label>
                <Input
                  id="egauge-history-end"
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-2">
                <Label htmlFor="egauge-interval">History Interval (minutes)</Label>
                <Input
                  id="egauge-interval"
                  type="number"
                  min={1}
                  max={1440}
                  value={intervalMinutes}
                  onChange={(event) => setIntervalMinutes(event.target.value)}
                  className="w-40"
                />
              </div>

              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={includeRate}
                  onChange={(event) => setIncludeRate(event.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                Include rate values
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={isRunningAction || getSystemInfoMutation.isPending || !isConnected}
                onClick={() =>
                  runAction("System Info", () => getSystemInfoMutation.mutateAsync())
                }
              >
                {(isRunningAction && getSystemInfoMutation.isPending) ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Fetch System Info
              </Button>

              <Button
                variant="outline"
                disabled={isRunningAction || getLocalDataMutation.isPending || !isConnected}
                onClick={() =>
                  runAction("Local Data", () => getLocalDataMutation.mutateAsync())
                }
              >
                {(isRunningAction && getLocalDataMutation.isPending) ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Fetch Local Data
              </Button>

              <Button
                variant="outline"
                disabled={isRunningAction || getRegisterLatestMutation.isPending || !isConnected}
                onClick={() =>
                  runAction("Register Latest", () =>
                    getRegisterLatestMutation.mutateAsync({
                      register: registerInput.trim() || undefined,
                      includeRate,
                    })
                  )
                }
              >
                {(isRunningAction && getRegisterLatestMutation.isPending) ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Fetch Register Latest
              </Button>

              <Button
                variant="outline"
                disabled={isRunningAction || getRegisterHistoryMutation.isPending || !isConnected}
                onClick={() =>
                  runAction("Register History", () =>
                    getRegisterHistoryMutation.mutateAsync({
                      startDate,
                      endDate,
                      intervalMinutes: Number(intervalMinutes) > 0 ? Number(intervalMinutes) : 15,
                      register: registerInput.trim() || undefined,
                      includeRate,
                    })
                  )
                }
              >
                {(isRunningAction && getRegisterHistoryMutation.isPending) ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Fetch Register History
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3) Response</CardTitle>
            <CardDescription>{resultTitle}</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="bg-slate-950 text-slate-100 p-4 rounded-md text-xs overflow-x-auto max-h-[560px]">
              {resultText}
            </pre>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
