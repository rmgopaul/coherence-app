/**
 * FrontPageDashboard — new broadsheet layout.
 *
 * Phase B commit 2: shell only. Masthead + hero. Newsprint columns,
 * wire feeds, and focus rail land in commit 3.
 *
 * Spec: handoff/web-spec.md
 */
import { KingOfTheDayHero } from "@/components/dashboard/KingOfTheDayHero";
import { Masthead } from "./frontpage/Masthead";
import { useDashboardData } from "./useDashboardData";
import { useFocusMode } from "@/contexts/FocusModeContext";
import "./frontpage/dashboard.css";

export default function FrontPageDashboard() {
  const data = useDashboardData();
  const { focusMode } = useFocusMode();

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
      />

      {!focusMode && (
        <section
          aria-label="Newsprint columns and wire feeds"
          className="fp-placeholder mono-label"
          style={{
            marginTop: 48,
            padding: 24,
            border: "2px dashed currentColor",
            opacity: 0.5,
            textAlign: "center",
          }}
        >
          NEWSPRINT COLUMNS · WIRE FEEDS — LANDING IN COMMIT 3
        </section>
      )}
    </div>
  );
}
