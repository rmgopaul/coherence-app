import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { ExternalLink, Loader2, Play, Square } from "lucide-react";
import { WidgetPageSkeleton } from "@/components/WidgetPageSkeleton";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { toast } from "sonner";

function formatDuration(totalSeconds: number | null | undefined): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds ?? 0));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ClockifyWidget() {
  const { user, loading: authLoading } = useAuth();
  const [, setLocation] = useLocation();
  const utils = trpc.useUtils();

  const [description, setDescription] = useState("");
  const [projectIdInput, setProjectIdInput] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!authLoading && !user) {
      setLocation("/");
    }
  }, [authLoading, user, setLocation]);

  const statusQuery = trpc.clockify.getStatus.useQuery(undefined, {
    enabled: !!user,
    retry: false,
  });

  const isConnected = Boolean(statusQuery.data?.connected);

  const currentEntryQuery = trpc.clockify.getCurrentEntry.useQuery(undefined, {
    enabled: !!user && isConnected,
    retry: false,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const recentEntriesQuery = trpc.clockify.getRecentEntries.useQuery(
    { limit: 20 },
    {
      enabled: !!user && isConnected,
      retry: false,
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
    }
  );

  const startTimer = trpc.clockify.startTimer.useMutation({
    onSuccess: async () => {
      toast.success("Clockify timer started");
      setDescription("");
      setProjectIdInput("");
      await Promise.all([
        utils.clockify.getCurrentEntry.invalidate(),
        utils.clockify.getRecentEntries.invalidate(),
      ]);
    },
    onError: (error) => {
      toast.error(`Failed to start timer: ${error.message}`);
    },
  });

  const stopTimer = trpc.clockify.stopTimer.useMutation({
    onSuccess: async (result) => {
      toast.success(result.stopped ? "Clockify timer stopped" : "No running timer found");
      await Promise.all([
        utils.clockify.getCurrentEntry.invalidate(),
        utils.clockify.getRecentEntries.invalidate(),
      ]);
    },
    onError: (error) => {
      toast.error(`Failed to stop timer: ${error.message}`);
    },
  });

  const currentEntry = currentEntryQuery.data;
  const isRunning = Boolean(currentEntry?.isRunning);
  const currentProjectLabel =
    currentEntry?.projectName?.trim() ||
    (currentEntry?.projectId ? `Project ${currentEntry.projectId}` : "No project selected");

  useEffect(() => {
    if (!isRunning) return;
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isRunning]);

  const liveDurationSeconds = useMemo(() => {
    if (!currentEntry) return 0;
    if (!currentEntry.start) return currentEntry.durationSeconds ?? 0;

    const startMs = Date.parse(currentEntry.start);
    if (!Number.isFinite(startMs)) return currentEntry.durationSeconds ?? 0;

    const endMs = currentEntry.end ? Date.parse(currentEntry.end) : nowMs;
    if (!Number.isFinite(endMs)) return currentEntry.durationSeconds ?? 0;

    return Math.max(0, Math.round((endMs - startMs) / 1000));
  }, [currentEntry, nowMs]);

  const handleStartTimer = () => {
    const trimmedDescription = description.trim();
    if (!trimmedDescription) {
      toast.error("Please enter what you are working on");
      return;
    }

    startTimer.mutate({
      description: trimmedDescription,
      projectId: projectIdInput.trim() || undefined,
    });
  };

  const handleStopTimer = () => {
    stopTimer.mutate();
  };

  const handleRefresh = async () => {
    await statusQuery.refetch();
    if (isConnected) {
      await Promise.all([currentEntryQuery.refetch(), recentEntriesQuery.refetch()]);
    }
  };

  if (authLoading || statusQuery.isLoading) {
    return <WidgetPageSkeleton variant="timer" />;
  }

  if (!user) {
    return null;
  }

  return (
    <main className="container max-w-4xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-end">
        <Button variant="outline" onClick={handleRefresh}>
          Refresh
        </Button>
      </div>

      {!isConnected ? (
        <Card>
          <CardHeader>
            <CardTitle>Clockify is not connected</CardTitle>
            <CardDescription>
              Connect Clockify in Settings before using the timer.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Button onClick={() => setLocation("/settings")}>Open Settings</Button>
            <Button variant="outline" asChild>
              <a href="https://app.clockify.me/tracker" target="_blank" rel="noopener noreferrer">
                Open Clockify
                <ExternalLink className="w-4 h-4 ml-2" />
              </a>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Current Timer</CardTitle>
              <CardDescription>
                {isRunning
                  ? "A timer is currently running"
                  : "No active timer. Start one with a task description and optional project."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="rounded-md border bg-card p-4">
                <p className="text-sm font-medium text-foreground">
                  {currentEntry?.description?.trim() || (isRunning ? "Untitled task" : "No running timer")}
                </p>
                <p className="mt-1 text-xs font-semibold text-primary">
                  Project: {currentProjectLabel}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Start: {formatTimestamp(currentEntry?.start ?? null)}
                </p>
                <p className="text-xs text-muted-foreground">
                  End: {isRunning ? "Running" : formatTimestamp(currentEntry?.end ?? null)}
                </p>
                <p className="mt-2 text-sm font-semibold text-foreground">
                  Duration: {formatDuration(isRunning ? liveDurationSeconds : currentEntry?.durationSeconds)}
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
                <div className="space-y-2">
                  <Label htmlFor="clockify-description">Task Description</Label>
                  <Input
                    id="clockify-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Example: Invoice reconciliation"
                    disabled={isRunning}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="clockify-project-id">Project ID (optional)</Label>
                  <Input
                    id="clockify-project-id"
                    value={projectIdInput}
                    onChange={(event) => setProjectIdInput(event.target.value)}
                    placeholder="Example: 6748b91fef191e6f..."
                    disabled={isRunning}
                  />
                </div>
                <Button
                  onClick={handleStartTimer}
                  disabled={isRunning || startTimer.isPending}
                  className="w-full md:w-auto"
                >
                  {startTimer.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Starting...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 mr-2" />
                      Start Timer
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleStopTimer}
                  disabled={!isRunning || stopTimer.isPending}
                  className="w-full md:w-auto"
                >
                  {stopTimer.isPending ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Stopping...
                    </>
                  ) : (
                    <>
                      <Square className="w-4 h-4 mr-2" />
                      Stop Timer
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent Time Entries</CardTitle>
              <CardDescription>Last 20 entries from your selected Clockify workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              {recentEntriesQuery.isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading entries...
                </div>
              ) : recentEntriesQuery.data && recentEntriesQuery.data.length > 0 ? (
                <div className="space-y-2">
                  {recentEntriesQuery.data.map((entry) => (
                    <div
                      key={entry.id}
                      className="rounded-md border bg-card px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-foreground">
                          {entry.description?.trim() || "Untitled task"}
                        </p>
                        <p className="text-xs font-medium text-muted-foreground">
                          {formatDuration(entry.durationSeconds)}
                        </p>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {formatTimestamp(entry.start)} to {entry.isRunning ? "Running" : formatTimestamp(entry.end)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Project: {entry.projectName || (entry.projectId ? `Project ${entry.projectId}` : "No project selected")}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No time entries found yet.</p>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}
