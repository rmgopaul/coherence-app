/**
 * Yahoo Finance market data fetcher.
 * Uses Yahoo quote endpoints to batch all symbols in a single request.
 * Falls back to Yahoo chart endpoint for individual symbols if needed.
 * No API key required.
 */

export interface MarketQuote {
  symbol: string;
  shortName: string;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  currency: string;
  marketState: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function toFiniteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeQuoteFromApi(q: any): MarketQuote {
  const price = toFiniteNumber(q.regularMarketPrice);
  const previousClose = toFiniteNumber(
    q.regularMarketPreviousClose ?? q.previousClose,
    price
  );
  const change = toFiniteNumber(q.regularMarketChange, price - previousClose);
  const changePercent = toFiniteNumber(
    q.regularMarketChangePercent,
    previousClose > 0 ? (change / previousClose) * 100 : 0
  );

  return {
    symbol: q.symbol ?? "",
    shortName: q.shortName ?? q.longName ?? q.symbol ?? "",
    price,
    previousClose,
    change,
    changePercent,
    currency: q.currency ?? "USD",
    marketState: q.marketState ?? "CLOSED",
  };
}

/**
 * Primary: batch fetch using Yahoo Finance quote API (single request for all symbols).
 */
async function fetchQuotesBatch(symbols: string[]): Promise<MarketQuote[]> {
  const symbolList = symbols.join(",");
  const encodedSymbols = encodeURIComponent(symbolList);
  const urls = [
    `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodedSymbols}`,
    `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodedSymbols}`,
    `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodedSymbols}`,
  ];

  let lastError: Error | null = null;

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(7000),
      });

      if (!response.ok) {
        throw new Error(`Yahoo quote endpoint returned HTTP ${response.status}`);
      }

      const json = (await response.json()) as any;
      const results = json?.quoteResponse?.result;
      if (!Array.isArray(results) || results.length === 0) continue;

      return results.map((q: any) => normalizeQuoteFromApi(q));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (lastError) throw lastError;
  return [];
}

/**
 * Fallback: Yahoo chart endpoint for a single symbol.
 */
async function fetchQuoteFromChart(symbol: string): Promise<MarketQuote | null> {
  try {
    const urls = [
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
    ];

    for (const url of urls) {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(7000),
      });

      if (!response.ok) continue;
      const json = (await response.json()) as any;
      const result = json?.chart?.result?.[0];
      const meta = result?.meta ?? {};
      const closeSeries = result?.indicators?.quote?.[0]?.close;
      const lastClose = Array.isArray(closeSeries)
        ? [...closeSeries]
            .reverse()
            .map((value) => toFiniteNumber(value, Number.NaN))
            .find((value) => Number.isFinite(value))
        : undefined;

      const price = toFiniteNumber(
        meta.regularMarketPrice ?? meta.postMarketPrice ?? meta.preMarketPrice,
        Number.isFinite(lastClose ?? Number.NaN) ? (lastClose as number) : 0
      );
      if (!price) continue;

      const previousClose = toFiniteNumber(
        meta.previousClose ?? meta.chartPreviousClose,
        price
      );
      const change = price - previousClose;
      const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

      return {
        symbol,
        shortName: meta.shortName ?? meta.longName ?? meta.symbol ?? symbol,
        price,
        previousClose,
        change,
        changePercent,
        currency: meta.currency ?? "USD",
        marketState: meta.marketState ?? "CLOSED",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Last-resort fallback: scrape Yahoo quote page for a single symbol.
 * Useful when query1/query2 subdomains are blocked but finance.yahoo.com works.
 */
async function fetchQuoteFromPage(symbol: string): Promise<MarketQuote | null> {
  try {
    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(7000),
    });

    if (!response.ok) return null;
    const html = await response.text();

    const pageSymbolMatch = html.match(/"symbol":\s*"([^"]+)"/);
    const pageSymbol = pageSymbolMatch?.[1] ?? "";
    if (pageSymbol && pageSymbol.toUpperCase() !== symbol.toUpperCase()) {
      return null;
    }

    const priceMatch = html.match(/"regularMarketPrice":\s*\{[^}]*"raw":\s*([\d.]+)/);
    const prevCloseMatch = html.match(/"regularMarketPreviousClose":\s*\{[^}]*"raw":\s*([\d.]+)/);
    const nameMatch = html.match(/"shortName":\s*"([^"]+)"/);
    const currencyMatch = html.match(/"currency":\s*"([^"]+)"/);
    const stateMatch = html.match(/"marketState":\s*"([^"]+)"/);

    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
    const previousClose = prevCloseMatch ? parseFloat(prevCloseMatch[1]) : price;
    if (!Number.isFinite(price) || price <= 0) return null;

    const change = price - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

    return {
      symbol,
      shortName: nameMatch?.[1] ?? symbol,
      price,
      previousClose,
      change,
      changePercent,
      currency: currencyMatch?.[1] ?? "USD",
      marketState: stateMatch?.[1] ?? "CLOSED",
    };
  } catch {
    return null;
  }
}

export async function fetchMarketQuotes(symbols: string[]): Promise<MarketQuote[]> {
  // Try batch API first
  try {
    const results = await fetchQuotesBatch(symbols);
    if (results.length > 0) {
      console.log(`[MarketData] Batch fetched ${results.length} quotes.`);
      return results;
    }
  } catch (error) {
    console.warn("[MarketData] Batch quote API failed, falling back to chart endpoint:", error);
  }

  // Fallback: fetch individual chart endpoints in parallel to avoid long sequential delays.
  const chartResults = await Promise.all(symbols.map((symbol) => fetchQuoteFromChart(symbol)));
  const chartQuotes = chartResults.filter((quote): quote is MarketQuote => Boolean(quote));
  if (chartQuotes.length > 0) {
    console.log(`[MarketData] Chart fallback fetched ${chartQuotes.length} quotes.`);
    return chartQuotes;
  }

  // Final fallback: finance.yahoo.com HTML quote pages.
  const pageResults = await Promise.all(symbols.map((symbol) => fetchQuoteFromPage(symbol)));
  const pageQuotes = pageResults.filter((quote): quote is MarketQuote => Boolean(quote));
  console.log(`[MarketData] Page fallback fetched ${pageQuotes.length} quotes.`);
  return pageQuotes;
}
