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
import { ArrowLeft, CheckSquare, Loader2, Plus } from "lucide-react";
import { useLocation } from "wouter";
import { toast } from "sonner";
import { useEffect, useState } from "react";

export default function TodoistWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const { data: tasks, isLoading, refetch } = trpc.todoist.getTasks.useQuery({ filter: "#Inbox" }, {
    enabled: !!user,
    retry: false,
  });
  const { data: projects } = trpc.todoist.getProjects.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [newTaskContent, setNewTaskContent] = useState("");
  const [newTaskDescription, setNewTaskDescription] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState<number>(1);
  
  const completeTask = trpc.todoist.completeTask.useMutation({
    onSuccess: () => {
      toast.success("Task completed!");
      refetch();
    },
    onError: (error) => {
      toast.error(`Failed to complete task: ${error.message}`);
    },
  });
  
  const createTask = trpc.todoist.createTask.useMutation({
    onSuccess: () => {
      toast.success("Task created successfully!");
      setIsCreateDialogOpen(false);
      setNewTaskContent("");
      setNewTaskDescription("");
      setNewTaskPriority(1);
      refetch();
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

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const projectMap = new Map(projects?.map((p) => [p.id, p]) || []);

  const priorityColors = {
    1: "text-slate-600",
    2: "text-blue-600",
    3: "text-amber-600",
    4: "text-red-600",
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-red-100 text-red-600">
                <CheckSquare className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Todoist Inbox</h1>
                <p className="text-sm text-slate-600">Your inbox tasks (up to 50 most recent)</p>
              </div>
            </div>
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
      </header>

      <main className="container max-w-4xl mx-auto px-4 py-8">
        {!tasks || tasks.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <CheckSquare className="w-12 h-12 text-slate-400 mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-slate-900 mb-2">No inbox tasks</h3>
              <p className="text-slate-600">
                Your inbox is empty! Create tasks in Todoist and they'll appear here.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">
                {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
              </h2>
              <Button variant="outline" onClick={() => refetch()}>
                Refresh
              </Button>
            </div>

            {tasks.map((task) => {
              const project = projectMap.get(task.projectId);
              const priorityColor = priorityColors[task.priority as keyof typeof priorityColors] || "text-slate-600";

              return (
                <Card key={task.id} className="hover:shadow-md transition-shadow">
                  <CardHeader>
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={false}
                        onCheckedChange={() => completeTask.mutate({ taskId: task.id })}
                        className="mt-1"
                      />
                      <div className="flex-1">
                        <CardTitle className="text-base">
                          {task.content}
                        </CardTitle>
                        {task.description && (
                          <CardDescription className="mt-1">{task.description}</CardDescription>
                        )}
                        <div className="flex items-center gap-4 mt-2 text-sm">
                          {project && (
                            <span className="text-slate-600">
                              <span className="font-medium">Project:</span> {project.name}
                            </span>
                          )}
                          {task.due && (
                            <span className="text-slate-600">
                              <span className="font-medium">Due:</span> {task.due.string}
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
          </div>
        )}
      </main>
    </div>
  );
}
