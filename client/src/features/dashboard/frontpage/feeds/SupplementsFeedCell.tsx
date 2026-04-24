/**
 * SupplementsFeedCell — compact wire-feed for today's supplement logging.
 *
 * Shows `logged/scheduled` count and a sparse tick row of the most
 * recent logs. Editing stays on /dashboard-legacy.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { formatTodayKey } from "@shared/dateKey";

const FIVE_MIN = 5 * 60_000;

/**
 * Some supplement logs store the dose as "3G" (value + unit baked in)
 * while others store dose "3" with doseUnit "G". Guard against the
 * double-unit render ("3G G") by dropping the suffix when the dose
 * already ends with the unit letters.
 */
function formatDose(dose?: string | null, doseUnit?: string | null): string {
  const d = (dose ?? "").toString().trim();
  const u = (doseUnit ?? "").toString().trim();
  if (!d && !u) return "—";
  if (!d) return u;
  if (!u) return d;
  if (d.toLowerCase().endsWith(u.toLowerCase())) return d;
  return `${d} ${u}`;
}

interface Props {
  updatedLabel: string;
}

export function SupplementsFeedCell({ updatedLabel }: Props) {
  const todayKey = formatTodayKey();

  const { data: definitions } = trpc.supplements.listDefinitions.useQuery(
    undefined,
    { refetchInterval: FIVE_MIN }
  );
  const { data: logs } = trpc.supplements.getLogs.useQuery(
    { dateKey: todayKey },
    { refetchInterval: FIVE_MIN }
  );

  const scheduled = definitions?.length ?? 0;
  const loggedToday = logs?.length ?? 0;

  const recent = useMemo(() => (logs ?? []).slice(0, 3), [logs]);

  if (scheduled === 0) {
    return (
      <a
        href="/supplements"
        className="wire-card wire-card--link"
        data-tone="offline"
        aria-label="Set up supplements"
      >
        <header className="wire-card__head">
          <span className="mono-label">SUPPLEMENTS</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">nothing scheduled.</p>
        </div>
      </a>
    );
  }

  return (
    <a
      href="/supplements"
      className="wire-card wire-card--link"
      aria-label="Open supplements"
    >
      <header className="wire-card__head">
        <span className="mono-label">SUPPLEMENTS</span>
        <span className="mono-label wire-card__ts">
          UPDATED {updatedLabel}
        </span>
      </header>
      <div className="wire-card__body">
        <div className="wire-stat-row">
          <div className="wire-stat">
            <span className="mono-label">LOGGED</span>
            <span className="fp-stat-big">
              {loggedToday}
              <span className="wire-stat__denom">/{scheduled}</span>
            </span>
          </div>
        </div>
        {recent.length > 0 ? (
          <ul className="wire-list">
            {recent.map((log) => (
              <li key={log.id} className="wire-list__row">
                <span className="mono-label">
                  {String(log.name ?? log.definitionId ?? "").slice(0, 18)}
                </span>
                <span className="wire-list__val mono-label">
                  {formatDose(log.dose, log.doseUnit)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="fp-empty">none logged yet today.</p>
        )}
      </div>
    </a>
  );
}
