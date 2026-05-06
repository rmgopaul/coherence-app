import { useMemo } from "react";
import type {
  CalendarEvent,
  GmailMessage,
  TodoistTask,
} from "@/features/dashboard/types";
import {
  countEventsToday,
  countFlaggedEmails,
  countOverdueP1,
  countUnreadEmails,
  formatTime,
  getEventAttendeeOrLocation,
  getEventStart,
  getEventTitle,
  getFirstEventTodayStart,
  getNextCalendarEvent,
  getTopTaskDueDate,
  oldestOverdueDays,
  selectTopTask,
} from "./briefing/selectTopTask";
import { useCountdown, type CountdownSeverity } from "./briefing/useCountdown";

export type TopTaskSourceKind = "todoist" | "gmail" | "drive";

export interface TopTaskSource {
  kind: TopTaskSourceKind;
  url: string;
}

export interface BriefingHeroRecovery {
  value: number;
  source: string;
}

export interface BriefingHeroProps {
  userName?: string | null;
  tasks: TodoistTask[];
  totalTasksToday?: number;
  calendarEvents: CalendarEvent[];
  gmailMessages: GmailMessage[];
  recovery?: BriefingHeroRecovery;
  headlineAccent?: string;
  topTaskSource?: TopTaskSource;
  onStartTopTask?: () => void;
  onOpenTopTaskSource?: () => void;
}

const COLOR_BG = "#0b0b0b";
const COLOR_INK = "#f6f2e7";
const COLOR_DIM = "#bbb7a4";
const COLOR_DECK = "#d4d0bc";
const COLOR_ACCENT = "#f6c83a";
const COLOR_BADGE = "#e23b2b";
const COLOR_CRITICAL = "#ff6b5b";
const COLOR_GREEN = "#73d96a";

export function BriefingHero({
  userName,
  tasks,
  totalTasksToday,
  calendarEvents,
  gmailMessages,
  recovery,
  headlineAccent,
  topTaskSource,
  onStartTopTask,
  onOpenTopTaskSource,
}: BriefingHeroProps) {
  const now = useMemo(() => new Date(), []);
  const topTask = useMemo(() => selectTopTask(tasks), [tasks]);
  const headlineTitle = topTask?.content ?? "";
  const dueDate = useMemo(() => getTopTaskDueDate(topTask), [topTask]);
  const { label: countdownLabel, severity } = useCountdown(dueDate);
  const dueLabel = dueDate ? formatTime(dueDate) : "no deadline";

  const fallbackEvent = useMemo(
    () => (topTask ? null : getNextCalendarEvent(calendarEvents, now)),
    [topTask, calendarEvents, now]
  );

  const nextMeeting = useMemo(
    () => getNextCalendarEvent(calendarEvents, now),
    [calendarEvents, now]
  );

  const eventsToday = countEventsToday(calendarEvents, now);
  const tasksTodayCount = tasks.length;
  const tasksTotalLabel =
    typeof totalTasksToday === "number" && totalTasksToday > tasksTodayCount
      ? `of ${totalTasksToday} today`
      : tasksTodayCount === 1
        ? "open today"
        : "open today";
  const overdueCount = countOverdueP1(tasks, now);
  const oldestOverdue = oldestOverdueDays(tasks, now);
  const flaggedEmails = countFlaggedEmails(gmailMessages);
  const unread = countUnreadEmails(gmailMessages);
  const firstEventStart = getFirstEventTodayStart(calendarEvents, now);

  const greetingName =
    userName && userName.trim().length > 0 ? userName.trim() : null;

  const sourceLabel = topTaskSource
    ? sourceCtaLabel(topTaskSource.kind)
    : null;

  return (
    <div
      className="relative overflow-hidden border-b-[3px] border-double px-7 py-6"
      style={{
        background: COLOR_BG,
        color: COLOR_INK,
        borderColor: COLOR_INK,
        colorScheme: "dark",
      }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 12% 20%, rgba(246,200,58,.14), transparent 40%), radial-gradient(circle at 92% 80%, rgba(226,59,43,.20), transparent 45%)",
        }}
      />

      <div className="relative z-10 flex flex-col gap-6 md:flex-row md:items-start">
        <div className="flex-1 min-w-0">
          <span
            className="font-archivo mb-2 -rotate-1 inline-block px-2.5 py-1 text-[10px] uppercase tracking-[0.14em]"
            style={{ background: COLOR_BADGE, color: COLOR_INK }}
          >
            ♛ {topTask ? "Today's P1" : fallbackEvent ? "Up next" : "Today"}
            {greetingName ? ` · ${greetingName}` : ""} · {formatTime(now)}
          </span>

          <h1
            className="font-archivo m-0 mb-2 max-w-[20ch] leading-[0.92] tracking-[-0.025em]"
            style={{ fontSize: "clamp(36px, 4.5vw, 54px)" }}
          >
            {topTask ? (
              <Headline title={headlineTitle} accent={headlineAccent} />
            ) : fallbackEvent ? (
              <span>{getEventTitle(fallbackEvent)}</span>
            ) : (
              <span>All clear today.</span>
            )}
          </h1>

          <p
            className="font-instrument m-0 max-w-[60ch] text-[18px] leading-[1.35]"
            style={{ color: COLOR_DECK }}
          >
            {topTask
              ? `Top priority — ${dueLabel}. Everything else is on rails.`
              : fallbackEvent
                ? buildFallbackDeck(fallbackEvent)
                : "No P1 tasks due today. Use the time."}
          </p>
        </div>

        <Countdown label={countdownLabel} severity={severity} dueLabel={dueLabel} />
      </div>

      <div className="relative z-10 mt-6 grid grid-cols-2 border-t border-white/20 sm:grid-cols-3 md:grid-cols-6">
        <Cell
          value={pad2(overdueCount)}
          tone={overdueCount > 0 ? "red" : "ink"}
          label="P1 · Overdue"
          sub={
            overdueCount > 0 && oldestOverdue !== null
              ? `oldest ${oldestOverdue}d`
              : "none"
          }
        />
        <Cell
          value={nextMeeting ? formatNextMeetingValue(nextMeeting) : "—"}
          label="Next meeting"
          sub={
            nextMeeting
              ? (getEventAttendeeOrLocation(nextMeeting) ??
                getEventTitle(nextMeeting))
              : "nothing scheduled"
          }
        />
        <Cell
          value={pad2(flaggedEmails)}
          tone={flaggedEmails > 0 ? "yellow" : "ink"}
          label="Flagged email"
          sub={`${unread} unread`}
        />
        <Cell
          value={pad2(eventsToday)}
          label="Events today"
          sub={firstEventStart ? `first ${formatTime(firstEventStart)}` : "—"}
        />
        <Cell
          value={pad2(tasksTodayCount)}
          label="Tasks today"
          sub={tasksTotalLabel}
        />
        {recovery ? (
          <Cell
            value={`${Math.round(recovery.value)}%`}
            tone={recoveryTone(recovery.value)}
            label="Recovery"
            sub={recovery.source}
          />
        ) : null}
      </div>

      <div className="relative z-10 mt-3.5 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onStartTopTask}
          disabled={!topTask}
          className="font-archivo px-3.5 py-2 text-[11px] uppercase tracking-[0.1em] transition disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            background: COLOR_ACCENT,
            color: COLOR_BG,
            border: `2px solid ${COLOR_ACCENT}`,
          }}
        >
          ► Start now
        </button>
        {sourceLabel && topTaskSource ? (
          <button
            type="button"
            onClick={onOpenTopTaskSource}
            className="font-archivo px-3.5 py-2 text-[11px] uppercase tracking-[0.1em]"
            style={{
              background: "transparent",
              color: COLOR_INK,
              border: "2px solid rgba(255,255,255,0.3)",
            }}
          >
            {sourceLabel} ↗
          </button>
        ) : null}
      </div>

      <style>{briefingPulseKeyframes}</style>
    </div>
  );
}

function Headline({ title, accent }: { title: string; accent?: string }) {
  if (accent && title.startsWith(accent) && accent.length < title.length) {
    const tail = title.slice(accent.length);
    return (
      <>
        <span
          style={{
            background:
              "linear-gradient(transparent 60%, rgba(246,200,58,0.85) 60% 92%, transparent 92%)",
            padding: "0 4px",
          }}
        >
          {accent}
        </span>
        {tail}
      </>
    );
  }
  return <>{title || "Focus"}</>;
}

function Countdown({
  label,
  severity,
  dueLabel,
}: {
  label: string;
  severity: CountdownSeverity;
  dueLabel: string;
}) {
  const color = severityColor(severity);
  const pulse = severity === "critical" ? "briefing-pulse 1.6s ease-in-out infinite" : undefined;
  return (
    <div
      className="font-archivo flex-none text-left leading-[0.9] tracking-[-0.03em] md:text-right"
      style={{ fontSize: 72, color, animation: pulse }}
    >
      {label}
      <div
        className="font-jetbrains mt-1.5 block text-[10px] font-normal tracking-[0.14em]"
        style={{ color: COLOR_DIM }}
      >
        TIME LEFT · DUE {dueLabel.toUpperCase()}
      </div>
    </div>
  );
}

function Cell({
  value,
  label,
  sub,
  tone,
}: {
  value: string;
  label: string;
  sub: string;
  tone?: "red" | "yellow" | "green" | "ink";
}) {
  const color = toneColor(tone);
  return (
    <div className="border-r border-white/20 px-4 py-3.5 last:border-r-0">
      <div
        className="font-archivo leading-none tracking-[-0.02em]"
        style={{ fontSize: 24, color }}
      >
        {value}
      </div>
      <div
        className="font-jetbrains mt-1.5 text-[9.5px] uppercase tracking-[0.12em]"
        style={{ color: COLOR_DIM }}
      >
        {label}
      </div>
      <div
        className="mt-0.5 truncate text-[11px]"
        style={{ color: "#dddddd" }}
      >
        {sub}
      </div>
    </div>
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function severityColor(severity: CountdownSeverity): string {
  switch (severity) {
    case "critical":
      return COLOR_CRITICAL;
    case "warn":
      return COLOR_ACCENT;
    case "calm":
    case "none":
    default:
      return COLOR_INK;
  }
}

function toneColor(tone?: "red" | "yellow" | "green" | "ink"): string {
  switch (tone) {
    case "red":
      return COLOR_CRITICAL;
    case "yellow":
      return COLOR_ACCENT;
    case "green":
      return COLOR_GREEN;
    case "ink":
    default:
      return COLOR_INK;
  }
}

function recoveryTone(value: number): "red" | "yellow" | "green" {
  if (value >= 67) return "green";
  if (value >= 34) return "yellow";
  return "red";
}

function sourceCtaLabel(kind: TopTaskSourceKind): string {
  switch (kind) {
    case "todoist":
      return "Open in Todoist";
    case "gmail":
      return "Open thread";
    case "drive":
      return "Open doc";
  }
}

function formatNextMeetingValue(event: CalendarEvent): string {
  const start = getEventStart(event);
  return start ? formatTime(start) : "—";
}

function buildFallbackDeck(event: CalendarEvent): string {
  const start = getEventStart(event);
  if (!start) return "Use the time.";
  return `Until ${formatTime(start)} — make it count.`;
}

const briefingPulseKeyframes = `
@keyframes briefing-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}
`;
