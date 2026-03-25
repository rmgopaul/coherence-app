import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import { toErrorMessage, clean, downloadTextFile } from "@/lib/helpers";
import { ArrowLeft, Download, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");
type PeriodPreset = "all" | "last_7_days" | "last_30_days" | "last_90_days" | "custom";

function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(input: string, deltaDays: number): string {
  const [year, month, day] = input.split("-").map((value) => Number(value));
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + deltaDays);
  return formatDateInput(date);
}

function csvEscape(value: string | number | null | undefined): string {
  const normalized = value === null || value === undefined ? "" : String(value);
  if (/["\n,]/.test(normalized)) {
    return `"${normalized.replaceAll('"', '""')}"`;
  }
  return normalized;
}

export default function ZendeskTicketMetrics() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();
  const today = useMemo(() => formatDateInput(new Date()), []);
  const defaultStartDate = useMemo(() => shiftDate(today, -29), [today]);

  const [subdomainInput, setSubdomainInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [maxTicketsInput, setMaxTicketsInput] = useState("10000");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("last_30_days");
  const [periodStartDateInput, setPeriodStartDateInput] = useState(defaultStartDate);
  const [periodEndDateInput, setPeriodEndDateInput] = useState(today);
  const [trackedUsersInput, setTrackedUsersInput] = useState("");
  const [trackedUsersOnly, setTrackedUsersOnly] = useState(false);
  const [search, setSearch] = useState("");

  const statusQuery = trpc.zendesk.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const connectMutation = trpc.zendesk.connect.useMutation();
  const saveTrackedUsersMutation = trpc.zendesk.saveTrackedUsers.useMutation();
  const disconnectMutation = trpc.zendesk.disconnect.useMutation();
  const metricsMutation = trpc.zendesk.getTicketMetrics.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.subdomain) setSubdomainInput(statusQuery.data.subdomain);
    if (statusQuery.data.email) setEmailInput(statusQuery.data.email);
    setTrackedUsersInput((statusQuery.data.trackedUsers ?? []).join("\n"));
    if ((statusQuery.data.trackedUsers ?? []).length > 0) {
      setTrackedUsersOnly(true);
    }
  }, [statusQuery.data]);

  const parseTrackedUsersInput = (): string[] => {
    return trackedUsersInput
      .split(/\r?\n|,/g)
      .map((value) => clean(value))
      .filter((value) => value.length > 0)
      .map((value) => value.toLowerCase())
      .filter((value, index, array) => array.indexOf(value) === index);
  };

  const resolvePeriodRange = (): { periodStartDate?: string; periodEndDate?: string } => {
    if (periodPreset === "all") return {};
    if (periodPreset === "custom") {
      const start = clean(periodStartDateInput);
      const end = clean(periodEndDateInput);
      if (!start || !end) {
        throw new Error("Choose both start and end dates for custom period.");
      }
      return {
        periodStartDate: start,
        periodEndDate: end,
      };
    }

    const end = today;
    const start =
      periodPreset === "last_7_days"
        ? shiftDate(end, -6)
        : periodPreset === "last_30_days"
          ? shiftDate(end, -29)
          : shiftDate(end, -89);

    return {
      periodStartDate: start,
      periodEndDate: end,
    };
  };

  const handleSaveTrackedUsers = async () => {
    if (!isConnected) {
      toast.error("Connect Zendesk before saving tracked users.");
      return;
    }
    const users = parseTrackedUsersInput();
    try {
      const response = await saveTrackedUsersMutation.mutateAsync({ users });
      setTrackedUsersInput(response.trackedUsers.join("\n"));
      await trpcUtils.zendesk.getStatus.invalidate();
      toast.success(`Saved ${NUMBER_FORMATTER.format(response.trackedUsers.length)} tracked user(s).`);
    } catch (error) {
      toast.error(`Failed to save tracked users: ${toErrorMessage(error)}`);
    }
  };

  const runMetricsLoad = async () => {
    const maxTicketsRaw = Number(maxTicketsInput);
    const maxTickets = Number.isFinite(maxTicketsRaw) ? Math.floor(maxTicketsRaw) : NaN;
    if (!Number.isFinite(maxTickets) || maxTickets < 100 || maxTickets > 50000) {
      toast.error("Max tickets must be between 100 and 50000.");
      return;
    }

    try {
      const range = resolvePeriodRange();
      await metricsMutation.mutateAsync({
        maxTickets,
        periodStartDate: range.periodStartDate,
        periodEndDate: range.periodEndDate,
        trackedUsersOnly,
      });
      toast.success("Zendesk metrics loaded.");
    } catch (error) {
      toast.error(`Failed to load metrics: ${toErrorMessage(error)}`);
    }
  };

  const handleConnect = async () => {
    const subdomain = clean(subdomainInput);
    const email = clean(emailInput);
    const apiToken = clean(apiTokenInput);

    if (!subdomain) {
      toast.error("Enter your Zendesk subdomain.");
      return;
    }
    if (!email) {
      toast.error("Enter your Zendesk email.");
      return;
    }
    if (!apiToken) {
      toast.error("Enter your Zendesk API token.");
      return;
    }

    try {
      await connectMutation.mutateAsync({
        subdomain,
        email,
        apiToken,
      });
      await trpcUtils.zendesk.getStatus.invalidate();
      toast.success("Zendesk connected.");
      setApiTokenInput("");
    } catch (error) {
      toast.error(`Failed to connect: ${toErrorMessage(error)}`);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      await trpcUtils.zendesk.getStatus.invalidate();
      metricsMutation.reset();
      toast.success("Zendesk disconnected.");
    } catch (error) {
      toast.error(`Failed to disconnect: ${toErrorMessage(error)}`);
    }
  };

  const filteredUsers = useMemo(() => {
    const users = metricsMutation.data?.users ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((row) => {
      const haystack = `${row.name} ${row.email ?? ""} ${row.userId ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [metricsMutation.data?.users, search]);

  const filteredResolverUsers = useMemo(() => {
    const users = metricsMutation.data?.resolverUsers ?? [];
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((row) => {
      const haystack = `${row.name} ${row.email ?? ""} ${row.userId ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [metricsMutation.data?.resolverUsers, search]);

  const exportUsersCsv = () => {
    const rows = filteredUsers;
    if (rows.length === 0) {
      toast.error("No rows to export.");
      return;
    }

    const headers = [
      "user_id",
      "name",
      "email",
      "role",
      "assigned",
      "active",
      "new",
      "open",
      "pending",
      "hold",
      "solved",
      "closed",
    ];
    const lines = [
      headers.join(","),
      ...rows.map((row) =>
        [
          row.userId,
          row.name,
          row.email,
          row.role,
          row.assigned,
          row.new + row.open + row.pending + row.hold,
          row.new,
          row.open,
          row.pending,
          row.hold,
          row.solved,
          row.closed,
        ]
          .map((value) => csvEscape(value))
          .join(",")
      ),
    ];
    const fileName = `zendesk-ticket-metrics-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
    downloadTextFile(fileName, lines.join("\n"), "text/csv;charset=utf-8");
  };

  const exportResolverUsersCsv = () => {
    const rows = filteredResolverUsers;
    if (rows.length === 0) {
      toast.error("No resolver rows to export.");
      return;
    }

    const headers = ["user_id", "name", "email", "role", "solved_actions", "closed_actions", "resolved_actions"];
    const lines = [
      headers.join(","),
      ...rows.map((row) =>
        [row.userId, row.name, row.email, row.role, row.solvedActions, row.closedActions, row.resolvedActions]
          .map((value) => csvEscape(value))
          .join(",")
      ),
    ];
    const fileName = `zendesk-resolver-actions-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
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
  const metrics = metricsMutation.data;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-emerald-50">
      <header className="border-b bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Dashboard
          </Button>
          <h1 className="text-2xl font-bold text-slate-900">Zendesk Ticket Metrics</h1>
          <p className="text-sm text-slate-600 mt-1">
            Per-user assignee status counts plus true resolver action counts (who changed status to solved/closed).
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Zendesk</CardTitle>
            <CardDescription>
              Save your Zendesk subdomain, account email, API token, and tracked-user list.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="zendesk-subdomain">Subdomain</Label>
                <Input
                  id="zendesk-subdomain"
                  value={subdomainInput}
                  onChange={(event) => setSubdomainInput(event.target.value)}
                  placeholder="your-company (or full Zendesk URL)"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zendesk-email">Email</Label>
                <Input
                  id="zendesk-email"
                  value={emailInput}
                  onChange={(event) => setEmailInput(event.target.value)}
                  placeholder="agent@company.com"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zendesk-api-token">API Token</Label>
                <Input
                  id="zendesk-api-token"
                  type="password"
                  value={apiTokenInput}
                  onChange={(event) => setApiTokenInput(event.target.value)}
                  placeholder="Zendesk API token"
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
                }}
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
              <span className="text-sm text-slate-600">
                Status: {isConnected ? "Connected" : "Not connected"}
              </span>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="zendesk-tracked-users">Tracked Users (persisted)</Label>
                <span className="text-xs text-slate-500">
                  Saved: {NUMBER_FORMATTER.format(statusQuery.data?.trackedUsers?.length ?? 0)}
                </span>
              </div>
              <Textarea
                id="zendesk-tracked-users"
                value={trackedUsersInput}
                onChange={(event) => setTrackedUsersInput(event.target.value)}
                placeholder={"One user per line:\n- user email (agent@company.com)\n- or Zendesk user ID (123456789)"}
                rows={6}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  onClick={handleSaveTrackedUsers}
                  disabled={saveTrackedUsersMutation.isPending || !isConnected}
                >
                  {saveTrackedUsersMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Save Tracked Users
                </Button>
                <span className="text-xs text-slate-500">
                  Use this to keep the same user list every time you reload.
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Ticket Metrics by Assignee</CardTitle>
            <CardDescription>
              Load assignee status counts and true resolver actions (who changed status to solved/closed).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
              <div className="space-y-2">
                <Label htmlFor="zendesk-max-tickets">Max Tickets to Scan</Label>
                <Input
                  id="zendesk-max-tickets"
                  type="number"
                  value={maxTicketsInput}
                  onChange={(event) => setMaxTicketsInput(event.target.value)}
                  min={100}
                  max={50000}
                />
                <p className="text-xs text-slate-500">Higher values include more history but take longer.</p>
              </div>
              <div className="space-y-2">
                <Label>Time Period</Label>
                <Select value={periodPreset} onValueChange={(value) => setPeriodPreset(value as PeriodPreset)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Time</SelectItem>
                    <SelectItem value="last_7_days">Last 7 Days</SelectItem>
                    <SelectItem value="last_30_days">Last 30 Days</SelectItem>
                    <SelectItem value="last_90_days">Last 90 Days</SelectItem>
                    <SelectItem value="custom">Custom Range</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="zendesk-period-start">Start Date</Label>
                <Input
                  id="zendesk-period-start"
                  type="date"
                  value={periodStartDateInput}
                  onChange={(event) => setPeriodStartDateInput(event.target.value)}
                  disabled={periodPreset !== "custom"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zendesk-period-end">End Date</Label>
                <Input
                  id="zendesk-period-end"
                  type="date"
                  value={periodEndDateInput}
                  onChange={(event) => setPeriodEndDateInput(event.target.value)}
                  disabled={periodPreset !== "custom"}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zendesk-search">Search User</Label>
                <Input
                  id="zendesk-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter by name, email, or user ID"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-6">
              <div className="flex items-center gap-2">
                <Switch
                  id="zendesk-tracked-users-only"
                  checked={trackedUsersOnly}
                  onCheckedChange={setTrackedUsersOnly}
                />
                <Label htmlFor="zendesk-tracked-users-only">Tracked users only</Label>
              </div>
              <div className="flex items-end gap-2">
                <Button onClick={runMetricsLoad} disabled={metricsMutation.isPending || !isConnected}>
                  {metricsMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Load Metrics
                </Button>
                <Button variant="outline" onClick={exportUsersCsv} disabled={filteredUsers.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Export Assignee CSV
                </Button>
                <Button variant="outline" onClick={exportResolverUsersCsv} disabled={filteredResolverUsers.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Export Resolver CSV
                </Button>
              </div>
            </div>

            {metricsMutation.error ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Metrics error: {toErrorMessage(metricsMutation.error)}
              </div>
            ) : null}

            <div className="grid grid-cols-2 md:grid-cols-11 gap-3">
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Assigned (Total)</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.assigned ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Assigned (Active)</p>
                <p className="text-xl font-semibold">
                  {NUMBER_FORMATTER.format(
                    (metrics?.totals.new ?? 0) +
                      (metrics?.totals.open ?? 0) +
                      (metrics?.totals.pending ?? 0) +
                      (metrics?.totals.hold ?? 0)
                  )}
                </p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">New</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.new ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Open</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.open ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Pending</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.pending ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Solved</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.solved ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Closed</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.closed ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Unassigned</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.unassigned ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Solved Actions</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.resolverTotals.solvedActions ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Closed Actions</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.resolverTotals.closedActions ?? 0)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Resolved Actions</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.resolverTotals.resolvedActions ?? 0)}</p>
              </div>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                Tickets scanned: {NUMBER_FORMATTER.format(metrics?.ticketCount ?? 0)} (max {NUMBER_FORMATTER.format(metrics?.maxTickets ?? 0)})
              </span>
              <span>
                Period: {metrics?.periodStartDate ?? "Earliest"} to {metrics?.periodEndDate ?? "Now"}
              </span>
              <span>
                {metrics?.generatedAt ? `Generated ${new Date(metrics.generatedAt).toLocaleString()}` : "No run yet"}
              </span>
            </div>

            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>Resolver actions counted: {NUMBER_FORMATTER.format(metrics?.resolverActionCount ?? 0)}</span>
              <span>
                {metrics?.periodStartDate
                  ? "Resolver actions are based on status-change events in this date window."
                  : "Resolver actions require a period start date."}
              </span>
            </div>

            {metrics?.truncated ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Result reached max ticket cap. Increase Max Tickets if you need complete historical totals.
              </div>
            ) : null}

            {metrics?.resolverTruncated ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Resolver action result reached scan cap. Increase Max Tickets to allow scanning more events.
              </div>
            ) : null}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Assigned</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead>New</TableHead>
                  <TableHead>Open</TableHead>
                  <TableHead>Pending</TableHead>
                  <TableHead>Hold</TableHead>
                  <TableHead>Solved</TableHead>
                  <TableHead>Closed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((row) => (
                  <TableRow key={row.userId ?? "unassigned"}>
                    <TableCell className="font-medium">{row.name}</TableCell>
                    <TableCell>{row.email ?? "N/A"}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.assigned)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.new + row.open + row.pending + row.hold)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.new)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.open)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.pending)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.hold)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.solved)}</TableCell>
                    <TableCell>{NUMBER_FORMATTER.format(row.closed)}</TableCell>
                  </TableRow>
                ))}
                {filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-6 text-center text-slate-500">
                      No rows to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>

            <div className="pt-2">
              <h3 className="text-sm font-semibold text-slate-900 mb-2">Resolved By User (Status Change Actions)</h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Solved Actions</TableHead>
                    <TableHead>Closed Actions</TableHead>
                    <TableHead>Resolved Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredResolverUsers.map((row) => (
                    <TableRow key={`resolver-${row.userId ?? "unknown"}-${row.name}`}>
                      <TableCell className="font-medium">{row.name}</TableCell>
                      <TableCell>{row.email ?? "N/A"}</TableCell>
                      <TableCell>{NUMBER_FORMATTER.format(row.solvedActions)}</TableCell>
                      <TableCell>{NUMBER_FORMATTER.format(row.closedActions)}</TableCell>
                      <TableCell>{NUMBER_FORMATTER.format(row.resolvedActions)}</TableCell>
                    </TableRow>
                  ))}
                  {filteredResolverUsers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                        No resolver rows to display.
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
