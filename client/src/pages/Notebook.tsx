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
  ArrowLeft,
  Bold,
  Calendar,
  CheckSquare,
  CircleDashed,
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
  Save,
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
type AttachTarget = "calendar" | "todoist";
type SaveState = "saved" | "saving" | "unsaved" | "error";
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
  return decodeHtmlEntities(
    content
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
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

function formatSeriesIdentifier(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length <= 18) return cleaned;
  return `${cleaned.slice(0, 7)}...${cleaned.slice(-6)}`;
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
  if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
  return `<p>${escapeHtml(raw).replace(/\n/g, "<br/>")}</p>`;
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

  const [noteNotebookInput, setNoteNotebookInput] = useState("General");
  const [noteTitleInput, setNoteTitleInput] = useState("");
  const [noteContentHtml, setNoteContentHtml] = useState("<p></p>");
  const [isDirty, setIsDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");

  const [attachOpen, setAttachOpen] = useState(false);
  const [attachType, setAttachType] = useState<AttachTarget>("calendar");
  const [attachQuery, setAttachQuery] = useState("");
  const [attachSelectionId, setAttachSelectionId] = useState("");

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<"list" | "editor">("list");

  const editorRef = useRef<HTMLDivElement | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);

  const loadNoteIntoEditor = useCallback((note: any) => {
    const notebookValue = (note?.notebook || "General").trim() || "General";
    const titleValue = String(note?.title || "");
    const htmlValue = normalizeStoredHtml(note?.content);

    setNoteNotebookInput(notebookValue);
    setNoteTitleInput(titleValue);
    setNoteContentHtml(htmlValue);
    setIsDirty(false);
    setSaveState("saved");

    // Force the contentEditable surface to update immediately when switching notes.
    if (editorRef.current) {
      editorRef.current.innerHTML = htmlValue;
    }
  }, []);

  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
  }, []);

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

  const meetingFolders = useMemo(() => {
    if (!notes) return [];

    const groups = new Map<
      string,
      {
        key: string;
        seriesId: string;
        eventId: string;
        fallbackTitle: string;
        noteIds: Set<string>;
        occurrences: number[];
      }
    >();

    for (const note of notes) {
      const links = Array.isArray((note as any).links) ? (note as any).links : [];
      for (const link of links) {
        if (link?.linkType !== "google_calendar_event") continue;
        const seriesId = String(link.seriesId || "").trim();
        const eventId = String(link.externalId || "").trim();
        if (!seriesId && !eventId) continue;

        const key = seriesId ? `series:${seriesId}` : `event:${eventId}`;
        const existing = groups.get(key) || {
          key,
          seriesId,
          eventId,
          fallbackTitle: String(link.sourceTitle || "").trim(),
          noteIds: new Set<string>(),
          occurrences: [],
        };

        existing.noteIds.add(String(note.id));
        if (!existing.fallbackTitle && link.sourceTitle) {
          existing.fallbackTitle = String(link.sourceTitle);
        }

        const occurrenceTs = new Date(String(link.occurrenceStartIso || "")).getTime();
        if (Number.isFinite(occurrenceTs)) existing.occurrences.push(occurrenceTs);

        groups.set(key, existing);
      }
    }

    const nowMs = Date.now();

    return Array.from(groups.values())
      .map((group) => {
        const option = calendarFilterOptionByKey.get(group.key);
        const sortTsFromLinks =
          group.occurrences.length > 0 ? [...group.occurrences].sort((a, b) => b - a)[0] : null;

        return {
          key: group.key,
          label: option?.label || group.fallbackTitle || "Meeting",
          summary: option?.summary || group.fallbackTitle || "Meeting",
          isRecurring: option?.isRecurring ?? group.key.startsWith("series:"),
          sortTs: option?.sortTs ?? sortTsFromLinks,
          noteCount: group.noteIds.size,
        };
      })
      .sort((a, b) => {
        const aTs = a.sortTs ?? 0;
        const bTs = b.sortTs ?? 0;
        const aFuture = a.sortTs !== null && aTs >= nowMs;
        const bFuture = b.sortTs !== null && bTs >= nowMs;
        if (aFuture !== bFuture) return aFuture ? -1 : 1;
        if (aFuture && bFuture) return aTs - bTs;
        if (!aFuture && !bFuture) return bTs - aTs;
        return a.label.localeCompare(b.label);
      });
  }, [notes, calendarFilterOptionByKey]);

  const selectedNote = useMemo(
    () => (notes || []).find((note) => note.id === selectedNoteId) || null,
    [notes, selectedNoteId]
  );

  const selectedLinks = useMemo(
    () => (Array.isArray(selectedNote?.links) ? selectedNote.links : []),
    [selectedNote]
  );

  const recurringLinkFilterKey = useMemo(() => {
    for (const link of selectedLinks) {
      if (link?.linkType !== "google_calendar_event") continue;
      const seriesId = String(link.seriesId || "").trim();
      if (seriesId) return `series:${seriesId}`;
    }
    return "";
  }, [selectedLinks]);

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

    if (activeEventFilterKey) {
      rows = rows.filter((note: any) => {
        const links = Array.isArray(note.links) ? note.links : [];
        return links.some((link: any) => {
          if (link.linkType !== "google_calendar_event") return false;
          const externalId = String(link.externalId || "");
          const seriesId = String(link.seriesId || "");
          if (activeEventFilterKey.startsWith("series:")) {
            return `series:${seriesId}` === activeEventFilterKey;
          }
          return `event:${externalId}` === activeEventFilterKey;
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

    return [...rows].sort((a: any, b: any) => {
      if (activeEventFilterKey) {
        const buildMeta = (note: any) => {
          const links = (Array.isArray(note.links) ? note.links : []).filter((link: any) => {
            if (link.linkType !== "google_calendar_event") return false;
            if (activeEventFilterKey.startsWith("series:")) {
              return `series:${String(link.seriesId || "")}` === activeEventFilterKey;
            }
            return `event:${String(link.externalId || "")}` === activeEventFilterKey;
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
      const aTs = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const bTs = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return bTs - aTs;
    });
  }, [notes, activeNav, activeEventFilterKey, searchQuery]);

  useEffect(() => {
    if (isDraftMode) return;
    if (!selectedNoteId && visibleNotes.length > 0) {
      setSelectedNoteId(visibleNotes[0].id);
    }
  }, [selectedNoteId, visibleNotes, isDraftMode]);

  useEffect(() => {
    if (!selectedNote || isDraftMode) return;
    loadNoteIntoEditor(selectedNote);
  }, [selectedNote?.id, selectedNote?.updatedAt, selectedNote?.content, isDraftMode, loadNoteIntoEditor]);

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
    setIsDraftMode(true);
    setSelectedNoteId(null);

    if (activeNav.kind === "notebook") {
      setNoteNotebookInput(activeNav.name);
    } else {
      setNoteNotebookInput("General");
    }

    setNoteTitleInput("");
    setNoteContentHtml("<p></p>");
    setIsDirty(false);
    setSaveState("saved");
    setMobilePanel("editor");

    if (editorRef.current) {
      editorRef.current.innerHTML = "<p></p>";
      editorRef.current.focus();
    }
  };

  const selectNote = (noteId: string) => {
    clearAutosaveTimer();
    const note = (notes || []).find((row: any) => row.id === noteId);
    setIsDraftMode(false);
    setSelectedNoteId(noteId);
    if (note) {
      loadNoteIntoEditor(note);
    }
    setMobilePanel("editor");
  };

  const deleteSelectedNote = async () => {
    if (!selectedNoteId || isDraftMode) {
      toast.error("Select a saved note first");
      return;
    }

    try {
      await deleteNoteMutation.mutateAsync({ noteId: selectedNoteId });
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

    const rows = calendarEventOptions.map((event: any) => ({
      id: String(event.id || ""),
      title: formatEventOptionLabel(event),
      subtitle: String(event.location || "").trim() || null,
    }));
    if (!query) return rows.slice(0, 200);
    return rows
      .filter((row) => row.title.toLowerCase().includes(query) || String(row.subtitle || "").toLowerCase().includes(query))
      .slice(0, 200);
  }, [attachType, attachQuery, todoistTasks, calendarEventOptions]);

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
      toast.error("Save the note first, then attach an event or task");
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
          toast.success("Task attached");
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
          toast.success("Event attached");
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

  const applyMeetingFilter = (meetingKey: string) => {
    setActiveNav({ kind: "notebook", name: "Meetings" });
    setActiveEventFilterKey(meetingKey);
    setIsSidebarOpen(false);
    setMobilePanel("list");
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
  };

  const navHeaderLabel = useMemo(() => {
    if (activeNav.kind === "view") {
      if (activeNav.key === "all") return "All notes";
      if (activeNav.key === "pinned") return "Pinned notes";
      return "Linked notes";
    }
    return activeNav.name;
  }, [activeNav]);

  const sidebarNav = (
    <div className="space-y-5">
      <div>
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Smart Views</p>
        <div className="space-y-1">
          {([
            { key: "all", label: "All Notes", count: smartViewCounts.all },
            { key: "pinned", label: "Pinned", count: smartViewCounts.pinned },
            { key: "linked", label: "Linked", count: smartViewCounts.linked },
          ] as const).map((row) => {
            const active = activeNav.kind === "view" && activeNav.key === row.key;
            return (
              <button
                key={row.key}
                type="button"
                onClick={() => {
                  setActiveNav({ kind: "view", key: row.key });
                  setActiveEventFilterKey("");
                  setIsSidebarOpen(false);
                  setMobilePanel("list");
                }}
                className={`w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  active
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span>{row.label}</span>
                  <span className="text-[11px]">{row.count}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Notebooks</p>
        <div className="space-y-1">
          {notebooks.map((notebook) => {
            const active = activeNav.kind === "notebook" && activeNav.name === notebook.name;
            return (
              <button
                key={notebook.name}
                type="button"
                onClick={() => {
                  setActiveNav({ kind: "notebook", name: notebook.name });
                  setActiveEventFilterKey("");
                  setIsSidebarOpen(false);
                  setMobilePanel("list");
                }}
                className={`w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                  active
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate">{notebook.name}</span>
                  <span className="text-[11px]">{notebook.count}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {activeNav.kind === "notebook" && activeNav.name === "Meetings" && meetingFolders.length > 0 && (
        <div>
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Meeting Folders</p>
          <div className="max-h-[240px] space-y-1 overflow-y-auto pr-1">
            {meetingFolders.map((meeting) => {
              const active = activeEventFilterKey === meeting.key;
              return (
                <button
                  key={meeting.key}
                  type="button"
                  onClick={() => applyMeetingFilter(meeting.key)}
                  className={`w-full rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                    active
                      ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <p className="truncate font-medium">{meeting.label}</p>
                  <p className="mt-0.5 text-[10px] opacity-80">
                    {meeting.noteCount} note{meeting.noteCount === 1 ? "" : "s"}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  const notesListPane = (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{navHeaderLabel}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search notes"
              className="h-9 pl-8 text-sm"
              aria-label="Search notes"
            />
          </div>
          {searchQuery.trim() && (
            <Button variant="outline" size="sm" onClick={() => setSearchQuery("")}>
              Clear
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span>{visibleNotes.length} shown</span>
          {selectedEventFilter && (
            <Badge variant="outline" className="gap-1 text-[11px]">
              <Calendar className="h-3 w-3" />
              {selectedEventFilter.label}
              <button
                type="button"
                onClick={clearEventFilter}
                className="ml-0.5 rounded-full p-0.5 hover:bg-slate-100"
                aria-label="Clear event filter"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          )}
        </div>

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
            No notes match your filters. Try a different view or clear search.
          </div>
        ) : (
          <div className="max-h-[calc(100vh-290px)] overflow-y-auto rounded-md border border-slate-200 bg-white">
            {visibleNotes.map((note: any) => {
              const active = !isDraftMode && selectedNoteId === note.id;
              const links = Array.isArray(note.links) ? note.links.length : 0;

              return (
                <button
                  key={note.id}
                  type="button"
                  onClick={() => selectNote(note.id)}
                  className={`w-full border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 ${
                    active ? "bg-emerald-50" : "hover:bg-slate-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-slate-900">{note.title}</p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">
                        {stripHtml(note.content || "") || "No content"}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1">
                        <Badge variant="outline" className="text-[10px]">
                          {note.notebook || "General"}
                        </Badge>
                        {note.pinned && (
                          <Badge variant="outline" className="text-[10px]">
                            Pinned
                          </Badge>
                        )}
                        {links > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            {links} link{links === 1 ? "" : "s"}
                          </Badge>
                        )}
                      </div>
                    </div>
                    <span className="shrink-0 text-[11px] text-slate-500">{formatDateTime(note.updatedAt || note.createdAt)}</span>
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
      <CardHeader className="pb-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Editor</CardTitle>
                  <p className="mt-1 text-xs text-slate-500">{getSaveStateLabel(saveState)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => void persistNote(true)}
                    disabled={saveState === "saving" || (!selectedNoteId && !isDraftMode)}
                  >
                    <Save className="mr-1 h-4 w-4" />
                    Save
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-8 w-8"
                        aria-label="More note actions"
                        disabled={!selectedNoteId || isDraftMode}
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56" aria-label="Note actions menu">
                      <DropdownMenuItem onClick={togglePin} disabled={!selectedNoteId || isDraftMode}>
                        {selectedNote?.pinned ? (
                          <>
                            <PinOff className="h-4 w-4" />
                            Unpin note
                          </>
                        ) : (
                          <>
                            <Pin className="h-4 w-4" />
                            Pin note
                          </>
                        )}
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

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[140px_minmax(0,1fr)] sm:items-center">
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
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={() => {
                  const sanitized = sanitizeEditorHtml(editorRef.current?.innerHTML || "<p></p>");
                  setNoteContentHtml(sanitized);
                  setIsDirty(true);
                }}
                onBlur={() => {
                  if (!editorRef.current) return;
                  const sanitized = sanitizeEditorHtml(editorRef.current.innerHTML || "<p></p>");
                  editorRef.current.innerHTML = sanitized;
                  setNoteContentHtml(sanitized);
                }}
                onKeyDown={handleEditorKeyDown}
                className="notes-richtext min-h-[260px] max-h-[calc(100vh-480px)] overflow-y-auto p-3 text-sm outline-none"
              />
            </div>

            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-700">Linked to</p>
                <div className="flex items-center gap-2">
                  {recurringLinkFilterKey && (
                    <Button
                      type="button"
                      size="sm"
                      variant={activeEventFilterKey === recurringLinkFilterKey ? "default" : "outline"}
                      className="h-7 px-2 text-xs"
                      onClick={() => {
                        setActiveEventFilterKey(
                          activeEventFilterKey === recurringLinkFilterKey ? "" : recurringLinkFilterKey
                        );
                      }}
                    >
                      <CircleDashed className="mr-1 h-3.5 w-3.5" />
                      {activeEventFilterKey === recurringLinkFilterKey ? "Viewing series" : "View series notes"}
                    </Button>
                  )}

                  <Button
                    type="button"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      if (!selectedNoteId || isDraftMode) {
                        toast.error("Save the note first, then attach");
                        return;
                      }
                      setAttachOpen(true);
                    }}
                  >
                    <Plus className="mr-1 h-3.5 w-3.5" />
                    Attach...
                  </Button>
                </div>
              </div>

              <div className="mt-2 space-y-2">
                {selectedLinks.length === 0 ? (
                  <p className="text-xs text-slate-500">No linked events or tasks yet.</p>
                ) : (
                  selectedLinks.map((link: any) => {
                    const isCalendar = link.linkType === "google_calendar_event";
                    const label = isCalendar
                      ? linkedEventLabelByLinkId.get(link.id) || link.sourceTitle || "Calendar event"
                      : link.sourceTitle || "Todoist task";

                    return (
                      <div
                        key={link.id}
                        className="flex items-start justify-between gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-1.5"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-slate-800">{label}</p>
                          <p className="mt-0.5 truncate text-[11px] text-slate-500">
                            {isCalendar ? "Event" : "Task"}
                            {link.seriesId ? ` · Series ${formatSeriesIdentifier(String(link.seriesId))}` : ""}
                            {link.occurrenceStartIso ? ` · ${formatDateTime(link.occurrenceStartIso)}` : ""}
                          </p>
                        </div>

                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-6 w-6"
                          onClick={() => void removeLink(link.id)}
                          aria-label="Unlink item"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    );
                  })
                )}
              </div>
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
                  <SheetDescription>Switch notebooks, smart views, or meeting folders.</SheetDescription>
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
        <div className="hidden gap-4 lg:grid lg:grid-cols-[260px_380px_minmax(0,1fr)]">
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
              Link this note to a calendar event or Todoist task from one place.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
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
            </div>

            <Input
              value={attachQuery}
              onChange={(e) => setAttachQuery(e.target.value)}
              placeholder={attachType === "calendar" ? "Search events" : "Search tasks"}
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
