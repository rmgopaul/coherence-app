import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionRating } from "@/components/SectionRating";
import { FileText, RefreshCw, Loader2, Trash2 } from "lucide-react";

const toPlainText = (content: string) => {
  if (typeof window === "undefined")
    return content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const div = document.createElement("div");
  div.innerHTML = content
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
  return (div.textContent || div.innerText || "").replace(/\s+/g, " ").trim();
};

export interface NotesCardProps {
  // Data
  noteTitleInput: string;
  noteContentInput: string;
  noteNotebookInput: string;
  noteNotebookFilter: string;
  editingNoteId: string | null;
  linkNoteId: string;
  linkTaskId: string;
  linkEventId: string;
  noteNotebookOptions: string[];
  filteredNotes: any[];
  notes: any[] | undefined;
  notesLoading: boolean;
  todayTasks: any[] | undefined;
  upcomingEvents: any[];
  sectionRating: number | undefined;

  // Handlers
  setNoteTitleInput: (v: string) => void;
  setNoteContentInput: (v: string) => void;
  setNoteNotebookInput: (v: string) => void;
  setNoteNotebookFilter: (v: string) => void;
  setEditingNoteId: (id: string | null) => void;
  setLinkNoteId: (v: string) => void;
  setLinkTaskId: (v: string) => void;
  setLinkEventId: (v: string) => void;
  onSubmitNote: () => void;
  onEditNote: (note: any) => void;
  onDeleteNote: (noteId: string) => void;
  onPinNote: (noteId: string, pinned: boolean) => void;
  onLinkNoteToTask: () => void;
  onLinkNoteToEvent: () => void;
  onRemoveLink: (linkId: string) => void;
  onRefresh: () => void;
  formatCalendarEventLabel: (event: any) => string;

  // Mutation state
  createPending: boolean;
  updatePending: boolean;
  linkPending: boolean;
}

export function NotesCard({
  noteTitleInput,
  noteContentInput,
  noteNotebookInput,
  noteNotebookFilter,
  editingNoteId,
  linkNoteId,
  linkTaskId,
  linkEventId,
  noteNotebookOptions,
  filteredNotes,
  notes,
  notesLoading,
  todayTasks,
  upcomingEvents,
  sectionRating,
  setNoteTitleInput,
  setNoteContentInput,
  setNoteNotebookInput,
  setNoteNotebookFilter,
  setEditingNoteId,
  setLinkNoteId,
  setLinkTaskId,
  setLinkEventId,
  onSubmitNote,
  onEditNote,
  onDeleteNote,
  onPinNote,
  onLinkNoteToTask,
  onLinkNoteToEvent,
  onRemoveLink,
  onRefresh,
  formatCalendarEventLabel,
  createPending,
  updatePending,
  linkPending,
}: NotesCardProps) {
  return (
    <Card className="min-w-0 flex flex-col">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-emerald-600" />
          <CardTitle className="text-base">Notes</CardTitle>
        </div>
        <div className="flex items-center gap-1">
          <SectionRating
            sectionId="section-notes"
            currentRating={sectionRating as any}
          />
          <Button variant="ghost" size="sm" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Notebook input + filter */}
        <div className="grid grid-cols-2 gap-2">
          <Input
            value={noteNotebookInput}
            onChange={(e) => setNoteNotebookInput(e.target.value)}
            placeholder="Notebook"
            className="h-8 text-xs"
          />
          <Select value={noteNotebookFilter} onValueChange={setNoteNotebookFilter}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Filter notebook" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All notebooks</SelectItem>
              {noteNotebookOptions.map((notebook) => (
                <SelectItem key={notebook} value={notebook}>
                  {notebook}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Note title */}
        <Input
          value={noteTitleInput}
          onChange={(e) => setNoteTitleInput(e.target.value)}
          placeholder="Note title"
          className="h-8 text-xs"
        />

        {/* Note content */}
        <Textarea
          value={noteContentInput}
          onChange={(e) => setNoteContentInput(e.target.value)}
          placeholder="Write note content..."
          className="min-h-[84px] text-xs"
        />

        {/* Create / Update + Cancel */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={onSubmitNote}
            disabled={createPending || updatePending}
          >
            {editingNoteId ? "Update Note" : "Create Note"}
          </Button>
          {editingNoteId && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => {
                setEditingNoteId(null);
                setNoteNotebookInput("General");
                setNoteTitleInput("");
                setNoteContentInput("");
              }}
            >
              Cancel
            </Button>
          )}
        </div>

        {/* Link Existing Note */}
        <div className="rounded-md border border-border bg-muted p-2 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">
            Link Existing Note
          </p>
          <Select
            value={linkNoteId || "__none"}
            onValueChange={(value) =>
              setLinkNoteId(value === "__none" ? "" : value)
            }
          >
            <SelectTrigger className="h-8 text-xs bg-card">
              <SelectValue placeholder="Select note" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">Select note</SelectItem>
              {(notes || []).map((note: any) => (
                <SelectItem key={note.id} value={note.id}>
                  {note.notebook || "General"} &bull; {note.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="grid grid-cols-1 gap-2">
            {/* Link to task */}
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={linkTaskId || "__none"}
                onValueChange={(value) =>
                  setLinkTaskId(value === "__none" ? "" : value)
                }
              >
                <SelectTrigger className="h-8 min-w-0 text-xs bg-card sm:flex-1">
                  <SelectValue placeholder="Link to Todoist task" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Select Todoist task</SelectItem>
                  {(todayTasks || []).slice(0, 50).map((task: any) => (
                    <SelectItem key={task.id} value={String(task.id)}>
                      {task.content}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8 text-xs sm:shrink-0"
                onClick={onLinkNoteToTask}
                disabled={linkPending}
              >
                Link Task
              </Button>
            </div>

            {/* Link to event */}
            <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={linkEventId || "__none"}
                onValueChange={(value) =>
                  setLinkEventId(value === "__none" ? "" : value)
                }
              >
                <SelectTrigger className="h-8 min-w-0 text-xs bg-card sm:flex-1">
                  <SelectValue placeholder="Link to calendar event" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">Select calendar event</SelectItem>
                  {upcomingEvents.slice(0, 50).map((event: any) => (
                    <SelectItem
                      key={event.id}
                      value={String(event.id || "")}
                    >
                      {formatCalendarEventLabel(event)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-8 text-xs sm:shrink-0"
                onClick={onLinkNoteToEvent}
                disabled={linkPending}
              >
                Link Event
              </Button>
            </div>
          </div>
        </div>

        {/* Notes list */}
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {notesLoading ? (
            <div className="flex justify-center py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filteredNotes.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No notes for this notebook filter.
            </p>
          ) : (
            filteredNotes.map((note: any) => (
              <div
                key={note.id}
                className="rounded-md border border-emerald-100 bg-emerald-50/60 px-2 py-2 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 text-left"
                    onClick={() => onEditNote(note)}
                  >
                    <p className="text-xs font-semibold text-foreground truncate">
                      {note.title}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                      {toPlainText(String(note.content || "")) || "No content"}
                    </p>
                  </button>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant={note.pinned ? "default" : "outline"}
                      className="h-6 px-2 text-xs"
                      onClick={() => onPinNote(note.id, !note.pinned)}
                    >
                      {note.pinned ? "Pinned" : "Pin"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => onDeleteNote(note.id)}
                    >
                      <Trash2 className="h-3 w-3 text-muted-foreground" />
                    </Button>
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <Badge variant="outline" className="text-xs">
                    Notebook: {note.notebook || "General"}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {new Date(
                      note.updatedAt || note.createdAt || Date.now()
                    ).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                <div className="flex flex-wrap gap-1">
                  {Array.isArray(note.links) && note.links.length > 0 ? (
                    note.links.map((link: any) => (
                      <Badge
                        key={link.id}
                        variant="outline"
                        className="text-xs gap-1"
                      >
                        {link.linkType === "todoist_task" ? "Task" : "Event"}
                        {link.seriesId ? " \u2022 Recurring" : ""}
                        <button
                          type="button"
                          className="ml-1 text-muted-foreground hover:text-foreground"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onRemoveLink(link.id);
                          }}
                          aria-label="Remove link"
                        >
                          &times;
                        </button>
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      No links
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
