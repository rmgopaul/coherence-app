import { toast } from "sonner";
import { useLocation } from "wouter";

import { trpc } from "@/lib/trpc";
import type { SignalRow } from "@/lib/signalActions";

export type WorkspaceNoteRow = Extract<
  SignalRow,
  { kind: "todoist" } | { kind: "calendar" }
>;

export function workspaceNotesRoute(row: WorkspaceNoteRow): string {
  if (row.kind === "calendar") {
    return `/notes?eventId=${encodeURIComponent(row.eventId)}`;
  }
  return `/notes?taskId=${encodeURIComponent(row.taskId)}`;
}

export function useWorkspaceNotes() {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();

  const invalidateNotes = () => {
    void utils.notes.list.invalidate();
    void utils.notes.listForExternal.invalidate();
    void utils.notes.countLinksByExternalIds.invalidate();
  };

  const createTodoistWorkspaceNote =
    trpc.notes.createFromTodoistTask.useMutation({
      onSuccess: result => {
        invalidateNotes();
        toast.success("Workspace note created");
        setLocation(`/notes?noteId=${encodeURIComponent(result.noteId)}`);
      },
      onError: err => toast.error(err.message),
    });

  const createCalendarWorkspaceNote =
    trpc.notes.createFromCalendarEvent.useMutation({
      onSuccess: result => {
        invalidateNotes();
        toast.success("Workspace note created");
        setLocation(`/notes?noteId=${encodeURIComponent(result.noteId)}`);
      },
      onError: err => toast.error(err.message),
    });

  function createWorkspaceNote(row: WorkspaceNoteRow) {
    if (row.kind === "todoist") {
      createTodoistWorkspaceNote.mutate({
        taskId: row.taskId,
        taskContent: row.content,
        taskUrl: row.taskUrl,
        dueDate: row.dueDate ?? undefined,
        projectName: row.projectName ?? undefined,
      });
      return;
    }

    createCalendarWorkspaceNote.mutate({
      eventId: row.eventId,
      eventSummary: row.title,
      eventUrl: row.eventUrl,
      start: row.start ?? undefined,
      location: row.location ?? undefined,
      recurringEventId: row.recurringEventId ?? undefined,
      iCalUID: row.iCalUID ?? undefined,
    });
  }

  function openWorkspaceNotes(row: WorkspaceNoteRow) {
    setLocation(workspaceNotesRoute(row));
  }

  return {
    createWorkspaceNote,
    openWorkspaceNotes,
    isCreatingWorkspaceNote:
      createTodoistWorkspaceNote.isPending ||
      createCalendarWorkspaceNote.isPending,
  };
}
