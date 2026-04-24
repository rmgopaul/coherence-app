/**
 * PoliticsFeedCell — Presidential approval averages (RCP + NYT) plus
 * Polymarket implied probabilities for the 2026 midterms (House,
 * Senate, and a Dem sweep of both chambers).
 *
 * Data comes from `marketDashboard.getMarketData`, which wraps both
 * `fetchTrumpApprovalRatings()` and `fetchPoliticalOdds()` server-side
 * and caches the combined payload for 5 minutes.
 *
 * Layout:
 *   APPROVAL · US PRES         UPDATED hh:mm
 *   RCP  APV x  DIS y  NET z   MMM D
 *   NYT  APV x  DIS y  NET z   MMM D
 *   MIDTERMS · P(DEM)          POLYMARKET · MMM D
 *   HOUSE 65  SENATE 42  SWEEP 32
 */
import { trpc } from "@/lib/trpc";

interface Props {
  updatedLabel: string;
}

interface ApprovalRow {
  source: string;
  approve: number | null;
  disapprove: number | null;
  net: number | null;
  asOf: string | null;
  url: string;
  error?: string;
}

interface PoliticalOddsRow {
  label: "HOUSE" | "SENATE" | "SWEEP";
  demPercent: number | null;
  asOf: string | null;
  url: string;
  error?: string;
}

function formatAsOf(raw: string | null): string {
  if (!raw) return "";
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    const dt = new Date(Number(y), Number(m) - 1, Number(d));
    if (!Number.isNaN(dt.getTime())) {
      return dt
        .toLocaleDateString("en-US", { month: "short", day: "numeric" })
        .toUpperCase();
    }
  }
  return raw.toUpperCase();
}

function ApprovalRowView({ row }: { row: ApprovalRow }) {
  const hasData =
    row.approve !== null && row.disapprove !== null && row.net !== null;
  const netClass =
    row.net !== null && row.net >= 0 ? "wire-ticker__up" : "wire-ticker__down";

  return (
    <li className="wire-approval__row">
      <span className="mono-label wire-approval__src">{row.source}</span>
      {hasData ? (
        <>
          <span className="wire-approval__pair">
            <span className="wire-approval__pair-label mono-label">APV</span>
            <span className="wire-approval__num">
              {row.approve!.toFixed(1)}
            </span>
          </span>
          <span className="wire-approval__pair">
            <span className="wire-approval__pair-label mono-label">DIS</span>
            <span className="wire-approval__num">
              {row.disapprove!.toFixed(1)}
            </span>
          </span>
          <span className={`mono-label wire-approval__net ${netClass}`}>
            NET {row.net! >= 0 ? "+" : ""}
            {row.net!.toFixed(1)}
          </span>
          <span className="mono-label wire-approval__asof">
            {formatAsOf(row.asOf)}
          </span>
        </>
      ) : (
        <span className="mono-label wire-approval__error">
          {row.error ?? "NO DATA"}
        </span>
      )}
    </li>
  );
}

function OddsCellView({ row }: { row: PoliticalOddsRow }) {
  const hasData = row.demPercent !== null;
  return (
    <a
      href={row.url}
      target="_blank"
      rel="noopener noreferrer"
      className="wire-politics__cell"
      title={
        row.error ??
        `Dem probability · ${row.label}${row.asOf ? ` · ${formatAsOf(row.asOf)}` : ""}`
      }
    >
      <span className="mono-label wire-politics__cell-label">{row.label}</span>
      <span className="wire-politics__num">
        {hasData ? `${Math.round(row.demPercent!)}` : "—"}
        {hasData && <span className="wire-politics__unit">%</span>}
      </span>
    </a>
  );
}

// Pick the most recent `asOf` out of the three odds rows to show
// alongside the POLYMARKET source label, so the user can tell how
// stale the prediction-market snapshot is.
function latestOddsAsOf(rows: PoliticalOddsRow[]): string | null {
  let latest: string | null = null;
  for (const row of rows) {
    if (!row.asOf) continue;
    if (latest === null || row.asOf > latest) latest = row.asOf;
  }
  return latest;
}

export function PoliticsFeedCell({ updatedLabel }: Props) {
  const { data, isLoading } = trpc.marketDashboard.getMarketData.useQuery(
    undefined,
    {
      refetchInterval: 5 * 60_000,
      staleTime: 4 * 60_000,
    }
  );

  const payload = data as
    | {
        approvalRatings?: ApprovalRow[];
        politicalOdds?: PoliticalOddsRow[];
      }
    | undefined;
  const approvalRows = (payload?.approvalRatings ?? []) as ApprovalRow[];
  const oddsRows = (payload?.politicalOdds ?? []) as PoliticalOddsRow[];
  const hasAnyData = approvalRows.length > 0 || oddsRows.length > 0;

  if (isLoading && !hasAnyData) {
    return (
      <article className="wire-card" data-tone="placeholder">
        <header className="wire-card__head">
          <span className="mono-label">POLITICS · US</span>
          <span className="mono-label wire-card__ts">
            UPDATED {updatedLabel}
          </span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">loading politics wire.</p>
        </div>
      </article>
    );
  }

  if (!hasAnyData) {
    return (
      <article className="wire-card" data-tone="offline">
        <header className="wire-card__head">
          <span className="mono-label">POLITICS · US</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">no politics on the wire.</p>
          <p className="mono-label wire-card__hint">
            RCP · NYT · POLYMARKET · RETRY IN 5m
          </p>
        </div>
      </article>
    );
  }

  const oddsAsOf = latestOddsAsOf(oddsRows);

  return (
    <article className="wire-card">
      <header className="wire-card__head">
        <span className="mono-label">POLITICS · US</span>
        <span className="mono-label wire-card__ts">UPDATED {updatedLabel}</span>
      </header>
      <div className="wire-card__body wire-politics">
        {approvalRows.length > 0 && (
          <section className="wire-politics__section">
            <div className="wire-politics__section-head">
              <span className="mono-label">APPROVAL · US PRES</span>
            </div>
            <ol className="wire-approval">
              {approvalRows.map((row) => (
                <ApprovalRowView key={row.source} row={row} />
              ))}
            </ol>
          </section>
        )}
        {oddsRows.length > 0 && (
          <section className="wire-politics__section">
            <div className="wire-politics__section-head">
              <span className="mono-label">MIDTERMS · P(DEM)</span>
              <span className="mono-label wire-politics__src">
                POLYMARKET
                {oddsAsOf ? ` · ${formatAsOf(oddsAsOf)}` : ""}
              </span>
            </div>
            <div className="wire-politics__odds">
              {oddsRows.map((row) => (
                <OddsCellView key={row.label} row={row} />
              ))}
            </div>
          </section>
        )}
      </div>
    </article>
  );
}
