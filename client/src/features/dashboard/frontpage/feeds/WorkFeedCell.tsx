/**
 * WorkFeedCell — today's tracked time from Clockify.
 *
 * Replaces the SolarFeedCell (SunPower reader submissions — the app
 * hasn't shipped enough data to justify a dedicated wire slot yet).
 *
 * Headline: hours tracked today. Below: current running timer (if
 * any) or the most recent activity, in mono. Falls back to a
 * "connect Clockify" empty state when the integration isn't wired.
 *
 * Uses the same `trpc.clockify.*` queries the legacy ClockifyWidget
 * consumes — read-only here, start/stop controls stay on the widget
 * page.
 */
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

const ONE_MIN = 60_000;

interface Props {
  updatedLabel: string;
}

function isToday(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

function formatHours(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0h";
  const totalMin = Math.floor(totalSeconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export function WorkFeedCell({ updatedLabel }: Props) {
  const { data: status } = trpc.clockify.getStatus.useQuery(undefined, {
    staleTime: 5 * ONE_MIN,
  });

  const connected = status?.connected ?? false;

  const { data: current } = trpc.clockify.getCurrentEntry.useQuery(
    undefined,
    { enabled: connected, refetchInterval: 30_000 }
  );
  const { data: recent } = trpc.clockify.getRecentEntries.useQuery(
    { limit: 50 },
    { enabled: connected, refetchInterval: ONE_MIN }
  );

  // Live tick so a running timer's total updates without refetching.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!current?.isRunning) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [current?.isRunning]);
  void tick;

  const { todaySeconds, topProject } = useMemo(() => {
    if (!Array.isArray(recent)) return { todaySeconds: 0, topProject: null as string | null };
    let total = 0;
    const byProject = new Map<string, number>();
    for (const entry of recent) {
      if (!isToday(entry.start)) continue;
      const secs = entry.durationSeconds ?? 0;
      total += secs;
      const key = entry.projectName ?? "(no project)";
      byProject.set(key, (byProject.get(key) ?? 0) + secs);
    }
    // Include the currently running timer's in-flight seconds.
    if (current?.isRunning && current.start) {
      const startMs = new Date(current.start).getTime();
      if (!Number.isNaN(startMs)) {
        const live = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
        total += live;
        const key = current.projectName ?? "(no project)";
        byProject.set(key, (byProject.get(key) ?? 0) + live);
      }
    }
    let top: string | null = null;
    let topSecs = 0;
    byProject.forEach((secs, name) => {
      if (secs > topSecs) {
        top = name;
        topSecs = secs;
      }
    });
    return { todaySeconds: total, topProject: top };
  }, [recent, current]);

  if (!connected) {
    return (
      <article className="wire-card" data-tone="offline">
        <header className="wire-card__head">
          <span className="mono-label">WORK · CLOCKIFY</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">not connected.</p>
          <p className="mono-label wire-card__hint">
            ADD API KEY IN SETTINGS
          </p>
        </div>
      </article>
    );
  }

  const isRunning = Boolean(current?.isRunning);
  const runningLabel =
    current?.description?.trim() || current?.projectName || "UNTITLED";

  return (
    <article className="wire-card">
      <header className="wire-card__head">
        <span className="mono-label">
          WORK · CLOCKIFY
          {isRunning ? " · LIVE" : ""}
        </span>
        <span className="mono-label wire-card__ts">
          UPDATED {updatedLabel}
        </span>
      </header>
      <div className="wire-card__body">
        <div className="wire-stat-row">
          <div className="wire-stat">
            <span className="mono-label">TODAY</span>
            <span className="fp-stat-big">{formatHours(todaySeconds)}</span>
          </div>
        </div>
        {isRunning ? (
          <p className="mono-label wire-card__hint">
            ▶ {runningLabel.slice(0, 40)}
          </p>
        ) : topProject ? (
          <p className="mono-label wire-card__hint">
            TOP · {topProject.slice(0, 28).toUpperCase()}
          </p>
        ) : (
          <p className="fp-empty">no time tracked yet.</p>
        )}
      </div>
    </article>
  );
}
