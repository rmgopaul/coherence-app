/**
 * Yahoo Finance market data fetcher.
 * Uses the v6 quote endpoint to batch all symbols in a single request.
 * Falls back to v8 chart endpoint for individual symbols if needed.
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

/**
 * Primary: batch fetch using Yahoo Finance v6 quote API (single request for all symbols).
 */
async function fetchQuotesBatch(symbols: string[]): Promise<MarketQuote[]> {
  const symbolList = symbols.join(",");
  const url = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbolList)}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Yahoo v6 quote API returned HTTP ${response.status}`);
  }

  const json = (await response.json()) as any;
  const results = json?.quoteResponse?.result;
  if (!Array.isArray(results)) return [];

  return results.map((q: any) => ({
    symbol: q.symbol ?? "",
    shortName: q.shortName ?? q.longName ?? q.symbol ?? "",
    price: q.regularMarketPrice ?? 0,
    previousClose: q.regularMarketPreviousClose ?? q.previousClose ?? 0,
    change: q.regularMarketChange ?? 0,
    changePercent: q.regularMarketChangePercent ?? 0,
    currency: q.currency ?? "USD",
    marketState: q.marketState ?? "CLOSED",
  }));
}

/**
 * Fallback: scrape Yahoo Finance quote page for a single symbol.
 * Extracts price data from the JSON embedded in the page.
 */
async function fetchQuoteFromPage(symbol: string): Promise<MarketQuote | null> {
  try {
    const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/`;
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return null;
    const html = await response.text();

    // Extract price from the page's structured data or meta tags
    // Verify we got the right symbol's page (Yahoo may redirect)
    const pageSymbolMatch = html.match(/"symbol":\s*"([^"]+)"/);
    const pageSymbol = pageSymbolMatch?.[1] ?? "";
    if (pageSymbol && pageSymbol.toUpperCase() !== symbol.toUpperCase()) {
      console.warn(`[MarketData] Page scrape for ${symbol} returned data for ${pageSymbol}, skipping.`);
      return null;
    }

    const priceMatch = html.match(/"regularMarketPrice":\s*\{[^}]*"raw":\s*([\d.]+)/);
    const prevCloseMatch = html.match(/"regularMarketPreviousClose":\s*\{[^}]*"raw":\s*([\d.]+)/);
    const nameMatch = html.match(/"shortName":\s*"([^"]+)"/);
    const currencyMatch = html.match(/"currency":\s*"([^"]+)"/);
    const stateMatch = html.match(/"marketState":\s*"([^"]+)"/);

    const price = priceMatch ? parseFloat(priceMatch[1]) : 0;
    const previousClose = prevCloseMatch ? parseFloat(prevCloseMatch[1]) : price;

    if (!price) return null;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchMarketQuotes(symbols: string[]): Promise<MarketQuote[]> {
  // Try batch API first
  try {
    const results = await fetchQuotesBatch(symbols);
    if (results.length > 0) {
      console.log(`[MarketData] Batch fetched ${results.length} quotes via v6 API.`);
      return results;
    }
  } catch (error) {
    console.warn("[MarketData] Batch v6 API failed, falling back to page scrape:", error);
  }

  // Fallback: scrape individual quote pages
  const results: MarketQuote[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const quote = await fetchQuoteFromPage(symbols[i]);
    if (quote) results.push(quote);
    if (i < symbols.length - 1) await sleep(500);
  }
  console.log(`[MarketData] Page-scraped ${results.length} quotes.`);
  return results;
}
