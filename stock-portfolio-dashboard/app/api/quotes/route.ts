import YahooFinance from "yahoo-finance2";
import { NextResponse } from "next/server";
import { calculateRsi, calculateSma } from "@/lib/indicators";
import type { QuotesResponse, StockRow } from "@/lib/types";

const LOOKBACK_DAYS = 120;
const MAX_SYMBOLS = 30;
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

async function buildStockRow(ticker: string): Promise<StockRow> {
  const period1 = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const period2 = new Date();

  const row: StockRow = {
    ticker,
    open: null,
    low: null,
    high: null,
    close: null,
    volume: null,
    peRatio: null,
    pbRatio: null,
    dividendOrDistributionYield: null,
    rsi14: null,
    ma5: null,
    ma20: null,
    ma50: null,
  };

  let quoteFailed = false;
  let historicalFailed = false;
  let quoteError = "";
  let historicalError = "";

  try {
    const quoteRaw = await yahooFinance.quote(ticker);
    const quote = quoteRaw as {
      regularMarketOpen?: number | null;
      regularMarketDayLow?: number | null;
      regularMarketDayHigh?: number | null;
      regularMarketPrice?: number | null;
      regularMarketVolume?: number | null;
      trailingPE?: number | null;
      priceToBook?: number | null;
      trailingAnnualDividendYield?: number | null;
      dividendYield?: number | null;
    };

    row.open = readNumber(quote.regularMarketOpen);
    row.low = readNumber(quote.regularMarketDayLow);
    row.high = readNumber(quote.regularMarketDayHigh);
    row.close = readNumber(quote.regularMarketPrice);
    row.volume = readNumber(quote.regularMarketVolume);
    row.peRatio = readNumber(quote.trailingPE);
    row.pbRatio = readNumber(quote.priceToBook);
    row.dividendOrDistributionYield = readYieldPercent(
      quote.trailingAnnualDividendYield,
      quote.dividendYield,
    );
  } catch (error) {
    quoteFailed = true;
    quoteError = readErrorMessage(error);
  }

  try {
    const historicalRaw = await yahooFinance.historical(ticker, {
      period1,
      period2,
      interval: "1d",
    });
    const historical = Array.isArray(historicalRaw)
      ? (historicalRaw as Array<{ close?: number | null }>)
      : [];

    const closes = historical
      .map((candle) => readNumber(candle.close))
      .filter((value): value is number => value !== null);

    // Some symbols can return sparse data, so indicators may intentionally be null.
    row.rsi14 = calculateRsi(closes, 14);
    row.ma5 = calculateSma(closes, 5);
    row.ma20 = calculateSma(closes, 20);
    row.ma50 = calculateSma(closes, 50);
  } catch (error) {
    historicalFailed = true;
    historicalError = readErrorMessage(error);
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

  const rows = await Promise.all(symbols.map((ticker) => buildStockRow(ticker)));

  return NextResponse.json<QuotesResponse>({
    asOf: new Date().toISOString(),
    rows,
  });
}
