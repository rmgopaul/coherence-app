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
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/lib/trpc";
import {
  ArrowLeft,
  Bold,
  BookOpen,
  Clock3,
  FileText,
  Filter,
  Italic,
  Link2,
  List,
  ListOrdered,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type ViewFilter = "all" | "pinned" | "linked";
type SaveState = "saved" | "saving" | "unsaved" | "error";
type NoteRow = {
  id: string;
  title?: string;
  notebook?: string;
  content?: string;
  pinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  links?: Array<{
    id: string;
    linkType?: string;
    externalId?: string;
    seriesId?: string;
    sourceTitle?: string | null;
    sourceUrl?: string | null;
    metadata?: string | Record<string, unknown> | null;
    createdAt?: string;
  }>;
};

const NOTES_PAGE_SIZE = 30;

function decodeHtmlEntities(content: string): string {
  if (typeof window === "undefined") {
    return content.replace(/&nbsp;/gi, " ");
  }
  const textarea = document.createElement("textarea");
  textarea.innerHTML = content;
  return textarea.value;
}

function stripHtml(content: string): string {
  const decoded = decodeHtmlEntities(content || "");
  return decoded
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function toEditorText(content: string): string {
  const raw = String(content || "");
  if (!raw) return "";
  if (/<[a-z][\s\S]*>/i.test(raw)) {
    return stripHtml(raw);
  }
  return decodeHtmlEntities(raw);
}

function normalizeNotebook(value: string | null | undefined): string {
  const cleaned = String(value || "").trim();
  return cleaned || "General";
}

function normalizeTitle(value: string | null | undefined): string {
  const cleaned = String(value || "").trim();
  return cleaned || "Untitled note";
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

function getNotePreview(content: string, maxLen = 160): string {
  const text = toEditorText(content || "").replace(/\s+/g, " ").trim();
  if (!text) return "No content yet.";
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trimEnd()}...`;
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
  const [isDraftMode, setIsDraftMode] = useState(true);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const [noteTitleInput, setNoteTitleInput] = useState("");
  const [noteNotebookInput, setNoteNotebookInput] = useState("General");
  const [noteContentInput, setNoteContentInput] = useState("");
  const [notePinnedInput, setNotePinnedInput] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const [mobileNotebooksOpen, setMobileNotebooksOpen] = useState(false);
  const [mobilePagesOpen, setMobilePagesOpen] = useState(false);

  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const savePromiseRef = useRef<Promise<string | null> | null>(null);

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

    if (routeView === "pinned") setViewFilter("pinned");
    if (routeView === "linked" || routeView === "calendar") setViewFilter("linked");

    if (routeSeriesId && routeSeriesId.trim()) {
      setEventFilterKey(`series:${routeSeriesId.trim()}`);
    } else if (routeEventId && routeEventId.trim()) {
      setEventFilterKey(`event:${routeEventId.trim()}`);
    }

    if (routeNoteId && routeNoteId.trim()) {
      setSelectedNoteId(routeNoteId.trim());
      setIsDraftMode(false);
      return;
    }

    if (routeNew) {
      setSelectedNoteId(null);
      setIsDraftMode(true);
      setNoteTitleInput("");
      setNoteNotebookInput(routeNotebook && routeNotebook.trim() ? normalizeNotebook(routeNotebook) : "General");
      setNoteContentInput("");
      setNotePinnedInput(false);
      setIsDirty(false);
      setSaveState("saved");
    }
  }, []);

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

  const notes = useMemo(() => (notesData ?? []) as NoteRow[], [notesData]);

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

  const selectedNote = useMemo(() => {
    if (!selectedNoteId) return null;
    return notes.find((note) => String(note.id) === String(selectedNoteId)) ?? null;
  }, [notes, selectedNoteId]);

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
        const content = toEditorText(note.content || "").toLowerCase();
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
  const notesInPage = useMemo(() => visibleNotes.slice(pageStart, pageEnd), [visibleNotes, pageStart, pageEnd]);

  useEffect(() => {
    if (notesPage > pagesTotal) {
      setNotesPage(pagesTotal);
    }
  }, [notesPage, pagesTotal]);

  useEffect(() => {
    setNotesPage(1);
  }, [selectedNotebook, viewFilter, eventFilterKey, searchQuery]);

  useEffect(() => {
    if (isDraftMode) return;
    if (!selectedNoteId || !selectedNote) return;
    if (isDirty) return;

    setNoteTitleInput(String(selectedNote.title || ""));
    setNoteNotebookInput(normalizeNotebook(selectedNote.notebook));
    setNoteContentInput(toEditorText(selectedNote.content || ""));
    setNotePinnedInput(Boolean(selectedNote.pinned));
    setSaveState("saved");
  }, [
    selectedNoteId,
    selectedNote?.id,
    selectedNote?.title,
    selectedNote?.notebook,
    selectedNote?.content,
    selectedNote?.pinned,
    selectedNote?.updatedAt,
    isDraftMode,
    isDirty,
  ]);

  useEffect(() => {
    if (notesLoading) return;
    if (!selectedNoteId && !isDraftMode && visibleNotes.length > 0) {
      setSelectedNoteId(String(visibleNotes[0].id));
      setIsDraftMode(false);
    }
  }, [notesLoading, selectedNoteId, isDraftMode, visibleNotes]);

  const canLoadMore = useMemo(() => notes.length >= notesFetchLimit, [notes.length, notesFetchLimit]);

  const saveCurrentNote = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    if (!isDirty) return selectedNoteId;

    if (savePromiseRef.current) {
      return savePromiseRef.current;
    }

    const runner = (async (): Promise<string | null> => {
      const payload = {
        notebook: normalizeNotebook(noteNotebookInput),
        title: normalizeTitle(noteTitleInput),
        content: noteContentInput,
        pinned: notePinnedInput,
      };

      setSaveState("saving");

      try {
        let resolvedNoteId = selectedNoteId;

        if (resolvedNoteId) {
          await updateNoteMutation.mutateAsync({
            noteId: resolvedNoteId,
            ...payload,
          });
        } else {
          const created = await createNoteMutation.mutateAsync(payload);
          resolvedNoteId = String(created.noteId);
          setSelectedNoteId(resolvedNoteId);
          setIsDraftMode(false);
        }

        setIsDirty(false);
        setSaveState("saved");
        setLastSavedAt(new Date());

        await trpcUtils.notes.list.invalidate();
        return resolvedNoteId;
      } catch (error) {
        setSaveState("error");
        toast.error(`Could not save note: ${error instanceof Error ? error.message : "Unknown error"}`);
        return null;
      }
    })();

    savePromiseRef.current = runner;
    try {
      return await runner;
    } finally {
      savePromiseRef.current = null;
    }
  }, [
    user,
    isDirty,
    selectedNoteId,
    noteNotebookInput,
    noteTitleInput,
    noteContentInput,
    notePinnedInput,
    updateNoteMutation,
    createNoteMutation,
    trpcUtils.notes.list,
  ]);

  const discardAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    discardAutosaveTimer();
    if (!user || !isDirty) return;

    setSaveState("unsaved");
    autosaveTimerRef.current = window.setTimeout(() => {
      void saveCurrentNote();
    }, 900);

    return () => {
      discardAutosaveTimer();
    };
  }, [user, isDirty, noteTitleInput, noteNotebookInput, noteContentInput, notePinnedInput, saveCurrentNote, discardAutosaveTimer]);

  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();

      if (key === "s") {
        event.preventDefault();
        void saveCurrentNote();
      }

      if (key === "n") {
        event.preventDefault();
        void (async () => {
          await saveCurrentNote();
          setSelectedNoteId(null);
          setIsDraftMode(true);
          setNoteTitleInput("");
          setNoteNotebookInput(selectedNotebook === "All Notebooks" ? "General" : selectedNotebook);
          setNoteContentInput("");
          setNotePinnedInput(false);
          setIsDirty(false);
          setSaveState("saved");
          setMobilePagesOpen(false);
        })();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [saveCurrentNote, selectedNotebook]);

  const createDraft = useCallback(async () => {
    await saveCurrentNote();
    setSelectedNoteId(null);
    setIsDraftMode(true);
    setNoteTitleInput("");
    setNoteNotebookInput(selectedNotebook === "All Notebooks" ? "General" : selectedNotebook);
    setNoteContentInput("");
    setNotePinnedInput(false);
    setIsDirty(false);
    setSaveState("saved");
    setMobilePagesOpen(false);
    requestAnimationFrame(() => {
      editorRef.current?.focus();
    });
  }, [saveCurrentNote, selectedNotebook]);

  const selectExistingNote = useCallback(
    async (noteId: string) => {
      if (!noteId) return;
      if (!isDraftMode && String(selectedNoteId || "") === String(noteId)) {
        setMobilePagesOpen(false);
        return;
      }

      await saveCurrentNote();
      setSelectedNoteId(noteId);
      setIsDraftMode(false);
      setIsDirty(false);
      setSaveState("saved");
      setMobilePagesOpen(false);
    },
    [isDraftMode, selectedNoteId, saveCurrentNote]
  );

  const deleteSelectedNote = useCallback(async () => {
    if (!selectedNoteId) {
      setIsDeleteDialogOpen(false);
      setSelectedNoteId(null);
      setIsDraftMode(true);
      setNoteTitleInput("");
      setNoteNotebookInput(selectedNotebook === "All Notebooks" ? "General" : selectedNotebook);
      setNoteContentInput("");
      setNotePinnedInput(false);
      setIsDirty(false);
      setSaveState("saved");
      return;
    }

    const currentIndex = visibleNotes.findIndex((note) => String(note.id) === String(selectedNoteId));
    const fallback =
      visibleNotes[currentIndex + 1] ||
      visibleNotes[currentIndex - 1] ||
      null;

    try {
      await deleteNoteMutation.mutateAsync({ noteId: selectedNoteId });
      await trpcUtils.notes.list.invalidate();
      toast.success("Note deleted.");

      if (fallback) {
        setSelectedNoteId(String(fallback.id));
        setIsDraftMode(false);
      } else {
        setSelectedNoteId(null);
        setIsDraftMode(true);
        setNoteTitleInput("");
        setNoteNotebookInput(selectedNotebook === "All Notebooks" ? "General" : selectedNotebook);
        setNoteContentInput("");
        setNotePinnedInput(false);
      }

      setIsDirty(false);
      setSaveState("saved");
    } catch (error) {
      toast.error(`Could not delete note: ${error instanceof Error ? error.message : "Unknown error"}`);
    } finally {
      setIsDeleteDialogOpen(false);
    }
  }, [
    selectedNoteId,
    visibleNotes,
    deleteNoteMutation,
    trpcUtils.notes.list,
    selectedNotebook,
  ]);

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

  const applyWrap = useCallback(
    (prefix: string, suffix = prefix) => {
      const el = editorRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const before = noteContentInput.slice(0, start);
      const selected = noteContentInput.slice(start, end);
      const after = noteContentInput.slice(end);
      const next = `${before}${prefix}${selected}${suffix}${after}`;
      setNoteContentInput(next);
      setIsDirty(true);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + prefix.length, end + prefix.length);
      });
    },
    [noteContentInput]
  );

  const applyLinePrefix = useCallback(
    (kind: "bullet" | "number") => {
      const el = editorRef.current;
      if (!el) return;
      const start = el.selectionStart;
      const end = el.selectionEnd;

      const blockStart = noteContentInput.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      const nextBreak = noteContentInput.indexOf("\n", end);
      const blockEnd = nextBreak === -1 ? noteContentInput.length : nextBreak;
      const block = noteContentInput.slice(blockStart, blockEnd);
      const lines = block.split("\n");

      const bulletRegex = /^-\s+/;
      const numberRegex = /^\d+\.\s+/;

      let transformed: string[];
      if (kind === "bullet") {
        const allBullets = lines.every((line) => line.trim() === "" || bulletRegex.test(line));
        transformed = allBullets
          ? lines.map((line) => line.replace(bulletRegex, ""))
          : lines.map((line) => (line.trim() ? (bulletRegex.test(line) ? line : `- ${line}`) : line));
      } else {
        const allNumbered = lines.every((line) => line.trim() === "" || numberRegex.test(line));
        transformed = allNumbered
          ? lines.map((line) => line.replace(numberRegex, ""))
          : lines.map((line, index) => {
              if (!line.trim()) return line;
              if (numberRegex.test(line)) return line;
              return `${index + 1}. ${line}`;
            });
      }

      const nextBlock = transformed.join("\n");
      const nextText = `${noteContentInput.slice(0, blockStart)}${nextBlock}${noteContentInput.slice(blockEnd)}`;
      setNoteContentInput(nextText);
      setIsDirty(true);

      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(blockStart, blockStart + nextBlock.length);
      });
    },
    [noteContentInput]
  );

  const insertLinkTemplate = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = noteContentInput.slice(start, end).trim() || "link text";
    const template = `[${selected}](https://)`;

    const next = `${noteContentInput.slice(0, start)}${template}${noteContentInput.slice(end)}`;
    setNoteContentInput(next);
    setIsDirty(true);

    requestAnimationFrame(() => {
      const cursorStart = start + selected.length + 3;
      const cursorEnd = cursorStart + "https://".length;
      el.focus();
      el.setSelectionRange(cursorStart, cursorEnd);
    });
  }, [noteContentInput]);

  const selectedNoteLinks = useMemo(() => {
    if (isDraftMode || !selectedNote) return [];
    return Array.isArray(selectedNote.links) ? selectedNote.links : [];
  }, [isDraftMode, selectedNote]);

  const notebookSearchRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return notebookCounts;
    return notebookCounts.filter((row) => row.name.toLowerCase().includes(query));
  }, [notebookCounts, searchQuery]);

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
              const active = !isDraftMode && String(selectedNoteId || "") === String(note.id);
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

                  <p className="mb-2 line-clamp-2 text-xs text-slate-600">{getNotePreview(String(note.content || ""), 100)}</p>

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
                OneNote-style layout with notebooks, pages, and a focused writing canvas.
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
                    value={noteTitleInput}
                    onChange={(event) => {
                      setNoteTitleInput(event.target.value);
                      setIsDirty(true);
                    }}
                    placeholder="Page title"
                    className="h-11 flex-1 border-slate-300 text-lg font-semibold"
                  />
                  <Button
                    variant={notePinnedInput ? "default" : "outline"}
                    className={notePinnedInput ? "bg-amber-500 text-white hover:bg-amber-600" : ""}
                    onClick={() => {
                      setNotePinnedInput((current) => !current);
                      setIsDirty(true);
                    }}
                    title={notePinnedInput ? "Unpin page" : "Pin page"}
                  >
                    {notePinnedInput ? <PinOff className="mr-2 h-4 w-4" /> : <Pin className="mr-2 h-4 w-4" />}
                    {notePinnedInput ? "Unpin" : "Pin"}
                  </Button>
                  <Button variant="outline" onClick={() => void saveCurrentNote()} disabled={saveState === "saving"}>
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
                    value={noteNotebookInput}
                    onChange={(event) => {
                      setNoteNotebookInput(event.target.value);
                      setIsDirty(true);
                    }}
                    placeholder="Notebook (example: Meetings, Projects, Personal)"
                    className="h-9 w-full max-w-sm border-slate-300"
                  />

                  <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 p-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => applyWrap("**")}> 
                      <Bold className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => applyWrap("_")}> 
                      <Italic className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => applyLinePrefix("bullet")}> 
                      <List className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => applyLinePrefix("number")}> 
                      <ListOrdered className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={insertLinkTemplate}> 
                      <Link2 className="h-4 w-4" />
                    </Button>
                  </div>

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
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px]">
                <div className="flex min-h-0 flex-col border-r border-slate-200">
                  <Textarea
                    ref={editorRef}
                    value={noteContentInput}
                    onChange={(event) => {
                      setNoteContentInput(event.target.value);
                      setIsDirty(true);
                    }}
                    placeholder="Start typing your notes..."
                    className="h-full min-h-[340px] resize-none rounded-none border-0 px-5 py-4 font-[ui-serif] text-[15px] leading-7 shadow-none focus-visible:ring-0"
                  />
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
                                <p className="mt-1 text-sm font-medium text-slate-900 line-clamp-2">
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
