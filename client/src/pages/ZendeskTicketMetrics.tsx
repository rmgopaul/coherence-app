import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Download, Loader2, PlugZap, RefreshCw, Unplug } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error.";
}

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
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

export default function ZendeskTicketMetrics() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const [subdomainInput, setSubdomainInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [apiTokenInput, setApiTokenInput] = useState("");
  const [maxTicketsInput, setMaxTicketsInput] = useState("10000");
  const [search, setSearch] = useState("");

  const statusQuery = trpc.zendesk.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const connectMutation = trpc.zendesk.connect.useMutation();
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
  }, [statusQuery.data]);

  const runMetricsLoad = async () => {
    const maxTicketsRaw = Number(maxTicketsInput);
    const maxTickets = Number.isFinite(maxTicketsRaw) ? Math.floor(maxTicketsRaw) : NaN;
    if (!Number.isFinite(maxTickets) || maxTickets < 100 || maxTickets > 50000) {
      toast.error("Max tickets must be between 100 and 50000.");
      return;
    }

    try {
      await metricsMutation.mutateAsync({ maxTickets });
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
            Per-user ticket counts by status (assigned, open, pending, hold, solved, closed).
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Zendesk</CardTitle>
            <CardDescription>
              Save your Zendesk subdomain, account email, and API token.
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Ticket Metrics by Assignee</CardTitle>
            <CardDescription>
              Load ticket counts per assigned user and break them down by status.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                <Label htmlFor="zendesk-search">Search User</Label>
                <Input
                  id="zendesk-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter by name, email, or user ID"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button onClick={runMetricsLoad} disabled={metricsMutation.isPending || !isConnected}>
                  {metricsMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                  Load Metrics
                </Button>
                <Button variant="outline" onClick={exportUsersCsv} disabled={filteredUsers.length === 0}>
                  <Download className="h-4 w-4 mr-2" />
                  Export CSV
                </Button>
              </div>
            </div>

            {metricsMutation.error ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Metrics error: {toErrorMessage(metricsMutation.error)}
              </div>
            ) : null}

            <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Assigned</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(metrics?.totals.assigned ?? 0)}</p>
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
            </div>

            <div className="flex items-center justify-between text-xs text-slate-600">
              <span>
                Tickets scanned: {NUMBER_FORMATTER.format(metrics?.ticketCount ?? 0)} (max {NUMBER_FORMATTER.format(metrics?.maxTickets ?? 0)})
              </span>
              <span>
                {metrics?.generatedAt ? `Generated ${new Date(metrics.generatedAt).toLocaleString()}` : "No run yet"}
              </span>
            </div>

            {metrics?.truncated ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Result reached max ticket cap. Increase Max Tickets if you need complete historical totals.
              </div>
            ) : null}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Assigned</TableHead>
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
                    <TableCell colSpan={9} className="py-6 text-center text-slate-500">
                      No rows to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
