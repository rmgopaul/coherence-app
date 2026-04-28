/**
 * SupplementsFeedCell — compact wire-feed for the supplements module.
 *
 * After Task 6.1 (2026-04-27) the primary content is the top
 * correlation signals (supplement → metric effect sizes) computed
 * nightly into `supplementCorrelations`. Until those land — fresh
 * install, brand-new supplement, or insufficient-data ladders —
 * the cell falls back to the previous adherence display
 * (`logged/scheduled` + recent logs) so the cell still has
 * something to say.
 */
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { formatTodayKey } from "@shared/dateKey";

const FIVE_MIN = 5 * 60_000;

/** Map raw metric keys to short labels; metric is one of 4 strings. */
const METRIC_LABEL: Record<string, string> = {
  recoveryScore: "Recovery",
  sleepHours: "Sleep",
  dayStrain: "Strain",
  hrvMs: "HRV",
};

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

/** Cohen's d → human label. ±0.2 small, ±0.5 medium, ±0.8 large. */
function effectLabel(d: number | null): string {
  if (d === null || !Number.isFinite(d)) return "—";
  const sign = d >= 0 ? "+" : "−";
  const mag = Math.abs(d);
  return `${sign}${mag.toFixed(2)}d`;
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
  // Task 6.1: top signals from the nightly correlation pre-compute.
  // Refetch interval is generous because the pre-compute only changes
  // once per night.
  const { data: topSignals } = trpc.supplements.getTopSignals.useQuery(
    { limit: 4 },
    { refetchInterval: 30 * 60_000 }
  );

  const scheduled = definitions?.length ?? 0;
  const loggedToday = logs?.length ?? 0;
  const hasSignals = (topSignals?.length ?? 0) > 0;

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
        {hasSignals ? (
          <ul className="wire-list">
            {topSignals!.map((signal) => (
              <li
                key={`${signal.supplementId}:${signal.metric}:${signal.windowDays}`}
                className="wire-list__row"
                title={`${signal.metric} over ${signal.windowDays}d, n=${signal.onN}/${signal.offN}`}
              >
                <span className="mono-label">
                  {String(signal.supplementName ?? signal.supplementId).slice(
                    0,
                    18
                  )}
                </span>
                <span className="wire-list__val mono-label">
                  {METRIC_LABEL[signal.metric] ?? signal.metric}{" "}
                  {effectLabel(signal.cohensD)}
                </span>
              </li>
            ))}
          </ul>
        ) : recent.length > 0 ? (
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
