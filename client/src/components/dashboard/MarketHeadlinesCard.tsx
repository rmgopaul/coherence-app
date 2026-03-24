import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  ArrowDownRight,
  ArrowUpRight,
  ExternalLink,
  Globe,
  Landmark,
  Newspaper,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useMemo } from "react";
import { DashboardWidget } from "./DashboardWidget";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

interface MarketQuote {
  symbol: string;
  shortName: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  currency: string;
  marketState: string;
}

interface NewsHeadline {
  title: string;
  link: string;
  source: string;
  pubDate: string;
  category: "us-politics" | "world";
}

interface ApprovalRatingSource {
  source: "RCP" | "NYT" | string;
  approve: number | null;
  disapprove: number | null;
  net: number | null;
  asOf: string | null;
  url: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatPrice(value: number): string {
  return value >= 1000
    ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${value.toFixed(2)}`;
}

function formatChangePercent(percent: number): string {
  const sign = percent >= 0 ? "+" : "";
  return `${sign}${percent.toFixed(2)}%`;
}

function relativeTime(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const CRYPTO_SYMBOLS = new Set(["BTC-USD", "ETH-USD"]);

/* ------------------------------------------------------------------ */
/*  Sub-components                                                      */
/* ------------------------------------------------------------------ */

function QuoteCard({ quote }: { quote: MarketQuote }) {
  const isPositive = quote.change >= 0;
  const isCrypto = CRYPTO_SYMBOLS.has(quote.symbol);
  const displaySymbol = quote.symbol.replace("-USD", "");

  return (
    <div className="flex items-center justify-between rounded-lg border p-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100">
            {displaySymbol}
          </span>
          {isCrypto && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
              Crypto
            </Badge>
          )}
        </div>
        <div className="text-xs text-slate-500 truncate">{quote.shortName}</div>
      </div>
      <div className="text-right ml-3 shrink-0">
        <div className="text-sm font-semibold tabular-nums text-slate-900 dark:text-slate-100">
          {formatPrice(quote.price)}
        </div>
        <div
          className={cn(
            "flex items-center justify-end gap-0.5 text-xs font-medium tabular-nums",
            isPositive ? "text-emerald-600" : "text-red-600"
          )}
        >
          {isPositive ? (
            <ArrowUpRight className="h-3 w-3" />
          ) : (
            <ArrowDownRight className="h-3 w-3" />
          )}
          {formatChangePercent(quote.changePercent)}
        </div>
      </div>
    </div>
  );
}

function HeadlineRow({ headline }: { headline: NewsHeadline }) {
  return (
    <a
      href={headline.link}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-3 rounded-md px-2 py-2 transition-colors hover:bg-slate-50 dark:hover:bg-slate-900"
    >
      <div className="mt-0.5 shrink-0">
        {headline.category === "us-politics" ? (
          <Landmark className="h-3.5 w-3.5 text-blue-500" />
        ) : (
          <Globe className="h-3.5 w-3.5 text-emerald-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm leading-snug text-slate-800 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-blue-400 line-clamp-2">
          {headline.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-slate-400">
          {headline.source && <span>{headline.source}</span>}
          {headline.pubDate && <span>{relativeTime(headline.pubDate)}</span>}
        </div>
      </div>
      <ExternalLink className="h-3 w-3 shrink-0 text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
    </a>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                      */
/* ------------------------------------------------------------------ */

export default function MarketHeadlinesCard() {
  const { data, isLoading, error, refetch } = trpc.marketDashboard.getMarketData.useQuery(
    undefined,
    {
      staleTime: 10 * 60_000,
      refetchInterval: 15 * 60_000,
      retry: 1,
    }
  );

  const stocks = useMemo(
    () => (data?.quotes ?? []).filter((q: MarketQuote) => !CRYPTO_SYMBOLS.has(q.symbol)),
    [data?.quotes]
  );

  const crypto = useMemo(
    () => (data?.quotes ?? []).filter((q: MarketQuote) => CRYPTO_SYMBOLS.has(q.symbol)),
    [data?.quotes]
  );

  const usPolitics = useMemo(
    () => (data?.headlines ?? []).filter((h: NewsHeadline) => h.category === "us-politics"),
    [data?.headlines]
  );

  const worldNews = useMemo(
    () => (data?.headlines ?? []).filter((h: NewsHeadline) => h.category === "world"),
    [data?.headlines]
  );

  const fetchedAt = data?.fetchedAt ? new Date(data.fetchedAt) : null;
  const marketRateLimited = Boolean((data as any)?.marketRateLimited);
  const approvalRatings = ((data as any)?.approvalRatings ?? []) as ApprovalRatingSource[];

  const stocksOverallChange = useMemo(() => {
    if (stocks.length === 0) return null;
    const totalPercent = stocks.reduce((sum: number, q: MarketQuote) => sum + q.changePercent, 0);
    return totalPercent / stocks.length;
  }, [stocks]);

  return (
    <DashboardWidget
      title="Headlines & Markets"
      icon={Newspaper}
      category="productivity"
      isLoading={isLoading}
      error={error?.message ?? null}
      onRetry={() => refetch()}
      lastUpdated={fetchedAt}
      collapsible
      storageKey="market-headlines"
    >
      <div className="space-y-5">
        {/* Market Section */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Market
            </h4>
            {stocksOverallChange !== null && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px] px-1.5 py-0 h-4",
                  stocksOverallChange >= 0
                    ? "text-emerald-600 border-emerald-200"
                    : "text-red-600 border-red-200"
                )}
              >
                {stocksOverallChange >= 0 ? (
                  <TrendingUp className="h-2.5 w-2.5 mr-0.5" />
                ) : (
                  <TrendingDown className="h-2.5 w-2.5 mr-0.5" />
                )}
                Avg {stocksOverallChange >= 0 ? "+" : ""}
                {stocksOverallChange.toFixed(1)}%
              </Badge>
            )}
          </div>

          {/* Crypto */}
          {crypto.length > 0 && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              {crypto.map((q: MarketQuote) => (
                <QuoteCard key={q.symbol} quote={q} />
              ))}
            </div>
          )}

          {/* Stocks */}
          {stocks.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {stocks.map((q: MarketQuote) => (
                <QuoteCard key={q.symbol} quote={q} />
              ))}
            </div>
          )}

          {!isLoading && stocks.length === 0 && crypto.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-4">
              {marketRateLimited
                ? "Market provider temporarily rate-limited requests (HTTP 429). Try again in 15-60 minutes."
                : "No market data available."}
            </p>
          )}
        </div>

        {/* Headlines Section */}
        {approvalRatings.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
              Trump Approval Averages
            </h4>
            <div className="grid grid-cols-1 gap-2">
              {approvalRatings.map((source, index) => (
                <a
                  key={`${source.source}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md border px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                      {source.source}
                    </span>
                    {source.asOf && (
                      <span className="text-[10px] text-slate-400">{source.asOf}</span>
                    )}
                  </div>
                  {source.approve !== null && source.disapprove !== null ? (
                    <div className="mt-1 text-sm text-slate-700 dark:text-slate-200">
                      Approve {source.approve.toFixed(1)}% | Disapprove {source.disapprove.toFixed(1)}%
                      {source.net !== null && (
                        <span className={cn("ml-2 font-medium", source.net >= 0 ? "text-emerald-600" : "text-red-600")}>
                          Net {source.net >= 0 ? "+" : ""}
                          {source.net.toFixed(1)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-amber-600">
                      {source.error || "Data unavailable"}
                    </div>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        <div>
          {usPolitics.length > 0 && (
            <div className="mb-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1.5">
                <Landmark className="h-3 w-3 text-blue-500" />
                US Politics
              </h4>
              <div className="space-y-0.5">
                {usPolitics.map((h: NewsHeadline, i: number) => (
                  <HeadlineRow key={`us-${i}`} headline={h} />
                ))}
              </div>
            </div>
          )}

          {worldNews.length > 0 && (
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1.5">
                <Globe className="h-3 w-3 text-emerald-500" />
                World
              </h4>
              <div className="space-y-0.5">
                {worldNews.map((h: NewsHeadline, i: number) => (
                  <HeadlineRow key={`world-${i}`} headline={h} />
                ))}
              </div>
            </div>
          )}

          {!isLoading && usPolitics.length === 0 && worldNews.length === 0 && (
            <p className="text-sm text-slate-400 text-center py-4">
              No headlines available.
            </p>
          )}
        </div>
      </div>
    </DashboardWidget>
  );
}
