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

const DEFAULT_TOKEN_URL = "https://gridlogic-api.sn.tesla.services/v1/auth/token";
const DEFAULT_API_BASE_URL = "https://gridlogic-api.sn.tesla.services/v2";
const DEFAULT_PORTAL_BASE_URL = "https://powerhub.energy.tesla.com";
const NUMBER_FORMATTER = new Intl.NumberFormat("en-US");

function clean(value: string | null | undefined): string {
  return (value ?? "").trim();
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
  const [search, setSearch] = useState("");
  const [resultTitle, setResultTitle] = useState("No request run yet");
  const [resultText, setResultText] = useState("{}");

  const statusQuery = trpc.teslaPowerhub.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const connectMutation = trpc.teslaPowerhub.connect.useMutation();
  const disconnectMutation = trpc.teslaPowerhub.disconnect.useMutation();
  const groupUsersMutation = trpc.teslaPowerhub.getGroupUsers.useMutation();

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    if (!statusQuery.data) return;
    if (statusQuery.data.clientId) setClientIdInput(statusQuery.data.clientId);
    if (statusQuery.data.groupId) setGroupIdInput(statusQuery.data.groupId);
    if (statusQuery.data.tokenUrl) setTokenUrlInput(statusQuery.data.tokenUrl);
    if (statusQuery.data.apiBaseUrl) setApiBaseUrlInput(statusQuery.data.apiBaseUrl);
    if (statusQuery.data.portalBaseUrl) setPortalBaseUrlInput(statusQuery.data.portalBaseUrl);
  }, [statusQuery.data]);

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
        clientSecret,
        groupId: clean(groupIdInput),
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
      groupUsersMutation.reset();
      toast.success("Tesla Powerhub disconnected.");
    } catch (error) {
      toast.error(`Failed to disconnect: ${toErrorMessage(error)}`);
    }
  };

  const handleFetchGroupUsers = async () => {
    const groupId = clean(groupIdInput);
    if (!groupId) {
      toast.error("Enter a group ID.");
      return;
    }

    try {
      const payload = await groupUsersMutation.mutateAsync({
        groupId,
        endpointUrl: clean(endpointUrlInput) || undefined,
      });
      setResultTitle(`Group Users (${payload.users.length})`);
      setResultText(JSON.stringify(payload, null, 2));
      toast.success("Group users loaded.");
    } catch (error) {
      toast.error(`Failed to load users: ${toErrorMessage(error)}`);
    }
  };

  const users = groupUsersMutation.data?.users ?? [];
  const filteredUsers = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return users;
    return users.filter((user) => {
      const haystack = `${user.id} ${user.name} ${user.email ?? ""} ${user.role ?? ""} ${user.status ?? ""}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [users, search]);

  const exportUsersCsv = () => {
    if (filteredUsers.length === 0) {
      toast.error("No rows to export.");
      return;
    }
    const headers = ["id", "name", "email", "role", "status"];
    const lines = [
      headers.join(","),
      ...filteredUsers.map((row) =>
        [row.id, row.name, row.email, row.role, row.status].map((value) => csvEscape(value)).join(",")
      ),
    ];
    const fileName = `tesla-powerhub-group-users-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
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
  const mutationError = groupUsersMutation.error ? toErrorMessage(groupUsersMutation.error) : null;
  const activeUsers = users.filter((user) => clean(user.status).toLowerCase() === "active").length;
  const inactiveUsers = users.filter((user) => clean(user.status).toLowerCase() === "inactive").length;

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
            Client credentials auth + group users endpoint (for example:
            {" "}
            <code>https://powerhub.energy.tesla.com/group/{"{groupId}"}/users</code>).
          </p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>1) Connect Tesla Powerhub</CardTitle>
            <CardDescription>
              Save client ID/client secret and default group ID for repeated requests.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
                  placeholder="Tesla app client secret"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-group-id">Default Group ID</Label>
                <Input
                  id="tesla-powerhub-group-id"
                  value={groupIdInput}
                  onChange={(event) => setGroupIdInput(event.target.value)}
                  placeholder="b4b6a137-0387-4f5a-bfd0-82638a119472"
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
              <span className="text-sm text-slate-600">
                Status: {isConnected ? "Connected" : "Not connected"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2) Group Users</CardTitle>
            <CardDescription>
              Fetch users for a group. Leave endpoint override blank for automatic URL fallback attempts.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tesla-powerhub-group-id-query">Group ID</Label>
                <Input
                  id="tesla-powerhub-group-id-query"
                  value={groupIdInput}
                  onChange={(event) => setGroupIdInput(event.target.value)}
                  placeholder="b4b6a137-0387-4f5a-bfd0-82638a119472"
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="tesla-powerhub-endpoint-override">Endpoint Override (optional)</Label>
                <Input
                  id="tesla-powerhub-endpoint-override"
                  value={endpointUrlInput}
                  onChange={(event) => setEndpointUrlInput(event.target.value)}
                  placeholder={`https://powerhub.energy.tesla.com/group/${clean(groupIdInput) || "{groupId}"}/users`}
                />
              </div>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <Button onClick={handleFetchGroupUsers} disabled={groupUsersMutation.isPending || !isConnected}>
                {groupUsersMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
                Fetch Group Users
              </Button>
              <div className="space-y-1">
                <Label htmlFor="tesla-powerhub-search">Search Users</Label>
                <Input
                  id="tesla-powerhub-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="name/email/role"
                />
              </div>
              <Button variant="outline" onClick={exportUsersCsv} disabled={filteredUsers.length === 0}>
                <Download className="h-4 w-4 mr-2" />
                Export CSV
              </Button>
            </div>

            {mutationError ? (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                Request error: {mutationError}
              </div>
            ) : null}

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Total Users</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(users.length)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Active</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(activeUsers)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Inactive</p>
                <p className="text-xl font-semibold">{NUMBER_FORMATTER.format(inactiveUsers)}</p>
              </div>
              <div className="rounded-lg border bg-white p-3">
                <p className="text-xs text-slate-500">Resolved Endpoint</p>
                <p className="text-xs font-medium break-all">{groupUsersMutation.data?.resolvedEndpointUrl ?? "N/A"}</p>
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-medium">{row.id}</TableCell>
                    <TableCell>{row.name}</TableCell>
                    <TableCell>{row.email ?? "N/A"}</TableCell>
                    <TableCell>{row.role ?? "N/A"}</TableCell>
                    <TableCell>{row.status ?? "N/A"}</TableCell>
                  </TableRow>
                ))}
                {filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-6 text-center text-slate-500">
                      No users to display.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
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
