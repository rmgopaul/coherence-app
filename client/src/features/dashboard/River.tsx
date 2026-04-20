/**
 * River — D3 view (Phase F7).
 *
 * Route: /dashboard/river
 *
 * Today's events + tasks + unread inbox merged into a single
 * chronologically-sorted stream, sized by importance. Headlines scale
 * from 15px ("sm") through 22 / 32 to 52px ("huge"); P1 tasks and
 * starred mail dominate.
 *
 * Spec: handoff/Productivity Hub Reimagined (2).html §D3
 */
import { useMemo } from "react";
import { useDashboardData } from "./useDashboardData";
import { buildRiver } from "./river/buildRiver";
import { RiverItem } from "./river/RiverItem";
import "./frontpage/dashboard.css";

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
];

function formatDateline(): string {
  const d = new Date();
  return `${DAY_NAMES[d.getDay()]} · ${MONTH_NAMES[d.getMonth()]} ${d.getDate()} · ${d.getFullYear()}`;
}

export default function River() {
  const data = useDashboardData();

  const items = useMemo(
    () =>
      buildRiver({
        calendar: data.calendar,
        tasks: data.tasks.dueToday,
        inbox: data.inbox,
      }),
    [data.calendar, data.tasks.dueToday, data.inbox]
  );

  return (
    <div className="fp-root fp-river-root">
      <div className="fp-river">
        <header className="fp-river__head">
          <h1>
            TODAY{" "}
            <em className="fp-river__head-em">&amp; what it wants.</em>
          </h1>
          <div className="fp-river__dateline mono-label">
            {formatDateline()} · {items.length} ITEMS
          </div>
        </header>

        {items.length === 0 ? (
          <p className="fp-empty">the day hasn't started feeding yet.</p>
        ) : (
          <ol className="fp-river__stream">
            {items.map((item) => (
              <li key={item.id} className="fp-river__row">
                <RiverItem item={item} />
              </li>
            ))}
          </ol>
        )}

        <footer className="fp-river__foot mono-label">
          AUTO-MERGED FROM CALENDAR · TODOIST · GMAIL · UPDATES EVERY MINUTE
        </footer>
      </div>
    </div>
  );
}
