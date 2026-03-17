import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { trpc } from "@/lib/trpc";
import { ArrowLeft, Clock3, ExternalLink, Loader2, Play, Square } from "lucide-react";
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
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-slate-600" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 py-4">
          <Button variant="ghost" onClick={() => setLocation("/dashboard")} className="mb-2">
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-100 text-blue-700">
                <Clock3 className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-slate-900">Clockify Tracker</h1>
                <p className="text-sm text-slate-600">Start, stop, and review your latest time entries</p>
              </div>
            </div>
            <Button variant="outline" onClick={handleRefresh}>
              Refresh
            </Button>
          </div>
        </div>
      </header>

      <main className="container max-w-4xl mx-auto px-4 py-8 space-y-6">
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
                    : "No active timer. Start one with a task description."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-md border border-slate-200 bg-white p-4">
                  <p className="text-sm font-medium text-slate-900">
                    {currentEntry?.description?.trim() || (isRunning ? "Untitled task" : "No running timer")}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Start: {formatTimestamp(currentEntry?.start ?? null)}
                  </p>
                  <p className="text-xs text-slate-500">
                    End: {isRunning ? "Running" : formatTimestamp(currentEntry?.end ?? null)}
                  </p>
                  <p className="mt-2 text-sm font-semibold text-slate-900">
                    Duration: {formatDuration(isRunning ? liveDurationSeconds : currentEntry?.durationSeconds)}
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
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
                  <div className="flex items-center gap-2 text-sm text-slate-600">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading entries...
                  </div>
                ) : recentEntriesQuery.data && recentEntriesQuery.data.length > 0 ? (
                  <div className="space-y-2">
                    {recentEntriesQuery.data.map((entry) => (
                      <div
                        key={entry.id}
                        className="rounded-md border border-slate-200 bg-white px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-slate-900">
                            {entry.description?.trim() || "Untitled task"}
                          </p>
                          <p className="text-xs font-medium text-slate-700">
                            {formatDuration(entry.durationSeconds)}
                          </p>
                        </div>
                        <p className="text-xs text-slate-500">
                          {formatTimestamp(entry.start)} to {entry.isRunning ? "Running" : formatTimestamp(entry.end)}
                        </p>
                        {entry.projectName ? (
                          <p className="text-xs text-slate-500">Project: {entry.projectName}</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">No time entries found yet.</p>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
