import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { invalidateWorkspaceNoteQueries } from "@/lib/workspaceNoteQueries";
import {
  noteLinkInputForWorkspaceRow,
  type WorkspaceNoteRow,
} from "./useWorkspaceNotes";

interface AttachExistingNoteDialogProps {
  row: WorkspaceNoteRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function workspaceTitle(row: WorkspaceNoteRow): string {
  return row.kind === "todoist" ? row.content : row.title;
}

export function AttachExistingNoteDialog({
  row,
  open,
  onOpenChange,
}: AttachExistingNoteDialogProps) {
  const [query, setQuery] = useState("");
  const utils = trpc.useUtils();
  const notesQuery = trpc.notes.list.useQuery(
    { limit: 500 },
    { enabled: open, staleTime: 60_000 }
  );
  const attachNote = trpc.notes.addLink.useMutation({
    onSuccess: result => {
      invalidateWorkspaceNoteQueries(utils);
      if (result.alreadyLinked) {
        toast.info("That note is already attached to this workspace");
      } else {
        toast.success("Attached existing note");
      }
      onOpenChange(false);
      setQuery("");
    },
    onError: err => toast.error(err.message),
  });

  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const notes = notesQuery.data ?? [];
    if (!normalizedQuery) return notes;

    return notes.filter(note => {
      const haystack = [
        note.title,
        note.notebook,
        note.content,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [notesQuery.data, query]);

  const title = workspaceTitle(row);

  function attach(noteId: string) {
    attachNote.mutate(noteLinkInputForWorkspaceRow(row, noteId));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach existing note</DialogTitle>
          <DialogDescription>
            Link a notebook page to {row.kind === "todoist" ? "task" : "event"}:{" "}
            {title}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search notes"
            className="pl-9"
            autoFocus
          />
        </div>

        <div className="max-h-80 overflow-y-auto rounded-md border">
          {notesQuery.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading notes...</p>
          ) : notesQuery.error ? (
            <p className="p-4 text-sm text-destructive">
              {notesQuery.error.message}
            </p>
          ) : filteredNotes.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No matching notes.
            </p>
          ) : (
            <ul className="divide-y">
              {filteredNotes.map(note => (
                <li key={note.id}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 p-3 text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={attachNote.isPending}
                    onClick={() => attach(note.id)}
                  >
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {note.title?.trim() || "(untitled)"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {note.notebook || "General"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={attachNote.isPending}
          >
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
