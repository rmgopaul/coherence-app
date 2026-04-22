/**
 * ApprovalFeedCell — Presidential approval averages (RCP + NYT).
 *
 * Data comes from the existing `marketDashboard.getMarketData` endpoint,
 * which already calls `fetchTrumpApprovalRatings()` server-side and returns
 * an `approvalRatings` array of `{ source, approve, disapprove, net, asOf,
 * url, error? }`.
 *
 * Layout: one row per source with APPROVE / DISAPPROVE / NET. NET
 * colors green when positive, red when negative. `asOf` rendered in
 * mono as the source's "as of" date.
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

function formatAsOf(raw: string | null): string {
  if (!raw) return "";
  // RCP gives "Oct 1, 2026" or ISO-ish; NYT gives YYYY-MM-DD. Render
  // everything as "MMM D" in mono, falling back to the raw string
  // when parsing fails (keeps RCP's "Oct 1" intact without a second
  // transformation step).
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

export function ApprovalFeedCell({ updatedLabel }: Props) {
  const { data, isLoading } = trpc.marketDashboard.getMarketData.useQuery(
    undefined,
    {
      // Match the MarketsCell cadence — same upstream query, same
      // cache, piggybacks on the tRPC batching so we don't fire a
      // second HTTP round-trip.
      refetchInterval: 10 * 60_000,
      staleTime: 4 * 60_000,
    }
  );

  const rows = ((data as { approvalRatings?: ApprovalRow[] } | undefined)
    ?.approvalRatings ?? []) as ApprovalRow[];

  if (isLoading && rows.length === 0) {
    return (
      <article className="wire-card" data-tone="placeholder">
        <header className="wire-card__head">
          <span className="mono-label">APPROVAL · US PRES</span>
          <span className="mono-label wire-card__ts">
            UPDATED {updatedLabel}
          </span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">loading poll averages.</p>
        </div>
      </article>
    );
  }

  if (rows.length === 0) {
    return (
      <article className="wire-card" data-tone="offline">
        <header className="wire-card__head">
          <span className="mono-label">APPROVAL · US PRES</span>
        </header>
        <div className="wire-card__body">
          <p className="fp-empty">no averages on the wire.</p>
          <p className="mono-label wire-card__hint">
            RCP + NYT · RETRY IN 5m
          </p>
        </div>
      </article>
    );
  }

  return (
    <article className="wire-card">
      <header className="wire-card__head">
        <span className="mono-label">APPROVAL · US PRES</span>
        <span className="mono-label wire-card__ts">UPDATED {updatedLabel}</span>
      </header>
      <div className="wire-card__body">
        <ol className="wire-approval">
          {rows.map((row) => (
            <ApprovalRowView key={row.source} row={row} />
          ))}
        </ol>
      </div>
    </article>
  );
}
