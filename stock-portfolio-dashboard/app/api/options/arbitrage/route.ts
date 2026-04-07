import YahooFinance from "yahoo-finance2";
import getCrumb from "yahoo-finance2/lib/getCrumb";
import { NextResponse } from "next/server";
import type { OptionsArbitrageResponse, OptionsArbitrageRow } from "@/lib/types";

const SYMBOL_CONCURRENCY = 10;
const SCREENER_PAGE_SIZE = 250;
const SYMBOL_CACHE_TTL_MS = 15 * 60 * 1000;
const EX_DIVIDEND_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const OPTION_REQUEST_TIMEOUT_MS = 6000;
const SUMMARY_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MAX_SCAN_SYMBOLS = 500;
const MAX_ALLOWED_SCAN_SYMBOLS = 3000;
const NASDAQ_TRADER_OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const SEC_TICKER_EXCHANGE_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const FALLBACK_SCREENER_IDS = [
  "most_actives",
  "day_gainers",
  "day_losers",
  "small_cap_gainers",
  "undervalued_large_caps",
  "undervalued_growth_stocks",
  "growth_technology_stocks",
  "portfolio_anchors",
  "most_shorted_stocks",
] as const;
const REQUEST_HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
};
const SCREENER_REFERER = "https://finance.yahoo.com/screener/equity/new";
const yahooFinance = new YahooFinance({
  suppressNotices: ["ripHistorical", "yahooSurvey"],
});
let nyseSymbolCache: { expiresAt: number; symbols: Map<string, string> } | null = null;
const exDividendCache = new Map<string, { value: string | null; expiresAt: number }>();

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIsoDateFromUnixSeconds(value: unknown): string | null {
  const seconds = readNumber(value);
  if (seconds === null) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function readIsoDate(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Yahoo can return unix seconds or unix milliseconds depending on endpoint.
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return null;
}

function isOnOrAfterToday(isoDate: string | null): boolean {
  if (!isoDate) {
    return true;
  }
  const date = new Date(isoDate);
  if (!Number.isFinite(date.getTime())) {
    return true;
  }
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  return dateStart >= todayStart;
}

async function runWithConcurrency<TItem, TResult>(
  items: TItem[],
  limit: number,
  task: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await task(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out")), timeoutMs);
    }),
  ]);
}

type YahooScreenerResponse = {
  finance?: {
    result?: Array<{
      total?: number;
      quotes?: Array<{ symbol?: string; exchange?: string }>;
    }>;
  };
};

async function getYahooCrumbAndCookieHeader() {
  const yfInternals = yahooFinance as unknown as {
    _opts: {
      logger?: unknown;
      cookieJar?: { getCookieString: (url: string, options?: { allPaths?: boolean }) => Promise<string> };
    };
    _notices?: unknown;
  };
  const cookieJar = yfInternals._opts?.cookieJar;
  if (!cookieJar) {
    throw new Error("Yahoo cookie jar is unavailable.");
  }
  const crumb = await getCrumb(
    cookieJar as never,
    global.fetch,
    { headers: REQUEST_HEADERS } as never,
    yfInternals._opts?.logger as never,
    yfInternals._notices as never,
  );
  if (!crumb) {
    throw new Error("Yahoo crumb was empty.");
  }

  return { crumb, cookieJar };
}

async function fetchNyseOptionableSymbolsFromYahoo(forceRefresh = false): Promise<Map<string, string>> {
  if (!forceRefresh && nyseSymbolCache && nyseSymbolCache.expiresAt > Date.now()) {
    return new Map(nyseSymbolCache.symbols);
  }

  try {
    const allNyseSymbols = await fetchNyseSymbolsFromNasdaqTrader();
    const { crumb, cookieJar } = await getYahooCrumbAndCookieHeader();
    const symbols = new Map<string, string>(allNyseSymbols);
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    while (offset < total) {
      const url = new URL("https://query2.finance.yahoo.com/v1/finance/screener");
      url.searchParams.set("crumb", crumb);
      url.searchParams.set("lang", "en-US");
      url.searchParams.set("region", "US");
      url.searchParams.set("formatted", "false");
      url.searchParams.set("corsDomain", "finance.yahoo.com");

      const cookie = await cookieJar.getCookieString(url.toString(), { allPaths: true });
      const payload = {
        size: SCREENER_PAGE_SIZE,
        offset,
        sortField: "intradaymarketcap",
        sortType: "DESC",
        quoteType: "EQUITY",
        // Restrict source universe to NYSE symbols that are optionable on Yahoo.
        query: {
          operator: "AND",
          operands: [
            { operator: "EQ", operands: ["exchange", "NYQ"] },
            { operator: "EQ", operands: ["optionable", true] },
          ],
        },
      };

      const response = await fetch(url, {
        method: "POST",
        cache: "no-store",
        headers: {
          ...REQUEST_HEADERS,
          "content-type": "application/json",
          cookie,
          origin: "https://finance.yahoo.com",
          referer: SCREENER_REFERER,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error("Failed to fetch NYSE optionable symbols from Yahoo screener.");
      }

      const data = (await response.json()) as YahooScreenerResponse;
      const result = data.finance?.result?.[0];
      if (!result) {
        break;
      }

      const pageQuotes = result.quotes ?? [];
      for (const quote of pageQuotes) {
        const symbol = typeof quote.symbol === "string" ? quote.symbol.trim().toUpperCase() : "";
        if (symbol) {
          symbols.set(symbol, "NYSE");
        }
      }

      total = typeof result.total === "number" && Number.isFinite(result.total) ? result.total : 0;
      if (pageQuotes.length === 0) {
        break;
      }
      offset += pageQuotes.length;
    }

    nyseSymbolCache = {
      expiresAt: Date.now() + SYMBOL_CACHE_TTL_MS,
      symbols,
    };
    return new Map(symbols);
  } catch {
    const fallbackSymbols = await fetchNyseSymbolsFallback();
    const allNyseSymbols = await fetchNyseSymbolsFromNasdaqTrader();
    for (const [symbol, exchange] of allNyseSymbols.entries()) {
      fallbackSymbols.set(symbol, exchange);
    }
    nyseSymbolCache = {
      expiresAt: Date.now() + SYMBOL_CACHE_TTL_MS,
      symbols: fallbackSymbols,
    };
    return new Map(fallbackSymbols);
  }
}

type FallbackScreenerQuote = {
  symbol?: string;
  exchange?: string;
  quoteType?: string;
};

async function fetchNyseSymbolsFallback(): Promise<Map<string, string>> {
  const symbols = new Map<string, string>();

  await Promise.all(
    FALLBACK_SCREENER_IDS.map(async (screenId) => {
      try {
        const result = (await yahooFinance.screener({
          scrIds: screenId,
          count: 250,
        })) as { quotes?: FallbackScreenerQuote[] };
        const quotes = Array.isArray(result.quotes) ? result.quotes : [];
        for (const quote of quotes) {
          const symbol = typeof quote.symbol === "string" ? quote.symbol.trim().toUpperCase() : "";
          if (!symbol) {
            continue;
          }
          // Keep NYSE equities only in fallback mode.
          if (quote.exchange === "NYQ" && quote.quoteType === "EQUITY") {
            symbols.set(symbol, "NYSE");
          }
        }
      } catch {
        // Ignore individual screener failures so one bad feed does not kill all fallback symbols.
      }
    }),
  );

  return symbols;
}

async function fetchNyseSymbolsFromNasdaqTrader(): Promise<Map<string, string>> {
  const symbols = new Map<string, string>();

  try {
    const response = await fetch(NASDAQ_TRADER_OTHER_LISTED_URL, {
      cache: "no-store",
      headers: REQUEST_HEADERS,
    });
    if (!response.ok) {
      return symbols;
    }

    const text = await response.text();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line || line.startsWith("ACT Symbol|") || line.startsWith("File Creation Time")) {
        continue;
      }
      const parts = line.split("|");
      if (parts.length < 3) {
        continue;
      }

      const symbol = parts[0]?.trim().toUpperCase() ?? "";
      const exchangeCode = parts[2]?.trim().toUpperCase() ?? "";
      // otherlisted.txt uses "N" for NYSE.
      if (exchangeCode !== "N") {
        continue;
      }
      if (!symbol || symbol.includes("$") || symbol.includes("^") || symbol.includes("=")) {
        continue;
      }
      symbols.set(symbol, "NYSE");
    }
  } catch {
    // Fall through to SEC fallback below.
  }

  if (symbols.size > 0) {
    return symbols;
  }

  return fetchNyseSymbolsFromSec();
}

type SecTickerExchangeResponse = {
  data?: Array<[number | string, string, string, string]>;
};

async function fetchNyseSymbolsFromSec(): Promise<Map<string, string>> {
  const symbols = new Map<string, string>();
  try {
    const response = await fetch(SEC_TICKER_EXCHANGE_URL, {
      cache: "no-store",
      headers: REQUEST_HEADERS,
    });
    if (!response.ok) {
      return symbols;
    }

    const data = (await response.json()) as SecTickerExchangeResponse;
    const rows = Array.isArray(data.data) ? data.data : [];
    for (const row of rows) {
      // SEC dataset order: [cik, name, ticker, exchange].
      const ticker = typeof row[2] === "string" ? row[2].trim().toUpperCase() : "";
      const exchange = typeof row[3] === "string" ? row[3].trim().toUpperCase() : "";
      if (exchange !== "NYSE") {
        continue;
      }
      if (!ticker || ticker.includes("$") || ticker.includes("^") || ticker.includes("=")) {
        continue;
      }
      symbols.set(ticker, "NYSE");
    }
  } catch {
    return symbols;
  }

  return symbols;
}

type YahooOptionChainResponse = {
  quote?: {
    regularMarketPrice?: number;
    trailingAnnualDividendRate?: number;
    exDividendDate?: unknown;
  };
  options?: Array<{
    puts?: Array<{ strike?: number; ask?: number; lastPrice?: number }>;
  }>;
};

type PutScanResult = {
  symbol: string;
  qualifiedRow: OptionsArbitrageRow | null;
  evaluated: boolean;
};

async function fetchExDividendDateFallback(symbolCandidates: string[]): Promise<string | null> {
  for (const candidate of symbolCandidates) {
    const cacheKey = candidate.toUpperCase();
    const cached = exDividendCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.value) {
        return cached.value;
      }
      continue;
    }

    try {
      const summary = (await withTimeout(
        yahooFinance.quoteSummary(candidate, {
          modules: ["summaryDetail", "calendarEvents"],
        }) as Promise<{
          summaryDetail?: { exDividendDate?: unknown };
          calendarEvents?: { exDividendDate?: unknown };
        }>,
        SUMMARY_REQUEST_TIMEOUT_MS,
      )) as {
        summaryDetail?: { exDividendDate?: unknown };
        calendarEvents?: { exDividendDate?: unknown };
      };
      const exDividendDate =
        readIsoDate(summary.summaryDetail?.exDividendDate) ??
        readIsoDate(summary.calendarEvents?.exDividendDate);
      exDividendCache.set(cacheKey, {
        value: exDividendDate,
        expiresAt: Date.now() + EX_DIVIDEND_CACHE_TTL_MS,
      });
      if (exDividendDate) {
        return exDividendDate;
      }
    } catch {
      exDividendCache.set(cacheKey, {
        value: null,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    }
  }

  return null;
}

async function scanPutCondition(symbol: string, exchange: string): Promise<PutScanResult> {
  try {
    const optionSymbolsToTry = symbol.includes(".")
      ? [symbol, symbol.replace(".", "-")]
      : [symbol, symbol.replace("-", ".")];
    let evaluated = false;

    for (const candidate of optionSymbolsToTry) {
      try {
        const data = (await withTimeout(
          yahooFinance.options(candidate) as Promise<YahooOptionChainResponse>,
          OPTION_REQUEST_TIMEOUT_MS,
        )) as YahooOptionChainResponse;
        const quote = data.quote;
        const closePrice = readNumber(quote?.regularMarketPrice);
        if (closePrice === null) {
          continue;
        }
        const dividend = readNumber(quote?.trailingAnnualDividendRate) ?? 0;
        if (dividend <= 0) {
          // Skip non-dividend symbols per options table requirement.
          return { symbol, qualifiedRow: null, evaluated: true };
        }
        let exDividendDate = readIsoDate(quote?.exDividendDate) ?? readIsoDateFromUnixSeconds(quote?.exDividendDate);
        const puts = data.options?.[0]?.puts ?? [];

        let bestMatch: { strike: number; ask: number; lastPrice: number; edge: number } | null = null;

        for (const put of puts) {
          const strike = readNumber(put.strike);
          const ask = readNumber(put.ask);
          const lastPrice = readNumber(put.lastPrice) ?? 0;
          if (strike === null || ask === null) {
            continue;
          }

          const leftSide = strike + dividend;
          const rightSide = closePrice + ask;
          if (leftSide <= rightSide) {
            continue;
          }

          const edge = leftSide - rightSide;
          if (!bestMatch || edge > bestMatch.edge) {
            bestMatch = { strike, ask, lastPrice, edge };
          }
        }

        evaluated = true;
        if (!bestMatch) {
          continue;
        }
        if (!exDividendDate) {
          // Options quote feed often omits ex-dividend date; fill from quote summary modules.
          exDividendDate = await fetchExDividendDateFallback(optionSymbolsToTry);
        }
        if (!isOnOrAfterToday(exDividendDate)) {
          // Ignore stale ex-dividend opportunities whose ex-date already passed.
          return { symbol, qualifiedRow: null, evaluated: true };
        }

        return {
          symbol,
          evaluated: true,
          qualifiedRow: {
            ticker: symbol,
            exchange,
            closePrice,
            dividend,
            exDividendDate,
            putStrikePrice: bestMatch.strike,
            putAskPrice: bestMatch.ask,
            putLastPrice: bestMatch.lastPrice,
          },
        };
      } catch {
        // Try the alternate Yahoo symbol format before failing this ticker.
      }
    }
    return { symbol, qualifiedRow: null, evaluated };
  } catch {
    return { symbol, qualifiedRow: null, evaluated: false };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawMarket = (searchParams.get("market") ?? "us").trim().toLowerCase();
  const forceRefresh = searchParams.get("refresh") === "1";
  const requestedMaxScan = Number(searchParams.get("maxScan") ?? DEFAULT_MAX_SCAN_SYMBOLS);
  const maxScanSymbols = Number.isFinite(requestedMaxScan)
    ? Math.max(50, Math.min(MAX_ALLOWED_SCAN_SYMBOLS, Math.floor(requestedMaxScan)))
    : DEFAULT_MAX_SCAN_SYMBOLS;
  if (searchParams.get("debugSymbols") === "1") {
    const symbols = await fetchNyseSymbolsFromNasdaqTrader();
    return NextResponse.json({
      source: "nyse-listing",
      count: symbols.size,
      hasTRP: symbols.has("TRP"),
      hasSU: symbols.has("SU"),
      hasBRKA: symbols.has("BRK-A"),
    });
  }
  if (rawMarket !== "us" && rawMarket !== "ca") {
    return NextResponse.json({ error: "Invalid market. Use 'us' or 'ca'." }, { status: 400 });
  }
  const market = rawMarket as "us" | "ca";

  if (market === "ca") {
    return NextResponse.json<OptionsArbitrageResponse>({
      asOf: new Date().toISOString(),
      market,
      scannedSymbols: 0,
      scannedTickers: [],
      rows: [],
      rejectedTickers: [],
    });
  }

  const exchangeMap = await fetchNyseOptionableSymbolsFromYahoo(forceRefresh);
  const symbolsWithExchange = Array.from(exchangeMap.entries())
    .map(([symbol, exchange]) => ({
      symbol,
      exchange,
    }))
    .slice(0, maxScanSymbols);
  const scannedTickers = symbolsWithExchange
    .map((item) => item.symbol)
    .sort((left, right) => left.localeCompare(right));
  const scanResults = await runWithConcurrency(symbolsWithExchange, SYMBOL_CONCURRENCY, (item) =>
    scanPutCondition(item.symbol, item.exchange),
  );

  const rows = scanResults
    .map((result) => result.qualifiedRow)
    .filter((row): row is OptionsArbitrageRow => row !== null)
    .sort((left, right) => left.ticker.localeCompare(right.ticker));
  const rejectedTickers = scanResults
    .filter((result) => result.evaluated && result.qualifiedRow === null)
    .map((result) => result.symbol)
    .sort((left, right) => left.localeCompare(right));

  return NextResponse.json<OptionsArbitrageResponse>({
    asOf: new Date().toISOString(),
    market,
    scannedSymbols: symbolsWithExchange.length,
    scannedTickers,
    rows,
    rejectedTickers,
  });
}
