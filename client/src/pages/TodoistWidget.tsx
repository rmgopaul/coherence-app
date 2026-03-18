import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { trpc } from "@/lib/trpc";
import { CheckSquare, Loader2, Plus, RefreshCw } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useEffect, useMemo, useState } from "react";

const TODOIST_PAGE_SIZE = 20;

type ViewFilter = "today" | "all" | "upcoming" | "inbox" | string;

function getApiFilter(viewFilter: ViewFilter): string | undefined {
  if (viewFilter === "all") return undefined;
  if (viewFilter === "today") return "today";
  if (viewFilter === "upcoming") return "7 days";
  if (viewFilter === "inbox") return "#Inbox";
  if (viewFilter.startsWith("project_")) {
    const projectId = viewFilter.replace("project_", "");
    return `#${projectId}`;
  }
  return viewFilter;
}

function getViewLabel(viewFilter: ViewFilter, projects?: any[]): string {
  if (viewFilter === "today") return "Today's Tasks";
  if (viewFilter === "all") return "All Open Tasks";
  if (viewFilter === "upcoming") return "Upcoming (7 Days)";
  if (viewFilter === "inbox") return "Inbox";
  if (viewFilter.startsWith("project_") && projects) {
    const projectId = viewFilter.replace("project_", "");
    const project = projects.find((p: any) => p.id === projectId);
    return project ? project.name : "Project";
  }
  return "Tasks";
}

export default function TodoistWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const [viewFilter, setViewFilter] = useState<ViewFilter>("today");

  const apiFilter = useMemo(() => getApiFilter(viewFilter), [viewFilter]);

  const { data: tasks, isLoading, refetch, isFetching } = trpc.todoist.getTasks.useQuery(
    apiFilter ? { filter: apiFilter } : undefined,
    { enabled: !!user, retry: false }
  );
  const { data: projects } = trpc.todoist.getProjects.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newTaskContent, setNewTaskContent] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<number>(1);
  const [localTasks, setLocalTasks] = useState<any[]>([]);
  const [taskSearch, setTaskSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"priority_desc" | "priority_asc" | "due_soon" | "content_asc">("priority_desc");
  const [taskPage, setTaskPage] = useState(1);

  const completeTask = trpc.todoist.completeTask.useMutation({
    onSuccess: (_data, variables) => {
      toast.success("Task completed!");
      setLocalTasks((previous) => previous.filter((task) => task.id !== variables.taskId));
    },
    onError: (error) => {
      toast.error(`Failed to complete task: ${error.message}`);
    },
  });

  const createTask = trpc.todoist.createTask.useMutation({
    onSuccess: (createdTask) => {
      toast.success("Task created successfully!");
      setIsCreateDialogOpen(false);
      setNewTaskContent("");
      setNewTaskDescription("");
      setNewTaskPriority(1);
      setLocalTasks((previous) => [createdTask, ...previous]);
      setTaskPage(1);
    },
    onError: (error) => {
      toast.error(`Failed to create task: ${error.message}`);
    },
  });

  const handleCreateTask = () => {
    if (!newTaskContent.trim()) {
      toast.error("Task content is required");
      return;
    }
    createTask.mutate({
      content: newTaskContent,
      description: newTaskDescription || undefined,
      priority: newTaskPriority,
    });
  };

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  useEffect(() => {
    setLocalTasks(tasks || []);
  }, [tasks]);

  const projectMap = new Map(projects?.map((p) => [p.id, p]) || []);

  const priorityColors = {
    1: "text-slate-600",
    2: "text-blue-600",
    3: "text-amber-600",
    4: "text-red-600",
  };

  const filteredTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    const rows = localTasks.filter((task) => {
      if (priorityFilter !== "all" && String(task.priority) !== priorityFilter) return false;
      if (!query) return true;
      const haystack = `${task.content || ""} ${task.description || ""}`.toLowerCase();
      return haystack.includes(query);
    });

    return rows.sort((a, b) => {
      if (sortBy === "priority_asc") return (a.priority ?? 0) - (b.priority ?? 0);
      if (sortBy === "due_soon") {
        const aDue = a.due?.date ? new Date(a.due.date).getTime() : Number.POSITIVE_INFINITY;
        const bDue = b.due?.date ? new Date(b.due.date).getTime() : Number.POSITIVE_INFINITY;
        if (aDue !== bDue) return aDue - bDue;
        return String(a.content || "").localeCompare(String(b.content || ""), undefined, { sensitivity: "base" });
      }
      if (sortBy === "content_asc") {
        return String(a.content || "").localeCompare(String(b.content || ""), undefined, { sensitivity: "base" });
      }
      return (b.priority ?? 0) - (a.priority ?? 0);
    });
  }, [localTasks, priorityFilter, sortBy, taskSearch]);

  const totalTaskPages = Math.max(1, Math.ceil(filteredTasks.length / TODOIST_PAGE_SIZE));
  const currentTaskPage = Math.min(taskPage, totalTaskPages);
  const taskStartIndex = (currentTaskPage - 1) * TODOIST_PAGE_SIZE;
  const taskEndIndex = taskStartIndex + TODOIST_PAGE_SIZE;
  const visibleTasks = filteredTasks.slice(taskStartIndex, taskEndIndex);

  useEffect(() => {
    setTaskPage(1);
  }, [priorityFilter, sortBy, taskSearch, viewFilter]);

  useEffect(() => {
    if (taskPage <= totalTaskPages) return;
    setTaskPage(totalTaskPages);
  }, [taskPage, totalTaskPages]);

  if (authLoading || (isLoading && !localTasks.length)) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const viewLabel = getViewLabel(viewFilter, projects);

  return (
    <div className="min-h-screen bg-background">
      <div className="container max-w-4xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400">
              <CheckSquare className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold">{viewLabel}</h1>
              <p className="text-sm text-muted-foreground">
                {filteredTasks.length} {filteredTasks.length === 1 ? "task" : "tasks"}
                {isFetching && !isLoading ? " • refreshing..." : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-4 h-4 ${isFetching ? "animate-spin" : ""}`} />
            </Button>
            <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Task
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create New Task</DialogTitle>
                  <DialogDescription>
                    Add a new task to your Todoist inbox
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <Label htmlFor="task-content">Task Name *</Label>
                    <Input
                      id="task-content"
                      placeholder="e.g., Buy groceries"
                      value={newTaskContent}
                      onChange={(e) => setNewTaskContent(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleCreateTask();
                        }
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="task-description">Description</Label>
                    <Textarea
                      id="task-description"
                      placeholder="Add more details..."
                      value={newTaskDescription}
                      onChange={(e) => setNewTaskDescription(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="task-priority">Priority</Label>
                    <Select
                      value={newTaskPriority.toString()}
                      onValueChange={(value) => setNewTaskPriority(parseInt(value))}
                    >
                      <SelectTrigger id="task-priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="1">P4 (Low)</SelectItem>
                        <SelectItem value="2">P3 (Medium)</SelectItem>
                        <SelectItem value="3">P2 (High)</SelectItem>
                        <SelectItem value="4">P1 (Urgent)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex justify-end gap-2 pt-4">
                    <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={handleCreateTask} disabled={createTask.isPending}>
                      {createTask.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Creating...
                        </>
                      ) : (
                        "Create Task"
                      )}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* View filter + search controls */}
        <Card className="mb-4">
          <CardContent className="pt-4">
            <div className="grid gap-2 md:grid-cols-5">
              <Select value={viewFilter} onValueChange={(v) => setViewFilter(v as ViewFilter)}>
                <SelectTrigger>
                  <SelectValue placeholder="View" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="upcoming">Upcoming (7 Days)</SelectItem>
                  <SelectItem value="inbox">Inbox</SelectItem>
                  <SelectItem value="all">All Open Tasks</SelectItem>
                  {projects && projects.length > 0 && (
                    <>
                      <SelectItem value="__separator_projects" disabled>
                        ── Projects ──
                      </SelectItem>
                      {projects.map((project: any) => (
                        <SelectItem key={project.id} value={`project_${project.id}`}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </>
                  )}
                </SelectContent>
              </Select>
              <Input
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                placeholder="Search tasks..."
                className="md:col-span-2"
              />
              <Select value={priorityFilter} onValueChange={setPriorityFilter}>
                <SelectTrigger>
                  <SelectValue placeholder="Filter priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="4">P1 (Urgent)</SelectItem>
                  <SelectItem value="3">P2 (High)</SelectItem>
                  <SelectItem value="2">P3 (Medium)</SelectItem>
                  <SelectItem value="1">P4 (Low)</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                <SelectTrigger>
                  <SelectValue placeholder="Sort by" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="priority_desc">Priority (High → Low)</SelectItem>
                  <SelectItem value="priority_asc">Priority (Low → High)</SelectItem>
                  <SelectItem value="due_soon">Due Soon</SelectItem>
                  <SelectItem value="content_asc">Title A-Z</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Task list */}
        {filteredTasks.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckSquare className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold mb-2">
                {localTasks.length === 0 ? `No ${viewLabel.toLowerCase()}` : "No tasks match these filters"}
              </h3>
              <p className="text-muted-foreground">
                {localTasks.length === 0
                  ? "Nothing here yet! Create tasks in Todoist and they'll appear here."
                  : "Try clearing search/filters to view more tasks."}
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {visibleTasks.map((task) => {
              const project = projectMap.get(task.projectId);
              const priorityColor = priorityColors[task.priority as keyof typeof priorityColors] || "text-slate-600";

              return (
                <Card key={task.id} className="hover:shadow-md transition-shadow">
                  <CardHeader className="py-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={false}
                        onCheckedChange={() => completeTask.mutate({ taskId: task.id })}
                        className="mt-1"
                      />
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-base">
                          {task.content}
                        </CardTitle>
                        {task.description && (
                          <CardDescription className="mt-1">{task.description}</CardDescription>
                        )}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-sm">
                          {project && (
                            <span className="text-muted-foreground">
                              <span className="font-medium">Project:</span> {project.name}
                            </span>
                          )}
                          {task.due && (
                            <span className="text-muted-foreground">
                              <span className="font-medium">Due:</span> {task.due.string || task.due.date}
                            </span>
                          )}
                          <span className={`font-medium ${priorityColor}`}>
                            P{task.priority}
                          </span>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              );
            })}
            {totalTaskPages > 1 && (
              <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground pt-2">
                <span>
                  Showing {visibleTasks.length} of {filteredTasks.length}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTaskPage((page) => Math.max(1, page - 1))}
                    disabled={currentTaskPage <= 1}
                  >
                    Previous
                  </Button>
                  <span>
                    Page {currentTaskPage} of {totalTaskPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTaskPage((page) => Math.min(totalTaskPages, page + 1))}
                    disabled={currentTaskPage >= totalTaskPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
