import { useAuth } from "@/_core/hooks/useAuth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { extractTextPreview, normalizeContentForEditor } from "@/lib/noteContent";
import { NoteSaveController, type NoteDraftSnapshot } from "@/lib/noteSaveController";
import { trpc } from "@/lib/trpc";
import {
  AlertTriangle,
  ArrowLeft,
  BookOpen,
  Clock3,
  FileText,
  Filter,
  Link2,
  Loader2,
  PanelLeft,
  Pin,
  PinOff,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type ViewFilter = "all" | "pinned" | "linked";
type SaveState = "idle" | "saved" | "saving" | "unsaved" | "error";

type NoteLinkRow = {
  id: string;
  linkType?: string;
  externalId?: string;
  seriesId?: string;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  metadata?: string | Record<string, unknown> | null;
  createdAt?: string;
};

type NoteRow = {
  id: string;
  userId?: number;
  notebook?: string | null;
  title?: string | null;
  content?: string | null;
  pinned?: boolean | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  links?: NoteLinkRow[];
};

const RichTextEditor = lazy(() => import("@/components/notebook/RichTextEditor"));

const NOTES_PAGE_SIZE = 30;
const AUTOSAVE_DEBOUNCE_MS = 2500;
const AUTOSAVE_MAX_WAIT_MS = 10000;

function normalizeNotebook(value: string | null | undefined): string {
  const cleaned = String(value || "").trim();
  return cleaned || "General";
}

function normalizeTitle(value: string | null | undefined): string {
  const cleaned = String(value || "").trim();
  return cleaned || "Untitled note";
}

function relativeTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatDateTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parseLinkMetadata(metadata: unknown): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === "object" && metadata !== null) return metadata as Record<string, unknown>;
  if (typeof metadata !== "string" || !metadata.trim()) return {};
  try {
    const parsed = JSON.parse(metadata);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function noteMatchesEventFilter(note: NoteRow, eventFilterKey: string): boolean {
  if (!eventFilterKey) return true;
  const links = Array.isArray(note.links) ? note.links : [];

  return links.some((link) => {
    if (link.linkType !== "google_calendar_event") return false;

    if (eventFilterKey.startsWith("series:")) {
      const target = eventFilterKey.slice("series:".length).trim();
      if (!target) return false;

      const metadata = parseLinkMetadata(link.metadata);
      const candidates = new Set<string>([
        String(link.seriesId || "").trim(),
        String(metadata.recurringEventId || "").trim(),
        String(metadata.iCalUID || "").trim(),
      ]);

      return candidates.has(target);
    }

    const externalId = String(link.externalId || "").trim();
    return `event:${externalId}` === eventFilterKey;
  });
}

function linkLabel(linkType: string | undefined): string {
  const value = String(linkType || "");
  if (value === "google_calendar_event") return "Calendar";
  if (value === "todoist_task") return "Todoist";
  if (value === "google_drive_file") return "Drive";
  if (value === "note_link") return "Note";
  return "Link";
}

function saveStateLabel(state: SaveState, lastSavedAt: Date | null): string {
  if (state === "saving") return "Saving...";
  if (state === "unsaved") return "Unsaved changes";
  if (state === "error") return "Save failed";
  if (state === "idle") return "Ready";
  if (!lastSavedAt) return "Saved";
  return `Saved ${lastSavedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

export default function Notebook() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const trpcUtils = trpc.useUtils();

  const [selectedNotebook, setSelectedNotebook] = useState<string>("All Notebooks");
  const [viewFilter, setViewFilter] = useState<ViewFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [eventFilterKey, setEventFilterKey] = useState("");
  const [notesFetchLimit, setNotesFetchLimit] = useState(500);
  const [notesPage, setNotesPage] = useState(1);

  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [pendingRouteNoteId, setPendingRouteNoteId] = useState<string | null>(null);
  const [routeWantsNewDraft, setRouteWantsNewDraft] = useState(false);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [mobileNotebooksOpen, setMobileNotebooksOpen] = useState(false);
  const [mobilePagesOpen, setMobilePagesOpen] = useState(false);

  const initialDraft = useMemo<NoteDraftSnapshot>(
    () => ({
      noteId: null,
      title: "",
      notebook: "General",
      contentHtml: "<p></p>",
      pinned: false,
      revision: 0,
    }),
    []
  );

  const saveControllerRef = useRef(
    new NoteSaveController({
      noteId: null,
      title: "",
      notebook: "General",
      contentHtml: "<p></p>",
      pinned: false,
    })
  );

  const [noteDraft, setNoteDraft] = useState<NoteDraftSnapshot>(initialDraft);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const [conflictNote, setConflictNote] = useState<NoteRow | null>(null);
  const baselineServerRef = useRef<{ noteId: string | null; updatedAt: string }>({
    noteId: null,
    updatedAt: "",
  });
  const dismissedConflictUpdatedAtRef = useRef<string | null>(null);

  const autosaveTimerRef = useRef<number | null>(null);
  const autosaveMaxTimerRef = useRef<number | null>(null);

  const {
    data: notesData,
    isLoading: notesLoading,
    error: notesError,
    refetch: refetchNotes,
  } = trpc.notes.list.useQuery(
    { limit: notesFetchLimit },
    {
      enabled: !!user,
      retry: false,
    }
  );

  const createNoteMutation = trpc.notes.create.useMutation();
  const updateNoteMutation = trpc.notes.update.useMutation();
  const deleteNoteMutation = trpc.notes.delete.useMutation();
  const removeNoteLinkMutation = trpc.notes.removeLink.useMutation();
  const uploadImageMutation = trpc.notes.uploadImage.useMutation();

  const handleUploadImage = useCallback(async (file: File): Promise<string | null> => {
    try {
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          const base64Data = result.split(",")[1];
          resolve(base64Data);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const { url } = await uploadImageMutation.mutateAsync({
        base64Data: base64,
        contentType: file.type as "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml",
        fileName: file.name,
      });
      return url;
    } catch {
      toast.error("Failed to upload image");
      return null;
    }
  }, [uploadImageMutation]);

  const notes = useMemo<NoteRow[]>(() => (notesData ?? []).map((note: any) => ({ ...note })), [notesData]);

  const selectedNoteFromQuery = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((note) => String(note.id) === String(selectedNoteId)) ?? null;
  }, [notes, selectedNoteId]);

  const smartCounts = useMemo(() => {
    const all = notes.length;
    const pinned = notes.filter((note) => Boolean(note.pinned)).length;
    const linked = notes.filter((note) => (note.links?.length ?? 0) > 0).length;
    return { all, pinned, linked };
  }, [notes]);

  const notebookCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes) {
      const notebook = normalizeNotebook(note.notebook);
      counts.set(notebook, (counts.get(notebook) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [notes]);

  const visibleNotes = useMemo(() => {
    let rows = [...notes];

    if (selectedNotebook !== "All Notebooks") {
      rows = rows.filter((note) => normalizeNotebook(note.notebook) === selectedNotebook);
    }

    if (viewFilter === "pinned") {
      rows = rows.filter((note) => Boolean(note.pinned));
    } else if (viewFilter === "linked") {
      rows = rows.filter((note) => (note.links?.length ?? 0) > 0);
    }

    if (eventFilterKey) {
      rows = rows.filter((note) => noteMatchesEventFilter(note, eventFilterKey));
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      rows = rows.filter((note) => {
        const title = normalizeTitle(note.title).toLowerCase();
        const notebook = normalizeNotebook(note.notebook).toLowerCase();
        const content = extractTextPreview(note.content).toLowerCase();
        return title.includes(query) || notebook.includes(query) || content.includes(query);
      });
    }

    rows.sort((a, b) => {
      const aPinned = Boolean(a.pinned) ? 1 : 0;
      const bPinned = Boolean(b.pinned) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;

      const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTs - aTs;
    });

    return rows;
  }, [notes, selectedNotebook, viewFilter, eventFilterKey, searchQuery]);

  const pagesTotal = Math.max(1, Math.ceil(visibleNotes.length / NOTES_PAGE_SIZE));
  const pagesCurrent = Math.min(notesPage, pagesTotal);
  const pageStart = (pagesCurrent - 1) * NOTES_PAGE_SIZE;
  const pageEnd = pageStart + NOTES_PAGE_SIZE;

  const notesInPage = useMemo(
    () => visibleNotes.slice(pageStart, pageEnd),
    [visibleNotes, pageStart, pageEnd]
  );

  const notebookSearchRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return notebookCounts;
    return notebookCounts.filter((row) => row.name.toLowerCase().includes(query));
  }, [notebookCounts, searchQuery]);

  const selectedNoteLinks = useMemo(() => {
    if (!selectedNoteFromQuery) return [];
    return Array.isArray(selectedNoteFromQuery.links) ? selectedNoteFromQuery.links : [];
  }, [selectedNoteFromQuery]);

  const clearAutosaveTimers = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (autosaveMaxTimerRef.current !== null) {
      window.clearTimeout(autosaveMaxTimerRef.current);
      autosaveMaxTimerRef.current = null;
    }
  }, []);

  const updateDraftFromController = useCallback((nextSnapshot: NoteDraftSnapshot) => {
    setNoteDraft(nextSnapshot);
    setSelectedNoteId(nextSnapshot.noteId);
  }, []);

  const applyLocalDraftChanges = useCallback(
    (changes: Partial<Omit<NoteDraftSnapshot, "revision">>) => {
      const nextSnapshot = saveControllerRef.current.markLocalChange(changes);
      updateDraftFromController(nextSnapshot);
      setSaveState("unsaved");
      setConflictNote(null);
      dismissedConflictUpdatedAtRef.current = null;
    },
    [updateDraftFromController]
  );

  const hydrateFromServerNote = useCallback(
    (note: NoteRow | null, fallbackNotebook?: string) => {
      const snapshot = saveControllerRef.current.hydrate({
        noteId: note ? String(note.id) : null,
        title: note ? String(note.title || "") : "",
        notebook: note ? normalizeNotebook(note.notebook) : normalizeNotebook(fallbackNotebook || "General"),
        contentHtml: note ? normalizeContentForEditor(String(note.content || "")) : "<p></p>",
        pinned: note ? Boolean(note.pinned) : false,
      });

      updateDraftFromController(snapshot);
      baselineServerRef.current = {
        noteId: snapshot.noteId,
        updatedAt: note ? String(note.updatedAt || "") : "",
      };
      setConflictNote(null);
      dismissedConflictUpdatedAtRef.current = null;
      setSaveState("saved");
    },
    [updateDraftFromController]
  );

  const updateCacheWithSnapshot = useCallback(
    (snapshot: NoteDraftSnapshot, updatedAtIso: string) => {
      const noteId = snapshot.noteId;
      if (!noteId) return;

      trpcUtils.notes.list.setData({ limit: notesFetchLimit }, (current) => {
        if (!Array.isArray(current)) return current;
        const rows = [...current] as any[];

        const existingIndex = rows.findIndex((row: any) => String(row.id) === String(noteId));
        const existing = existingIndex >= 0 ? rows[existingIndex] : null;

        const nextRow: any = {
          ...(existing || {}),
          id: noteId,
          notebook: normalizeNotebook(snapshot.notebook),
          title: normalizeTitle(snapshot.title),
          content: snapshot.contentHtml,
          pinned: snapshot.pinned,
          createdAt: existing?.createdAt || updatedAtIso,
          updatedAt: updatedAtIso,
          links: existing?.links || [],
        };

        const nextRows = [...rows];
        if (existingIndex >= 0) {
          nextRows[existingIndex] = nextRow;
        } else {
          nextRows.unshift(nextRow);
        }

        nextRows.sort((a: any, b: any) => {
          const aPinned = Boolean(a?.pinned) ? 1 : 0;
          const bPinned = Boolean(b?.pinned) ? 1 : 0;
          if (aPinned !== bPinned) return bPinned - aPinned;

          const aTs = new Date(a?.updatedAt || a?.createdAt || 0).getTime();
          const bTs = new Date(b?.updatedAt || b?.createdAt || 0).getTime();
          return bTs - aTs;
        });

        return nextRows as any;
      });
    },
    [notesFetchLimit, trpcUtils.notes.list]
  );

  const persistSnapshot = useCallback(
    async (snapshot: NoteDraftSnapshot): Promise<{ noteId: string | null }> => {
      const payload = {
        notebook: normalizeNotebook(snapshot.notebook),
        title: normalizeTitle(snapshot.title),
        content: snapshot.contentHtml,
        pinned: snapshot.pinned,
      };

      if (snapshot.noteId) {
        await updateNoteMutation.mutateAsync({
          noteId: snapshot.noteId,
          ...payload,
        });
        return { noteId: snapshot.noteId };
      }

      const created = await createNoteMutation.mutateAsync(payload);
      return { noteId: String(created.noteId) };
    },
    [createNoteMutation, updateNoteMutation]
  );

  const applySaveResult = useCallback(
    (updatedAtIso: string) => {
      const controller = saveControllerRef.current;
      const latest = controller.getSnapshot();
      updateDraftFromController(latest);

      if (latest.noteId) {
        updateCacheWithSnapshot(latest, updatedAtIso);
        baselineServerRef.current = {
          noteId: latest.noteId,
          updatedAt: updatedAtIso,
        };
      }

      if (controller.isDirty()) {
        setSaveState("unsaved");
      } else {
        setSaveState("saved");
        setLastSavedAt(new Date(updatedAtIso));
        clearAutosaveTimers();
      }
    },
    [clearAutosaveTimers, updateCacheWithSnapshot, updateDraftFromController]
  );

  const runSave = useCallback(
    async (mode: "auto" | "manual" | "switch" = "manual"): Promise<boolean> => {
      const controller = saveControllerRef.current;

      if (!controller.isDirty() && !controller.isSaving()) {
        if (mode === "manual") {
          setSaveState("saved");
        }
        return true;
      }

      setSaveState("saving");
      const result = await controller.save(persistSnapshot);

      if (!result.ok) {
        setSaveState("error");
        toast.error(`Could not save note: ${result.error instanceof Error ? result.error.message : "Unknown error"}`);
        return false;
      }

      applySaveResult(new Date().toISOString());
      return true;
    },
    [applySaveResult, persistSnapshot]
  );

  const flushSaves = useCallback(async (): Promise<boolean> => {
    const controller = saveControllerRef.current;
    if (!controller.isDirty() && !controller.isSaving()) return true;

    setSaveState("saving");
    const result = await controller.flush(persistSnapshot);

    if (!result.ok) {
      setSaveState("error");
      toast.error(`Could not save note: ${result.error instanceof Error ? result.error.message : "Unknown error"}`);
      return false;
    }

    applySaveResult(new Date().toISOString());
    return true;
  }, [applySaveResult, persistSnapshot]);

  const createDraft = useCallback(async () => {
    const ok = await flushSaves();
    if (!ok) return;

    const fallbackNotebook = selectedNotebook === "All Notebooks" ? "General" : selectedNotebook;
    hydrateFromServerNote(null, fallbackNotebook);
    setMobilePagesOpen(false);
  }, [flushSaves, hydrateFromServerNote, selectedNotebook]);

  const selectExistingNote = useCallback(
    async (noteId: string) => {
      if (!noteId) return;
      if (String(selectedNoteId || "") === String(noteId) && saveControllerRef.current.getSnapshot().noteId === noteId) {
        setMobilePagesOpen(false);
        return;
      }

      const ok = await flushSaves();
      if (!ok) return;

      const target = notes.find((note) => String(note.id) === String(noteId));
      if (!target) {
        toast.error("Could not load note");
        return;
      }

      hydrateFromServerNote(target);
      setMobilePagesOpen(false);
    },
    [flushSaves, hydrateFromServerNote, notes, selectedNoteId]
  );

  const deleteSelectedNote = useCallback(async () => {
    const noteId = saveControllerRef.current.getSnapshot().noteId;

    if (!noteId) {
      setIsDeleteDialogOpen(false);
      const fallbackNotebook = selectedNotebook === "All Notebooks" ? "General" : selectedNotebook;
      hydrateFromServerNote(null, fallbackNotebook);
      return;
    }

    const currentIndex = visibleNotes.findIndex((note) => String(note.id) === String(noteId));
    const fallback = visibleNotes[currentIndex + 1] || visibleNotes[currentIndex - 1] || null;

    try {
      await deleteNoteMutation.mutateAsync({ noteId });
      await trpcUtils.notes.list.invalidate();
      toast.success("Note deleted.");

      if (fallback) {
        hydrateFromServerNote(fallback);
      } else {
        const fallbackNotebook = selectedNotebook === "All Notebooks" ? "General" : selectedNotebook;
        hydrateFromServerNote(null, fallbackNotebook);
      }
    } catch (error) {
      toast.error(`Could not delete note: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsDeleteDialogOpen(false);
    }
  }, [deleteNoteMutation, hydrateFromServerNote, selectedNotebook, trpcUtils.notes.list, visibleNotes]);

  const removeLink = useCallback(
    async (linkId: string) => {
      if (!linkId) return;
      try {
        await removeNoteLinkMutation.mutateAsync({ linkId });
        await trpcUtils.notes.list.invalidate();
        toast.success("Link removed.");
      } catch (error) {
        toast.error(`Could not remove link: ${error instanceof Error ? error.message : "Unknown error"}`);
      }
    },
    [removeNoteLinkMutation, trpcUtils.notes.list]
  );

  useEffect(() => {
    if (!loading && !user) {
      setLocation("/");
    }
  }, [loading, user, setLocation]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const routeNotebook = params.get("notebook");
    const routeView = params.get("view")?.trim().toLowerCase();
    const routeNoteId = params.get("noteId");
    const routeEventId = params.get("eventId");
    const routeSeriesId = params.get("seriesId");
    const routeNew = params.get("new") === "1";

    if (routeNotebook && routeNotebook.trim()) {
      if (routeNotebook.trim().toLowerCase() === "all") {
        setSelectedNotebook("All Notebooks");
      } else {
        setSelectedNotebook(routeNotebook.trim());
      }
    }

    if (routeView === "pinned") {
      setViewFilter("pinned");
    } else if (routeView === "linked" || routeView === "calendar") {
      setViewFilter("linked");
    }

    if (routeSeriesId && routeSeriesId.trim()) {
      setEventFilterKey(`series:${routeSeriesId.trim()}`);
    } else if (routeEventId && routeEventId.trim()) {
      setEventFilterKey(`event:${routeEventId.trim()}`);
    }

    if (routeNoteId && routeNoteId.trim()) {
      setPendingRouteNoteId(routeNoteId.trim());
    }

    if (routeNew) {
      setRouteWantsNewDraft(true);
    }
  }, []);

  useEffect(() => {
    if (notesPage > pagesTotal) {
      setNotesPage(pagesTotal);
    }
  }, [notesPage, pagesTotal]);

  useEffect(() => {
    setNotesPage(1);
  }, [selectedNotebook, viewFilter, eventFilterKey, searchQuery]);

  useEffect(() => {
    if (notesLoading) return;

    if (routeWantsNewDraft) {
      const fallbackNotebook = selectedNotebook === "All Notebooks" ? "General" : selectedNotebook;
      hydrateFromServerNote(null, fallbackNotebook);
      setRouteWantsNewDraft(false);
      return;
    }

    if (pendingRouteNoteId) {
      const target = notes.find((note) => String(note.id) === String(pendingRouteNoteId));
      if (target) {
        hydrateFromServerNote(target);
      }
      setPendingRouteNoteId(null);
      return;
    }

    const controller = saveControllerRef.current;
    const currentSnapshot = controller.getSnapshot();

    if (currentSnapshot.noteId) {
      const target = notes.find((note) => String(note.id) === String(currentSnapshot.noteId));
      if (target) {
        const baseline = baselineServerRef.current;
        const targetUpdatedAt = String(target.updatedAt || "");
        const shouldHydrate =
          !controller.isDirty() &&
          !controller.isSaving() &&
          (baseline.noteId !== currentSnapshot.noteId || baseline.updatedAt !== targetUpdatedAt);

        if (shouldHydrate) {
          hydrateFromServerNote(target);
        }
      }
      return;
    }

    if (visibleNotes.length > 0) {
      hydrateFromServerNote(visibleNotes[0]);
      return;
    }

    if (!controller.isDirty()) {
      const fallbackNotebook = selectedNotebook === "All Notebooks" ? "General" : selectedNotebook;
      hydrateFromServerNote(null, fallbackNotebook);
    }
  }, [
    notesLoading,
    notes,
    pendingRouteNoteId,
    routeWantsNewDraft,
    visibleNotes,
    selectedNotebook,
    hydrateFromServerNote,
  ]);

  useEffect(() => {
    const controller = saveControllerRef.current;
    if (!user) return;

    if (!controller.isDirty()) {
      clearAutosaveTimers();
      return;
    }

    setSaveState((current) => (current === "saving" ? current : "unsaved"));

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(() => {
      void runSave("auto");
    }, AUTOSAVE_DEBOUNCE_MS);

    if (autosaveMaxTimerRef.current === null) {
      autosaveMaxTimerRef.current = window.setTimeout(() => {
        void runSave("auto");
      }, AUTOSAVE_MAX_WAIT_MS);
    }
  }, [clearAutosaveTimers, noteDraft.revision, runSave, user]);

  useEffect(() => {
    return () => {
      clearAutosaveTimers();
    };
  }, [clearAutosaveTimers]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        void runSave("manual");
        return;
      }

      if (key === "n") {
        event.preventDefault();
        void createDraft();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [createDraft, runSave]);

  useEffect(() => {
    const handleFocus = () => {
      const controller = saveControllerRef.current;
      if (!controller.isDirty() && !controller.isSaving()) {
        void refetchNotes();
      } else {
        void trpcUtils.notes.list.fetch({ limit: notesFetchLimit });
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [notesFetchLimit, refetchNotes, trpcUtils.notes.list]);

  useEffect(() => {
    const currentNoteId = saveControllerRef.current.getSnapshot().noteId;
    if (!currentNoteId) return;

    const baseline = baselineServerRef.current;
    if (baseline.noteId !== currentNoteId) return;

    const serverNote = notes.find((note) => String(note.id) === String(currentNoteId));
    if (!serverNote) return;

    const serverUpdatedAt = String(serverNote.updatedAt || "");
    if (!serverUpdatedAt || !baseline.updatedAt || serverUpdatedAt === baseline.updatedAt) return;

    const controller = saveControllerRef.current;
    if (controller.isDirty() || controller.isSaving()) {
      if (dismissedConflictUpdatedAtRef.current === serverUpdatedAt) return;
      setConflictNote(serverNote);
      return;
    }

    hydrateFromServerNote(serverNote);
  }, [hydrateFromServerNote, noteDraft.revision, notes]);

  const canLoadMore = useMemo(() => notes.length >= notesFetchLimit, [notes.length, notesFetchLimit]);

  const statusLabel = saveStateLabel(saveState, lastSavedAt);

  const renderNotebookPane = (isMobile = false) => (
    <div className="flex h-full flex-col gap-3">
      <div className="space-y-2 border-b border-slate-200 pb-3">
        <Button
          onClick={() => void createDraft()}
          className="w-full justify-start bg-emerald-600 text-white hover:bg-emerald-700"
        >
          <Plus className="mr-2 h-4 w-4" />
          New Page
        </Button>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search notes and notebooks"
            className="pl-9"
          />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Views</p>
        <div className="grid grid-cols-1 gap-1.5">
          {([
            { key: "all", label: "All Notes", count: smartCounts.all },
            { key: "pinned", label: "Pinned", count: smartCounts.pinned },
            { key: "linked", label: "Linked", count: smartCounts.linked },
          ] as const).map((row) => {
            const active = viewFilter === row.key;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => {
                  setViewFilter(row.key);
                  if (isMobile) setMobileNotebooksOpen(false);
                }}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                  active
                    ? "border-emerald-500 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span>{row.label}</span>
                <span className="text-xs font-medium">{row.count}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Notebooks</p>
        <button
          type="button"
          onClick={() => {
            setSelectedNotebook("All Notebooks");
            if (isMobile) setMobileNotebooksOpen(false);
          }}
          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
            selectedNotebook === "All Notebooks"
              ? "border-emerald-500 bg-emerald-50 text-emerald-900"
              : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          }`}
        >
          <span>All Notebooks</span>
          <span className="text-xs font-medium">{smartCounts.all}</span>
        </button>

        {notebookSearchRows.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-300 px-3 py-2 text-xs text-slate-500">
            No matching notebooks.
          </p>
        ) : (
          notebookSearchRows.map((row) => {
            const active = selectedNotebook === row.name;
            return (
              <button
                key={row.name}
                type="button"
                onClick={() => {
                  setSelectedNotebook(row.name);
                  if (isMobile) setMobileNotebooksOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                  active
                    ? "border-blue-500 bg-blue-50 text-blue-900"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span className="truncate">{row.name}</span>
                <span className="text-xs font-medium">{row.count}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  const renderPagesPane = (isMobile = false) => (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-slate-200 pb-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">Pages</p>
          <Badge variant="outline" className="text-slate-600">
            {visibleNotes.length}
          </Badge>
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Filter className="h-3.5 w-3.5" />
          <span>{selectedNotebook === "All Notebooks" ? "All notebooks" : selectedNotebook}</span>
          <span>•</span>
          <span>{viewFilter === "all" ? "All" : viewFilter === "pinned" ? "Pinned" : "Linked"}</span>
        </div>

        {eventFilterKey ? (
          <div className="flex items-center justify-between rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
            <span className="truncate">Calendar filter active: {eventFilterKey}</span>
            <button
              type="button"
              className="ml-2 rounded p-0.5 hover:bg-amber-100"
              onClick={() => setEventFilterKey("")}
              aria-label="Clear calendar filter"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1 pt-3">
        {notesLoading ? (
          <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading notes...
          </div>
        ) : notesError ? (
          <div className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            Failed to load notes: {notesError.message}
          </div>
        ) : notesInPage.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 px-3 py-5 text-sm text-slate-500">
            No notes match your filters.
          </div>
        ) : (
          <div className="space-y-2">
            {notesInPage.map((note) => {
              const active = String(saveControllerRef.current.getSnapshot().noteId || "") === String(note.id);
              const linksCount = note.links?.length ?? 0;
              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => void selectExistingNote(String(note.id))}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    active
                      ? "border-emerald-500 bg-emerald-50 shadow-sm"
                      : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <div className="mb-1.5 flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-sm font-semibold text-slate-900">{normalizeTitle(note.title)}</p>
                    {note.pinned ? <Pin className="h-3.5 w-3.5 shrink-0 text-amber-500" /> : null}
                  </div>

                  <p className="mb-2 line-clamp-2 text-xs text-slate-600">
                    {extractTextPreview(note.content).slice(0, 100) || "No content yet."}
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                    <Badge variant="outline" className="h-5 border-slate-300 px-1.5 font-normal">
                      {normalizeNotebook(note.notebook)}
                    </Badge>
                    {linksCount > 0 ? (
                      <Badge variant="outline" className="h-5 border-blue-300 bg-blue-50 px-1.5 text-blue-700">
                        {linksCount} link{linksCount === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                    <span className="ml-auto inline-flex items-center gap-1">
                      <Clock3 className="h-3 w-3" />
                      {relativeTime(note.updatedAt || note.createdAt)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>
            Page {pagesCurrent} of {pagesTotal}
          </span>
          <span>
            {visibleNotes.length === 0
              ? "0 results"
              : `Showing ${pageStart + 1}-${Math.min(pageEnd, visibleNotes.length)} of ${visibleNotes.length}`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => setNotesPage((current) => Math.max(1, current - 1))}
            disabled={pagesCurrent <= 1}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1"
            onClick={() => setNotesPage((current) => Math.min(pagesTotal, current + 1))}
            disabled={pagesCurrent >= pagesTotal}
          >
            Next
          </Button>
        </div>
        {canLoadMore ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setNotesFetchLimit((current) => current + 500)}
          >
            Load 500 more notes
          </Button>
        ) : null}
        {isMobile ? (
          <Button variant="ghost" size="sm" className="w-full" onClick={() => setMobilePagesOpen(false)}>
            Close
          </Button>
        ) : null}
      </div>
    </div>
  );

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="text-sm text-slate-600">Loading notebook...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#f8fafc] via-[#fdfdff] to-[#eef2ff]">
      <div className="mx-auto max-w-[1800px] space-y-4 p-4 md:p-6">
        <Card className="border-slate-200 bg-white/95 shadow-sm">
          <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="mb-1 inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                <BookOpen className="h-3.5 w-3.5" />
                Notebook
              </div>
              <h1 className="text-2xl font-semibold text-slate-900">Structured Notes Workspace</h1>
              <p className="mt-1 text-sm text-slate-600">
                Stable rich-text editing with deterministic autosave and OneNote-style navigation.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setLocation("/dashboard")}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to Dashboard
              </Button>
              <Button variant="outline" onClick={() => void refetchNotes()}>
                Refresh
              </Button>
              <Button onClick={() => void createDraft()} className="bg-emerald-600 text-white hover:bg-emerald-700">
                <Plus className="mr-2 h-4 w-4" />
                New Page
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="lg:hidden">
          <Card className="border-slate-200 bg-white/90">
            <CardContent className="flex items-center gap-2 p-3">
              <Button variant="outline" size="sm" onClick={() => setMobileNotebooksOpen(true)}>
                <PanelLeft className="mr-2 h-4 w-4" />
                Notebooks
              </Button>
              <Button variant="outline" size="sm" onClick={() => setMobilePagesOpen(true)}>
                <FileText className="mr-2 h-4 w-4" />
                Pages
              </Button>
              <div className="ml-auto text-xs text-slate-500">{visibleNotes.length} visible</div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_360px_minmax(0,1fr)]">
          <Card className="hidden h-[calc(100vh-13.5rem)] border-slate-200 bg-white/95 lg:flex lg:flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Notebooks</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">{renderNotebookPane()}</CardContent>
          </Card>

          <Card className="hidden h-[calc(100vh-13.5rem)] border-slate-200 bg-white/95 lg:flex lg:flex-col">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Pages</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 flex-1">{renderPagesPane()}</CardContent>
          </Card>

          <Card className="h-[calc(100vh-13.5rem)] border-slate-200 bg-white/95">
            <CardContent className="flex h-full flex-col p-0">
              <div className="space-y-3 border-b border-slate-200 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={noteDraft.title}
                    onChange={(event) => applyLocalDraftChanges({ title: event.target.value })}
                    placeholder="Page title"
                    className="h-11 flex-1 border-slate-300 text-lg font-semibold"
                  />
                  <Button
                    variant={noteDraft.pinned ? "default" : "outline"}
                    className={noteDraft.pinned ? "bg-amber-500 text-white hover:bg-amber-600" : ""}
                    onClick={() => applyLocalDraftChanges({ pinned: !noteDraft.pinned })}
                    title={noteDraft.pinned ? "Unpin page" : "Pin page"}
                  >
                    {noteDraft.pinned ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
                    {noteDraft.pinned ? "Unpin" : "Pin"}
                  </Button>
                  <Button variant="outline" onClick={() => void runSave("manual")} disabled={saveState === "saving"}>
                    {saveState === "saving" ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Saving
                      </>
                    ) : (
                      <>
                        <Save className="mr-2 h-4 w-4" />
                        Save
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    className="border-rose-300 text-rose-700 hover:bg-rose-50"
                    onClick={() => setIsDeleteDialogOpen(true)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    value={noteDraft.notebook}
                    onChange={(event) => applyLocalDraftChanges({ notebook: event.target.value })}
                    placeholder="Notebook (example: Meetings, Projects, Personal)"
                    className="h-9 w-full max-w-sm border-slate-300"
                  />

                  <div className="ml-auto flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={`h-7 border text-xs ${
                        saveState === "error"
                          ? "border-rose-300 bg-rose-50 text-rose-700"
                          : saveState === "unsaved"
                            ? "border-amber-300 bg-amber-50 text-amber-700"
                            : saveState === "saving"
                              ? "border-blue-300 bg-blue-50 text-blue-700"
                              : "border-emerald-300 bg-emerald-50 text-emerald-700"
                      }`}
                    >
                      {statusLabel}
                    </Badge>
                  </div>
                </div>

                {conflictNote ? (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900">
                    <AlertTriangle className="h-4 w-4" />
                    <span className="mr-1">This note was updated in another tab.</span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-amber-400 bg-white text-amber-900 hover:bg-amber-100"
                      onClick={() => {
                        dismissedConflictUpdatedAtRef.current = String(conflictNote.updatedAt || "");
                        setConflictNote(null);
                      }}
                    >
                      Keep mine
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-amber-400 bg-white text-amber-900 hover:bg-amber-100"
                      onClick={() => {
                        hydrateFromServerNote(conflictNote);
                        setConflictNote(null);
                      }}
                    >
                      Reload latest
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
                <div className="min-h-0 border-r border-slate-200">
                  <Suspense
                    fallback={
                      <div className="flex h-full min-h-[320px] items-center justify-center text-sm text-slate-500">
                        Loading editor...
                      </div>
                    }
                  >
                    <RichTextEditor
                      value={noteDraft.contentHtml}
                      onChange={(value) => applyLocalDraftChanges({ contentHtml: value })}
                      onSaveShortcut={() => {
                        void runSave("manual");
                      }}
                      onUploadImage={handleUploadImage}
                      className="h-full"
                    />
                  </Suspense>
                </div>

                <div className="hidden min-h-0 flex-col border-t border-slate-200 bg-slate-50/60 xl:flex xl:border-t-0">
                  <div className="border-b border-slate-200 px-4 py-3">
                    <p className="text-sm font-semibold text-slate-900">Linked Items</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      Existing links for this page. Manage or remove links from here.
                    </p>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {selectedNoteLinks.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-slate-300 bg-white px-3 py-4 text-xs text-slate-500">
                        No links on this note.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {selectedNoteLinks.map((link) => (
                          <div key={link.id} className="rounded-lg border border-slate-200 bg-white p-3">
                            <div className="flex items-start justify-between gap-2">
                              <div>
                                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                                  {linkLabel(link.linkType)}
                                </p>
                                <p className="mt-1 line-clamp-2 text-sm font-medium text-slate-900">
                                  {link.sourceTitle || link.externalId || "Linked item"}
                                </p>
                                <p className="mt-1 text-[11px] text-slate-500">Added {formatDateTime(link.createdAt)}</p>
                              </div>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-rose-600 hover:bg-rose-50"
                                onClick={() => void removeLink(link.id)}
                                title="Remove link"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                            {link.sourceUrl ? (
                              <a
                                href={String(link.sourceUrl)}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-2 inline-flex max-w-full items-center gap-1 text-xs text-blue-700 underline-offset-2 hover:underline"
                              >
                                <Link2 className="h-3 w-3" />
                                <span className="truncate">Open source</span>
                              </a>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <Sheet open={mobileNotebooksOpen} onOpenChange={setMobileNotebooksOpen}>
        <SheetContent side="left" className="w-[90vw] max-w-sm">
          <SheetHeader>
            <SheetTitle>Notebooks</SheetTitle>
            <SheetDescription>Choose a notebook or view.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 px-4 pb-4">{renderNotebookPane(true)}</div>
        </SheetContent>
      </Sheet>

      <Sheet open={mobilePagesOpen} onOpenChange={setMobilePagesOpen}>
        <SheetContent side="left" className="w-[95vw] max-w-md">
          <SheetHeader>
            <SheetTitle>Pages</SheetTitle>
            <SheetDescription>Browse notes for the current filters.</SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1 px-4 pb-4">{renderPagesPane(true)}</div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the note and all links tied to it. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteSelectedNote()} className="bg-rose-600 hover:bg-rose-700">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
