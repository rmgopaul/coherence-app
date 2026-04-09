import { useState } from "react";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { UserPlus, Shield, Trash2, Copy, Link } from "lucide-react";
import { useSolarRecAuth } from "../hooks/useSolarRecAuth";

// ---------------------------------------------------------------------------
// User Management
// ---------------------------------------------------------------------------

function UserManagement() {
  const usersQuery = trpc.users.list.useQuery();
  const invitesQuery = trpc.users.listInvites.useQuery();
  const inviteMutation = trpc.users.invite.useMutation({
    onSuccess: () => {
      invitesQuery.refetch();
      setInviteEmail("");
      setInviteDialogOpen(false);
    },
  });
  const updateRoleMutation = trpc.users.updateRole.useMutation({
    onSuccess: () => usersQuery.refetch(),
  });
  const deleteInviteMutation = trpc.users.deleteInvite.useMutation({
    onSuccess: () => invitesQuery.refetch(),
  });
  const deactivateMutation = trpc.users.deactivate.useMutation({
    onSuccess: () => usersQuery.refetch(),
  });

  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"operator" | "viewer" | "admin">("operator");
  const [lastInviteToken, setLastInviteToken] = useState<string | null>(null);
  const { user: currentUser } = useSolarRecAuth();

  const handleInvite = () => {
    inviteMutation.mutate(
      { email: inviteEmail, role: inviteRole },
      {
        onSuccess: (data) => {
          setLastInviteToken(data.token);
        },
      }
    );
  };

  const roleBadgeColor = (role: string) => {
    switch (role) {
      case "owner": return "default";
      case "admin": return "default";
      case "operator": return "secondary";
      case "viewer": return "outline";
      default: return "outline";
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Team Members</CardTitle>
            <CardDescription>Manage who can access Solar REC.</CardDescription>
          </div>
          <Dialog open={inviteDialogOpen} onOpenChange={setInviteDialogOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <UserPlus className="h-3.5 w-3.5" />
                Invite
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Invite Team Member</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 pt-2">
                <Input
                  placeholder="Email address"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  type="email"
                />
                <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as typeof inviteRole)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="operator">Operator (run APIs + edit)</SelectItem>
                    <SelectItem value="viewer">Viewer (read only)</SelectItem>
                    <SelectItem value="admin">Admin (manage users)</SelectItem>
                  </SelectContent>
                </Select>
                {lastInviteToken && (
                  <div className="rounded-md border p-3 bg-muted/50">
                    <p className="text-xs text-muted-foreground mb-1">
                      Invite created! The user can now sign in with Google using this email.
                    </p>
                  </div>
                )}
                {inviteMutation.error && (
                  <p className="text-xs text-destructive">
                    {inviteMutation.error.message}
                  </p>
                )}
                <Button
                  onClick={handleInvite}
                  disabled={!inviteEmail || inviteMutation.isPending}
                  className="w-full"
                >
                  {inviteMutation.isPending ? "Sending..." : "Send Invite"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {usersQuery.data?.map((u) => (
            <div
              key={u.id}
              className="flex items-center justify-between py-2 px-3 rounded-md border"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {u.name ?? u.email}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {u.email}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={roleBadgeColor(u.role)}>{u.role}</Badge>
                {u.id !== currentUser?.id && u.role !== "owner" && (
                  <>
                    <Select
                      value={u.role}
                      onValueChange={(v) =>
                        updateRoleMutation.mutate({
                          userId: u.id,
                          role: v as "admin" | "operator" | "viewer",
                        })
                      }
                    >
                      <SelectTrigger className="h-7 w-[100px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="admin">Admin</SelectItem>
                        <SelectItem value="operator">Operator</SelectItem>
                        <SelectItem value="viewer">Viewer</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive"
                      onClick={() => deactivateMutation.mutate({ userId: u.id })}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
                {!u.isActive && (
                  <Badge variant="destructive" className="text-[10px]">
                    Deactivated
                  </Badge>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Pending invites */}
        {invitesQuery.data && invitesQuery.data.length > 0 && (
          <div className="mt-4">
            <h4 className="text-xs font-medium text-muted-foreground mb-2">
              Pending Invites
            </h4>
            <div className="space-y-1">
              {invitesQuery.data
                .filter((i) => !i.usedAt)
                .map((invite) => (
                  <div
                    key={invite.id}
                    className="flex items-center justify-between py-1.5 px-3 rounded border text-xs"
                  >
                    <span>{invite.email}</span>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">
                        {invite.role}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-5 text-muted-foreground hover:text-destructive"
                        onClick={() => deleteInviteMutation.mutate({ inviteId: invite.id })}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API Credentials Management
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { key: "solaredge", label: "SolarEdge", fields: ["apiKey"] },
  { key: "enphase-v4", label: "Enphase V4", fields: ["apiKey", "clientId", "clientSecret"] },
  { key: "fronius", label: "Fronius", fields: ["accessKeyId", "accessKeyValue"] },
  { key: "generac", label: "Generac", fields: ["accessToken"] },
  { key: "hoymiles", label: "Hoymiles", fields: ["username", "password"] },
  { key: "goodwe", label: "GoodWe", fields: ["account", "password"] },
  { key: "solis", label: "Solis", fields: ["apiKey", "apiSecret"] },
  { key: "locus", label: "Locus Energy", fields: ["clientId", "clientSecret", "partnerId"] },
  { key: "apsystems", label: "APsystems", fields: ["appId", "appSecret"] },
  { key: "solarlog", label: "SolarLog", fields: ["deviceUrl", "password"] },
  { key: "growatt", label: "Growatt", fields: ["username", "password"] },
  { key: "egauge", label: "eGauge", fields: ["baseUrl", "username", "password", "meterId"] },
  {
    key: "tesla-powerhub",
    label: "Tesla Powerhub",
    fields: ["clientId", "clientSecret", "groupId", "signal", "tokenUrl", "apiBaseUrl", "portalBaseUrl"],
  },
];

function CredentialsManagement() {
  const credsQuery = trpc.credentials.list.useQuery();
  const connectMutation = trpc.credentials.connect.useMutation({
    onSuccess: () => {
      credsQuery.refetch();
      setAddDialogOpen(false);
      setFormFields({});
    },
  });
  const disconnectMutation = trpc.credentials.disconnect.useMutation({
    onSuccess: () => credsQuery.refetch(),
  });
  const migrateMutation = trpc.credentials.migrateFromMain.useMutation({
    onSuccess: () => {
      credsQuery.refetch();
    },
  });

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState(PROVIDERS[0].key);
  const [connectionName, setConnectionName] = useState("");
  const [formFields, setFormFields] = useState<Record<string, string>>({});

  const providerConfig = PROVIDERS.find((p) => p.key === selectedProvider);

  const handleConnect = () => {
    connectMutation.mutate({
      provider: selectedProvider,
      connectionName: connectionName || providerConfig?.label,
      metadata: JSON.stringify(formFields),
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">API Credentials</CardTitle>
            <CardDescription>
              Shared credentials used by the team for monitoring APIs.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => migrateMutation.mutate()}
              disabled={migrateMutation.isPending}
            >
              {migrateMutation.isPending ? "Migrating..." : "Migrate from Main"}
            </Button>
            <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="gap-1.5">
                  <Link className="h-3.5 w-3.5" />
                  Connect
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Connect API</DialogTitle>
                </DialogHeader>
                <div className="space-y-3 pt-2">
                  <Select
                    value={selectedProvider}
                    onValueChange={(v) => {
                      setSelectedProvider(v);
                      setFormFields({});
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p.key} value={p.key}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Connection name (optional)"
                    value={connectionName}
                    onChange={(e) => setConnectionName(e.target.value)}
                  />
                  {providerConfig?.fields.map((field) => (
                    <Input
                      key={field}
                      placeholder={field}
                      value={formFields[field] ?? ""}
                      onChange={(e) =>
                        setFormFields((prev) => ({ ...prev, [field]: e.target.value }))
                      }
                      type={
                        field.toLowerCase().includes("secret") ||
                        field.toLowerCase().includes("password")
                          ? "password"
                          : "text"
                      }
                    />
                  ))}
                  <Button
                    onClick={handleConnect}
                    disabled={connectMutation.isPending}
                    className="w-full"
                  >
                    {connectMutation.isPending ? "Connecting..." : "Save Connection"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {migrateMutation.data && (
          <div className="mb-3 rounded-md border bg-muted/40 p-3 text-xs">
            <p>
              Migration complete: {migrateMutation.data.created} created,{" "}
              {migrateMutation.data.updated} updated, {migrateMutation.data.skipped} skipped.
            </p>
          </div>
        )}
        {migrateMutation.error && (
          <p className="mb-3 text-xs text-destructive">
            Migration failed: {migrateMutation.error.message}
          </p>
        )}
        <div className="space-y-2">
          {credsQuery.data?.map((cred) => (
            <div
              key={cred.id}
              className="flex items-center justify-between py-2 px-3 rounded-md border"
            >
              <div>
                <p className="text-sm font-medium">
                  {cred.connectionName ?? cred.provider}
                </p>
                <p className="text-xs text-muted-foreground">{cred.provider}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={cred.hasAccessToken ? "default" : "outline"}>
                  {cred.hasAccessToken ? "Connected" : "No Token"}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={() => disconnectMutation.mutate({ id: cred.id })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {credsQuery.data?.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No API credentials connected yet.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings Page
// ---------------------------------------------------------------------------

export default function SolarRecSettings() {
  const { isAdmin } = useSolarRecAuth();

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-sm text-muted-foreground">
          Admin access required.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage team members and API connections.
        </p>
      </div>
      <UserManagement />
      <CredentialsManagement />
    </div>
  );
}
