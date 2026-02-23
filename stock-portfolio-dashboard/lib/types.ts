export type StockRow = {
  ticker: string;
  open: number | null;
  low: number | null;
  high: number | null;
  close: number | null;
  volume: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  dividendOrDistributionYield: number | null;
  rsi14: number | null;
  ma5: number | null;
  ma20: number | null;
  ma50: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHistogram: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  error?: string;
};

export type QuotesResponse = {
  asOf: string;
  rows: StockRow[];
};
