import { Badge } from "@/components/ui/badge";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  ArrowDownRight,
  ArrowUpRight,
  Globe,
  Landmark,
  Newspaper,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
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
const HEADLINES_COLLAPSED = 3;
const HEADLINES_EXPANDED = 10;

/* ------------------------------------------------------------------ */
/*  Sub-components                                                      */
/* ------------------------------------------------------------------ */

function QuoteRow({ quote }: { quote: MarketQuote }) {
  const isPositive = quote.change >= 0;
  const isCrypto = CRYPTO_SYMBOLS.has(quote.symbol);
  const displaySymbol = quote.symbol.replace("-USD", "");

  return (
    <div className="flex items-center gap-3 py-1.5 px-1 text-sm">
      <span className="font-mono font-semibold text-foreground w-14 shrink-0">
        {displaySymbol}
      </span>
      {isCrypto && (
        <Badge variant="outline" className="text-xs px-1 py-0 h-4 shrink-0">
          Crypto
        </Badge>
      )}
      <span className="text-xs text-muted-foreground truncate flex-1">{quote.shortName}</span>
      <span className="font-semibold tabular-nums text-foreground shrink-0">
        {formatPrice(quote.price)}
      </span>
      <span
        className={cn(
          "flex items-center gap-0.5 text-xs font-medium tabular-nums shrink-0 w-16 justify-end",
          isPositive ? "text-emerald-600" : "text-red-600"
        )}
      >
        {isPositive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
        {formatChangePercent(quote.changePercent)}
      </span>
    </div>
  );
}

function HeadlineRow({ headline }: { headline: NewsHeadline }) {
  return (
    <a
      href={headline.link}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-2 py-1 px-1 rounded transition-colors hover:bg-muted"
    >
      {headline.category === "us-politics" ? (
        <Landmark className="h-3 w-3 text-blue-500 shrink-0" />
      ) : (
        <Globe className="h-3 w-3 text-emerald-500 shrink-0" />
      )}
      <span className="text-sm text-foreground group-hover:text-blue-600 truncate flex-1">
        {headline.title}
      </span>
      <span className="text-xs text-muted-foreground shrink-0">
        {headline.source && `${headline.source} `}
        {headline.pubDate && relativeTime(headline.pubDate)}
      </span>
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

  const [newsExpanded, setNewsExpanded] = useState(false);
  const headlineLimit = newsExpanded ? HEADLINES_EXPANDED : HEADLINES_COLLAPSED;

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

  const allQuotes = [...crypto, ...stocks];
  const totalHeadlines = usPolitics.length + worldNews.length;

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
      <div className="space-y-3">
        {/* Market — compact table rows */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Market
            </h4>
            {stocksOverallChange !== null && (
              <Badge
                variant="outline"
                className={cn(
                  "text-xs px-1.5 py-0 h-4",
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

          {allQuotes.length > 0 ? (
            <div className="divide-y divide-border rounded-md border">
              {allQuotes.map((q: MarketQuote) => (
                <QuoteRow key={q.symbol} quote={q} />
              ))}
            </div>
          ) : !isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-3">
              {marketRateLimited
                ? "Market provider rate-limited. Retry in 15-60 min."
                : "No market data available."}
            </p>
          ) : null}
        </div>

        {/* Approval Ratings — inline compact */}
        {approvalRatings.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
              Approval Averages
            </h4>
            <div className="flex flex-wrap gap-2">
              {approvalRatings.map((source, index) => (
                <a
                  key={`${source.source}-${index}`}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs hover:bg-muted transition-colors"
                >
                  <span className="font-semibold text-foreground">{source.source}</span>
                  {source.approve !== null && source.disapprove !== null ? (
                    <>
                      <span className="text-muted-foreground">
                        {source.approve.toFixed(1)}% / {source.disapprove.toFixed(1)}%
                      </span>
                      {source.net !== null && (
                        <span className={cn("font-medium", source.net >= 0 ? "text-emerald-600" : "text-red-600")}>
                          {source.net >= 0 ? "+" : ""}{source.net.toFixed(1)}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-amber-600">{source.error || "N/A"}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Headlines — compact single-line rows */}
        {(usPolitics.length > 0 || worldNews.length > 0) && (
          <div>
            {usPolitics.length > 0 && (
              <div className="mb-2">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5 flex items-center gap-1.5">
                  <Landmark className="h-3 w-3 text-blue-500" />
                  US Politics
                </h4>
                {usPolitics.slice(0, headlineLimit).map((h: NewsHeadline, i: number) => (
                  <HeadlineRow key={`us-${i}`} headline={h} />
                ))}
              </div>
            )}

            {worldNews.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-0.5 flex items-center gap-1.5">
                  <Globe className="h-3 w-3 text-emerald-500" />
                  World
                </h4>
                {worldNews.slice(0, headlineLimit).map((h: NewsHeadline, i: number) => (
                  <HeadlineRow key={`world-${i}`} headline={h} />
                ))}
              </div>
            )}

            {totalHeadlines > HEADLINES_COLLAPSED && (
              <button
                type="button"
                onClick={() => setNewsExpanded(!newsExpanded)}
                className="mt-1 text-xs font-medium text-primary hover:underline px-1"
              >
                {newsExpanded ? "Show less" : `Show all ${totalHeadlines} headlines`}
              </button>
            )}
          </div>
        )}

        {!isLoading && usPolitics.length === 0 && worldNews.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-3">
            No headlines available.
          </p>
        )}
      </div>
    </DashboardWidget>
  );
}
