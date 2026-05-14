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

function trimToMax(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

export type WorkspaceNoteLinkInput = {
  noteId: string;
  linkType: "todoist_task" | "google_calendar_event";
  externalId: string;
  seriesId?: string;
  occurrenceStartIso?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  metadata?: Record<string, unknown>;
};

export function noteLinkInputForWorkspaceRow(
  row: WorkspaceNoteRow,
  noteId: string
): WorkspaceNoteLinkInput {
  if (row.kind === "todoist") {
    return {
      noteId,
      linkType: "todoist_task",
      externalId: row.taskId,
      sourceUrl: row.taskUrl,
      sourceTitle: trimToMax(row.content, 255),
      metadata: {
        dueDate: row.dueDate ?? null,
        projectName: row.projectName ?? null,
      },
    };
  }

  return {
    noteId,
    linkType: "google_calendar_event",
    externalId: row.eventId,
    seriesId: (row.recurringEventId || row.iCalUID || "").trim() || undefined,
    occurrenceStartIso: row.start?.trim() || undefined,
    sourceUrl: row.eventUrl,
    sourceTitle: trimToMax(row.title, 255),
    metadata: {
      location: row.location ?? null,
      recurringEventId: row.recurringEventId ?? null,
      iCalUID: row.iCalUID ?? null,
    },
  };
}

export function invalidateWorkspaceNoteQueries(
  utils: ReturnType<typeof trpc.useUtils>
) {
  void utils.notes.list.invalidate();
  void utils.notes.listForExternal.invalidate();
  void utils.notes.countLinksByExternalIds.invalidate();
}

export function useWorkspaceNotes() {
  const utils = trpc.useUtils();
  const [, setLocation] = useLocation();

  const createTodoistWorkspaceNote =
    trpc.notes.createFromTodoistTask.useMutation({
      onSuccess: result => {
        invalidateWorkspaceNoteQueries(utils);
        toast.success("Workspace note created");
        setLocation(`/notes?noteId=${encodeURIComponent(result.noteId)}`);
      },
      onError: err => toast.error(err.message),
    });

  const createCalendarWorkspaceNote =
    trpc.notes.createFromCalendarEvent.useMutation({
      onSuccess: result => {
        invalidateWorkspaceNoteQueries(utils);
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
