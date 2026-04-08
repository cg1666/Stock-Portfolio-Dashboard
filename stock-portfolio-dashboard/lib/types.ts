export type StockRow = {
  ticker: string;
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
  sharpeRatio: number | null;
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

export type OptionsArbitrageRow = {
  ticker: string;
  exchange: string;
  closePrice: number;
  dividend: number;
  exDividendDate: string | null;
  putExpirationDate: string | null;
  putStrikePrice: number;
  putAskPrice: number;
  putAskSize: number;
  putLastPrice: number;
};

export type OptionsArbitrageResponse = {
  asOf: string;
  market: "us" | "ca";
  scannedSymbols: number;
  scannedTickers: string[];
  rows: OptionsArbitrageRow[];
  rejectedTickers: string[];
  failedTickers: string[];
};
