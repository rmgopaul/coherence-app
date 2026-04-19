/**
 * SolarFeedCell — compact wire-feed for SunPower reader submissions.
 *
 * Consumes the same `trpc.solarReadings.summary` query as the legacy
 * SolarReadingsCard. Read-only summary — editing stays on
 * /dashboard-legacy.
 */
import { trpc } from "@/lib/trpc";

const FIVE_MIN = 5 * 60_000;

interface Props {
  updatedLabel: string;
}

export function SolarFeedCell({ updatedLabel }: Props) {
  const { data } = trpc.solarReadings.summary.useQuery(undefined, {
    refetchInterval: FIVE_MIN,
  });

  const totalReadings = data?.totalReadings ?? 0;
  const uniqueCustomers = data?.uniqueCustomers ?? 0;

  if (totalReadings === 0) {
    return (
      <article className="wire-card" data-tone="offline">
        <header className="wire-card__head">
          <span className="mono-label">SOLAR · SUNPOWER</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">no readings yet.</p>
          <p className="mono-label wire-card__hint">
            WAITING ON SUNPOWER READER APP
          </p>
        </div>
      </article>
    );
  }

  return (
    <article className="wire-card">
      <header className="wire-card__head">
        <span className="mono-label">SOLAR · SUNPOWER</span>
        <span className="mono-label wire-card__ts">
          UPDATED {updatedLabel}
        </span>
      </header>
      <div className="wire-card__body">
        <div className="wire-stat-row">
          <div className="wire-stat">
            <span className="mono-label">READINGS</span>
            <span className="fp-stat-big">{totalReadings}</span>
          </div>
          <div className="wire-stat">
            <span className="mono-label">CUSTOMERS</span>
            <span className="fp-stat-big">{uniqueCustomers}</span>
          </div>
        </div>
      </div>
    </article>
  );
}
