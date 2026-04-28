/**
 * Task 9.3 (2026-04-28) — Workset selector.
 *
 * Reusable dual-control input for any job page that takes a list of
 * CSG IDs. Two tabs:
 *
 *   1. **Paste IDs** — controlled textarea (callers own the text).
 *      Same UX as the legacy textareas this component replaces.
 *      Bottom row shows "N IDs detected" + (optionally)
 *      "Save as workset" once the user has pasted something
 *      worth saving.
 *
 *   2. **Load workset** — Select dropdown of every workset in the
 *      caller's scope (via `worksets.list`). Selecting one fetches
 *      detail (`worksets.get`) and dumps the CSG IDs back into the
 *      paste textarea, switching tabs so the user can verify before
 *      hitting Start.
 *
 * The component never owns the canonical `csgIds` — callers do.
 * This keeps the integration shallow (replace one Textarea with one
 * WorksetSelector + props) and means existing parsing logic on the
 * page (`split(/[\n,\t]+/).filter(Boolean)`) doesn't change.
 *
 * Save-as-workset opens a small Dialog with a name input and calls
 * `worksets.create` with the parsed IDs. On success the dialog
 * closes and the toast confirms; the new workset shows up in the
 * "Load workset" dropdown immediately (the list query invalidates).
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { solarRecTrpc as trpc } from "../solarRecTrpc";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Bookmark, BookmarkPlus, Loader2 } from "lucide-react";
import { parseCsgIdInput } from "@/lib/csgIdInput";

// Re-export for test files that imported from this component before
// the parser was extracted. Keep until callers migrate to
// `@/lib/csgIdInput`.
export { parseCsgIdInput } from "@/lib/csgIdInput";

interface WorksetSelectorProps {
  /** Free-text contents of the paste textarea. */
  value: string;
  onChange: (next: string) => void;
  /** Disable inputs (e.g. when a job is already running). */
  disabled?: boolean;
  /** Textarea row count — defaults to 6 to match the legacy inputs. */
  rows?: number;
  /** Placeholder for the textarea. Defaults to a CSG-style example. */
  placeholder?: string;
  /** Optional override for the "N IDs detected" wording. */
  countSuffix?: string;
}

export function WorksetSelector({
  value,
  onChange,
  disabled = false,
  rows = 6,
  placeholder = "CSG-12345\nCSG-12346\nCSG-12347",
  countSuffix = "IDs detected",
}: WorksetSelectorProps) {
  const [tab, setTab] = useState<"paste" | "load">("paste");
  const [selectedWorksetId, setSelectedWorksetId] = useState<string>("");
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [newWorksetName, setNewWorksetName] = useState("");

  const utils = trpc.useUtils();
  const listQuery = trpc.worksets.list.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const [loadingWorkset, setLoadingWorkset] = useState(false);
  const createWorkset = trpc.worksets.create.useMutation({
    onSuccess: () => {
      utils.worksets.list.invalidate();
    },
  });

  const detectedIds = useMemo(() => parseCsgIdInput(value), [value]);
  const worksets = listQuery.data?.worksets ?? [];
  const hasWorksets = worksets.length > 0;

  // When the user picks a workset from the dropdown, fetch its
  // detail via the imperative `utils.client.*.query` helper and
  // dump the csgIds back into the paste textarea. Keep them on the
  // Paste tab afterward so the verify-before-launch flow is
  // unchanged. Imperative fetch (vs `useQuery`) avoids leaving a
  // long-lived React Query cache entry per loaded workset.
  useEffect(() => {
    let cancelled = false;
    if (!selectedWorksetId) return;
    setLoadingWorkset(true);
    utils.client.worksets.get
      .query({ id: selectedWorksetId })
      .then((res) => {
        if (cancelled) return;
        const text = res.workset.csgIds.join("\n");
        onChange(text);
        setTab("paste");
        toast.success(
          `Loaded ${res.workset.csgIds.length} IDs from "${res.workset.name}"`
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        toast.error(
          err instanceof Error ? err.message : "Failed to load workset"
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingWorkset(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onChange
    // / utils references are stable; running on every render would
    // re-fetch the same workset on every key press.
  }, [selectedWorksetId]);

  function handleSave() {
    const trimmed = newWorksetName.trim();
    if (!trimmed) {
      toast.error("Workset name is required");
      return;
    }
    if (detectedIds.length === 0) {
      toast.error("Paste at least one CSG ID before saving");
      return;
    }
    createWorkset.mutate(
      { name: trimmed, csgIds: detectedIds },
      {
        onSuccess: (res) => {
          toast.success(
            `Saved "${res.workset.name}" with ${res.workset.csgIdCount} IDs`
          );
          setSaveDialogOpen(false);
          setNewWorksetName("");
        },
        onError: (err) => {
          toast.error(err.message);
        },
      }
    );
  }

  return (
    <div className="space-y-3">
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as "paste" | "load")}
      >
        <TabsList className="h-8">
          <TabsTrigger value="paste" className="text-xs">
            Paste IDs
          </TabsTrigger>
          <TabsTrigger value="load" className="text-xs" disabled={!hasWorksets}>
            <Bookmark className="h-3 w-3 mr-1" />
            Load workset
            {hasWorksets ? ` (${worksets.length})` : ""}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="paste" className="mt-3 space-y-2">
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            className="font-mono text-xs"
            disabled={disabled}
          />
        </TabsContent>

        <TabsContent value="load" className="mt-3 space-y-2">
          {hasWorksets ? (
            <Select
              value={selectedWorksetId}
              onValueChange={setSelectedWorksetId}
              disabled={disabled || loadingWorkset}
            >
              <SelectTrigger className="text-xs">
                <SelectValue placeholder="Select a workset…" />
              </SelectTrigger>
              <SelectContent>
                {worksets.map((w) => (
                  <SelectItem key={w.id} value={w.id} className="text-xs">
                    {w.name} · {w.csgIdCount} IDs
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-muted-foreground">
              No worksets in this scope yet. Paste IDs below and click
              "Save as workset" to create one.
            </p>
          )}
          {loadingWorkset && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading…
            </p>
          )}
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {detectedIds.length} {countSuffix}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSaveDialogOpen(true)}
          disabled={disabled || detectedIds.length === 0}
          className="h-7 text-xs"
        >
          <BookmarkPlus className="h-3 w-3 mr-1" />
          Save as workset
        </Button>
      </div>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as workset</DialogTitle>
            <DialogDescription>
              Saves {detectedIds.length} CSG IDs as a named workset
              visible to your whole team.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="workset-name">Name</Label>
            <Input
              id="workset-name"
              value={newWorksetName}
              onChange={(e) => setNewWorksetName(e.target.value)}
              placeholder="Q2 abp followups"
              autoFocus
              disabled={createWorkset.isPending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setSaveDialogOpen(false)}
              disabled={createWorkset.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={createWorkset.isPending}>
              {createWorkset.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : null}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default WorksetSelector;
