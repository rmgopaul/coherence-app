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

export class MarketRateLimitError extends Error {
  code = "RATE_LIMIT" as const;

  constructor(message = "Market data provider rate limited requests.") {
    super(message);
    this.name = "MarketRateLimitError";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const CRYPTO_TO_COINGECKO_ID: Record<string, string> = {
  "BTC-USD": "bitcoin",
  "ETH-USD": "ethereum",
};

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

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current);
  return cells;
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

      if (response.status === 429) {
        throw new MarketRateLimitError("Yahoo quote API returned HTTP 429.");
      }
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

    let sawRateLimit = false;
    for (const url of urls) {
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(7000),
      });

      if (response.status === 429) {
        sawRateLimit = true;
        continue;
      }
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
    if (sawRateLimit) {
      throw new MarketRateLimitError(`Yahoo chart endpoint returned HTTP 429 for ${symbol}.`);
    }
    return null;
  } catch (error) {
    if (error instanceof MarketRateLimitError) {
      throw error;
    }
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

    if (response.status === 429) {
      throw new MarketRateLimitError(`Yahoo quote page returned HTTP 429 for ${symbol}.`);
    }
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
  } catch (error) {
    if (error instanceof MarketRateLimitError) {
      throw error;
    }
    return null;
  }
}

async function fetchStockQuotesFromStooq(symbols: string[]): Promise<MarketQuote[]> {
  const stockSymbols = symbols.filter((symbol) => !symbol.endsWith("-USD"));
  if (stockSymbols.length === 0) return [];

  // Stooq expects symbols joined with "+" (not commas).
  const stooqSymbols = stockSymbols.map((symbol) => `${symbol.toLowerCase()}.us`);
  const url =
    `https://stooq.com/q/l/?s=${encodeURIComponent(stooqSymbols.join("+"))}` +
    "&f=sd2t2ohlcvn&e=csv";

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/csv,text/plain,*/*",
      },
      signal: AbortSignal.timeout(7000),
    });

    if (!response.ok) return [];
    const csvText = await response.text();
    const lines = csvText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) return [];

    const quotes: MarketQuote[] = [];
    for (const line of lines) {
      const cells = splitCsvLine(line);
      // Stooq rows with f=sd2t2ohlcvn are:
      // 0:symbol, 1:date, 2:time, 3:open, 4:high, 5:low, 6:close, 7:volume, 8:name
      const symbolRaw = (cells[0] ?? "").trim().toUpperCase();
      const close = toFiniteNumber(cells[6], Number.NaN);
      if (!symbolRaw || !Number.isFinite(close) || close <= 0) continue;

      // Guard against malformed aggregate rows containing commas in symbol field.
      if (symbolRaw.includes(",")) continue;

      const normalizedSymbol = symbolRaw.replace(".US", "");
      const previousCloseGuess = toFiniteNumber(cells[3], close);
      const change = close - previousCloseGuess;
      const changePercent =
        previousCloseGuess > 0 ? (change / previousCloseGuess) * 100 : 0;

      quotes.push({
        symbol: normalizedSymbol,
        shortName: (cells[8] ?? normalizedSymbol).trim() || normalizedSymbol,
        price: close,
        previousClose: previousCloseGuess,
        change,
        changePercent,
        currency: "USD",
        marketState: "CLOSED",
      });
    }

    return quotes;
  } catch {
    return [];
  }
}

async function fetchCryptoQuotesFromCoinGecko(symbols: string[]): Promise<MarketQuote[]> {
  const cryptoSymbols = symbols.filter((symbol) => CRYPTO_TO_COINGECKO_ID[symbol]);
  if (cryptoSymbols.length === 0) return [];

  const ids = Array.from(new Set(cryptoSymbols.map((symbol) => CRYPTO_TO_COINGECKO_ID[symbol])));
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(","))}` +
    "&vs_currencies=usd&include_24hr_change=true";

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(7000),
    });
    if (!response.ok) return [];

    const json = (await response.json()) as Record<
      string,
      { usd?: number; usd_24h_change?: number }
    >;

    const quotes: MarketQuote[] = [];
    for (const symbol of cryptoSymbols) {
      const id = CRYPTO_TO_COINGECKO_ID[symbol];
      const payload = json?.[id];
      const price = toFiniteNumber(payload?.usd, Number.NaN);
      if (!Number.isFinite(price) || price <= 0) continue;
      const changePercent = toFiniteNumber(payload?.usd_24h_change, 0);
      const previousClose =
        Number.isFinite(changePercent) && Math.abs(changePercent) < 99.9
          ? price / (1 + changePercent / 100)
          : price;
      const change = price - previousClose;

      quotes.push({
        symbol,
        shortName: symbol.replace("-USD", ""),
        price,
        previousClose,
        change,
        changePercent,
        currency: "USD",
        marketState: "CLOSED",
      });
    }
    return quotes;
  } catch {
    return [];
  }
}

async function fetchQuotesFromSecondaryProviders(symbols: string[]): Promise<MarketQuote[]> {
  const [stocksResult, cryptoResult] = await Promise.allSettled([
    fetchStockQuotesFromStooq(symbols),
    fetchCryptoQuotesFromCoinGecko(symbols),
  ]);

  const stocks = stocksResult.status === "fulfilled" ? stocksResult.value : [];
  const crypto = cryptoResult.status === "fulfilled" ? cryptoResult.value : [];

  const deduped = new Map<string, MarketQuote>();
  [...stocks, ...crypto].forEach((quote) => {
    if (!quote.symbol) return;
    if (!deduped.has(quote.symbol)) deduped.set(quote.symbol, quote);
  });
  return Array.from(deduped.values());
}

export async function fetchMarketQuotes(symbols: string[]): Promise<MarketQuote[]> {
  let sawRateLimit = false;

  // Try batch API first
  try {
    const results = await fetchQuotesBatch(symbols);
    if (results.length > 0) {
      console.log(`[MarketData] Batch fetched ${results.length} quotes.`);
      return results;
    }
  } catch (error) {
    if (error instanceof MarketRateLimitError) {
      sawRateLimit = true;
    }
    console.warn("[MarketData] Batch quote API failed, falling back to chart endpoint:", error);
  }

  // Fallback: fetch individual chart endpoints in parallel to avoid long sequential delays.
  const chartSettled = await Promise.allSettled(symbols.map((symbol) => fetchQuoteFromChart(symbol)));
  const chartQuotes = chartSettled
    .filter((result): result is PromiseFulfilledResult<MarketQuote | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((quote): quote is MarketQuote => Boolean(quote));
  chartSettled.forEach((result) => {
    if (result.status === "rejected" && result.reason instanceof MarketRateLimitError) {
      sawRateLimit = true;
    }
  });
  if (chartQuotes.length > 0) {
    console.log(`[MarketData] Chart fallback fetched ${chartQuotes.length} quotes.`);
    return chartQuotes;
  }

  // Secondary providers (no Yahoo): Stooq for stocks + CoinGecko for crypto.
  const secondaryQuotes = await fetchQuotesFromSecondaryProviders(symbols);
  if (secondaryQuotes.length > 0) {
    console.log(`[MarketData] Secondary providers fetched ${secondaryQuotes.length} quotes.`);
    return secondaryQuotes;
  }

  // Final fallback: finance.yahoo.com HTML quote pages.
  const pageSettled = await Promise.allSettled(symbols.map((symbol) => fetchQuoteFromPage(symbol)));
  const pageQuotes = pageSettled
    .filter((result): result is PromiseFulfilledResult<MarketQuote | null> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((quote): quote is MarketQuote => Boolean(quote));
  pageSettled.forEach((result) => {
    if (result.status === "rejected" && result.reason instanceof MarketRateLimitError) {
      sawRateLimit = true;
    }
  });
  console.log(`[MarketData] Page fallback fetched ${pageQuotes.length} quotes.`);
  if (pageQuotes.length === 0 && sawRateLimit) {
    throw new MarketRateLimitError("Yahoo rate limited market data requests.");
  }
  return pageQuotes;
}
