/**
 * Task 5.1 — Team & Permissions matrix editor.
 *
 * Rendered as a card inside SolarRecSettings. Only visible to users with
 * `admin` on the `team-permissions` module (scope owner + scope-admin
 * users satisfy this via the middleware's bypass rule).
 *
 * Preset manager ships in the follow-up PR; this PR lands cell-by-cell
 * editing + the scope-admin toggle only.
 */

import { useMemo } from "react";
import { toast } from "sonner";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { useSolarRecPermission } from "../hooks/useSolarRecPermission";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldAlert } from "lucide-react";
import {
  PERMISSION_LEVELS,
  type ModuleKey,
  type PermissionLevel,
} from "@shared/solarRecModules";

type MatrixPermission = {
  userId: number;
  moduleKey: ModuleKey;
  permission: PermissionLevel;
};

type MatrixUser = {
  id: number;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  isScopeAdmin: boolean;
};

function buildMatrix(
  users: MatrixUser[],
  perms: MatrixPermission[]
): Map<number, Map<ModuleKey, PermissionLevel>> {
  const out = new Map<number, Map<ModuleKey, PermissionLevel>>();
  for (const u of users) out.set(u.id, new Map());
  for (const p of perms) {
    const row = out.get(p.userId) ?? new Map();
    row.set(p.moduleKey, p.permission);
    out.set(p.userId, row);
  }
  return out;
}

export default function TeamPermissions() {
  const gate = useSolarRecPermission("team-permissions");

  const modulesQuery = trpc.permissions.listModules.useQuery();
  const matrixQuery = trpc.permissions.listScopePermissions.useQuery(
    undefined,
    { enabled: gate.canAdmin }
  );
  const utils = trpc.useUtils();

  const setOne = trpc.permissions.setUserPermission.useMutation({
    onSuccess: () => {
      utils.permissions.listScopePermissions.invalidate();
      utils.permissions.getMyPermissions.invalidate();
    },
    onError: err => toast.error(`Save failed: ${err.message}`),
  });
  const setScopeAdmin = trpc.permissions.setUserScopeAdmin.useMutation({
    onSuccess: () => {
      utils.permissions.listScopePermissions.invalidate();
      utils.permissions.getMyPermissions.invalidate();
    },
    onError: err => toast.error(`Save failed: ${err.message}`),
  });

  const matrix = useMemo(() => {
    const users = matrixQuery.data?.users ?? [];
    const perms = (matrixQuery.data?.permissions ?? []) as MatrixPermission[];
    return buildMatrix(users, perms);
  }, [matrixQuery.data]);

  if (!gate.canAdmin) return null;

  if (matrixQuery.isLoading || modulesQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Team & Permissions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const users = matrixQuery.data?.users ?? [];
  const modules = modulesQuery.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Team & Permissions</CardTitle>
        <CardDescription>
          Per-module permission matrix. Scope owner and scope-admin users bypass
          the matrix with implicit admin on every module.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="border-b">
                <th className="py-2 pr-3 text-left font-medium sticky left-0 bg-background">
                  User
                </th>
                <th className="py-2 px-2 text-center font-medium whitespace-nowrap">
                  Scope admin
                </th>
                {modules.map(m => (
                  <th
                    key={m.key}
                    className="py-2 px-2 text-left font-medium whitespace-nowrap"
                    title={m.description}
                  >
                    {m.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map(u => {
                const row = matrix.get(u.id) ?? new Map();
                return (
                  <tr key={u.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-3 align-top sticky left-0 bg-background">
                      <div className="flex flex-col">
                        <span className="font-medium">{u.name ?? u.email}</span>
                        <span className="text-xs text-muted-foreground">
                          {u.email}
                        </span>
                        <div className="mt-1 flex items-center gap-1">
                          <Badge variant="outline" className="text-xs">
                            {u.role}
                          </Badge>
                          {!u.isActive && (
                            <Badge variant="destructive" className="text-xs">
                              inactive
                            </Badge>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-2 align-top text-center">
                      <div className="flex flex-col items-center gap-1">
                        <Switch
                          checked={u.isScopeAdmin}
                          disabled={setScopeAdmin.isPending}
                          onCheckedChange={checked =>
                            setScopeAdmin.mutate({
                              userId: u.id,
                              isScopeAdmin: checked,
                            })
                          }
                        />
                        {u.isScopeAdmin && (
                          <span
                            className="text-[10px] text-amber-700 inline-flex items-center gap-0.5"
                            title="Bypasses the matrix with implicit admin on every module."
                          >
                            <ShieldAlert className="h-3 w-3" />
                            bypass
                          </span>
                        )}
                      </div>
                    </td>
                    {modules.map(m => {
                      const current: PermissionLevel =
                        row.get(m.key as ModuleKey) ?? "none";
                      return (
                        <td key={m.key} className="py-2 px-2 align-top">
                          <Select
                            value={current}
                            disabled={u.isScopeAdmin || setOne.isPending}
                            onValueChange={value =>
                              setOne.mutate({
                                userId: u.id,
                                moduleKey: m.key as ModuleKey,
                                permission: value as PermissionLevel,
                              })
                            }
                          >
                            <SelectTrigger
                              className="h-8 w-[92px] text-xs"
                              title={
                                u.isScopeAdmin
                                  ? "Scope-admin bypasses the matrix."
                                  : undefined
                              }
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {PERMISSION_LEVELS.map(level => (
                                <SelectItem key={level} value={level}>
                                  {level}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={modules.length + 2}
                    className="py-6 text-center text-muted-foreground"
                  >
                    No team members yet. Invite someone from the Users section.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
