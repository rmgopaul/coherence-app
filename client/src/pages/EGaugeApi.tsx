import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { buildConvertedReadRow, pushConvertedReadsToRecDashboard } from "@/lib/convertedReads";
import { toErrorMessage, downloadTextFile } from "@/lib/helpers";
import { ArrowLeft, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const EGAUGE_METER_URL_PLACEHOLDER = "https://YOUR-METER.d.egauge.net";
const EGAUGE_PORTFOLIO_URL_PLACEHOLDER = "https://www.egauge.net";

type EgaugeAccessType = "public" | "user_login" | "site_login" | "portfolio_login";

const ACCESS_TYPE_LABELS: Record<EgaugeAccessType, string> = {
  public: "Public Link",
  user_login: "Credentialed Login",
  site_login: "Credentialed Login",
  portfolio_login: "Portfolio Login",
};

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

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

  const [connectionNameInput, setConnectionNameInput] = useState("");
  const [meterIdInput, setMeterIdInput] = useState("");
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [accessType, setAccessType] = useState<EgaugeAccessType>("public");
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");

  const [registerInput, setRegisterInput] = useState("");
  const [includeRate, setIncludeRate] = useState(false);
  const [startDate, setStartDate] = useState(defaultStartDate);
  const [endDate, setEndDate] = useState(today);
  const [intervalMinutes, setIntervalMinutes] = useState("15");
  const [portfolioFilter, setPortfolioFilter] = useState("");
  const [portfolioGroupId, setPortfolioGroupId] = useState("");

  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");
  const [isRunningAction, setIsRunningAction] = useState(false);

  const statusQuery = trpc.egauge.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const connectMutation = trpc.egauge.connect.useMutation();
  const setActiveConnectionMutation = trpc.egauge.setActiveConnection.useMutation();
  const removeConnectionMutation = trpc.egauge.removeConnection.useMutation();
  const disconnectMutation = trpc.egauge.disconnect.useMutation();
  const getSystemInfoMutation = trpc.egauge.getSystemInfo.useMutation();
  const getLocalDataMutation = trpc.egauge.getLocalData.useMutation();
  const getRegisterLatestMutation = trpc.egauge.getRegisterLatest.useMutation();
  const getRegisterHistoryMutation = trpc.egauge.getRegisterHistory.useMutation();
  const getPortfolioSystemsMutation = trpc.egauge.getPortfolioSystems.useMutation();
  const bulkSnapshotsMutation = trpc.egauge.getProductionSnapshots.useMutation();
  const getRemoteDataset = trpc.solarRecDashboard.getDataset.useMutation();
  const saveRemoteDataset = trpc.solarRecDashboard.saveDataset.useMutation();

  type BulkSnapshotRow = { meterId: string; meterName: string | null; status: string; found: boolean; lifetimeKwh: number | null; anchorDate: string; error: string | null };
  const [bulkMeterIdsCsv, setBulkMeterIdsCsv] = useState("");
  const [bulkIsRunning, setBulkIsRunning] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkSnapshotRow[]>([]);

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    const availableIds = new Set((statusQuery.data.connections ?? []).map((connection) => connection.id));
    if (availableIds.size === 0) {
      setSelectedConnectionId("");
      return;
    }

    setSelectedConnectionId((current) => {
      if (current && availableIds.has(current)) return current;
      return statusQuery.data?.activeConnectionId ?? statusQuery.data.connections[0]?.id ?? "";
    });
  }, [statusQuery.data]);

  useEffect(() => {
    if (!statusQuery.data?.connections?.length) return;
    const selected =
      statusQuery.data.connections.find((connection) => connection.id === selectedConnectionId) ??
      statusQuery.data.connections.find((connection) => connection.isActive) ??
      statusQuery.data.connections[0];
    if (!selected) return;

    setConnectionNameInput(selected.name ?? "");
    setMeterIdInput(selected.meterId ?? "");
    setBaseUrlInput(selected.baseUrl ?? "");
    setAccessType(selected.accessType as EgaugeAccessType);
    setUsernameInput(selected.username ?? "");
    setPasswordInput("");
  }, [selectedConnectionId, statusQuery.data]);

  const connections = statusQuery.data?.connections ?? [];
  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId);
  const activeConnection = connections.find((connection) => connection.isActive);
  const requiresCredentials = accessType !== "public";
  const formIsPortfolioAccess = accessType === "portfolio_login";
  const activeIsPortfolioAccess = (activeConnection?.accessType as EgaugeAccessType | undefined) === "portfolio_login";
  const baseUrlPlaceholder = formIsPortfolioAccess ? EGAUGE_PORTFOLIO_URL_PLACEHOLDER : EGAUGE_METER_URL_PLACEHOLDER;

  const handleConnect = async () => {
    const baseUrl = baseUrlInput.trim();
    if (!baseUrl) {
      toast.error(`Enter your eGauge URL (example: ${baseUrlPlaceholder}).`);
      return;
    }

    const username = usernameInput.trim();
    const password = passwordInput.trim();
    const submitAccessType = accessType === "site_login" ? "user_login" : accessType;
    const hasSavedPassword = Boolean(selectedConnection?.hasPassword);

    if (requiresCredentials && !username) {
      toast.error("Username is required for credentialed login.");
      return;
    }

    if (requiresCredentials && !password && !hasSavedPassword) {
      toast.error("Password is required for credentialed login.");
      return;
    }

    try {
      const response = await connectMutation.mutateAsync({
        connectionName: connectionNameInput.trim() || undefined,
        meterId: meterIdInput.trim() || undefined,
        baseUrl,
        accessType: submitAccessType,
        username: requiresCredentials ? username : undefined,
        password: requiresCredentials ? (password || undefined) : undefined,
      });

      await trpcUtils.egauge.getStatus.invalidate();
      setSelectedConnectionId(response.activeConnectionId);
      setPasswordInput("");
      toast.success(
        `eGauge profile saved. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) stored.`
      );
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleSetActiveConnection = async () => {
    const connectionId = selectedConnectionId.trim();
    if (!connectionId) {
      toast.error("Select a meter profile first.");
      return;
    }

    try {
      await setActiveConnectionMutation.mutateAsync({ connectionId });
      await trpcUtils.egauge.getStatus.invalidate();
      toast.success("Active eGauge profile updated.");
    } catch (error) {
      toast.error(`Failed to switch profile: ${toErrorMessage(error)}`);
    }
  };

  const handleRemoveConnection = async () => {
    const connectionId = selectedConnectionId.trim();
    if (!connectionId) {
      toast.error("Select a meter profile first.");
      return;
    }

    try {
      const response = await removeConnectionMutation.mutateAsync({ connectionId });
      await trpcUtils.egauge.getStatus.invalidate();
      setSelectedConnectionId(response.activeConnectionId ?? "");
      toast.success(
        response.connected
          ? `Removed profile. ${NUMBER_FORMATTER.format(response.totalConnections)} profile(s) remain.`
          : "Removed final profile. eGauge is now disconnected."
      );
    } catch (error) {
      toast.error(`Failed to remove profile: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.egauge.getStatus.invalidate();
      setSelectedConnectionId("");
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

  const parseBulkMeterIds = (): string[] =>
    Array.from(
      new Set(
        bulkMeterIdsCsv
          .split(/[\n,]+/)
          .map((value) => value.trim().toLowerCase())
          .filter((value) => value.length > 0)
      )
    );

  const handlePullAllPortfolioIds = async () => {
    if (!isConnected) {
      toast.error("Connect eGauge first.");
      return;
    }
    if (!activeIsPortfolioAccess) {
      toast.error("Switch Active Mode to Portfolio Login first.");
      return;
    }

    setBulkIsRunning(true);
    try {
      const result = await getPortfolioSystemsMutation.mutateAsync({
        filter: portfolioFilter.trim() || undefined,
        groupId: portfolioGroupId.trim() || undefined,
      });
      const ids = Array.from(
        new Set(
          (result.rows ?? [])
            .map((row) => (typeof row?.meterId === "string" ? row.meterId.trim().toLowerCase() : ""))
            .filter((value) => value.length > 0)
        )
      );
      setBulkMeterIdsCsv(ids.join("\n"));
      toast.success(
        `Fetched ${NUMBER_FORMATTER.format(ids.length)} eGauge IDs from portfolio. Next step: run bulk snapshots.`
      );
    } catch (error) {
      toast.error(`Failed to fetch portfolio IDs: ${toErrorMessage(error)}`);
    } finally {
      setBulkIsRunning(false);
    }
  };

  const handleRunBulkSnapshots = async () => {
    const ids = parseBulkMeterIds();
    const shouldAutoFetchPortfolio = activeIsPortfolioAccess && ids.length === 0;

    if (!shouldAutoFetchPortfolio && ids.length === 0) {
      toast.error(
        activeIsPortfolioAccess
          ? "Click \"Fetch All Portfolio IDs\" first, or keep IDs blank to auto-fetch during run."
          : "Enter at least one meter ID."
      );
      return;
    }

    setBulkIsRunning(true);
    setBulkRows([]);
    try {
      const result = await bulkSnapshotsMutation.mutateAsync({
        meterIds: ids.length > 0 ? ids : undefined,
        autoFetchPortfolioIds: shouldAutoFetchPortfolio ? true : undefined,
        filter: activeIsPortfolioAccess ? portfolioFilter.trim() || undefined : undefined,
        groupId: activeIsPortfolioAccess ? portfolioGroupId.trim() || undefined : undefined,
      });
      const rows = result.rows as BulkSnapshotRow[];
      setBulkRows(rows);

      if (activeIsPortfolioAccess && Array.isArray(result.meterIdsUsed)) {
        const normalizedIds = result.meterIdsUsed
          .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
          .filter((value) => value.length > 0);
        if (normalizedIds.length > 0) {
          setBulkMeterIdsCsv(Array.from(new Set(normalizedIds)).join("\n"));
        }
      }

      toast.success(
        `Completed eGauge bulk snapshots: ${result.found} found, ${result.notFound} not found, ${result.errored} errors.`
      );

      const readRows = rows
        .filter((row) => row.found && row.lifetimeKwh != null)
        .map((row) =>
          buildConvertedReadRow("eGauge", row.meterId, row.meterName ?? "", row.lifetimeKwh!, row.anchorDate)
        );
      const pushResult = await pushConvertedReadsToRecDashboard(
        (input) => getRemoteDataset.mutateAsync(input),
        (input) => saveRemoteDataset.mutateAsync(input),
        readRows,
        "eGauge"
      );
      if (pushResult.pushed > 0) {
        toast.success(
          `Pushed ${pushResult.pushed} eGauge rows to Solar REC Dashboard Converted Reads.${pushResult.skipped > 0 ? ` ${pushResult.skipped} duplicates skipped.` : ""}`
        );
      } else if (pushResult.skipped > 0) {
        toast.message(`All ${pushResult.skipped} eGauge Converted Reads rows already exist.`);
      }
    } catch (error) {
      toast.error(`Bulk snapshots failed: ${toErrorMessage(error)}`);
    } finally {
      setBulkIsRunning(false);
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
            Meter profiles support Public Link or Credentialed Login. Portfolio Login is available for account-wide system listing.
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect eGauge</CardTitle>
            <CardDescription>
              Save many meter profiles (hundreds of unique meter IDs). Use Public Link or Credentialed Login per meter.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="space-y-2">
                <Label htmlFor="egauge-connection-name">Profile Name (optional)</Label>
                <Input
                  id="egauge-connection-name"
                  value={connectionNameInput}
                  onChange={(event) => setConnectionNameInput(event.target.value)}
                  placeholder="Example: North Portfolio Meter A"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="egauge-meter-id">Meter ID (optional)</Label>
                <Input
                  id="egauge-meter-id"
                  value={meterIdInput}
                  onChange={(event) => setMeterIdInput(event.target.value)}
                  placeholder="Example: egauge12345"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="egauge-base-url">eGauge URL</Label>
                <Input
                  id="egauge-base-url"
                  value={baseUrlInput}
                  onChange={(event) => setBaseUrlInput(event.target.value)}
                  placeholder={baseUrlPlaceholder}
                />
                <p className="text-xs text-slate-500">
                  {formIsPortfolioAccess ? (
                    <>
                      Portfolio login URL example: <span className="font-mono">{EGAUGE_PORTFOLIO_URL_PLACEHOLDER}</span>
                    </>
                  ) : (
                    <>
                      Meter URL example: <span className="font-mono">{EGAUGE_METER_URL_PLACEHOLDER}</span>
                    </>
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label>Access Type</Label>
                <Select
                  value={accessType === "site_login" ? "user_login" : accessType}
                  onValueChange={(value) => setAccessType(value as EgaugeAccessType)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select access type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public Link</SelectItem>
                    <SelectItem value="user_login">Credentialed Login</SelectItem>
                    <SelectItem value="portfolio_login">Portfolio Login</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="egauge-username">Username</Label>
                <Input
                  id="egauge-username"
                  value={usernameInput}
                  onChange={(event) => setUsernameInput(event.target.value)}
                  placeholder="Required for credentialed login"
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
                  placeholder={
                    requiresCredentials
                      ? (selectedConnection?.hasPassword ? "Leave blank to keep saved password" : "Required for credentialed login")
                      : "Not required for public link"
                  }
                  disabled={!requiresCredentials}
                />
              </div>
            </div>

            {connections.length > 0 ? (
              <div className="rounded-lg border bg-slate-50/70 p-4 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="space-y-2 md:col-span-2">
                    <Label>Saved Meter Profiles</Label>
                    <Select value={selectedConnectionId} onValueChange={setSelectedConnectionId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select saved meter profile" />
                      </SelectTrigger>
                      <SelectContent>
                        {connections.map((connection) => (
                          <SelectItem key={connection.id} value={connection.id}>
                            {connection.name} ({connection.meterId})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      onClick={handleSetActiveConnection}
                      disabled={!selectedConnectionId || setActiveConnectionMutation.isPending}
                    >
                      {setActiveConnectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Set Active
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleRemoveConnection}
                      disabled={!selectedConnectionId || removeConnectionMutation.isPending}
                    >
                      {removeConnectionMutation.isPending ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : null}
                      Remove Profile
                    </Button>
                  </div>
                </div>

                <div className="text-xs text-slate-600">
                  {NUMBER_FORMATTER.format(connections.length)} profile(s) saved. Active profile:{" "}
                  <span className="font-medium text-slate-900">{activeConnection?.name ?? "N/A"}</span>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {connections.map((connection) => (
                    <div
                      key={connection.id}
                      className={`rounded-md border px-3 py-2 text-xs ${
                        connection.isActive
                          ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                          : "border-slate-200 bg-white text-slate-700"
                      }`}
                    >
                      <p className="font-medium">{connection.name}</p>
                      <p>Meter ID: {connection.meterId}</p>
                      <p>Access: {ACCESS_TYPE_LABELS[connection.accessType as EgaugeAccessType] ?? connection.accessType}</p>
                      <p>Username: {connection.username ?? "N/A"}</p>
                      <p>URL: {connection.baseUrl}</p>
                      <p>Updated: {new Date(connection.updatedAt).toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

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
                Status: {isConnected ? `Connected (${connections.length} profile${connections.length === 1 ? "" : "s"})` : "Not connected"}
              </span>
              <span className="text-sm text-slate-600">
                Active Mode: {activeConnection ? ACCESS_TYPE_LABELS[activeConnection.accessType as EgaugeAccessType] : ACCESS_TYPE_LABELS[accessType]}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) eGauge Data Actions</CardTitle>
            <CardDescription>
              {activeIsPortfolioAccess
                ? "Fetch all systems available from your eGauge portfolio login."
                : "Fetch system info, local readings, and register data from one meter."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {activeIsPortfolioAccess ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="egauge-portfolio-filter">Portfolio Filter (optional)</Label>
                  <Input
                    id="egauge-portfolio-filter"
                    value={portfolioFilter}
                    onChange={(event) => setPortfolioFilter(event.target.value)}
                    placeholder="Filter by name/group/job (as supported by eGuard)"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="egauge-portfolio-group">Group ID (optional)</Label>
                  <Input
                    id="egauge-portfolio-group"
                    value={portfolioGroupId}
                    onChange={(event) => setPortfolioGroupId(event.target.value)}
                    placeholder="Optional eGuard group ID"
                  />
                </div>
              </div>
            ) : (
              <>
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
              </>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={isRunningAction || getPortfolioSystemsMutation.isPending || !isConnected || !activeIsPortfolioAccess}
                onClick={() =>
                  runAction("Portfolio Systems", () =>
                    getPortfolioSystemsMutation.mutateAsync({
                      filter: portfolioFilter.trim() || undefined,
                      groupId: portfolioGroupId.trim() || undefined,
                    })
                  )
                }
              >
                {(isRunningAction && getPortfolioSystemsMutation.isPending) ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Fetch Portfolio Systems
              </Button>

              <Button
                variant="outline"
                disabled={isRunningAction || getSystemInfoMutation.isPending || !isConnected || activeIsPortfolioAccess}
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
                disabled={isRunningAction || getLocalDataMutation.isPending || !isConnected || activeIsPortfolioAccess}
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
                disabled={isRunningAction || getRegisterLatestMutation.isPending || !isConnected || activeIsPortfolioAccess}
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
                disabled={isRunningAction || getRegisterHistoryMutation.isPending || !isConnected || activeIsPortfolioAccess}
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

        <Card>
          <CardHeader>
            <CardTitle>4) Bulk Production Snapshots</CardTitle>
            <CardDescription>
              {activeIsPortfolioAccess
                ? "Portfolio mode: fetch all eGauge IDs in your account, then run a bulk lifetime kWh pull. Results auto-push to Solar REC Dashboard Converted Reads."
                : "Enter meter IDs (one per line) matching your saved connections to fetch lifetime production. Results auto-push to Solar REC Dashboard Converted Reads."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>{activeIsPortfolioAccess ? "eGauge IDs (optional override)" : "Meter IDs (one per line)"}</Label>
              <textarea
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                value={bulkMeterIdsCsv}
                onChange={(e) => setBulkMeterIdsCsv(e.target.value)}
                placeholder={
                  activeIsPortfolioAccess
                    ? "Leave blank to auto-fetch all IDs from your portfolio, or paste specific IDs"
                    : "egauge12345\negauge67890"
                }
                disabled={bulkIsRunning}
              />
              <p className="mt-1 text-xs text-slate-500">
                {activeIsPortfolioAccess
                  ? "Step 1: Fetch portfolio IDs. Step 2: Run bulk snapshots for lifetime kWh."
                  : "Use saved meter profiles or paste IDs manually."}
              </p>
              {!activeIsPortfolioAccess && statusQuery.data?.connections && statusQuery.data.connections.length > 0 && (
                <Button
                  variant="link"
                  size="sm"
                  className="mt-1 px-0"
                  onClick={() => {
                    const ids = statusQuery.data!.connections.map((c: { meterId: string }) => c.meterId).join("\n");
                    setBulkMeterIdsCsv(ids);
                  }}
                >
                  Use all saved meter IDs ({statusQuery.data.connections.length})
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {activeIsPortfolioAccess ? (
                <Button
                  variant="outline"
                  onClick={handlePullAllPortfolioIds}
                  disabled={bulkIsRunning || !statusQuery.data?.connected}
                >
                  {bulkIsRunning && getPortfolioSystemsMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Fetch All Portfolio IDs
                </Button>
              ) : null}
              <Button
                onClick={handleRunBulkSnapshots}
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
                    const headers = ["meter_id", "meter_name", "status", "lifetime_kwh", "anchor_date", "error"];
                    const csvLines = [
                      headers.join(","),
                      ...bulkRows.map((row) =>
                        [row.meterId, `"${(row.meterName ?? "").replace(/"/g, '""')}"`, row.status, row.lifetimeKwh ?? "", row.anchorDate, `"${(row.error ?? "").replace(/"/g, '""')}"`].join(",")
                      ),
                    ];
                    downloadTextFile(
                      `egauge-bulk-snapshots-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`,
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
                      <th className="text-left p-2">Meter ID</th>
                      <th className="text-left p-2">Meter Name</th>
                      <th className="text-left p-2">Status</th>
                      <th className="text-left p-2">Lifetime (kWh)</th>
                      <th className="text-left p-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map((row) => (
                      <tr key={row.meterId} className="border-b">
                        <td className="p-2 font-mono">{row.meterId}</td>
                        <td className="p-2">{row.meterName ?? "N/A"}</td>
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
