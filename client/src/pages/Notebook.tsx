import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LinkMenu, type LinkMenuOptionKey } from "@/components/notebook/LinkMenu";
import { NotebookSidebar } from "@/components/notebook/NotebookSidebar";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { trpc } from "@/lib/trpc";
import {
  getSelectionDraftKey,
  resolveNotebookEditorSnapshot,
  type NotebookEditorDraft,
} from "@/lib/notebookEditorSync";
import {
  ArrowLeft,
  Bold,
  Calendar,
  CheckSquare,
  Copy,
  FileText,
  Filter,
  FolderOpen,
  Link2,
  List,
  ListOrdered,
  Loader2,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Underline,
  Unlink,
  Italic,
  PanelLeft,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

type SmartView = "all" | "pinned" | "linked";
type AttachTarget = "calendar" | "todoist" | "note" | "drive";
type SaveState = "saved" | "saving" | "unsaved" | "error";
type NotesSort = "context" | "updated_desc" | "created_desc" | "title_asc";
type NavigationSelection =
  | { kind: "view"; key: SmartView }
  | { kind: "notebook"; name: string };

type CalendarFilterOption = {
  key: string;
  eventId: string;
  seriesId: string;
  summary: string;
  label: string;
  sortTs: number | null;
  isRecurring: boolean;
};

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
    .replace(/<[^>]+>/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function getEventStartMs(event: any): number | null {
  const raw = event?.start?.dateTime || event?.start?.date;
  if (!raw) return null;
  const ms = new Date(raw).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function formatEventOptionLabel(event: any): string {
  const summary = String(event?.summary || "Untitled").trim() || "Untitled";
  const startDateTime = event?.start?.dateTime;
  const startDate = event?.start?.date;
  const raw = startDateTime || startDate;
  if (!raw) return summary;

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return summary;

  const weekday = date.toLocaleDateString("en-US", { weekday: "short" });
  if (startDateTime) {
    const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${summary} · ${weekday} ${time}`;
  }

  return `${summary} · ${weekday} all-day`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeStoredHtml(content: string | null | undefined): string {
  const raw = (content || "").trim();
  if (!raw) return "<p></p>";
  const decoded = decodeHtmlEntities(raw).trim();
  if (/<[a-z][\s\S]*>/i.test(decoded)) return sanitizeEditorHtml(decoded);
  if (/<[a-z][\s\S]*>/i.test(raw)) return sanitizeEditorHtml(raw);
  return `<p>${escapeHtml(decoded).replace(/\n/g, "<br/>")}</p>`;
}

function sanitizeEditorHtml(rawHtml: string): string {
  if (typeof window === "undefined") return rawHtml || "<p></p>";

  const wrapper = document.createElement("div");
  wrapper.innerHTML = rawHtml || "";

  wrapper.querySelectorAll("script, style").forEach((node) => node.remove());

  const allowedAttrs = new Set(["href", "target", "rel"]);
  wrapper.querySelectorAll("*").forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      if (!allowedAttrs.has(attr.name.toLowerCase())) {
        el.removeAttribute(attr.name);
      }
    }

    if (el.tagName === "A") {
      const href = (el.getAttribute("href") || "").trim();
      const safeHref = href.startsWith("http://") || href.startsWith("https://") || href.startsWith("mailto:");
      if (!safeHref) {
        el.removeAttribute("href");
      } else {
        el.setAttribute("target", "_blank");
        el.setAttribute("rel", "noopener noreferrer");
      }
    }
  });

  const cleaned = wrapper.innerHTML.trim();
  return cleaned.length > 0 ? cleaned : "<p></p>";
}

function getSaveStateLabel(state: SaveState): string {
  if (state === "saving") return "Saving...";
  if (state === "unsaved") return "Unsaved";
  if (state === "error") return "Save failed";
  return "Saved";
}

export default function Notebook() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  const [activeNav, setActiveNav] = useState<NavigationSelection>({ kind: "view", key: "all" });
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isDraftMode, setIsDraftMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeEventFilterKey, setActiveEventFilterKey] = useState("");
  const [notesSort, setNotesSort] = useState<NotesSort>("context");
  const [isCalendarFilterOpen, setIsCalendarFilterOpen] = useState(false);
  const [calendarFilterQuery, setCalendarFilterQuery] = useState("");
  const [seriesOnlyFilter, setSeriesOnlyFilter] = useState(false);
  const [linkedOnlyFilter, setLinkedOnlyFilter] = useState(false);

  const [noteNotebookInput, setNoteNotebookInput] = useState("General");
  const [noteTitleInput, setNoteTitleInput] = useState("");
  const [noteContentHtml, setNoteContentHtml] = useState("<p></p>");
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [draftsByKey, setDraftsByKey] = useState<Record<string, NotebookEditorDraft>>({});

  const [attachOpen, setAttachOpen] = useState(false);
  const [attachType, setAttachType] = useState<AttachTarget>("calendar");
  const [attachQuery, setAttachQuery] = useState("");
  const [attachSelectionId, setAttachSelectionId] = useState("");
  const [isLinkMenuOpen, setIsLinkMenuOpen] = useState(false);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"list" | "editor">("list");

  const editorRef = useRef<HTMLDivElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const isSwitchingNoteRef = useRef(false);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

  const applyEditorSnapshot = useCallback((snapshot: { title: string; notebook: string; content: string; dirty: boolean; source: "note" | "draft" | "empty" }) => {
    const notebookValue = (snapshot.notebook || "General").trim() || "General";
    const titleValue = String(snapshot.title || "");
    const htmlValue =
      snapshot.source === "note"
        ? normalizeStoredHtml(snapshot.content)
        : sanitizeEditorHtml(snapshot.content || "<p></p>");

    setNoteNotebookInput(notebookValue);
    setNoteTitleInput(titleValue);
    setNoteContentHtml(htmlValue);
    setIsDirty(Boolean(snapshot.dirty));
    setSaveState(snapshot.dirty ? "unsaved" : "saved");
  }, []);

  const stashCurrentDraft = useCallback(() => {
    if (!isDirty) return;
    const draftKey = getSelectionDraftKey(selectedNoteId, isDraftMode);
    if (!draftKey) return;

    const sanitized = sanitizeEditorHtml(editorRef.current?.innerHTML || noteContentHtml || "<p></p>");
    setDraftsByKey((prev) => ({
      ...prev,
      [draftKey]: {
        title: noteTitleInput,
        notebook: noteNotebookInput.trim() || "General",
        contentHtml: sanitized,
        dirty: true,
        updatedAt: Date.now(),
      },
    }));
  }, [isDirty, selectedNoteId, isDraftMode, noteContentHtml, noteTitleInput, noteNotebookInput]);

  useEffect(() => {
    if (!loading && !user) {
      setLocation("/");
    }
  }, [loading, user, setLocation]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const notebook = params.get("notebook");
    const eventId = params.get("eventId");
    const seriesId = params.get("seriesId");

    if (notebook && notebook.trim()) {
      if (notebook.trim().toLowerCase() === "all") {
        setActiveNav({ kind: "view", key: "all" });
      } else {
        setActiveNav({ kind: "notebook", name: notebook.trim() });
      }
    }

    if (seriesId && seriesId.trim()) {
      setActiveEventFilterKey(`series:${seriesId.trim()}`);
    } else if (eventId && eventId.trim()) {
      setActiveEventFilterKey(`event:${eventId.trim()}`);
    }
  }, []);

  const { data: integrations } = trpc.integrations.list.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const hasTodoist = integrations?.some((integration) => integration.provider === "todoist") ?? false;
  const hasGoogle = integrations?.some((integration) => integration.provider === "google") ?? false;

  useEffect(() => {
    if (hasGoogle) {
      setAttachType("calendar");
      return;
    }
    if (hasTodoist) {
      setAttachType("todoist");
    }
  }, [hasGoogle, hasTodoist]);

  useEffect(() => {
    if (activeNav.kind === "view" && activeNav.key === "linked" && linkedOnlyFilter) {
      setLinkedOnlyFilter(false);
    }
  }, [activeNav, linkedOnlyFilter]);

  const {
    data: notes,
    isLoading: notesLoading,
    error: notesError,
    refetch: refetchNotes,
  } = trpc.notes.list.useQuery(
    { limit: 1000 },
    {
      enabled: !!user,
      retry: false,
    }
  );

  const { data: todoistTasks } = trpc.todoist.getTasks.useQuery(undefined, {
    enabled: !!user && hasTodoist,
    retry: false,
  });

  const { data: calendarEvents } = trpc.google.getCalendarEvents.useQuery(undefined, {
    enabled: !!user && hasGoogle,
    retry: false,
  });

  const { data: driveFiles } = trpc.google.getDriveFiles.useQuery(undefined, {
    enabled: !!user && hasGoogle,
    retry: false,
  });

  const createNoteMutation = trpc.notes.create.useMutation();
  const updateNoteMutation = trpc.notes.update.useMutation();
  const deleteNoteMutation = trpc.notes.delete.useMutation();
  const addNoteLinkMutation = trpc.notes.addLink.useMutation();
  const removeNoteLinkMutation = trpc.notes.removeLink.useMutation();

  const smartViewCounts = useMemo(() => {
    const rows = notes || [];
    const all = rows.length;
    const pinned = rows.filter((note: any) => Boolean(note.pinned)).length;
    const linked = rows.filter((note: any) => (Array.isArray(note.links) ? note.links.length > 0 : false)).length;
    return { all, pinned, linked };
  }, [notes]);

  const notebooks = useMemo(() => {
    const counts = new Map<string, number>();
    for (const note of notes || []) {
      const notebook = (note.notebook || "General").trim() || "General";
      counts.set(notebook, (counts.get(notebook) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [notes]);

  const calendarEventOptions = useMemo(() => {
    return (calendarEvents || [])
      .filter((event: any) => Boolean(event.start?.dateTime || event.start?.date))
      .sort((a: any, b: any) => {
        const aStart = new Date(a.start?.dateTime || a.start?.date || 0).getTime();
        const bStart = new Date(b.start?.dateTime || b.start?.date || 0).getTime();
        return bStart - aStart;
      });
  }, [calendarEvents]);

  const calendarFilterOptions = useMemo<CalendarFilterOption[]>(() => {
    const events = (calendarEvents || []).filter((event: any) => getEventStartMs(event) !== null);
    const nowMs = Date.now();
    const recurringGroups = new Map<string, any[]>();
    const nonRecurring: any[] = [];

    for (const event of events) {
      const seriesId = String(event.recurringEventId || event.iCalUID || "").trim();
      if (seriesId) {
        const bucket = recurringGroups.get(seriesId) || [];
        bucket.push(event);
        recurringGroups.set(seriesId, bucket);
      } else {
        nonRecurring.push(event);
      }
    }

    const options: CalendarFilterOption[] = [];

    recurringGroups.forEach((group, seriesId) => {
      const byTime = [...group].sort((a, b) => (getEventStartMs(a) || 0) - (getEventStartMs(b) || 0));
      const upcoming = byTime.find((event) => {
        const ts = getEventStartMs(event);
        return ts !== null && ts >= nowMs;
      });
      const representative = upcoming || byTime[byTime.length - 1];
      const repTs = getEventStartMs(representative);
      const summary = String(representative?.summary || "Untitled").trim() || "Untitled";

      options.push({
        key: `series:${seriesId}`,
        eventId: String(representative?.id || ""),
        seriesId,
        summary,
        label: formatEventOptionLabel(representative),
        sortTs: repTs,
        isRecurring: true,
      });
    });

    const seenEventIds = new Set<string>();
    for (const event of nonRecurring) {
      const eventId = String(event?.id || "").trim();
      if (!eventId || seenEventIds.has(eventId)) continue;
      seenEventIds.add(eventId);

      const summary = String(event?.summary || "Untitled").trim() || "Untitled";
      const startTs = getEventStartMs(event);

      options.push({
        key: `event:${eventId}`,
        eventId,
        seriesId: "",
        summary,
        label: formatEventOptionLabel(event),
        sortTs: startTs,
        isRecurring: false,
      });
    }

    return options.sort((a, b) => {
      const aTs = a.sortTs ?? 0;
      const bTs = b.sortTs ?? 0;
      const aFuture = a.sortTs !== null && aTs >= nowMs;
      const bFuture = b.sortTs !== null && bTs >= nowMs;
      if (aFuture !== bFuture) return aFuture ? -1 : 1;
      if (aFuture && bFuture) return aTs - bTs;
      if (!aFuture && !bFuture) return bTs - aTs;
      return a.label.localeCompare(b.label);
    });
  }, [calendarEvents]);

  const calendarFilterOptionByKey = useMemo(() => {
    const map = new Map<string, CalendarFilterOption>();
    for (const option of calendarFilterOptions) {
      map.set(option.key, option);
    }
    return map;
  }, [calendarFilterOptions]);

  const selectedEventFilter = useMemo(
    () => (activeEventFilterKey ? calendarFilterOptionByKey.get(activeEventFilterKey) || null : null),
    [activeEventFilterKey, calendarFilterOptionByKey]
  );

  const effectiveEventFilterKey = useMemo(() => {
    if (!activeEventFilterKey) return "";
    if (!seriesOnlyFilter) return activeEventFilterKey;
    const selected = calendarFilterOptionByKey.get(activeEventFilterKey);
    if (selected?.seriesId) {
      return `series:${selected.seriesId}`;
    }
    return activeEventFilterKey;
  }, [activeEventFilterKey, seriesOnlyFilter, calendarFilterOptionByKey]);

  const canToggleSeriesOnly = Boolean(selectedEventFilter?.seriesId);

  useEffect(() => {
    if (!canToggleSeriesOnly && seriesOnlyFilter) {
      setSeriesOnlyFilter(false);
    }
  }, [canToggleSeriesOnly, seriesOnlyFilter]);

  const selectedNote = useMemo(
    () => (notes || []).find((note) => String(note.id) === String(selectedNoteId || "")) || null,
    [notes, selectedNoteId]
  );

  const selectedLinks = useMemo(
    () => (Array.isArray(selectedNote?.links) ? selectedNote.links : []),
    [selectedNote]
  );

  const visibleNotes = useMemo(() => {
    let rows = [...(notes || [])];

    if (activeNav.kind === "view") {
      if (activeNav.key === "pinned") {
        rows = rows.filter((note: any) => Boolean(note.pinned));
      } else if (activeNav.key === "linked") {
        rows = rows.filter((note: any) => (Array.isArray(note.links) ? note.links.length > 0 : false));
      }
    } else {
      rows = rows.filter((note: any) => (note.notebook || "General") === activeNav.name);
    }

    if (linkedOnlyFilter && !(activeNav.kind === "view" && activeNav.key === "linked")) {
      rows = rows.filter((note: any) => (Array.isArray(note.links) ? note.links.length > 0 : false));
    }

    if (effectiveEventFilterKey) {
      rows = rows.filter((note: any) => {
        const links = Array.isArray(note.links) ? note.links : [];
        return links.some((link: any) => {
          if (link.linkType !== "google_calendar_event") return false;
          const externalId = String(link.externalId || "");
          const seriesId = String(link.seriesId || "");
          if (effectiveEventFilterKey.startsWith("series:")) {
            return `series:${seriesId}` === effectiveEventFilterKey;
          }
          return `event:${externalId}` === effectiveEventFilterKey;
        });
      });
    }

    const query = searchQuery.trim().toLowerCase();
    if (query) {
      rows = rows.filter((note: any) => {
        const title = String(note.title || "").toLowerCase();
        const notebook = String(note.notebook || "").toLowerCase();
        const content = stripHtml(String(note.content || "")).toLowerCase();
        return title.includes(query) || notebook.includes(query) || content.includes(query);
      });
    }

    const nowMs = Date.now();
    const getUpdatedTs = (note: any) => new Date(note.updatedAt || note.createdAt || 0).getTime();
    const alphaCompare = (a: any, b: any) =>
      String(a.title || "Untitled").localeCompare(String(b.title || "Untitled"), undefined, {
        sensitivity: "base",
      });

    return [...rows].sort((a: any, b: any) => {
      if (notesSort === "updated_desc") {
        return getUpdatedTs(b) - getUpdatedTs(a);
      }
      if (notesSort === "created_desc") {
        const aCreated = new Date(a.createdAt || 0).getTime();
        const bCreated = new Date(b.createdAt || 0).getTime();
        return bCreated - aCreated;
      }
      if (notesSort === "title_asc") {
        return alphaCompare(a, b);
      }

      if (effectiveEventFilterKey) {
        const buildMeta = (note: any) => {
          const links = (Array.isArray(note.links) ? note.links : []).filter((link: any) => {
            if (link.linkType !== "google_calendar_event") return false;
            if (effectiveEventFilterKey.startsWith("series:")) {
              return `series:${String(link.seriesId || "")}` === effectiveEventFilterKey;
            }
            return `event:${String(link.externalId || "")}` === effectiveEventFilterKey;
          });

          const times = links
            .map((link: any) => new Date(String(link.occurrenceStartIso || "")).getTime())
            .filter((ts: number) => Number.isFinite(ts));
          const future = times.filter((ts: number) => ts >= nowMs).sort((x: number, y: number) => x - y)[0];
          const past = times.filter((ts: number) => ts < nowMs).sort((x: number, y: number) => y - x)[0];

          if (Number.isFinite(future)) return { bucket: 0, ts: future as number };
          if (Number.isFinite(past)) return { bucket: 1, ts: past as number };

          const updated = new Date(note.updatedAt || note.createdAt || 0).getTime();
          return { bucket: 2, ts: updated };
        };

        const aMeta = buildMeta(a);
        const bMeta = buildMeta(b);
        if (aMeta.bucket !== bMeta.bucket) return aMeta.bucket - bMeta.bucket;
        if (aMeta.bucket === 0) return aMeta.ts - bMeta.ts;
        return bMeta.ts - aMeta.ts;
      }

      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return getUpdatedTs(b) - getUpdatedTs(a);
    });
  }, [notes, activeNav, linkedOnlyFilter, effectiveEventFilterKey, searchQuery, notesSort]);

  useEffect(() => {
    if (isDraftMode) return;
    if (!selectedNoteId && visibleNotes.length > 0) {
      setSelectedNoteId(String(visibleNotes[0].id));
    }
  }, [selectedNoteId, visibleNotes, isDraftMode]);

  useEffect(() => {
    const snapshot = resolveNotebookEditorSnapshot({
      selectedNoteId,
      isDraftMode,
      notes: (notes || []) as Array<{ id: string; title?: string; notebook?: string; content?: string }>,
      draftsByKey,
    });
    if (!snapshot) return;

    applyEditorSnapshot({
      source: snapshot.source,
      title: snapshot.title,
      notebook: snapshot.notebook,
      content: snapshot.content,
      dirty: snapshot.dirty,
    });
  }, [selectedNoteId, isDraftMode, notes, draftsByKey, applyEditorSnapshot]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const nextHtml = noteContentHtml || "<p></p>";
    if (editor.innerHTML !== nextHtml) {
      editor.innerHTML = nextHtml;
    }
  }, [noteContentHtml]);

  const persistNote = useCallback(async (showSuccessToast = false) => {
    const notebook = noteNotebookInput.trim() || "General";
    const titleInput = noteTitleInput.trim();
    const rawContent = editorRef.current?.innerHTML || noteContentHtml || "<p></p>";
    const content = sanitizeEditorHtml(rawContent);
    const contentText = stripHtml(content);

    if (isDraftMode && !titleInput && !contentText) {
      setIsDirty(false);
      setSaveState("saved");
      return;
    }

    setSaveState("saving");

    try {
      if (!isDraftMode && selectedNoteId) {
        await updateNoteMutation.mutateAsync({
          noteId: selectedNoteId,
          notebook,
          title: titleInput || "Untitled note",
          content,
        });
        const savedDraftKey = getSelectionDraftKey(selectedNoteId, false);
        if (savedDraftKey) {
          setDraftsByKey((prev) => {
            if (!prev[savedDraftKey]) return prev;
            const next = { ...prev };
            delete next[savedDraftKey];
            return next;
          });
        }
        setIsDirty(false);
        setSaveState("saved");
        await refetchNotes();
        if (showSuccessToast) {
          toast.success("Note saved");
        }
        return;
      }

      const result = await createNoteMutation.mutateAsync({
        notebook,
        title: titleInput || "Untitled note",
        content,
        pinned: false,
      });

      const draftKey = getSelectionDraftKey(null, true);
      if (draftKey) {
        setDraftsByKey((prev) => {
          if (!prev[draftKey]) return prev;
          const next = { ...prev };
          delete next[draftKey];
          return next;
        });
      }
      setSelectedNoteId(result.noteId);
      setIsDraftMode(false);
      setIsDirty(false);
      setSaveState("saved");
      await refetchNotes();
      if (showSuccessToast) {
        toast.success("Note saved");
      }
    } catch (error: any) {
      setSaveState("error");
      toast.error(`Failed to save note: ${error?.message || "Unknown error"}`);
    }
  }, [
    noteNotebookInput,
    noteTitleInput,
    noteContentHtml,
    isDraftMode,
    selectedNoteId,
    updateNoteMutation,
    createNoteMutation,
    refetchNotes,
  ]);

  useEffect(() => {
    if (!isDirty) return;
    setSaveState("unsaved");
    clearAutosaveTimer();
    const scheduledNoteId = selectedNoteId;
    const scheduledIsDraft = isDraftMode;
    autosaveTimerRef.current = window.setTimeout(() => {
      // Ignore autosave if the user switched notes/draft state before timer fired.
      if (scheduledIsDraft !== isDraftMode) return;
      if (!scheduledIsDraft && scheduledNoteId !== selectedNoteId) return;
      void persistNote();
    }, 850);
    return clearAutosaveTimer;
  }, [isDirty, selectedNoteId, isDraftMode, persistNote, clearAutosaveTimer]);

  const runEditorCommand = (command: string, value?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    setNoteContentHtml(sanitizeEditorHtml(editor.innerHTML || "<p></p>"));
    setIsDirty(true);
  };

  const handleInsertLink = () => {
    const input = window.prompt("Enter URL (https://...)");
    if (!input) return;
    const url = input.trim();
    if (!url) return;
    runEditorCommand("createLink", url);
  };

  const createDraft = () => {
    clearAutosaveTimer();
    stashCurrentDraft();
    setIsDraftMode(true);
    setSelectedNoteId(null);
    setMobilePanel("editor");
    const draftKey = getSelectionDraftKey(null, true);
    if (draftKey) {
      setDraftsByKey((prev) => {
        if (prev[draftKey]) return prev;
        return {
          ...prev,
          [draftKey]: {
            title: "",
            notebook: activeNav.kind === "notebook" ? activeNav.name : "General",
            contentHtml: "<p></p>",
            dirty: false,
            updatedAt: Date.now(),
          },
        };
      });
    }
  };

  const selectNote = (note: any) => {
    clearAutosaveTimer();
    stashCurrentDraft();
    isSwitchingNoteRef.current = true;
    setIsDraftMode(false);
    setSelectedNoteId(String(note.id));
    setMobilePanel("editor");
  };

  useEffect(() => {
    isSwitchingNoteRef.current = false;
  }, [selectedNoteId, isDraftMode]);

  useEffect(() => {
    setIsLinkMenuOpen(false);
  }, [selectedNoteId, isDraftMode, mobilePanel]);

  const handleLinkMenuSelect = (target: LinkMenuOptionKey) => {
    if (!selectedNoteId || isDraftMode) {
      toast.error("Save the note first, then add links.");
      return;
    }

    if (target === "calendar") {
      if (!hasGoogle) {
        toast.error("Connect Google to link calendar events.");
        return;
      }
      setAttachType("calendar");
      setAttachSelectionId("");
      setAttachQuery("");
      setAttachOpen(true);
      return;
    }

    if (target === "todoist") {
      if (!hasTodoist) {
        toast.error("Connect Todoist to link tasks.");
        return;
      }
      setAttachType("todoist");
      setAttachSelectionId("");
      setAttachQuery("");
      setAttachOpen(true);
      return;
    }

    if (target === "drive") {
      if (!hasGoogle) {
        toast.error("Connect Google to link Drive files.");
        return;
      }
      setAttachType("drive");
      setAttachSelectionId("");
      setAttachQuery("");
      setAttachOpen(true);
      return;
    }

    setAttachType("note");
    setAttachSelectionId("");
    setAttachQuery("");
    setAttachOpen(true);
  };

  const deleteSelectedNote = async () => {
    if (!selectedNoteId || isDraftMode) {
      toast.error("Select a saved note first");
      return;
    }

    try {
      await deleteNoteMutation.mutateAsync({ noteId: selectedNoteId });
      const deletedDraftKey = getSelectionDraftKey(selectedNoteId, false);
      if (deletedDraftKey) {
        setDraftsByKey((prev) => {
          if (!prev[deletedDraftKey]) return prev;
          const next = { ...prev };
          delete next[deletedDraftKey];
          return next;
        });
      }
      setIsDeleteDialogOpen(false);
      setSelectedNoteId(null);
      setIsDraftMode(false);
      setNoteNotebookInput("General");
      setNoteTitleInput("");
      setNoteContentHtml("<p></p>");
      setSaveState("saved");
      setMobilePanel("list");
      await refetchNotes();
      toast.success("Note deleted");
    } catch (error: any) {
      toast.error(`Failed to delete note: ${error?.message || "Unknown error"}`);
    }
  };

  const togglePin = async () => {
    if (!selectedNote || isDraftMode) {
      toast.error("Select a saved note first");
      return;
    }

    try {
      await updateNoteMutation.mutateAsync({
        noteId: selectedNote.id,
        pinned: !selectedNote.pinned,
      });
      await refetchNotes();
    } catch (error: any) {
      toast.error(`Failed to update note: ${error?.message || "Unknown error"}`);
    }
  };

  const moveSelectedNoteToNotebook = async (targetNotebook: string) => {
    if (!selectedNote || isDraftMode) return;

    setNoteNotebookInput(targetNotebook);
    setIsDirty(true);

    try {
      await updateNoteMutation.mutateAsync({
        noteId: selectedNote.id,
        notebook: targetNotebook,
      });
      await refetchNotes();
      toast.success(`Moved to ${targetNotebook}`);
    } catch (error: any) {
      toast.error(`Failed to move note: ${error?.message || "Unknown error"}`);
    }
  };

  const duplicateSelectedNote = async () => {
    if (!selectedNote || isDraftMode) {
      toast.error("Select a saved note first");
      return;
    }

    try {
      const result = await createNoteMutation.mutateAsync({
        notebook: String(selectedNote.notebook || "General"),
        title: `${String(selectedNote.title || "Untitled note")} (Copy)`,
        content: normalizeStoredHtml(selectedNote.content),
        pinned: false,
      });

      await refetchNotes();
      setSelectedNoteId(String(result.noteId));
      setIsDraftMode(false);
      setMobilePanel("editor");
      toast.success("Note duplicated");
    } catch (error: any) {
      toast.error(`Failed to duplicate note: ${error?.message || "Unknown error"}`);
    }
  };

  const linkedEventLabelByLinkId = useMemo(() => {
    const map = new Map<string, string>();
    for (const link of selectedLinks) {
      if (link.linkType !== "google_calendar_event") continue;
      const eventId = String(link.externalId || "");
      const event = calendarEventOptions.find((row: any) => String(row.id || "") === eventId);
      if (event) {
        map.set(link.id, formatEventOptionLabel(event));
      }
    }
    return map;
  }, [selectedLinks, calendarEventOptions]);

  const attachItems = useMemo(() => {
    const query = attachQuery.trim().toLowerCase();

    if (attachType === "todoist") {
      const rows = (todoistTasks || []).map((task: any) => ({
        id: String(task.id),
        title: String(task.content || "Untitled task"),
        subtitle: task.projectName ? String(task.projectName) : null,
      }));
      if (!query) return rows.slice(0, 200);
      return rows
        .filter((row) => row.title.toLowerCase().includes(query) || String(row.subtitle || "").toLowerCase().includes(query))
        .slice(0, 200);
    }

    if (attachType === "note") {
      const rows = (notes || [])
        .filter((note: any) => String(note.id) !== String(selectedNoteId || ""))
        .map((note: any) => ({
          id: String(note.id),
          title: String(note.title || "Untitled note"),
          subtitle: String(note.notebook || "General"),
        }));
      if (!query) return rows.slice(0, 200);
      return rows
        .filter((row) => row.title.toLowerCase().includes(query) || String(row.subtitle || "").toLowerCase().includes(query))
        .slice(0, 200);
    }

    if (attachType === "drive") {
      const rows = (driveFiles || []).map((file: any) => ({
        id: String(file.id || ""),
        title: String(file.name || "Untitled file"),
        subtitle: String(file.mimeType || "").trim() || "Google Drive file",
      }));
      if (!query) return rows.slice(0, 200);
      return rows
        .filter((row) => row.title.toLowerCase().includes(query) || String(row.subtitle || "").toLowerCase().includes(query))
        .slice(0, 200);
    }

    const rows = calendarEventOptions.map((event: any) => ({
      id: String(event.id || ""),
      title: formatEventOptionLabel(event),
      subtitle: String(event.location || "").trim() || null,
    }));
    if (!query) return rows.slice(0, 200);
    return rows
      .filter((row) => row.title.toLowerCase().includes(query) || String(row.subtitle || "").toLowerCase().includes(query))
      .slice(0, 200);
  }, [attachType, attachQuery, todoistTasks, notes, selectedNoteId, driveFiles, calendarEventOptions]);

  const selectedAttachItem = useMemo(
    () => attachItems.find((row) => row.id === attachSelectionId) || null,
    [attachItems, attachSelectionId]
  );

  const isAttachAlreadyLinked = useMemo(() => {
    if (!selectedAttachItem) return false;

    if (attachType === "todoist") {
      return selectedLinks.some(
        (link: any) => link.linkType === "todoist_task" && String(link.externalId || "") === selectedAttachItem.id
      );
    }

    if (attachType === "note") {
      return selectedLinks.some(
        (link: any) => link.linkType === "note_link" && String(link.externalId || "") === selectedAttachItem.id
      );
    }

    if (attachType === "drive") {
      return selectedLinks.some(
        (link: any) => link.linkType === "google_drive_file" && String(link.externalId || "") === selectedAttachItem.id
      );
    }

    const event = calendarEventOptions.find((row: any) => String(row.id || "") === selectedAttachItem.id);
    const seriesId = String(event?.recurringEventId || event?.iCalUID || "").trim();

    return selectedLinks.some((link: any) => {
      if (link.linkType !== "google_calendar_event") return false;
      if (String(link.externalId || "") === selectedAttachItem.id) return true;
      const existingSeriesId = String(link.seriesId || "").trim();
      return !!seriesId && seriesId === existingSeriesId;
    });
  }, [selectedAttachItem, attachType, selectedLinks, calendarEventOptions]);

  const attachSelectedItem = async () => {
    if (!selectedNoteId || isDraftMode) {
      toast.error("Save the note first, then add links.");
      return;
    }

    if (!selectedAttachItem) {
      toast.error("Select an item to attach");
      return;
    }

    try {
      if (attachType === "todoist") {
        const task = (todoistTasks || []).find((row: any) => String(row.id) === selectedAttachItem.id);
        if (!task) {
          toast.error("Task not found");
          return;
        }

        const result = await addNoteLinkMutation.mutateAsync({
          noteId: selectedNoteId,
          linkType: "todoist_task",
          externalId: String(task.id),
          sourceUrl: (task as any).url || `https://todoist.com/app/task/${task.id}`,
          sourceTitle: String(task.content || "Todoist task"),
          metadata: {
            dueDate: task.due?.date ?? task.due?.string ?? null,
          },
        });

        if (result?.alreadyLinked) {
          toast.info("This task is already linked");
        } else {
          toast.success("Task linked");
        }
      } else if (attachType === "note") {
        const note = (notes || []).find((row: any) => String(row.id) === selectedAttachItem.id);
        if (!note) {
          toast.error("Note not found");
          return;
        }

        const result = await addNoteLinkMutation.mutateAsync({
          noteId: selectedNoteId,
          linkType: "note_link",
          externalId: String(note.id),
          sourceUrl: `/notes?noteId=${encodeURIComponent(String(note.id))}`,
          sourceTitle: String(note.title || "Linked note"),
          metadata: {
            notebook: note.notebook || "General",
          },
        });

        if (result?.alreadyLinked) {
          toast.info("This note is already linked");
        } else {
          toast.success("Note linked");
        }
      } else if (attachType === "drive") {
        const file = (driveFiles || []).find((row: any) => String(row.id || "") === selectedAttachItem.id);
        if (!file) {
          toast.error("Drive file not found");
          return;
        }

        const result = await addNoteLinkMutation.mutateAsync({
          noteId: selectedNoteId,
          linkType: "google_drive_file",
          externalId: String(file.id || ""),
          sourceUrl: file.webViewLink || undefined,
          sourceTitle: String(file.name || "Google Drive file"),
          metadata: {
            mimeType: file.mimeType || null,
          },
        });

        if (result?.alreadyLinked) {
          toast.info("This Drive file is already linked");
        } else {
          toast.success("Drive file linked");
        }
      } else {
        const event = calendarEventOptions.find((row: any) => String(row.id || "") === selectedAttachItem.id);
        if (!event) {
          toast.error("Event not found");
          return;
        }

        const result = await addNoteLinkMutation.mutateAsync({
          noteId: selectedNoteId,
          linkType: "google_calendar_event",
          externalId: String(event.id || ""),
          seriesId: event.recurringEventId || event.iCalUID || "",
          occurrenceStartIso: event.start?.dateTime || event.start?.date || "",
          sourceUrl: event.htmlLink || undefined,
          sourceTitle: String(event.summary || "Google Calendar event"),
          metadata: {
            location: event.location || null,
            recurringEventId: event.recurringEventId || null,
            iCalUID: event.iCalUID || null,
          },
        });

        if (result?.alreadyLinked) {
          toast.info("This event is already linked");
        } else {
          toast.success("Event linked");
        }
      }

      await refetchNotes();
      setAttachOpen(false);
      setAttachSelectionId("");
      setAttachQuery("");
    } catch (error: any) {
      toast.error(`Failed to attach: ${error?.message || "Unknown error"}`);
    }
  };

  const removeLink = async (linkId: string) => {
    try {
      await removeNoteLinkMutation.mutateAsync({ linkId });
      await refetchNotes();
      toast.success("Link removed");
    } catch (error: any) {
      toast.error(`Failed to remove link: ${error?.message || "Unknown error"}`);
    }
  };

  const handleEditorKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      const selection = window.getSelection();
      const node = selection?.anchorNode || null;
      const startElement =
        node && node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement || null;
      const currentLi = startElement?.closest("li") || null;
      if (currentLi) {
        const liText = (currentLi.textContent || "").replace(/\u00a0/g, "").trim();
        if (!liText) {
          event.preventDefault();
          document.execCommand("outdent");
          if (editorRef.current) {
            const sanitized = sanitizeEditorHtml(editorRef.current.innerHTML || "<p></p>");
            editorRef.current.innerHTML = sanitized;
            setNoteContentHtml(sanitized);
            setIsDirty(true);
          }
          return;
        }
      }
    }

    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;
    const key = event.key.toLowerCase();

    if (key === "s") {
      event.preventDefault();
      void persistNote();
      return;
    }
    if (key === "b") {
      event.preventDefault();
      runEditorCommand("bold");
      return;
    }
    if (key === "i") {
      event.preventDefault();
      runEditorCommand("italic");
      return;
    }
    if (key === "u") {
      event.preventDefault();
      runEditorCommand("underline");
      return;
    }
    if (key === "k") {
      event.preventDefault();
      handleInsertLink();
      return;
    }

    if (event.shiftKey && key === "7") {
      event.preventDefault();
      runEditorCommand("insertOrderedList");
      return;
    }

    if (event.shiftKey && key === "8") {
      event.preventDefault();
      runEditorCommand("insertUnorderedList");
      return;
    }
  };

  const clearEventFilter = () => {
    setActiveEventFilterKey("");
    setSeriesOnlyFilter(false);
  };

  const navHeaderLabel = useMemo(() => {
    if (activeNav.kind === "view") {
      if (activeNav.key === "all") return "All notes";
      if (activeNav.key === "pinned") return "Pinned";
      return "Linked";
    }
    return activeNav.name;
  }, [activeNav]);

  const scopeBreadcrumb = useMemo(() => {
    if (!selectedEventFilter) return navHeaderLabel;
    if (seriesOnlyFilter && selectedEventFilter.seriesId) {
      return `${navHeaderLabel} • ${selectedEventFilter.summary} (series)`;
    }
    return `${navHeaderLabel} • ${selectedEventFilter.label}`;
  }, [navHeaderLabel, selectedEventFilter, seriesOnlyFilter]);

  const hasAnyFilter = Boolean(activeEventFilterKey || linkedOnlyFilter || searchQuery.trim());

  const filteredCalendarFilterOptions = useMemo(() => {
    const query = calendarFilterQuery.trim().toLowerCase();
    if (!query) return calendarFilterOptions;
    return calendarFilterOptions.filter((option) => {
      return (
        option.label.toLowerCase().includes(query) ||
        option.summary.toLowerCase().includes(query) ||
        option.seriesId.toLowerCase().includes(query)
      );
    });
  }, [calendarFilterOptions, calendarFilterQuery]);

  const clearAllFilters = () => {
    setSearchQuery("");
    setActiveEventFilterKey("");
    setSeriesOnlyFilter(false);
    setLinkedOnlyFilter(false);
  };

  const calendarLinkedCount = useMemo(() => {
    return (notes || []).filter((note: any) =>
      (Array.isArray(note.links) ? note.links : []).some((link: any) => link.linkType === "google_calendar_event")
    ).length;
  }, [notes]);

  const sidebarSelected = useMemo(() => {
    if (activeNav.kind === "notebook") {
      return { kind: "notebook" as const, notebookName: activeNav.name };
    }

    if (activeEventFilterKey) {
      return { kind: "system" as const, key: "calendar" as const };
    }

    if (activeNav.key === "pinned") {
      return { kind: "system" as const, key: "pinned" as const };
    }

    return { kind: "system" as const, key: "all" as const };
  }, [activeNav, activeEventFilterKey]);

  const handleSelectSystemView = (key: "all" | "calendar" | "pinned") => {
    if (key === "calendar") {
      setActiveNav({ kind: "view", key: "all" });
      setIsSidebarOpen(false);
      setMobilePanel("list");
      setCalendarFilterQuery("");
      setIsCalendarFilterOpen(true);
      return;
    }

    if (key === "all") {
      setActiveNav({ kind: "view", key: "all" });
      clearAllFilters();
    } else {
      setActiveNav({ kind: "view", key: "pinned" });
    }

    setIsSidebarOpen(false);
    setMobilePanel("list");
  };

  const sidebarNav = (
    <NotebookSidebar
      notebooks={notebooks}
      systemCounts={{
        all: smartViewCounts.all,
        calendar: calendarLinkedCount,
        pinned: smartViewCounts.pinned,
      }}
      selected={sidebarSelected}
      onSelectSystem={handleSelectSystemView}
      onSelectNotebook={(name) => {
        setActiveNav({ kind: "notebook", name });
        setIsSidebarOpen(false);
        setMobilePanel("list");
      }}
    />
  );

  const notesListPane = (
    <Card className="h-full">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="truncate text-base" title={scopeBreadcrumb}>
            {scopeBreadcrumb}
          </CardTitle>
          <div className="flex shrink-0 items-center gap-2 text-xs text-slate-600">
            <span>{visibleNotes.length}</span>
            {hasAnyFilter && (
              <button
                type="button"
                className="text-emerald-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                onClick={clearAllFilters}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2.5">
        <div className="flex items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes..."
              className="h-9 pl-8 text-sm"
              aria-label="Search notes"
            />
          </div>

          <select
            value={notesSort}
            onChange={(e) => setNotesSort(e.target.value as NotesSort)}
            aria-label="Sort notes"
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-xs text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <option value="context">Context</option>
            <option value="updated_desc">Updated</option>
            <option value="created_desc">Created</option>
            <option value="title_asc">Title</option>
          </select>

          <Button
            variant={activeEventFilterKey || linkedOnlyFilter ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setCalendarFilterQuery("");
              setIsCalendarFilterOpen(true);
            }}
            aria-label="Open notes filter"
            className="h-9 px-2.5 focus-visible:ring-2 focus-visible:ring-emerald-500"
          >
            <Filter className="h-3.5 w-3.5" />
          </Button>
        </div>

        {(activeEventFilterKey || linkedOnlyFilter || seriesOnlyFilter) && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedEventFilter && (
              <Badge variant="outline" className="gap-1 text-[11px]">
                <Calendar className="h-3 w-3" />
                {seriesOnlyFilter && selectedEventFilter.seriesId
                  ? `Calendar: ${selectedEventFilter.summary} (series)`
                  : `Calendar: ${selectedEventFilter.label}`}
                <button
                  type="button"
                  onClick={clearEventFilter}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  aria-label="Clear calendar filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {seriesOnlyFilter && selectedEventFilter?.seriesId && (
              <Badge variant="outline" className="gap-1 text-[11px]">
                Series only
                <button
                  type="button"
                  onClick={() => setSeriesOnlyFilter(false)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  aria-label="Disable series only filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
            {linkedOnlyFilter && (
              <Badge variant="outline" className="gap-1 text-[11px]">
                Linked only
                <button
                  type="button"
                  onClick={() => setLinkedOnlyFilter(false)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  aria-label="Disable linked only filter"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            )}
          </div>
        )}

        {notesLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-slate-600" />
          </div>
        ) : notesError ? (
          <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            Failed to load notes: {notesError.message}
          </p>
        ) : visibleNotes.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-600">
            No notes match this filter.
          </div>
        ) : (
          <div className="max-h-[calc(100vh-245px)] overflow-y-auto rounded-md border border-slate-200 bg-white">
            {visibleNotes.map((note: any) => {
              const active = !isDraftMode && String(selectedNoteId || "") === String(note.id);
              const links = Array.isArray(note.links) ? note.links.length : 0;
              const preview = stripHtml(note.content || "");
              const showNotebookChip = activeNav.kind !== "notebook";

              return (
                <button
                  key={note.id}
                  type="button"
                  onMouseDown={() => {
                    // Mark switch before contentEditable blur fires to avoid stale editor write-back.
                    isSwitchingNoteRef.current = true;
                  }}
                  onClick={() => selectNote(note)}
                  className={`w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                    active ? "bg-emerald-50" : "hover:bg-slate-50"
                  }`}
                  aria-label={`Open note ${String(note.title || "Untitled note")}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-900">{note.title}</p>
                      {preview ? <p className="mt-0.5 line-clamp-1 text-xs text-slate-600">{preview}</p> : null}
                      <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <div className="min-w-0">
                          {showNotebookChip ? (
                            <Badge variant="outline" className="max-w-full truncate text-[10px]">
                              {note.notebook || "General"}
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {links > 0 ? (
                            <span className="inline-flex items-center gap-1" title={`${links} linked items`}>
                              <Link2 className="h-3 w-3" />
                              {links}
                            </span>
                          ) : null}
                          {note.pinned ? <Pin className="h-3 w-3" aria-label="Pinned note" /> : null}
                          <span>{formatDateTime(note.updatedAt || note.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );

  const editorPane = (
    <Card className="h-full">
      <CardHeader className="sticky top-0 z-10 border-b bg-white/95 pb-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">Editor</CardTitle>
            <p className="mt-1 text-xs text-slate-500">{getSaveStateLabel(saveState)}</p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => void persistNote(true)}
              disabled={saveState === "saving" || (!selectedNoteId && !isDraftMode) || !isDirty}
            >
              {saveState === "saving" ? "Saving..." : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label={selectedNote?.pinned ? "Unpin note" : "Pin note"}
              disabled={!selectedNoteId || isDraftMode}
              onClick={() => void togglePin()}
            >
              {selectedNote?.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="More note actions"
                  disabled={!selectedNoteId && !isDraftMode}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56" aria-label="Note actions menu">
                <DropdownMenuItem onClick={() => void persistNote(true)} disabled={saveState === "saving"}>
                  Save now
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                <DropdownMenuItem onClick={() => void duplicateSelectedNote()} disabled={!selectedNoteId || isDraftMode}>
                  <Copy className="h-4 w-4" />
                  Duplicate
                </DropdownMenuItem>

                <DropdownMenuSeparator />

                {(notebooks.length > 0 ? notebooks : [{ name: "General", count: 0 }]).slice(0, 12).map((row) => (
                  <DropdownMenuItem
                    key={row.name}
                    onClick={() => void moveSelectedNoteToNotebook(row.name)}
                    disabled={!selectedNoteId || isDraftMode || row.name === (selectedNote?.notebook || "General")}
                  >
                    <FolderOpen className="h-4 w-4" />
                    Move to {row.name}
                  </DropdownMenuItem>
                ))}

                <DropdownMenuSeparator />

                <DropdownMenuItem
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={!selectedNoteId || isDraftMode}
                  className="text-rose-700 focus:text-rose-700"
                >
                  <Trash2 className="h-4 w-4" />
                  Delete note
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {!selectedNoteId && !isDraftMode ? (
          <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 py-7 text-sm text-slate-600">
            Select a note from the middle pane or create a new note.
          </div>
        ) : (
          <>
            <Input
              value={noteTitleInput}
              onChange={(e) => {
                setNoteTitleInput(e.target.value);
                setIsDirty(true);
              }}
              className="h-9 text-sm"
              placeholder="Note title"
              aria-label="Note title"
            />

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[120px_minmax(0,1fr)] sm:items-center">
              <label className="text-xs font-medium text-slate-600" htmlFor="notebook-name-input">
                Notebook
              </label>
              <Input
                id="notebook-name-input"
                value={noteNotebookInput}
                onChange={(e) => {
                  setNoteNotebookInput(e.target.value);
                  setIsDirty(true);
                }}
                className="h-8 text-xs"
                placeholder="Notebook name"
              />
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-medium text-slate-600">Linked:</span>
                {selectedLinks.length === 0 ? (
                  <span className="text-xs text-slate-500">No linked items yet.</span>
                ) : (
                  selectedLinks.map((link: any) => {
                    const isCalendar = link.linkType === "google_calendar_event";
                    const isTodoist = link.linkType === "todoist_task";
                    const isNote = link.linkType === "note_link";
                    const isDrive = link.linkType === "google_drive_file";
                    const label = isCalendar
                      ? linkedEventLabelByLinkId.get(link.id) || link.sourceTitle || "Calendar event"
                      : isTodoist
                        ? link.sourceTitle || "Todoist task"
                        : isNote
                          ? link.sourceTitle || "Linked note"
                          : isDrive
                            ? link.sourceTitle || "Google Drive file"
                            : link.sourceTitle || "Linked item";

                    return (
                      <Badge key={link.id} variant="outline" className="max-w-[260px] gap-1 truncate text-[11px]">
                        <span className="truncate">{label}</span>
                        <button
                          type="button"
                          className="rounded-full p-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          aria-label={`Unlink ${label}`}
                          onClick={() => void removeLink(link.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })
                )}
                <div className="relative ml-auto">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 px-2 text-xs"
                    onClick={() => {
                      if (!selectedNoteId || isDraftMode) {
                        toast.error("Save the note first, then link it.");
                        return;
                      }
                      setIsLinkMenuOpen((prev) => !prev);
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Link to...
                  </Button>
                  <LinkMenu
                    open={isLinkMenuOpen}
                    onClose={() => setIsLinkMenuOpen(false)}
                    onSelect={handleLinkMenuSelect}
                    className="right-0 top-full mt-1"
                  />
                </div>
              </div>
            </div>

            <div className="rounded-md border border-slate-200 bg-white">
              <div className="flex items-center gap-1 border-b border-slate-200 p-1.5">
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => runEditorCommand("bold")}>
                  <Bold className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => runEditorCommand("italic")}>
                  <Italic className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => runEditorCommand("underline")}>
                  <Underline className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={handleInsertLink}>
                  <Link2 className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => runEditorCommand("unlink")}>
                  <Unlink className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => runEditorCommand("insertUnorderedList")}>
                  <List className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onMouseDown={(e) => e.preventDefault()} onClick={() => runEditorCommand("insertOrderedList")}>
                  <ListOrdered className="h-3.5 w-3.5" />
                </Button>
              </div>

              <div
                key={isDraftMode ? "draft-editor" : `note-editor-${selectedNoteId || "none"}`}
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={(event) => {
                  const sanitized = sanitizeEditorHtml(editorRef.current?.innerHTML || "<p></p>");
                  setNoteContentHtml(sanitized);
                  setIsDirty(true);
                }}
                onBlur={(event) => {
                  if (isSwitchingNoteRef.current) return;
                  if (!editorRef.current) return;
                  const sanitized = sanitizeEditorHtml(editorRef.current.innerHTML || "<p></p>");
                  editorRef.current.innerHTML = sanitized;
                  setNoteContentHtml(sanitized);
                }}
                onKeyDown={handleEditorKeyDown}
                className="notes-richtext min-h-[260px] max-h-[calc(100vh-480px)] overflow-y-auto p-3 text-sm outline-none"
              />
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-white to-emerald-50 dark:from-slate-950 dark:via-slate-900 dark:to-blue-950">
      <header className="sticky top-0 z-20 border-b bg-white/90 backdrop-blur dark:bg-slate-900/90">
        <div className="container mx-auto flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setLocation("/dashboard")}> 
              <ArrowLeft className="mr-1 h-4 w-4" />
              Dashboard
            </Button>

            <Sheet open={isSidebarOpen} onOpenChange={setIsSidebarOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" size="sm" className="lg:hidden" aria-label="Open notebooks navigation">
                  <PanelLeft className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[320px] sm:max-w-[320px]">
                <SheetHeader>
                  <SheetTitle>Notebook Navigation</SheetTitle>
                  <SheetDescription>Switch system views and notebooks.</SheetDescription>
                </SheetHeader>
                <div className="px-4 pb-4">{sidebarNav}</div>
              </SheetContent>
            </Sheet>

            <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Notebook</h1>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => refetchNotes()}>
              Refresh
            </Button>
            <Button size="sm" onClick={createDraft}>
              <Plus className="mr-1 h-4 w-4" />
              New Note
            </Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-4">
        <div className="hidden gap-4 lg:grid lg:grid-cols-[240px_400px_minmax(0,1fr)]">
          <Card className="h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Browse</CardTitle>
            </CardHeader>
            <CardContent>{sidebarNav}</CardContent>
          </Card>

          {notesListPane}
          {editorPane}
        </div>

        <div className="space-y-4 lg:hidden">
          {mobilePanel === "list" ? (
            <>{notesListPane}</>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <Button type="button" variant="outline" size="sm" onClick={() => setMobilePanel("list")}>
                  <ArrowLeft className="mr-1 h-4 w-4" />
                  Back to list
                </Button>
                <span className="text-xs text-slate-500">{getSaveStateLabel(saveState)}</span>
              </div>
              {editorPane}
            </>
          )}
        </div>
      </main>

      <Dialog
        open={isCalendarFilterOpen}
        onOpenChange={(open) => {
          setIsCalendarFilterOpen(open);
          if (!open) {
            setCalendarFilterQuery("");
          }
        }}
      >
      <DialogContent className="sm:max-w-xl" aria-label="Calendar filter dialog">
        <DialogHeader>
          <DialogTitle>Filters</DialogTitle>
          <DialogDescription>Refine notes by calendar context and linked state.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            value={calendarFilterQuery}
            onChange={(e) => setCalendarFilterQuery(e.target.value)}
            placeholder="Search events or series"
            className="h-9"
            aria-label="Search calendar filters"
          />

          {activeNav.kind !== "view" || activeNav.key !== "linked" ? (
            <label className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700">
              <span>Linked only</span>
              <input
                type="checkbox"
                checked={linkedOnlyFilter}
                onChange={(e) => setLinkedOnlyFilter(e.target.checked)}
                aria-label="Linked only filter"
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
            </label>
          ) : null}

          {canToggleSeriesOnly ? (
            <label className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-700">
              <span>Series only</span>
              <input
                type="checkbox"
                checked={seriesOnlyFilter}
                onChange={(e) => setSeriesOnlyFilter(e.target.checked)}
                aria-label="Series only filter"
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
            </label>
          ) : null}

          <div className="max-h-80 overflow-y-auto rounded-md border border-slate-200">
            <button
              type="button"
              onClick={() => {
                clearEventFilter();
                setIsCalendarFilterOpen(false);
                }}
                className={`w-full border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  !selectedEventFilter ? "bg-emerald-50" : ""
                }`}
                aria-label="Show notes from all calendar events"
              >
                <p className="text-sm font-medium text-slate-900">All calendar events</p>
                <p className="text-xs text-slate-500">No calendar filter</p>
              </button>

              {filteredCalendarFilterOptions.length === 0 ? (
                <p className="px-3 py-6 text-sm text-slate-500">No calendar events match your search.</p>
              ) : (
                filteredCalendarFilterOptions.map((option) => {
                  const active = effectiveEventFilterKey === option.key;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => {
                        setActiveEventFilterKey(option.key);
                        setSeriesOnlyFilter(option.key.startsWith("series:"));
                        setIsCalendarFilterOpen(false);
                      }}
                      className={`w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                        active ? "bg-emerald-50" : ""
                      }`}
                      aria-label={`Filter notes by ${option.label}`}
                    >
                      <p className="truncate text-sm font-medium text-slate-900">{option.label}</p>
                      <p className="text-xs text-slate-500">{option.isRecurring ? "Recurring series" : "Single event"}</p>
                    </button>
                  );
                })
              )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={clearAllFilters}>
            Clear all
          </Button>
          <Button type="button" variant="outline" onClick={() => setIsCalendarFilterOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>

      <Dialog
        open={attachOpen}
        onOpenChange={(open) => {
          setAttachOpen(open);
          if (!open) {
            setAttachQuery("");
            setAttachSelectionId("");
          }
        }}
      >
        <DialogContent className="sm:max-w-xl" aria-label="Attach event or task dialog">
          <DialogHeader>
            <DialogTitle>Attach to note</DialogTitle>
            <DialogDescription>
              Link and unlink calendar events, tasks, notes, and Drive files in one place.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-md border border-slate-200 bg-slate-50 p-2.5">
              <p className="mb-1 text-xs font-medium text-slate-700">Currently linked</p>
              <div className="flex flex-wrap gap-1.5">
                {selectedLinks.length === 0 ? (
                  <p className="text-xs text-slate-500">No linked items yet.</p>
                ) : (
                  selectedLinks.map((link: any) => {
                    const isCalendar = link.linkType === "google_calendar_event";
                    const isTodoist = link.linkType === "todoist_task";
                    const isNote = link.linkType === "note_link";
                    const isDrive = link.linkType === "google_drive_file";
                    const label = isCalendar
                      ? linkedEventLabelByLinkId.get(link.id) || link.sourceTitle || "Calendar event"
                      : isTodoist
                        ? link.sourceTitle || "Todoist task"
                        : isNote
                          ? link.sourceTitle || "Linked note"
                          : isDrive
                            ? link.sourceTitle || "Google Drive file"
                            : link.sourceTitle || "Linked item";

                    return (
                      <Badge key={link.id} variant="outline" className="max-w-[290px] gap-1 truncate text-[11px]">
                        <span className="truncate">{label}</span>
                        <button
                          type="button"
                          className="rounded-full p-0.5 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                          aria-label={`Unlink ${label}`}
                          onClick={() => void removeLink(link.id)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    );
                  })
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {hasGoogle && (
                <Button
                  type="button"
                  size="sm"
                  variant={attachType === "calendar" ? "default" : "outline"}
                  onClick={() => {
                    setAttachType("calendar");
                    setAttachSelectionId("");
                    setAttachQuery("");
                  }}
                >
                  <Calendar className="mr-1 h-3.5 w-3.5" />
                  Calendar
                </Button>
              )}
              {hasTodoist && (
                <Button
                  type="button"
                  size="sm"
                  variant={attachType === "todoist" ? "default" : "outline"}
                  onClick={() => {
                    setAttachType("todoist");
                    setAttachSelectionId("");
                    setAttachQuery("");
                  }}
                >
                  <CheckSquare className="mr-1 h-3.5 w-3.5" />
                  Todoist
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant={attachType === "note" ? "default" : "outline"}
                onClick={() => {
                  setAttachType("note");
                  setAttachSelectionId("");
                  setAttachQuery("");
                }}
              >
                <FileText className="mr-1 h-3.5 w-3.5" />
                Note
              </Button>
              {hasGoogle && (
                <Button
                  type="button"
                  size="sm"
                  variant={attachType === "drive" ? "default" : "outline"}
                  onClick={() => {
                    setAttachType("drive");
                    setAttachSelectionId("");
                    setAttachQuery("");
                  }}
                >
                  <FolderOpen className="mr-1 h-3.5 w-3.5" />
                  Drive
                </Button>
              )}
            </div>

            <Input
              value={attachQuery}
              onChange={(e) => setAttachQuery(e.target.value)}
              placeholder={
                attachType === "calendar"
                  ? "Search events"
                  : attachType === "todoist"
                    ? "Search tasks"
                    : attachType === "note"
                      ? "Search notes"
                      : "Search Drive files"
              }
              className="h-9"
              aria-label="Search attach items"
            />

            <div className="max-h-72 overflow-y-auto rounded-md border border-slate-200">
              {attachItems.length === 0 ? (
                <p className="px-3 py-6 text-sm text-slate-500">No items match your search.</p>
              ) : (
                attachItems.map((item) => {
                  const active = attachSelectionId === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setAttachSelectionId(item.id)}
                      className={`w-full border-b border-slate-100 px-3 py-2 text-left last:border-b-0 ${
                        active ? "bg-emerald-50" : "hover:bg-slate-50"
                      }`}
                    >
                      <p className="truncate text-sm font-medium text-slate-900">{item.title}</p>
                      {item.subtitle && <p className="truncate text-xs text-slate-500">{item.subtitle}</p>}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAttachOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void attachSelectedItem()}
              disabled={!selectedAttachItem || isAttachAlreadyLinked || addNoteLinkMutation.isPending}
            >
              {addNoteLinkMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {isAttachAlreadyLinked ? "Already linked" : "Attach"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this note?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The note and its links will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700"
              onClick={(event) => {
                event.preventDefault();
                void deleteSelectedNote();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
