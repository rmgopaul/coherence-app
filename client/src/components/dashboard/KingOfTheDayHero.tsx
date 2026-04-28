import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CalendarEvent, TodoistTask } from "@/features/dashboard/types";
import type { DailyBrief } from "@/lib/dailyBrief";
import { resolveKingHeadlineHref } from "@/lib/kingHeadlineLink";
import "./king-of-the-day.css";

/* ------------------------------------------------------------------ */
/*  Types — mirror the shapes returned by existing tRPC endpoints      */
/* ------------------------------------------------------------------ */

interface MarketQuote {
  symbol: string;
  shortName: string;
  price: number;
  change: number;
  changePercent: number;
}

interface WhoopSummary {
  recoveryScore: number | null;
  dayStrain: number | null;
  sleepHours: number | null;
  hrvRmssdMilli: number | null;
  restingHeartRate: number | null;
}

export interface KingOfDayServerRow {
  source: "auto" | "manual" | "ai";
  title: string;
  reason: string | null;
  taskId: string | null;
  eventId: string | null;
  pinnedAt: Date | string | null;
}

export interface KingOfTheDayHeroProps {
  userName?: string | null;
  todayTasks: TodoistTask[];
  completedCount: number;
  whoopSummary: WhoopSummary | null | undefined;
  marketQuotes: MarketQuote[];
  dailyBrief: DailyBrief | null;
  calendarEvents: CalendarEvent[];
  unreadGmailCount: number;
  /**
   * Server-picked headline from `trpc.kingOfDay.get` (Phase C).
   * When present, overrides the client-side derivation; the fallback
   * lives in `deriveHeadline` for loading/error states.
   */
  kingOfDay?: KingOfDayServerRow | null;
  /**
   * Fires when the user taps the × on a manual pin. Wire to
   * `trpc.kingOfDay.unpin` at the call site.
   */
  onUnpin?: () => void;
  /**
   * Fires when the user right-clicks the headline or hits `k`.
   * Call site opens the pin dialog.
   */
  onRequestPin?: () => void;
  /**
   * Fires when the user clicks the REGENERATE affordance. Only shown
   * for auto/ai picks — manual pins use the × on the PINNED badge
   * instead. Call site should unpin + refetch to re-run the selector.
   */
  onRegenerate?: () => void;
  /**
   * When true, the REGENERATE button is disabled (mutation in flight).
   */
  regenerating?: boolean;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Crown — three-spike Basquiat scribble                              */
/* ------------------------------------------------------------------ */

function Crown({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 140"
      className={cn("kotd-crown", className)}
      aria-hidden="true"
    >
      {/* outer scribble pass */}
      <path d="M14 122 L46 24 L86 96 L120 12 L154 96 L196 24 L226 122" />
      {/* inner wobble — the second pass makes it feel hand-drawn */}
      <path
        d="M18 118 L48 30 L88 92 L122 18 L156 92 L194 30 L224 118"
        style={{ opacity: 0.8, strokeWidth: 5 }}
      />
      {/* baseline */}
      <path d="M10 128 L230 128" style={{ strokeWidth: 6 }} />
      {/* jewel dots */}
      <circle cx="46" cy="22" r="5" fill="oklch(0.92 0.18 95)" stroke="none" />
      <circle cx="120" cy="10" r="6" fill="oklch(0.92 0.18 95)" stroke="none" />
      <circle cx="196" cy="22" r="5" fill="oklch(0.92 0.18 95)" stroke="none" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Headline derivation — what is the ONE thing today?                 */
/*  Repo's DailyBrief uses `outcomes[]` with `title`/`why`.            */
/* ------------------------------------------------------------------ */

function deriveHeadline(
  dailyBrief: DailyBrief | null,
  todayTasks: TodoistTask[]
): { headline: string; annotation: string } {
  // 1. If the Daily Brief produced an explicit outcome, use it.
  const topOutcome = dailyBrief?.outcomes?.[0];
  if (topOutcome?.title) {
    return {
      headline: topOutcome.title,
      annotation: topOutcome.why ?? "TODAY'S FOCUS",
    };
  }

  // 2. Otherwise, first overdue Todoist task wins.
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = todayTasks.find((task) => {
    const due = task.due?.date ? new Date(task.due.date) : null;
    return due && due < today;
  });
  if (overdue?.content) {
    return { headline: overdue.content, annotation: "OVERDUE — SHIP IT" };
  }

  // 3. Fallback: first task due today.
  if (todayTasks[0]?.content) {
    return { headline: todayTasks[0].content, annotation: "FIRST UP" };
  }

  // 4. Empty state.
  return { headline: "A clean slate", annotation: "NOTHING DUE" };
}

/* ------------------------------------------------------------------ */
/*  Time helpers                                                        */
/* ------------------------------------------------------------------ */

function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function hoursLeftInDay(now: Date): { h: number; m: number } {
  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);
  const ms = endOfDay.getTime() - now.getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return { h, m };
}

function greetingForHour(hour: number): string {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function formatDate(now: Date): string {
  return now
    .toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    })
    .toUpperCase();
}

/* ------------------------------------------------------------------ */
/*  Stat tile                                                           */
/* ------------------------------------------------------------------ */

function StatTile({
  label,
  value,
  delta,
  emphasize = false,
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  emphasize?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 border-l-2 border-white/10 px-4 py-1 first:border-l-0 first:pl-0",
        emphasize && "first:pl-0"
      )}
    >
      <div className="kotd-stat-label">{label}</div>
      <div
        className={cn(
          "kotd-stat-value",
          emphasize ? "text-[oklch(0.92_0.18_95)]" : "text-[#f5f2ea]"
        )}
      >
        {value}
      </div>
      {delta !== undefined && delta !== null && (
        <div className="kotd-stat-delta text-white/70">{delta}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main component                                                      */
/* ------------------------------------------------------------------ */

export function KingOfTheDayHero({
  userName,
  todayTasks,
  completedCount,
  whoopSummary,
  marketQuotes,
  dailyBrief,
  calendarEvents,
  unreadGmailCount,
  kingOfDay,
  onUnpin,
  onRequestPin,
  onRegenerate,
  regenerating = false,
  className,
}: KingOfTheDayHeroProps) {
  const now = useNow(60_000);
  // Phase C: prefer the server-picked headline when present. Falls
  // through to the existing client-side derivation on loading/error
  // so the hero is never blank.
  const { headline, annotation } = useMemo(() => {
    if (kingOfDay?.title) {
      return {
        headline: kingOfDay.title,
        annotation: kingOfDay.reason ?? "TODAY'S FOCUS",
      };
    }
    return deriveHeadline(dailyBrief, todayTasks);
  }, [kingOfDay, dailyBrief, todayTasks]);
  const isPinned = kingOfDay?.source === "manual";
  const source = kingOfDay?.source ?? null;

  // Task 10.4 (2026-04-28): when the king resolves to a Todoist task
  // or a Calendar event in the dashboard's lookahead window, the
  // headline becomes a deep link. Pure helper keeps the resolution
  // logic out of the React render path; falls back to plain text
  // when no URL is available so the hero never renders a broken
  // link.
  const headlineHref = useMemo(
    () => resolveKingHeadlineHref(kingOfDay, calendarEvents),
    [kingOfDay, calendarEvents]
  );
  // Regenerate only makes sense for picks the selector produced
  // (auto = rules, ai = LLM). A manual pin already has the × on the
  // PINNED badge for the same "clear it" effect.
  const showRegenerate = Boolean(
    onRegenerate && (source === "auto" || source === "ai")
  );

  // Long-press to pin — touch equivalent of right-click. Starts a
  // 500ms timer on touchstart; cancels on move/end/cancel. If the
  // timer fires, we open the pin dialog via onRequestPin.
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);
  const handleTouchStart = useCallback(() => {
    if (!onRequestPin) return;
    longPressFired.current = false;
    cancelLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      longPressTimer.current = null;
      onRequestPin();
    }, 500);
  }, [onRequestPin, cancelLongPress]);
  useEffect(() => cancelLongPress, [cancelLongPress]);
  const { h: hoursLeft, m: minutesLeft } = hoursLeftInDay(now);
  const greeting = greetingForHour(now.getHours());

  // Top market mover — absolute percent
  const topMover = useMemo(() => {
    const sorted = [...marketQuotes].sort(
      (a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent)
    );
    return sorted[0] ?? null;
  }, [marketQuotes]);

  // Next calendar event (not yet started or in progress)
  const nextEvent = useMemo(() => {
    const nowMs = now.getTime();
    const upcoming = [...calendarEvents]
      .filter((event) => {
        const startStr = event.start?.dateTime ?? event.start?.date ?? null;
        if (!startStr) return false;
        const startMs = new Date(startStr).getTime();
        return !Number.isNaN(startMs) && startMs >= nowMs - 60 * 60 * 1000;
      })
      .sort((a, b) => {
        const aStart = new Date(a.start?.dateTime ?? a.start?.date ?? 0).getTime();
        const bStart = new Date(b.start?.dateTime ?? b.start?.date ?? 0).getTime();
        return aStart - bStart;
      });
    return upcoming[0] ?? null;
  }, [calendarEvents, now]);

  const nextEventStart = nextEvent?.start?.dateTime ?? nextEvent?.start?.date ?? null;
  const minsUntilNextEvent = nextEventStart
    ? Math.max(0, Math.round((new Date(nextEventStart).getTime() - now.getTime()) / 60_000))
    : null;

  const openTaskCount = todayTasks.length;
  const firstName = (userName ?? "").trim().split(/\s+/)[0] || "";
  const recoveryPct = whoopSummary?.recoveryScore;
  const recoveryBucket =
    recoveryPct == null
      ? "—"
      : recoveryPct >= 67
      ? "GREEN"
      : recoveryPct >= 34
      ? "YELLOW"
      : "RED";

  const secondOutcomeTitle = dailyBrief?.outcomes?.[1]?.title;

  return (
    <section
      className={cn("kotd-hero px-6 py-8 sm:px-10 sm:py-12", className)}
      aria-label="Today's focus"
    >
      {/* Top rail: date + greeting + crown */}
      <header className="flex items-start justify-between gap-6 border-b border-white/10 pb-6">
        <div>
          <div className="kotd-stat-label">{formatDate(now)}</div>
          {firstName && (
            <div className="kotd-scribble mt-1 text-[1.4rem] leading-none text-[oklch(0.92_0.18_95)]">
              {greeting}, {firstName.toLowerCase()} —
            </div>
          )}
        </div>
        <Crown className="h-20 w-36 shrink-0 sm:h-28 sm:w-48" />
      </header>

      {/* Headline — the one thing */}
      <div className="mt-8">
        <div className="flex items-center gap-3">
          <div className="kotd-scribble text-[1.2rem] leading-none text-[oklch(0.92_0.18_95)]">
            {annotation}
          </div>
          {isPinned && (
            <span
              className="kotd-pinned-badge"
              role="status"
              aria-label="Manually pinned — click the × to unpin"
            >
              PINNED
              <button
                type="button"
                className="kotd-pinned-badge__close"
                onClick={onUnpin}
                aria-label="Unpin today's headline"
                title="Unpin"
              >
                ×
              </button>
            </span>
          )}
          {showRegenerate && (
            <span className="flex items-center">
              {source === "ai" && (
                <span className="kotd-regenerate__src">AI PICK</span>
              )}
              <button
                type="button"
                className="kotd-regenerate"
                onClick={onRegenerate}
                disabled={regenerating}
                aria-label="Regenerate today's headline"
                title="Re-run the selector"
              >
                {regenerating ? "REGENERATING…" : "↻ REGENERATE"}
              </button>
            </span>
          )}
        </div>
        <h1
          className="kotd-display kotd-headline mt-3 text-[clamp(2.5rem,7.5vw,6.25rem)]"
          title={
            onRequestPin
              ? `${headline} — right-click or press K to pin a different headline`
              : headline
          }
          // a11y: announce the headline when it changes (e.g., after
          // a regenerate or pin). `polite` so we don't interrupt, and
          // `atomic` so the whole headline is read as one chunk.
          aria-live="polite"
          aria-atomic="true"
          onContextMenu={
            onRequestPin
              ? (e) => {
                  e.preventDefault();
                  onRequestPin();
                }
              : undefined
          }
          // Touch long-press = pin dialog (matches the right-click
          // affordance on desktop). Tapping briefly does nothing —
          // we explicitly cancel the timer on touchend/move/cancel.
          onTouchStart={onRequestPin ? handleTouchStart : undefined}
          onTouchEnd={onRequestPin ? cancelLongPress : undefined}
          onTouchMove={onRequestPin ? cancelLongPress : undefined}
          onTouchCancel={onRequestPin ? cancelLongPress : undefined}
          style={{
            // iOS Safari shows a grey highlight on touch; suppress
            // it so the long-press feels intentional rather than
            // accidental. Also disable the default text-selection
            // callout which competes with our long-press gesture.
            WebkitTapHighlightColor: "transparent",
            WebkitTouchCallout: "none",
            WebkitUserSelect: "none",
            userSelect: "none",
          }}
        >
          {headlineHref ? (
            <a
              href={headlineHref}
              target="_blank"
              rel="noopener noreferrer"
              // Task 10.4: deep link to the source (Todoist task /
              // Calendar event). Stop click-bubbling so the
              // surrounding h1's right-click-to-pin and long-press-
              // to-pin gestures are preserved — a tap opens the
              // source, but right-click + long-press still pin a
              // different headline.
              onClick={(e) => e.stopPropagation()}
              className="kotd-highlight text-black no-underline hover:underline"
            >
              {headline}
            </a>
          ) : (
            <span className="kotd-highlight text-black">{headline}</span>
          )}
        </h1>
        {secondOutcomeTitle && (
          <p className="kotd-display mt-4 text-[clamp(1.25rem,2.2vw,2rem)] text-white/45">
            then{" "}
            <span className="kotd-strike text-white/60">
              {secondOutcomeTitle}
            </span>
          </p>
        )}
      </div>

      {/* Four giant stats */}
      <div className="mt-10 grid grid-cols-2 gap-y-6 sm:grid-cols-4 sm:gap-x-2">
        <StatTile
          emphasize
          label="Time left"
          value={
            hoursLeft > 0
              ? `${hoursLeft}h ${minutesLeft.toString().padStart(2, "0")}m`
              : `${minutesLeft}m`
          }
          delta="to midnight"
        />
        <StatTile
          label="Tasks"
          value={`${completedCount}/${completedCount + openTaskCount}`}
          delta={openTaskCount === 0 ? "inbox zero" : `${openTaskCount} open`}
        />
        <StatTile
          label="Recovery"
          value={recoveryPct == null ? "—" : `${Math.round(recoveryPct)}`}
          delta={
            recoveryPct == null ? (
              <span className="opacity-50">whoop offline</span>
            ) : (
              <span
                className={cn(
                  recoveryBucket === "GREEN" && "text-[oklch(0.75_0.18_145)]",
                  recoveryBucket === "YELLOW" && "text-[oklch(0.85_0.18_95)]",
                  recoveryBucket === "RED" && "text-[oklch(0.68_0.22_27)]"
                )}
              >
                {recoveryBucket}
                {whoopSummary?.sleepHours != null
                  ? ` · ${whoopSummary.sleepHours}h sleep`
                  : ""}
              </span>
            )
          }
        />
        <StatTile
          label="Top mover"
          value={
            topMover ? (
              <span className="block truncate">
                {topMover.symbol.replace("-USD", "")}
              </span>
            ) : (
              "—"
            )
          }
          delta={
            topMover ? (
              <span
                className={cn(
                  "flex flex-wrap items-baseline gap-x-2",
                  topMover.changePercent >= 0
                    ? "text-[oklch(0.75_0.18_145)]"
                    : "text-[oklch(0.68_0.22_27)]"
                )}
              >
                <span>
                  {topMover.changePercent >= 0 ? "▲" : "▼"}{" "}
                  {Math.abs(topMover.changePercent).toFixed(2)}%
                </span>
                <span className="text-white/50">
                  $
                  {topMover.price >= 100
                    ? topMover.price.toFixed(0)
                    : topMover.price.toFixed(2)}
                </span>
              </span>
            ) : null
          }
        />
      </div>

      {/* Action rail */}
      <div className="mt-10 flex flex-wrap gap-2 border-t border-white/10 pt-6">
        {nextEvent && (
          <Button
            variant="secondary"
            className="rounded-none bg-[#f5f2ea] text-black hover:bg-white"
            onClick={() => {
              if (nextEvent.htmlLink) {
                window.open(nextEvent.htmlLink, "_blank", "noopener,noreferrer");
              }
            }}
          >
            <span className="kotd-stat-label mr-2 !text-[0.65rem] !text-black/60">
              NEXT UP
            </span>
            {nextEvent.summary ?? "(untitled)"}
            {minsUntilNextEvent !== null && minsUntilNextEvent > 0 && (
              <span className="ml-2 text-black/55">· in {minsUntilNextEvent}m</span>
            )}
          </Button>
        )}
        {unreadGmailCount > 0 && (
          <Button
            variant="outline"
            className="rounded-none border-white/25 bg-transparent text-[#f5f2ea] hover:bg-white/10 hover:text-[#f5f2ea]"
          >
            <span className="kotd-stat-label mr-2 !text-[0.65rem]">INBOX</span>
            {unreadGmailCount} unread
          </Button>
        )}
        {openTaskCount > 0 && (
          <Button
            variant="outline"
            className="rounded-none border-white/25 bg-transparent text-[#f5f2ea] hover:bg-white/10 hover:text-[#f5f2ea]"
          >
            <span className="kotd-stat-label mr-2 !text-[0.65rem]">TASKS</span>
            {openTaskCount} open today
          </Button>
        )}
      </div>
    </section>
  );
}

export default KingOfTheDayHero;
