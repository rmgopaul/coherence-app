/**
 * Task 5.1 — permission preset manager.
 *
 * Rendered alongside TeamPermissions. Admin-only. Lets a scope admin:
 *   - Create named presets (e.g. "Monitoring Operator").
 *   - Edit/delete existing presets.
 *   - Apply a preset to a team member; the preset overwrites their
 *     matrix rows.
 */

import { useMemo, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Pencil, Plus, Trash2, UserPlus2 } from "lucide-react";
import {
  MODULES,
  PERMISSION_LEVELS,
  type ModuleKey,
  type PermissionLevel,
} from "@shared/solarRecModules";

type HydratedPreset = {
  id: string;
  name: string;
  description: string | null;
  permissions: Array<{ moduleKey: ModuleKey; permission: PermissionLevel }>;
};

type EditorState = {
  mode: "create" | "edit";
  id: string | null;
  name: string;
  description: string;
  map: Record<ModuleKey, PermissionLevel>;
};

function emptyMap(): Record<ModuleKey, PermissionLevel> {
  const out = {} as Record<ModuleKey, PermissionLevel>;
  for (const m of MODULES) out[m.key] = "none";
  return out;
}

function mapFromEntries(
  entries: Array<{ moduleKey: ModuleKey; permission: PermissionLevel }>
): Record<ModuleKey, PermissionLevel> {
  const out = emptyMap();
  for (const e of entries) out[e.moduleKey] = e.permission;
  return out;
}

function mapToEntries(
  map: Record<ModuleKey, PermissionLevel>
): Array<{ moduleKey: ModuleKey; permission: PermissionLevel }> {
  return MODULES.map((m) => ({
    moduleKey: m.key,
    permission: map[m.key] ?? "none",
  }));
}

export default function PermissionPresets() {
  const gate = useSolarRecPermission("team-permissions");
  const utils = trpc.useUtils();

  const presetsQuery = trpc.permissions.listPresets.useQuery(undefined, {
    enabled: gate.canAdmin,
  });
  const matrixQuery = trpc.permissions.listScopePermissions.useQuery(
    undefined,
    { enabled: gate.canAdmin }
  );

  const createMutation = trpc.permissions.createPreset.useMutation({
    onSuccess: () => {
      utils.permissions.listPresets.invalidate();
      setEditor(null);
      toast.success("Preset created");
    },
    onError: (err) => toast.error(`Create failed: ${err.message}`),
  });

  const updateMutation = trpc.permissions.updatePreset.useMutation({
    onSuccess: () => {
      utils.permissions.listPresets.invalidate();
      setEditor(null);
      toast.success("Preset updated");
    },
    onError: (err) => toast.error(`Update failed: ${err.message}`),
  });

  const deleteMutation = trpc.permissions.deletePreset.useMutation({
    onSuccess: () => {
      utils.permissions.listPresets.invalidate();
      toast.success("Preset deleted");
    },
    onError: (err) => toast.error(`Delete failed: ${err.message}`),
  });

  const applyMutation = trpc.permissions.applyPreset.useMutation({
    onSuccess: (data) => {
      utils.permissions.listScopePermissions.invalidate();
      setApplyState(null);
      toast.success(
        `Applied ${data.presetName}: ${data.applied} module(s) set`
      );
    },
    onError: (err) => toast.error(`Apply failed: ${err.message}`),
  });

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [applyState, setApplyState] = useState<{
    preset: HydratedPreset;
    userId: number | null;
  } | null>(null);

  const presets = (presetsQuery.data ?? []) as HydratedPreset[];
  const users = matrixQuery.data?.users ?? [];

  const startCreate = () => {
    setEditor({
      mode: "create",
      id: null,
      name: "",
      description: "",
      map: emptyMap(),
    });
  };

  const startEdit = (preset: HydratedPreset) => {
    setEditor({
      mode: "edit",
      id: preset.id,
      name: preset.name,
      description: preset.description ?? "",
      map: mapFromEntries(preset.permissions),
    });
  };

  const saveEditor = () => {
    if (!editor) return;
    const name = editor.name.trim();
    if (!name) {
      toast.error("Preset needs a name");
      return;
    }
    const permissions = mapToEntries(editor.map);
    const description = editor.description.trim() || null;
    if (editor.mode === "create") {
      createMutation.mutate({ name, description, permissions });
    } else if (editor.id) {
      updateMutation.mutate({
        id: editor.id,
        name,
        description,
        permissions,
      });
    }
  };

  const presetModuleCount = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of presets) {
      map.set(
        p.id,
        p.permissions.filter((e) => e.permission !== "none").length
      );
    }
    return map;
  }, [presets]);

  if (!gate.canAdmin) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4">
          <div>
            <CardTitle>Permission Presets</CardTitle>
            <CardDescription>
              Save reusable templates and apply them to teammates.
            </CardDescription>
          </div>
          <Button size="sm" onClick={startCreate} disabled={editor !== null}>
            <Plus className="h-4 w-4 mr-1" />
            New preset
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {presetsQuery.isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : presets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No presets yet. Create one to bulk-apply a permission set to new or
            existing teammates.
          </p>
        ) : (
          <div className="space-y-2">
            {presets.map((preset) => {
              const nonNone = presetModuleCount.get(preset.id) ?? 0;
              return (
                <div
                  key={preset.id}
                  className="flex items-center justify-between py-2 px-3 rounded-md border"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {preset.name}
                      </p>
                      <Badge variant="outline" className="text-xs">
                        {nonNone} module{nonNone === 1 ? "" : "s"}
                      </Badge>
                    </div>
                    {preset.description && (
                      <p className="text-xs text-muted-foreground truncate">
                        {preset.description}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setApplyState({ preset, userId: null })
                      }
                    >
                      <UserPlus2 className="h-3.5 w-3.5 mr-1" />
                      Apply
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => startEdit(preset)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete preset "${preset.name}"? This does NOT change permissions on users who already had it applied.`
                          )
                        ) {
                          deleteMutation.mutate({ id: preset.id });
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Editor dialog */}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editor?.mode === "create" ? "Create preset" : "Edit preset"}
            </DialogTitle>
            <DialogDescription>
              Pick a permission level per module. Leaving a module at `none`
              hides it entirely for anyone the preset is applied to.
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
                <div className="space-y-1">
                  <Label htmlFor="preset-name">Name</Label>
                  <Input
                    id="preset-name"
                    value={editor.name}
                    onChange={(e) =>
                      setEditor({ ...editor, name: e.target.value })
                    }
                    placeholder="Monitoring Operator"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="preset-description">Description</Label>
                  <Textarea
                    id="preset-description"
                    value={editor.description}
                    onChange={(e) =>
                      setEditor({ ...editor, description: e.target.value })
                    }
                    rows={2}
                    placeholder="Who is this preset for?"
                  />
                </div>
              </div>
              <div className="max-h-[320px] overflow-y-auto border rounded-md">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr>
                      <th className="text-left py-2 px-3 font-medium">Module</th>
                      <th className="text-left py-2 px-3 font-medium w-[140px]">
                        Permission
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {MODULES.map((m) => {
                      const current = editor.map[m.key];
                      return (
                        <tr key={m.key} className="border-t">
                          <td className="py-2 px-3">
                            <div className="flex flex-col">
                              <span>{m.label}</span>
                              <span className="text-xs text-muted-foreground">
                                {m.description}
                              </span>
                            </div>
                          </td>
                          <td className="py-2 px-3">
                            <Select
                              value={current}
                              onValueChange={(value) =>
                                setEditor({
                                  ...editor,
                                  map: {
                                    ...editor.map,
                                    [m.key]: value as PermissionLevel,
                                  },
                                })
                              }
                            >
                              <SelectTrigger className="h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {PERMISSION_LEVELS.map((level) => (
                                  <SelectItem key={level} value={level}>
                                    {level}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              Cancel
            </Button>
            <Button
              onClick={saveEditor}
              disabled={
                createMutation.isPending || updateMutation.isPending
              }
            >
              {createMutation.isPending || updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              {editor?.mode === "create" ? "Create preset" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Apply dialog */}
      <Dialog
        open={applyState !== null}
        onOpenChange={(open) => {
          if (!open) setApplyState(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply preset</DialogTitle>
            <DialogDescription>
              {applyState
                ? `Overwrite a teammate's permissions with "${applyState.preset.name}". Any existing module rows not in the preset are cleared.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {applyState && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>User</Label>
                <Select
                  value={
                    applyState.userId !== null
                      ? String(applyState.userId)
                      : undefined
                  }
                  onValueChange={(value) =>
                    setApplyState({
                      ...applyState,
                      userId: Number(value),
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a user" />
                  </SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={String(u.id)}>
                        {u.name ? `${u.name} — ${u.email}` : u.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="rounded border bg-muted/30 px-3 py-2 text-xs">
                This preset sets {
                  applyState.preset.permissions.filter(
                    (e) => e.permission !== "none"
                  ).length
                } module(s).
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setApplyState(null)}>
              Cancel
            </Button>
            <Button
              disabled={
                !applyState ||
                applyState.userId === null ||
                applyMutation.isPending
              }
              onClick={() => {
                if (!applyState || applyState.userId === null) return;
                applyMutation.mutate({
                  presetId: applyState.preset.id,
                  userId: applyState.userId,
                });
              }}
            >
              {applyMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : null}
              Apply preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
