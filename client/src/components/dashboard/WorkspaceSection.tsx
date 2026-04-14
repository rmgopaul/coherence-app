import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionRating } from "@/components/SectionRating";
import {
  Calendar,
  CheckSquare,
  Mail,
  MailCheck,
  Loader2,
  RefreshCw,
  Plus,
  MessageSquare,
  FileText,
  FolderOpen,
} from "lucide-react";
import type {
  CalendarEvent,
  GmailMessage,
  TodoistTask,
  TodoistProject,
  Note,
  DriveFile,
} from "@/features/dashboard/types";
import type { DashboardSectionKey } from "@/lib/dashboardPreferences";

// ---------------------------------------------------------------------------
// Inline utilities (kept local to avoid coupling to Dashboard internals)
// ---------------------------------------------------------------------------

const decodeHtmlEntities = (content: string) => {
  if (typeof window === "undefined") return content.replace(/&nbsp;/gi, " ");
  const textarea = document.createElement("textarea");
  textarea.innerHTML = content;
  return textarea.value;
};

const toPlainText = (content: string) =>
  decodeHtmlEntities(
    content
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface WorkspaceSectionProps {
  // --- Visibility / collapse state ---
  isSectionVisible: (key: DashboardSectionKey) => boolean;
  workspaceExpanded: boolean;
  setWorkspaceExpanded: (v: boolean) => void;
  dashboardViewMode: "essential" | "detailed";
  setDashboardViewMode: (v: "essential" | "detailed") => void;

  // --- Navigation ---
  setLocation: (path: string) => void;

  // --- Section ratings ---
  sectionRatingMap: Record<string, unknown>;

  // --- Calendar ---
  hasGoogle: boolean;
  calendarLoading: boolean;
  upcomingEvents: CalendarEvent[];
  eventsByDate: {
    date: string;
    events: CalendarEvent[];
    colors: { header: string; text: string; bg: string; border: string };
  }[];
  selectedCalendarHistoryEventId: string | null;
  setSelectedCalendarHistoryEventId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedCalendarHistoryEvent: CalendarEvent | null;
  calendarLinkedNotes: (Note & { latestOccurrence?: string | null })[];
  refetchCalendar: () => void;
  openNotebookForCalendarEvent: (event: CalendarEvent) => void;
  handleCreateNoteFromCalendarEvent: (event: CalendarEvent) => void;
  createNoteFromCalendarMutationPending: boolean;
  handleEditNote: (note: Note) => void;
  formatEventTime: (event: CalendarEvent) => string;

  // --- Todoist ---
  hasTodoist: boolean;
  tasksLoading: boolean;
  todayTasks: TodoistTask[] | undefined;
  todoistFilter: string;
  setTodoistFilter: (v: string) => void;
  todoistProjects: TodoistProject[] | undefined;
  todoistLabels: string[];
  quickTodoistTaskInput: string;
  setQuickTodoistTaskInput: (v: string) => void;
  handleQuickAddTodoistTask: () => void;
  quickAddTodoistTaskPending: boolean;
  handleCompleteTask: (taskId: string) => void;
  handleCreateNoteFromTask: (task: TodoistTask) => void;
  createNoteFromTaskMutationPending: boolean;
  refetchTasks: () => void;
  refetchTodoistCompletedToday: () => void;

  // --- Email ---
  emailsLoading: boolean;
  emailsFetching: boolean;
  gmailMessages: GmailMessage[] | undefined;
  markingEmailId: string | null;
  markEmailAsReadPending: boolean;
  createTaskFromEmailPending: boolean;
  refetchEmails: () => void;
  handleMarkEmailAsRead: (messageId: string, e: React.MouseEvent) => void;
  handleAddEmailToTodoist: (message: GmailMessage, e: React.MouseEvent) => void;
  getEmailHeader: (message: GmailMessage, name: string) => string;
  formatEmailDate: (internalDate: string) => string;

  // --- Drive ---
  driveLoading: boolean;
  displayedDriveFiles: DriveFile[];
  driveSearchQuery: string;
  setDriveSearchQuery: (v: string) => void;
  driveSearchResults: DriveFile[] | null;
  isSearching: boolean;
  handleDriveSearch: () => void;
  clearDriveSearch: () => void;
  refetchDrive: () => void;
  createSpreadsheet: {
    mutate: (opts: { title: string }) => void;
    isPending: boolean;
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function WorkspaceSection(props: WorkspaceSectionProps) {
  const {
    isSectionVisible,
    workspaceExpanded,
    setWorkspaceExpanded,
    dashboardViewMode,
    setDashboardViewMode,
    setLocation,
    sectionRatingMap,

    // Calendar
    hasGoogle,
    calendarLoading,
    upcomingEvents,
    eventsByDate,
    selectedCalendarHistoryEventId,
    setSelectedCalendarHistoryEventId,
    selectedCalendarHistoryEvent,
    calendarLinkedNotes,
    refetchCalendar,
    openNotebookForCalendarEvent,
    handleCreateNoteFromCalendarEvent,
    createNoteFromCalendarMutationPending,
    handleEditNote,
    formatEventTime,

    // Todoist
    hasTodoist,
    tasksLoading,
    todayTasks,
    todoistFilter,
    setTodoistFilter,
    todoistProjects,
    todoistLabels,
    quickTodoistTaskInput,
    setQuickTodoistTaskInput,
    handleQuickAddTodoistTask,
    quickAddTodoistTaskPending,
    handleCompleteTask,
    handleCreateNoteFromTask,
    createNoteFromTaskMutationPending,
    refetchTasks,
    refetchTodoistCompletedToday,

    // Email
    emailsLoading,
    emailsFetching,
    gmailMessages,
    markingEmailId,
    markEmailAsReadPending,
    createTaskFromEmailPending,
    refetchEmails,
    handleMarkEmailAsRead,
    handleAddEmailToTodoist,
    getEmailHeader,
    formatEmailDate,

    // Drive
    driveLoading,
    displayedDriveFiles,
    driveSearchQuery,
    setDriveSearchQuery,
    driveSearchResults,
    isSearching,
    handleDriveSearch,
    clearDriveSearch,
    refetchDrive,
    createSpreadsheet,
  } = props;

  // -----------------------------------------------------------------------
  // State 3: workspace section NOT visible (e.g. non-detailed mode)
  // -----------------------------------------------------------------------
  if (!isSectionVisible("workspace")) {
    return (
      <div id="section-workspace" className="container mx-auto px-4 py-6 scroll-mt-40">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Detailed Workspace</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Switch to Detailed mode to view calendar, Todoist, Gmail, Drive, and Chat workspace sections.
            </p>
            <Button onClick={() => setDashboardViewMode("detailed")}>Switch to Detailed Mode</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // State 2: visible but collapsed
  // -----------------------------------------------------------------------
  if (!workspaceExpanded) {
    return (
      <div id="section-workspace" className="container mx-auto px-4 py-6 scroll-mt-40">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Workspace Hidden</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-3">
              Workspace data loading is paused until you expand this section.
            </p>
            <Button onClick={() => setWorkspaceExpanded(true)}>Show Workspace</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // -----------------------------------------------------------------------
  // State 1: visible + expanded — full 4-column grid
  // -----------------------------------------------------------------------
  return (
    <main id="section-workspace" className="container mx-auto px-4 py-6 flex-1 overflow-hidden scroll-mt-40">
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-full">

        {/* ============================================================= */}
        {/* Left Column — Calendar Events                                  */}
        {/* ============================================================= */}
        <Card className="lg:col-span-1 flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-emerald-600" />
              <CardTitle className="text-base">Upcoming Events</CardTitle>
            </div>
            <div className="flex items-center gap-1">
              <SectionRating sectionId="section-calendar" currentRating={sectionRatingMap["section-calendar"] as any} />
              {hasGoogle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchCalendar()}
                  disabled={calendarLoading}
                >
                  <RefreshCw className={`h-4 w-4 ${calendarLoading ? "animate-spin" : ""}`} />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2 overflow-y-auto flex-1">
            {!hasGoogle ? (
              <div className="text-center py-8 text-muted-foreground">
                <Calendar className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">Connect Google Calendar in Settings</p>
                <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2">
                  Go to Settings
                </Button>
              </div>
            ) : calendarLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-emerald-600" />
              </div>
            ) : upcomingEvents.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">No upcoming events</p>
              </div>
            ) : (
              eventsByDate.map(({ date, events, colors }) => (
                <div key={date} className="mb-2.5">
                  <div className={`${colors.header} px-2 py-0.5 rounded-t text-xs font-semibold ${colors.text} sticky top-0 z-10`}>
                    {date}
                  </div>
                  <div className="space-y-1 mt-1">
                    {events.map((event) => (
                      <div
                        key={event.id}
                        className={`p-2 ${colors.bg} rounded-md border ${colors.border} hover:opacity-95 transition-opacity ${
                          selectedCalendarHistoryEventId === String(event.id || "")
                            ? "ring-1 ring-emerald-500"
                            : ""
                        } cursor-pointer`}
                        onClick={() =>
                          setSelectedCalendarHistoryEventId((current) =>
                            current === String(event.id || "") ? null : String(event.id || "")
                          )
                        }
                      >
                        <div className="flex items-start gap-2">
                          <a
                            href={event.htmlLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 min-w-0"
                          >
                            <p className={`font-medium text-xs ${colors.text} truncate leading-4`}>{event.summary}</p>
                            <p className="text-xs text-muted-foreground">{formatEventTime(event)}</p>
                            {event.location && (
                              <p className="text-xs text-muted-foreground truncate">{event.location}</p>
                            )}
                          </a>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 shrink-0"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              setSelectedCalendarHistoryEventId((current) =>
                                current === String(event.id || "") ? null : String(event.id || "")
                              );
                            }}
                            title="Show related notes"
                          >
                            <MessageSquare className="h-3.5 w-3.5 text-emerald-700" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 shrink-0"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openNotebookForCalendarEvent(event);
                            }}
                            title="Open in notebook"
                          >
                            <FolderOpen className="h-3.5 w-3.5 text-emerald-700" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 shrink-0"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              handleCreateNoteFromCalendarEvent(event);
                            }}
                            disabled={createNoteFromCalendarMutationPending}
                            title="Create linked note"
                          >
                            <FileText className="h-3.5 w-3.5 text-emerald-700" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {selectedCalendarHistoryEvent &&
                    events.some(
                      (event) =>
                        String(event.id || "") === String(selectedCalendarHistoryEvent.id || "")
                    ) && (
                      <div className="mt-1.5 rounded-md border border-emerald-200 bg-emerald-50/70 p-2">
                        <p className="text-xs font-semibold text-emerald-900 mb-1">
                          Linked notes for this event series
                        </p>
                        {calendarLinkedNotes.length === 0 ? (
                          <p className="text-xs text-emerald-800">
                            No linked notes yet. Link an existing note from the Notes card or create one.
                          </p>
                        ) : (
                          <div className="space-y-1.5 max-h-32 overflow-y-auto pr-1">
                            {calendarLinkedNotes.slice(0, 12).map((note) => (
                              <button
                                key={note.id}
                                type="button"
                                onClick={() => handleEditNote(note)}
                                className="w-full text-left rounded border border-emerald-200 bg-card px-2 py-1.5 hover:bg-emerald-50"
                              >
                                <p className="text-xs font-semibold text-foreground truncate">
                                  {note.notebook || "General"} • {note.title}
                                </p>
                                <p className="text-xs text-muted-foreground line-clamp-1">
                                  {toPlainText(String(note.content || "")) || "No content"}
                                </p>
                                {note.latestOccurrence && (
                                  <p className="text-xs text-emerald-700 mt-0.5">
                                    Linked occurrence:{" "}
                                    {new Date(note.latestOccurrence).toLocaleString("en-US", {
                                      month: "short",
                                      day: "numeric",
                                      hour: "numeric",
                                      minute: "2-digit",
                                    })}
                                  </p>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* ============================================================= */}
        {/* Middle Column — Todoist Tasks                                   */}
        {/* ============================================================= */}
        <Card id="section-todoist" className="lg:col-span-1 flex flex-col overflow-hidden border border-[#cf3a2b] bg-[#e44332] text-white shadow-[0_18px_34px_rgba(228,67,50,0.35)] scroll-mt-40">
          <CardHeader className="space-y-3 pb-4 border-b border-white/20 bg-[#e44332] text-white">
            <div className="flex flex-row items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckSquare className="h-5 w-5 text-white" />
                <CardTitle className="text-lg text-white">
                  {todoistFilter === "all" ? "All Open Tasks" :
                   todoistFilter === "today" ? "Today's Tasks" :
                   todoistFilter === "#Inbox" ? "Inbox" :
                   todoistFilter === "upcoming" ? "Upcoming" :
                   todoistFilter.startsWith("label_") ?
                     `@${decodeURIComponent(todoistFilter.replace("label_", ""))}` :
                   todoistFilter.startsWith("project_") ?
                     todoistProjects?.find((p) => p.id === todoistFilter.replace("project_", ""))?.name || "Tasks" :
                   "Tasks"}
                </CardTitle>
              </div>
              <SectionRating sectionId="section-todoist" currentRating={sectionRatingMap["section-todoist"] as any} />
              {hasTodoist && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    refetchTasks();
                    refetchTodoistCompletedToday();
                  }}
                  disabled={tasksLoading}
                  className="text-white hover:text-white hover:bg-white/20"
                >
                  <RefreshCw className={`h-4 w-4 ${tasksLoading ? "animate-spin" : ""}`} />
                </Button>
              )}
            </div>
            {hasTodoist && (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    value={quickTodoistTaskInput}
                    onChange={(e) => setQuickTodoistTaskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleQuickAddTodoistTask();
                      }
                    }}
                    placeholder="Quick add a task..."
                    className="h-9 border-white/40 bg-card text-foreground placeholder:text-muted-foreground"
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleQuickAddTodoistTask}
                    disabled={quickAddTodoistTaskPending || !quickTodoistTaskInput.trim()}
                    className="h-9 shrink-0 bg-card text-[#c93426] hover:bg-red-50"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    Add
                  </Button>
                </div>
                <Select value={todoistFilter} onValueChange={setTodoistFilter}>
                  <SelectTrigger className="w-full border-white/40 bg-card text-slate-800">
                    <SelectValue placeholder="Select filter" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All open tasks</SelectItem>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="#Inbox">Inbox</SelectItem>
                    <SelectItem value="upcoming">Upcoming</SelectItem>
                    {todoistProjects && todoistProjects.length > 0 && (
                      <>
                        <SelectItem value="separator" disabled>── My Projects ──</SelectItem>
                        {todoistProjects.map((project) => (
                          <SelectItem key={project.id} value={`project_${project.id}`}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </>
                    )}
                    {todoistLabels.length > 0 && (
                      <>
                        <SelectItem value="separator-labels" disabled>── Labels ──</SelectItem>
                        {todoistLabels.map((label) => (
                          <SelectItem key={label} value={`label_${encodeURIComponent(label)}`}>
                            @{label}
                          </SelectItem>
                        ))}
                      </>
                    )}
                  </SelectContent>
                </Select>
              </>
            )}
          </CardHeader>
          <CardContent className="space-y-2 overflow-y-auto flex-1 pt-3 bg-[#e44332]">
            {!hasTodoist ? (
              <div className="text-center py-8 text-white/90">
                <CheckSquare className="h-12 w-12 mx-auto mb-3 text-white/70" />
                <p className="text-sm">Connect Todoist in Settings</p>
                <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2 text-white">
                  Go to Settings
                </Button>
              </div>
            ) : tasksLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-white" />
              </div>
            ) : !todayTasks || todayTasks.length === 0 ? (
              <div className="text-center py-8 text-white/90">
                <p className="text-sm">
                  {todoistFilter === "today"
                    ? "No tasks for today"
                    : todoistFilter === "all"
                      ? "No open tasks found"
                      : "No tasks for this filter"}
                </p>
              </div>
            ) : (
              todayTasks.slice(0, 50).map((task) => (
                <div
                  key={task.id}
                  className="flex items-start gap-3 p-2 rounded border border-[#f29b90] bg-[#d63a2b] hover:bg-[#c93426] transition-colors"
                >
                  <Checkbox
                    checked={false}
                    onCheckedChange={() => handleCompleteTask(task.id)}
                    className="mt-1 border-white/80 data-[state=checked]:border-white data-[state=checked]:bg-card"
                  />
                  <div className="flex-1 min-w-0">
                    <a
                      href={("url" in task ? (task as { url?: string }).url : undefined) || `https://todoist.com/app/task/${task.id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-white break-words hover:text-white/90 hover:underline"
                    >
                      {task.content.replace(/\s*\(https?:\/\/[^)]+\)\s*/g, '').trim()}
                    </a>
                    {task.description && (
                      <p className="text-xs text-red-100 mt-1 break-words">{task.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      {task.priority > 1 && (
                        <span className="text-xs px-1.5 py-0.5 bg-card text-[#c93426] rounded font-semibold">
                          P{task.priority}
                        </span>
                      )}
                      {task.due?.date && (
                        <span className="text-xs text-red-100">{task.due.date}</span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 w-7 p-0 shrink-0 text-white hover:bg-white/20 hover:text-white"
                    onClick={() => handleCreateNoteFromTask(task)}
                    disabled={createNoteFromTaskMutationPending}
                    title="Create linked note"
                  >
                    <FileText className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* ============================================================= */}
        {/* Third Column — Important & Unread Emails                       */}
        {/* ============================================================= */}
        <Card className="lg:col-span-1 flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <div className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-purple-600" />
              <CardTitle className="text-lg">Important &amp; Unread</CardTitle>
            </div>
            <div className="flex items-center gap-1">
              <SectionRating sectionId="section-emails" currentRating={sectionRatingMap["section-emails"] as any} />
              {hasGoogle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchEmails()}
                  disabled={emailsLoading || emailsFetching}
                >
                  <RefreshCw
                    className={`h-4 w-4 ${emailsLoading || emailsFetching ? "animate-spin" : ""}`}
                  />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 overflow-y-auto flex-1">
            {!hasGoogle ? (
              <div className="text-center py-8 text-muted-foreground">
                <Mail className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">Connect Gmail in Settings</p>
                <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2">
                  Go to Settings
                </Button>
              </div>
            ) : emailsLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-purple-600" />
              </div>
            ) : !gmailMessages || gmailMessages.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p className="text-sm">No recent emails</p>
              </div>
            ) : (
              gmailMessages.slice(0, 50).map((message) => (
                <div key={message.id} className="group relative">
                  <a
                    href={`https://mail.google.com/mail/u/0/#inbox/${message.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-3 bg-purple-50 rounded-lg border border-purple-100 hover:bg-purple-100 transition-colors"
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <p className="font-medium text-sm text-gray-900 truncate flex-1">
                        {getEmailHeader(message, "From")}
                      </p>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {formatEmailDate(message.internalDate)}
                      </span>
                    </div>
                    <p className="text-sm font-medium text-gray-700 truncate mb-1">
                      {getEmailHeader(message, "Subject")}
                    </p>
                    <p className="text-xs text-muted-foreground line-clamp-2">{message.snippet}</p>
                  </a>
                  <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={(e) => handleMarkEmailAsRead(message.id, e)}
                      disabled={markEmailAsReadPending}
                      title="Mark as read"
                    >
                      {markingEmailId === message.id && markEmailAsReadPending ? (
                        <Loader2 className="h-3 w-3 animate-spin text-purple-600" />
                      ) : (
                        <MailCheck className="h-3 w-3 text-purple-700" />
                      )}
                    </Button>
                    {hasTodoist && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        onClick={(e) => handleAddEmailToTodoist(message, e)}
                        disabled={createTaskFromEmailPending}
                        title="Add to Todoist"
                      >
                        <CheckSquare className="h-3 w-3 text-red-600" />
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* ============================================================= */}
        {/* Fourth Column — Google Drive Files                             */}
        {/* ============================================================= */}
        <Card className="lg:col-span-1 flex flex-col">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
            <div className="flex items-center gap-2">
              <FolderOpen className="h-5 w-5 text-green-600" />
              <CardTitle className="text-lg">Drive Files</CardTitle>
            </div>
            <div className="flex items-center gap-1">
              <SectionRating sectionId="section-drive" currentRating={sectionRatingMap["section-drive"] as any} />
              {hasGoogle && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => refetchDrive()}
                  disabled={driveLoading}
                >
                  <RefreshCw className={`h-4 w-4 ${driveLoading ? "animate-spin" : ""}`} />
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 overflow-y-auto flex-1">
            {hasGoogle && (
              <div className="flex gap-2 mb-2">
                <Input
                  type="text"
                  placeholder="Search all Drive files..."
                  value={driveSearchQuery}
                  onChange={(e) => setDriveSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleDriveSearch()}
                  className="flex-1"
                />
                <Button
                  size="sm"
                  onClick={handleDriveSearch}
                  disabled={isSearching || !driveSearchQuery.trim()}
                  className="bg-green-600 hover:bg-green-700"
                >
                  {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
                </Button>
                {driveSearchResults !== null && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={clearDriveSearch}
                  >
                    Clear
                  </Button>
                )}
              </div>
            )}
            {!hasGoogle ? (
              <div className="text-center py-8 text-muted-foreground">
                <FolderOpen className="h-12 w-12 mx-auto mb-3 text-gray-300" />
                <p className="text-sm">Connect Google Drive in Settings</p>
                <Button variant="link" onClick={() => setLocation("/settings")} className="mt-2">
                  Go to Settings
                </Button>
              </div>
            ) : (
              <>
                <Button
                  className="w-full mb-3 bg-green-600 hover:bg-green-700"
                  onClick={() => {
                    const title = `Untitled Spreadsheet ${new Date().toLocaleDateString()}`;
                    createSpreadsheet.mutate({ title });
                  }}
                  disabled={createSpreadsheet.isPending}
                >
                  {createSpreadsheet.isPending ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <FileText className="h-4 w-4 mr-2" />
                  )}
                  Create Spreadsheet
                </Button>
                {driveLoading ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-green-600" />
                  </div>
                ) : displayedDriveFiles.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <p className="text-sm">{driveSearchResults !== null ? "No files found" : "No recent files"}</p>
                  </div>
                ) : (
                  displayedDriveFiles.map((file) => (
                    <a
                      key={file.id}
                      href={file.webViewLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-3 bg-green-50 rounded-lg border border-green-100 hover:bg-green-100 transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        {file.iconLink && (
                          <img src={file.iconLink} alt="" className="w-4 h-4 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-gray-900 truncate">{file.name}</p>
                          <p className="text-xs text-muted-foreground mt-1">
                            {new Date(file.modifiedTime).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                    </a>
                  ))
                )}
              </>
            )}
          </CardContent>
        </Card>

      </div>
    </main>
  );
}
