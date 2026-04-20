/**
 * FrontPageDashboard — new broadsheet layout.
 *
 * Masthead · Hero · Newsprint columns · Wire feeds grid.
 * Focus mode unmounts newsprint + wire grid (so their queries skip via
 * React reconciliation, not `display:none`) and shows FocusModeRail
 * instead.
 *
 * Spec: handoff/web-spec.md
 */
import { useEffect, useState } from "react";
import { KingOfTheDayHero } from "@/components/dashboard/KingOfTheDayHero";
import { Masthead } from "./frontpage/Masthead";
import { DropDock } from "./frontpage/DropDock";
import { NewsprintColumns } from "./frontpage/NewsprintColumns";
import { InboxPanel } from "./frontpage/InboxPanel";
import { WireFeedsGrid } from "./frontpage/WireFeedsGrid";
import { FocusModeRail } from "./frontpage/FocusModeRail";
import { PinDialog } from "./frontpage/PinDialog";
import { useDashboardData } from "./useDashboardData";
import { useFocusMode } from "@/contexts/FocusModeContext";
import { trpc } from "@/lib/trpc";
import "./frontpage/dashboard.css";

export default function FrontPageDashboard() {
  const data = useDashboardData();
  const { focusMode } = useFocusMode();
  const utils = trpc.useUtils();
  const unpinKing = trpc.kingOfDay.unpin.useMutation({
    onSuccess: () => {
      utils.kingOfDay.get.invalidate();
    },
  });

  // Phase C.2 — pin dialog. Opens via the `k` keyboard shortcut, a
  // right-click on the hero headline, or the long-press context menu
  // on touch devices.
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }
      if (e.key === "k" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setPinDialogOpen(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="fp-root" data-focus={focusMode ? "1" : "0"}>
      {/* a11y: keyboard users Tab onto this first. Activating it moves
          focus past the masthead straight to the hero headline. */}
      <a href="#fp-main" className="fp-skip-link">
        Skip to today&rsquo;s headline
      </a>

      <Masthead
        dateKey={data.todayKey}
        weather={data.weather}
        accountCreatedAt={data.accountCreatedAt}
      />

      {!focusMode && <DropDock />}

      <main id="fp-main" tabIndex={-1}>
      <KingOfTheDayHero
        userName={data.userName}
        todayTasks={data.tasks.dueToday}
        completedCount={data.tasks.completedCount}
        whoopSummary={data.health.whoop}
        marketQuotes={data.market?.quotes ?? []}
        dailyBrief={data.dailyBrief}
        calendarEvents={data.calendar}
        unreadGmailCount={data.unreadGmailCount}
        kingOfDay={data.kingOfDay}
        onUnpin={() => unpinKing.mutate({ dateKey: data.todayKey })}
        onRequestPin={() => setPinDialogOpen(true)}
        // Regenerate = unpin (deletes the persisted row) + refetch.
        // `ensureKing` re-runs the selector end-to-end, which hits
        // the AI layer again when SMART_KING_AI_ENABLED.
        onRegenerate={() => unpinKing.mutate({ dateKey: data.todayKey })}
        regenerating={unpinKing.isPending}
      />

      <PinDialog
        open={pinDialogOpen}
        onOpenChange={setPinDialogOpen}
        todayKey={data.todayKey}
        tasks={data.tasks.dueToday}
        calendar={data.calendar}
      />

      {focusMode ? (
        <FocusModeRail calendar={data.calendar} />
      ) : (
        <>
          <NewsprintColumns
            calendar={data.calendar}
            tasks={data.tasks}
            waitingOn={data.waitingOn}
          />
          <InboxPanel messages={data.inbox} />
          <WireFeedsGrid data={data} />
        </>
      )}
      </main>
    </div>
  );
}
