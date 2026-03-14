import YahooFinance from "yahoo-finance2";
import { NextResponse } from "next/server";

type PeriodOption = "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "max";

const PERIODS: PeriodOption[] = ["1mo", "3mo", "6mo", "1y", "2y", "5y", "max"];
const yahooFinance = new YahooFinance({
  suppressNotices: ["ripHistorical", "yahooSurvey"],
});

function parsePeriod(value: string | null): PeriodOption {
  if (!value) {
    return "6mo";
  }
  return PERIODS.includes(value as PeriodOption) ? (value as PeriodOption) : "6mo";
}

function periodStart(period: PeriodOption): Date {
  const now = new Date();
  const date = new Date(now);

  // Translate period shortcuts into an explicit date window.
  switch (period) {
    case "1mo":
      date.setMonth(date.getMonth() - 1);
      return date;
    case "3mo":
      date.setMonth(date.getMonth() - 3);
      return date;
    case "6mo":
      date.setMonth(date.getMonth() - 6);
      return date;
    case "1y":
      date.setFullYear(date.getFullYear() - 1);
      return date;
    case "2y":
      date.setFullYear(date.getFullYear() - 2);
      return date;
    case "5y":
      date.setFullYear(date.getFullYear() - 5);
      return date;
    case "max":
      return new Date("1970-01-01T00:00:00.000Z");
    default:
      return date;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawSymbol = searchParams.get("symbol");
  const symbol = rawSymbol?.trim().toUpperCase();
  const period = parsePeriod(searchParams.get("period"));

  if (!symbol) {
    return NextResponse.json({ error: "Missing symbol query parameter." }, { status: 400 });
  }

  const period1 = periodStart(period);
  const period2 = new Date();

  try {
    const chart = await yahooFinance.chart(symbol, {
      period1,
      period2,
      interval: "1d",
    });

    const quotes = Array.isArray(chart?.quotes)
      ? (chart.quotes as Array<{
          date?: Date;
          open?: number | null;
          high?: number | null;
          low?: number | null;
          close?: number | null;
          volume?: number | null;
        }>)
      : [];

    const candles = quotes
      .map((quote) => {
        if (
          !quote.date ||
          quote.open === null ||
          quote.high === null ||
          quote.low === null ||
          quote.close === null ||
          quote.open === undefined ||
          quote.high === undefined ||
          quote.low === undefined ||
          quote.close === undefined
        ) {
          return null;
        }
        return {
          time: quote.date.toISOString(),
          open: quote.open,
          high: quote.high,
          low: quote.low,
          close: quote.close,
          volume: typeof quote.volume === "number" && Number.isFinite(quote.volume) ? quote.volume : 0,
        };
      })
      .filter((candle): candle is NonNullable<typeof candle> => candle !== null);

    return NextResponse.json({
      symbol,
      period,
      asOf: new Date().toISOString(),
      candles,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load chart data.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
