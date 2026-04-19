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
import { KingOfTheDayHero } from "@/components/dashboard/KingOfTheDayHero";
import { Masthead } from "./frontpage/Masthead";
import { NewsprintColumns } from "./frontpage/NewsprintColumns";
import { WireFeedsGrid } from "./frontpage/WireFeedsGrid";
import { FocusModeRail } from "./frontpage/FocusModeRail";
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

  return (
    <div className="fp-root" data-focus={focusMode ? "1" : "0"}>
      <Masthead dateKey={data.todayKey} weather={data.weather} />

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
          <WireFeedsGrid data={data} />
        </>
      )}
    </div>
  );
}
