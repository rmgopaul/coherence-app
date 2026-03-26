import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import { Clock3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";

function formatDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function GlobalClockifyTimer() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();
  const [nowMs, setNowMs] = useState(() => Date.now());

  const statusQuery = trpc.clockify.getStatus.useQuery(undefined, {
    enabled: Boolean(user),
    retry: false,
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  const isClockifyConnected = Boolean(statusQuery.data?.connected);

  const currentEntryQuery = trpc.clockify.getCurrentEntry.useQuery(undefined, {
    enabled: Boolean(user) && isClockifyConnected,
    retry: false,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
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

  const durationSeconds = useMemo(() => {
    if (!currentEntry) return 0;
    if (!currentEntry.start) return currentEntry.durationSeconds ?? 0;

    const startMs = Date.parse(currentEntry.start);
    if (!Number.isFinite(startMs)) return currentEntry.durationSeconds ?? 0;

    const endMs = currentEntry.end ? Date.parse(currentEntry.end) : nowMs;
    if (!Number.isFinite(endMs)) return currentEntry.durationSeconds ?? 0;

    return Math.max(0, Math.round((endMs - startMs) / 1000));
  }, [currentEntry, nowMs]);

  if (loading || !user || !isClockifyConnected) {
    return null;
  }

  const description = currentEntry?.description?.trim() || "No active timer";
  const projectLabel =
    currentEntry?.projectName?.trim() ||
    (currentEntry?.projectId ? `Project ${currentEntry.projectId}` : "No project selected");

  return (
    <button
      type="button"
      onClick={() => setLocation("/widget/clockify")}
      className="fixed bottom-20 right-4 z-50 flex items-center gap-2 rounded-full border bg-card/95 px-3 py-2 shadow-lg backdrop-blur-sm hover:shadow-xl transition-shadow cursor-pointer"
    >
      <Clock3 className={`h-3.5 w-3.5 shrink-0 ${isRunning ? "text-health" : "text-muted-foreground"}`} />
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Clockify
      </span>
      <span className={`text-xs font-medium ${isRunning ? "text-foreground" : "text-muted-foreground"}`}>
        {isRunning ? formatDuration(durationSeconds) : "Idle"}
      </span>
      {isRunning && (
        <span className="text-xs text-muted-foreground truncate max-w-[10rem]">
          {projectLabel}
        </span>
      )}
    </button>
  );
}
