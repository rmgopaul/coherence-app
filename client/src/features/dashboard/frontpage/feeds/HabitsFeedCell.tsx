/**
 * HabitsFeedCell — compact wire-feed for today's habit completion.
 *
 * Shows done/total + top streak. Editing (toggling completion) stays
 * on /dashboard-legacy.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";

const FIVE_MIN = 5 * 60_000;

interface Props {
  updatedLabel: string;
}

export function HabitsFeedCell({ updatedLabel }: Props) {
  const { data: habits } = trpc.habits.getForDate.useQuery(undefined, {
    refetchInterval: FIVE_MIN,
  });
  const { data: streaks } = trpc.habits.getStreaks.useQuery(undefined, {
    refetchInterval: FIVE_MIN,
  });

  const total = habits?.length ?? 0;
  const done = useMemo(
    () => (habits ?? []).filter((h) => h.completed).length,
    [habits]
  );

  const topStreak = useMemo(() => {
    if (!Array.isArray(streaks)) return 0;
    return streaks.reduce((max, s) => {
      const n = typeof s.streak === "number" ? s.streak : 0;
      return n > max ? n : max;
    }, 0);
  }, [streaks]);

  if (total === 0) {
    return (
      <article className="wire-card" data-tone="offline">
        <header className="wire-card__head">
          <span className="mono-label">HABITS</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">no habits yet.</p>
        </div>
      </article>
    );
  }

  const pctComplete = Math.round((done / total) * 100);

  return (
    <article className="wire-card">
      <header className="wire-card__head">
        <span className="mono-label">HABITS</span>
        <span className="mono-label wire-card__ts">
          UPDATED {updatedLabel}
        </span>
      </header>
      <div className="wire-card__body">
        <div className="wire-stat-row">
          <div className="wire-stat">
            <span className="mono-label">TODAY</span>
            <span className="fp-stat-big">
              {done}
              <span className="wire-stat__denom">/{total}</span>
            </span>
          </div>
          <div className="wire-stat">
            <span className="mono-label">BEST STREAK</span>
            <span className="fp-stat-big">{topStreak}d</span>
          </div>
        </div>
        <div
          className="wire-progress"
          role="progressbar"
          aria-valuenow={pctComplete}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pctComplete}% of habits complete today`}
        >
          <div
            className="wire-progress__fill"
            style={{ width: `${pctComplete}%` }}
          />
        </div>
      </div>
    </article>
  );
}
