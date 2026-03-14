import YahooFinance from "yahoo-finance2";
import { NextResponse } from "next/server";
import {
  calculateBollingerBands,
  calculateMacd,
  calculateRsi,
  calculateSma,
} from "@/lib/indicators";
import type { QuotesResponse, StockRow } from "@/lib/types";

const LOOKBACK_DAYS = 120;
const MAX_SYMBOLS = 100;
const SYMBOL_CONCURRENCY = 6;
const yahooFinance = new YahooFinance({
  // Suppress non-fatal library notices in server logs.
  suppressNotices: ["ripHistorical", "yahooSurvey"],
});

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
  const quoteRaw = await yahooFinance.quote(symbol);
  const quote = quoteRaw as {
    regularMarketOpen?: number | null;
    regularMarketDayLow?: number | null;
    regularMarketDayHigh?: number | null;
    regularMarketPrice?: number | null;
    regularMarketChange?: number | null;
    regularMarketChangePercent?: number | null;
    regularMarketVolume?: number | null;
    trailingPE?: number | null;
    priceToBook?: number | null;
    trailingAnnualDividendYield?: number | null;
    dividendYield?: number | null;
  };

  return {
    open: readNumber(quote.regularMarketOpen),
    low: readNumber(quote.regularMarketDayLow),
    high: readNumber(quote.regularMarketDayHigh),
    close: readNumber(quote.regularMarketPrice),
    change: readNumber(quote.regularMarketChange),
    changePercent: readNumber(quote.regularMarketChangePercent),
    volume: readNumber(quote.regularMarketVolume),
    peRatio: readNumber(quote.trailingPE),
    pbRatio: readNumber(quote.priceToBook),
    dividendOrDistributionYield: readYieldPercent(
      quote.trailingAnnualDividendYield,
      quote.dividendYield,
    ),
  };
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
    macd: macd.macd,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    bbUpper: bollinger.upper,
    bbMiddle: bollinger.middle,
    bbLower: bollinger.lower,
  };
}

async function buildStockRow(ticker: string): Promise<StockRow> {
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
    peRatio: null,
    pbRatio: null,
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

  const rows = await runWithConcurrency(symbols, SYMBOL_CONCURRENCY, (ticker) =>
    buildStockRow(ticker),
  );

  return NextResponse.json<QuotesResponse>({
    asOf: new Date().toISOString(),
    rows,
  });
}
