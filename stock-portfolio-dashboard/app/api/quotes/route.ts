import YahooFinance from "yahoo-finance2";
import { NextResponse } from "next/server";
import {
  calculateBollingerBands,
  calculateMacd,
  calculateRsi,
  calculateSharpeRatio,
  calculateSma,
} from "@/lib/indicators";
import type { QuotesResponse, StockRow } from "@/lib/types";

const LOOKBACK_DAYS = 120;
const MAX_SYMBOLS = 100;
const SYMBOL_CONCURRENCY = 6;
const BETA_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const BETA_NULL_RETRY_MS = 5 * 60 * 1000;
const yahooFinance = new YahooFinance({
  // Suppress non-fatal library notices in server logs.
  suppressNotices: ["ripHistorical", "yahooSurvey"],
});
const betaCache = new Map<string, { value: number | null; expiresAt: number }>();
const betaInFlight = new Map<string, Promise<number | null>>();

function parseSymbols(searchParams: URLSearchParams): string[] {
  const raw = searchParams.get("symbols");
  if (!raw) {
    return [];
  }

  // Normalize once here so all downstream calls use a clean ticker list.
  const deduped = new Set(
    raw
      .split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter(Boolean),
  );

  return Array.from(deduped).slice(0, MAX_SYMBOLS);
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNumberLike(value: unknown): number | null {
  const direct = readNumber(value);
  if (direct !== null) {
    return direct;
  }

  // Some Yahoo fields are wrapped as { raw, fmt } objects in summary endpoints.
  if (value && typeof value === "object" && "raw" in value) {
    return readNumber((value as { raw?: unknown }).raw);
  }
  return null;
}

function readYieldPercent(
  trailingAnnualDividendYield: unknown,
  dividendYield: unknown,
): number | null {
  const trailing = readNumber(trailingAnnualDividendYield);
  if (trailing !== null) {
    // trailingAnnualDividendYield is returned as a decimal (0.01 = 1%).
    return trailing * 100;
  }

  // dividendYield is often already represented as a percentage value.
  return readNumber(dividendYield);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Unknown Yahoo Finance error.";
}

type QuoteMetrics = {
  open: number | null;
  low: number | null;
  high: number | null;
  close: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  fiftyTwoWeekLow: number | null;
  fiftyTwoWeekHigh: number | null;
  marketCapOrNetAssets: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  beta: number | null;
  dividendOrDistributionYield: number | null;
};

type QuoteLike = {
  symbol?: string;
  regularMarketOpen?: number | null;
  regularMarketDayLow?: number | null;
  regularMarketDayHigh?: number | null;
  regularMarketPrice?: number | null;
  regularMarketChange?: number | null;
  regularMarketChangePercent?: number | null;
  regularMarketVolume?: number | null;
  fiftyTwoWeekLow?: number | null;
  fiftyTwoWeekHigh?: number | null;
  marketCap?: number | null;
  totalAssets?: number | null;
  netAssets?: number | null;
  trailingPE?: number | null;
  priceToBook?: number | null;
  beta?: number | null;
  trailingAnnualDividendYield?: number | null;
  dividendYield?: number | null;
};

type QuoteSummaryLike = {
  price?: {
    regularMarketOpen?: unknown;
    regularMarketDayLow?: unknown;
    regularMarketDayHigh?: unknown;
    regularMarketPrice?: unknown;
    regularMarketChange?: unknown;
    regularMarketChangePercent?: unknown;
    regularMarketVolume?: unknown;
    marketCap?: unknown;
  };
  summaryDetail?: {
    fiftyTwoWeekLow?: unknown;
    fiftyTwoWeekHigh?: unknown;
    trailingPE?: unknown;
    beta?: unknown;
    trailingAnnualDividendYield?: unknown;
    dividendYield?: unknown;
  };
  defaultKeyStatistics?: {
    priceToBook?: unknown;
    beta?: unknown;
  };
  financialData?: {
    totalAssets?: unknown;
    netAssets?: unknown;
  };
};

function readMarketCapOrNetAssets(quote: QuoteLike): number | null {
  // Prefer market cap for equities, then fall back to fund asset fields when available.
  return (
    readNumber(quote.marketCap) ??
    readNumber(quote.totalAssets) ??
    readNumber(quote.netAssets)
  );
}

function toQuoteMetrics(quote: QuoteLike): QuoteMetrics {
  return {
    open: readNumber(quote.regularMarketOpen),
    low: readNumber(quote.regularMarketDayLow),
    high: readNumber(quote.regularMarketDayHigh),
    close: readNumber(quote.regularMarketPrice),
    change: readNumber(quote.regularMarketChange),
    changePercent: readNumber(quote.regularMarketChangePercent),
    volume: readNumber(quote.regularMarketVolume),
    // Keep explicit range endpoints so UI can render "low - high".
    fiftyTwoWeekLow: readNumber(quote.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: readNumber(quote.fiftyTwoWeekHigh),
    marketCapOrNetAssets: readMarketCapOrNetAssets(quote),
    peRatio: readNumber(quote.trailingPE),
    pbRatio: readNumber(quote.priceToBook),
    beta: readNumberLike(quote.beta),
    dividendOrDistributionYield: readYieldPercent(
      quote.trailingAnnualDividendYield,
      quote.dividendYield,
    ),
  };
}

function toQuoteMetricsFromSummary(summary: QuoteSummaryLike): QuoteMetrics {
  const price = summary.price ?? {};
  const detail = summary.summaryDetail ?? {};
  const stats = summary.defaultKeyStatistics ?? {};
  const financial = summary.financialData ?? {};

  return {
    open: readNumberLike(price.regularMarketOpen),
    low: readNumberLike(price.regularMarketDayLow),
    high: readNumberLike(price.regularMarketDayHigh),
    close: readNumberLike(price.regularMarketPrice),
    change: readNumberLike(price.regularMarketChange),
    changePercent: readNumberLike(price.regularMarketChangePercent),
    volume: readNumberLike(price.regularMarketVolume),
    fiftyTwoWeekLow: readNumberLike(detail.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: readNumberLike(detail.fiftyTwoWeekHigh),
    marketCapOrNetAssets:
      readNumberLike(price.marketCap) ??
      readNumberLike(financial.totalAssets) ??
      readNumberLike(financial.netAssets),
    peRatio: readNumberLike(detail.trailingPE),
    pbRatio: readNumberLike(stats.priceToBook),
    beta: readNumberLike(detail.beta) ?? readNumberLike(stats.beta),
    dividendOrDistributionYield: readYieldPercent(
      detail.trailingAnnualDividendYield,
      detail.dividendYield,
    ),
  };
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

async function fetchQuoteMetrics(symbol: string) {
  try {
    const quote = (await yahooFinance.quote(symbol)) as QuoteLike;
    const beta = await fetchBetaFallback(symbol, readNumberLike(quote.beta));
    return {
      ...toQuoteMetrics(quote),
      beta,
    };
  } catch {
    // Fallback to quoteSummary when quote endpoint is throttled.
    const summary = (await yahooFinance.quoteSummary(symbol, {
      modules: ["price", "summaryDetail", "defaultKeyStatistics", "financialData"],
    })) as QuoteSummaryLike;
    const summaryMetrics = toQuoteMetricsFromSummary(summary);
    const beta = await fetchBetaFallback(symbol, summaryMetrics.beta);
    return {
      ...summaryMetrics,
      beta,
    };
  }
}

async function fetchBetaFallback(
  symbol: string,
  initialBeta: number | null,
): Promise<number | null> {
  const cacheKey = symbol.trim().toUpperCase();
  if (initialBeta !== null) {
    betaCache.set(cacheKey, {
      value: initialBeta,
      expiresAt: Date.now() + BETA_CACHE_TTL_MS,
    });
    return initialBeta;
  }

  const cached = betaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const existingRequest = betaInFlight.get(cacheKey);
  if (existingRequest) {
    return existingRequest;
  }

  const request = (async () => {
    try {
      const summary = (await yahooFinance.quoteSummary(cacheKey, {
        modules: ["summaryDetail", "defaultKeyStatistics"],
      })) as {
        summaryDetail?: { beta?: unknown };
        defaultKeyStatistics?: { beta?: unknown };
      };
      // Fallback to summary modules because quote() frequently omits beta.
      const beta =
        readNumberLike(summary.summaryDetail?.beta) ??
        readNumberLike(summary.defaultKeyStatistics?.beta);
      betaCache.set(cacheKey, {
        value: beta,
        expiresAt: Date.now() + (beta === null ? BETA_NULL_RETRY_MS : BETA_CACHE_TTL_MS),
      });
      return beta;
    } catch {
      // Cache short-lived null to prevent immediate retry loops under throttling.
      betaCache.set(cacheKey, {
        value: null,
        expiresAt: Date.now() + BETA_NULL_RETRY_MS,
      });
      return null;
    } finally {
      betaInFlight.delete(cacheKey);
    }
  })();

  betaInFlight.set(cacheKey, request);
  return request;
}

async function fetchQuoteMetricsBatch(symbols: string[]): Promise<Map<string, QuoteMetrics>> {
  if (symbols.length === 0) {
    return new Map();
  }

  // Batch quote lookup reduces request volume and prevents Yahoo 429 throttling.
  const quotesRaw = (await yahooFinance.quote(symbols)) as unknown;
  const quotes = Array.isArray(quotesRaw) ? (quotesRaw as QuoteLike[]) : [];
  const results = new Map<string, QuoteMetrics>();
  for (const quote of quotes) {
    const symbol = typeof quote.symbol === "string" ? quote.symbol.trim().toUpperCase() : "";
    if (!symbol) {
      continue;
    }
    results.set(symbol, toQuoteMetrics(quote));
  }
  return results;
}

async function fetchHistoricalIndicators(symbol: string, period1: Date, period2: Date) {
  const chart = await yahooFinance.chart(symbol, {
    period1,
    period2,
    interval: "1d",
  });
  const quotes = Array.isArray(chart?.quotes)
    ? (chart.quotes as Array<{ close?: number | null }>)
    : [];

  const closes = quotes
    .map((candle) => readNumber(candle.close))
    .filter((value): value is number => value !== null);

  // Some symbols can return sparse data, so indicators may intentionally be null.
  const macd = calculateMacd(closes, 12, 26, 9);
  const bollinger = calculateBollingerBands(closes, 20, 2);
  return {
    rsi14: calculateRsi(closes, 14),
    ma5: calculateSma(closes, 5),
    ma20: calculateSma(closes, 20),
    ma50: calculateSma(closes, 50),
    sharpeRatio: calculateSharpeRatio(closes),
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    bbUpper: bollinger.upper,
    bbMiddle: bollinger.middle,
    bbLower: bollinger.lower,
  };
}

async function buildStockRow(
  ticker: string,
  batchQuoteMetrics: Map<string, QuoteMetrics>,
  batchQuoteError: string | null,
): Promise<StockRow> {
  const period1 = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date();
  const alternateTicker = ticker.includes(".") ? ticker.replace(".", "-") : null;

  const row: StockRow = {
    ticker,
    open: null,
    low: null,
    high: null,
    close: null,
    change: null,
    changePercent: null,
    volume: null,
    fiftyTwoWeekLow: null,
    fiftyTwoWeekHigh: null,
    marketCapOrNetAssets: null,
    peRatio: null,
    pbRatio: null,
    beta: null,
    sharpeRatio: null,
    dividendOrDistributionYield: null,
    rsi14: null,
    ma5: null,
    ma20: null,
    ma50: null,
    macd: null,
    macdSignal: null,
    macdHistogram: null,
    bbUpper: null,
    bbMiddle: null,
    bbLower: null,
  };

  let quoteFailed = false;
  let historicalFailed = false;
  let quoteError = "";
  let historicalError = "";

  const preloadedQuote =
    batchQuoteMetrics.get(ticker) ??
    (alternateTicker ? batchQuoteMetrics.get(alternateTicker) : undefined);

  if (preloadedQuote) {
    Object.assign(row, preloadedQuote);
    if (row.beta === null) {
      // Batch quote data can omit beta; recover it lazily per symbol.
      row.beta = await fetchBetaFallback(ticker, null);
      if (row.beta === null && alternateTicker) {
        row.beta = await fetchBetaFallback(alternateTicker, null);
      }
    }
  } else {
    try {
      Object.assign(row, await fetchQuoteMetrics(ticker));
    } catch (error) {
      if (alternateTicker) {
        try {
          // Retry common class-share format (e.g. BRK.B -> BRK-B) for Yahoo compatibility.
          Object.assign(row, await fetchQuoteMetrics(alternateTicker));
        } catch (retryError) {
          quoteFailed = true;
          quoteError = readErrorMessage(retryError);
        }
      } else {
        quoteFailed = true;
        quoteError = readErrorMessage(error);
      }
    }
    if (quoteFailed && batchQuoteError) {
      quoteError = quoteError || batchQuoteError;
    }
  }

  try {
    Object.assign(row, await fetchHistoricalIndicators(ticker, period1, period2));
  } catch (error) {
    if (alternateTicker) {
      try {
        Object.assign(row, await fetchHistoricalIndicators(alternateTicker, period1, period2));
      } catch (retryError) {
        historicalFailed = true;
        historicalError = readErrorMessage(retryError);
      }
    } else {
      historicalFailed = true;
      historicalError = readErrorMessage(error);
    }
  }

  if (quoteFailed && historicalFailed) {
    row.error = `Unable to fetch data for this ticker. (${quoteError || historicalError})`;
  } else if (historicalFailed) {
    row.error = "Price data loaded, but indicators are temporarily unavailable.";
  }

  return row;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = parseSymbols(searchParams);

  if (symbols.length === 0) {
    return NextResponse.json<QuotesResponse>(
      { asOf: new Date().toISOString(), rows: [] },
      { status: 200 },
    );
  }

  // Include alternate Yahoo-compatible symbols so batch lookup can cover both variants.
  const quoteSymbols = Array.from(
    new Set(
      symbols.flatMap((ticker) =>
        ticker.includes(".") ? [ticker, ticker.replace(".", "-")] : [ticker],
      ),
    ),
  );
  let batchQuoteMetrics = new Map<string, QuoteMetrics>();
  let batchQuoteError: string | null = null;
  try {
    batchQuoteMetrics = await fetchQuoteMetricsBatch(quoteSymbols);
  } catch (error) {
    batchQuoteError = readErrorMessage(error);
  }

  const rows = await runWithConcurrency(symbols, SYMBOL_CONCURRENCY, (ticker) =>
    buildStockRow(ticker, batchQuoteMetrics, batchQuoteError),
  );

  return NextResponse.json<QuotesResponse>({
    asOf: new Date().toISOString(),
    rows,
  });
}
