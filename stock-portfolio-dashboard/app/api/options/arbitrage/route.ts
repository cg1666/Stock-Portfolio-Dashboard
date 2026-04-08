import { createHash } from "crypto";
import { NextResponse } from "next/server";
import type { OptionsArbitrageResponse, OptionsArbitrageRow } from "@/lib/types";

const SYMBOL_CONCURRENCY = 8;
const SYMBOL_CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SCAN_SYMBOLS = 3000;
const MAX_ALLOWED_SCAN_SYMBOLS = 10000;

const NASDAQ_TRADER_OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const NASDAQ_TRADER_NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const SEC_TICKER_EXCHANGE_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

const TMX_GRAPHQL_URL = "https://app-money.tmx.com/graphql";
const QUOTEMEDIA_AUTH_BASE_URL = "https://app.quotemedia.com/auth/g/authenticate/dataTool/v0";
const QUOTEMEDIA_DATATOOL_BASE_URL = "https://app.quotemedia.com/datatool";
const QUOTEMEDIA_WEBMASTER_ID = "101020";
const QUOTEMEDIA_OPTIONS_TOOL_NAME = "options";
const QUOTEMEDIA_TOKEN_TTL_MS = 8 * 60 * 1000;

const REQUEST_HEADERS = {
  accept: "application/json",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  origin: "https://money.tmx.com",
  referer: "https://money.tmx.com/",
};

let nyseSymbolCache: { expiresAt: number; symbols: Map<string, string> } | null = null;
let quoteMediaTokenCache: { token: string; expiresAt: number } | null = null;

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function isStrictlyAfterDate(leftIsoDate: string | null, rightIsoDate: string | null): boolean {
  if (!leftIsoDate || !rightIsoDate) {
    return false;
  }
  const leftDate = new Date(leftIsoDate);
  const rightDate = new Date(rightIsoDate);
  if (!Number.isFinite(leftDate.getTime()) || !Number.isFinite(rightDate.getTime())) {
    return false;
  }

  // Compare at date granularity so timezone offsets do not flip same-day values.
  const leftStart = new Date(leftDate.getFullYear(), leftDate.getMonth(), leftDate.getDate()).getTime();
  const rightStart = new Date(
    rightDate.getFullYear(),
    rightDate.getMonth(),
    rightDate.getDate(),
  ).getTime();
  return leftStart > rightStart;
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

async function fetchNyseOptionableSymbols(forceRefresh = false): Promise<Map<string, string>> {
  if (!forceRefresh && nyseSymbolCache && nyseSymbolCache.expiresAt > Date.now()) {
    return new Map(nyseSymbolCache.symbols);
  }

  try {
    const symbols = await fetchNyseSymbolsFromNasdaqTrader();
    nyseSymbolCache = {
      expiresAt: Date.now() + SYMBOL_CACHE_TTL_MS,
      symbols,
    };
    return new Map(symbols);
  } catch {
    const symbols = await fetchNyseSymbolsFromSec();
    nyseSymbolCache = {
      expiresAt: Date.now() + SYMBOL_CACHE_TTL_MS,
      symbols,
    };
    return new Map(symbols);
  }
}

async function fetchNyseSymbolsFromNasdaqTrader(): Promise<Map<string, string>> {
  const symbols = new Map<string, string>();

  try {
    const otherListedResponse = await fetch(NASDAQ_TRADER_OTHER_LISTED_URL, {
      cache: "no-store",
      headers: {
        ...REQUEST_HEADERS,
        // NasdaqTrader serves this as plain text; JSON-only accept headers get rejected.
        accept: "text/plain,*/*",
      },
    });
    const nasdaqListedResponse = await fetch(NASDAQ_TRADER_NASDAQ_LISTED_URL, {
      cache: "no-store",
      headers: {
        ...REQUEST_HEADERS,
        accept: "text/plain,*/*",
      },
    });

    const otherListedText = otherListedResponse.ok ? await otherListedResponse.text() : "";
    const otherListedLines = otherListedText.split(/\r?\n/);
    for (const line of otherListedLines) {
      if (!line || line.startsWith("ACT Symbol|") || line.startsWith("File Creation Time")) {
        continue;
      }
      const parts = line.split("|");
      if (parts.length < 3) {
        continue;
      }

      const symbol = parts[0]?.trim().toUpperCase() ?? "";
      const exchangeCode = parts[2]?.trim().toUpperCase() ?? "";
      // otherlisted.txt uses "N" for NYSE listings.
      if (exchangeCode !== "N") {
        continue;
      }
      if (!symbol || symbol.includes("$") || symbol.includes("^") || symbol.includes("=")) {
        continue;
      }
      symbols.set(symbol, "NYSE");
    }

    const nasdaqListedText = nasdaqListedResponse.ok ? await nasdaqListedResponse.text() : "";
    const nasdaqListedLines = nasdaqListedText.split(/\r?\n/);
    for (const line of nasdaqListedLines) {
      if (!line || line.startsWith("Symbol|") || line.startsWith("File Creation Time")) {
        continue;
      }
      const parts = line.split("|");
      if (parts.length < 1) {
        continue;
      }
      const symbol = parts[0]?.trim().toUpperCase() ?? "";
      if (!symbol || symbol.includes("$") || symbol.includes("^") || symbol.includes("=")) {
        continue;
      }
      symbols.set(symbol, "NASDAQ");
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
      const ticker = typeof row[2] === "string" ? row[2].trim().toUpperCase() : "";
      const exchange = typeof row[3] === "string" ? row[3].trim().toUpperCase() : "";
      if (exchange !== "NYSE" && exchange !== "NASDAQ") {
        continue;
      }
      if (!ticker || ticker.includes("$") || ticker.includes("^") || ticker.includes("=")) {
        continue;
      }
      symbols.set(ticker, exchange);
    }
  } catch {
    return symbols;
  }
  return symbols;
}

type QuoteMediaOptionQuote = {
  expiration?: string | number | Date;
  expiry?: string | number | Date;
  expiryDate?: string | number | Date;
  expirydate?: string | number | Date;
  expirationDate?: string | number | Date;
  date?: string | number | Date;
  contract?: {
    callput?: string;
    strike?: number;
    expiration?: string | number | Date;
    expiry?: string | number | Date;
    expiryDate?: string | number | Date;
    expirydate?: string | number | Date;
    expirationDate?: string | number | Date;
    expDate?: string | number | Date;
    expdate?: string | number | Date;
    maturityDate?: string | number | Date;
  };
  pricedata?: {
    ask?: number;
    asksize?: number;
    last?: number;
  };
};

type QuoteMediaOptionsResponse = {
  results?: {
    expiryGroup?: Array<{
      expiration?: string | number | Date;
      expiry?: string | number | Date;
      expiryDate?: string | number | Date;
      expirydate?: string | number | Date;
      expirationDate?: string | number | Date;
      date?: string | number | Date;
      callputgroup?: Array<{
        quote?: QuoteMediaOptionQuote[];
      }>;
    }>;
  };
};

type TmxGraphQuoteBySymbolResponse = {
  data?: {
    getQuoteBySymbol?: {
      price?: number;
      exchangeCode?: string;
      exchangeName?: string;
      dividendAmount?: number;
      exDividendDate?: string;
    } | null;
  };
};

type TmxQuoteMetrics = {
  closePrice: number | null;
  dividend: number;
  exDividendDate: string | null;
  exchange: string;
};

type PutScanResult = {
  symbol: string;
  qualifiedRow: OptionsArbitrageRow | null;
  evaluated: boolean;
};

function toTmxUsSymbol(symbol: string): string {
  return symbol.includes(":") ? symbol : `${symbol}:US`;
}

function normalizeUsExchangeName(exchangeName: unknown, exchangeCode: unknown): string {
  const code = typeof exchangeCode === "string" ? exchangeCode.trim().toUpperCase() : "";
  if (code === "NYSE" || code === "NYS" || code === "NYQ") {
    return "NYSE";
  }
  if (code === "NASDAQ" || code === "NAS" || code === "NGM" || code === "NMS") {
    return "NASDAQ";
  }
  if (code === "AMEX" || code === "ASE") {
    return "AMEX";
  }

  const name = typeof exchangeName === "string" ? exchangeName.trim().toUpperCase() : "";
  if (name.includes("NEW YORK")) {
    return "NYSE";
  }
  if (name.includes("NASDAQ")) {
    return "NASDAQ";
  }
  if (name.includes("AMERICAN")) {
    return "AMEX";
  }
  return "NYSE";
}

type PutContractCandidate = {
  quote: QuoteMediaOptionQuote;
  expirationDate: string | null;
};

function readExpiryIsoDate(expiryGroup: {
  expiration?: string | number | Date;
  expiry?: string | number | Date;
  expiryDate?: string | number | Date;
  expirydate?: string | number | Date;
  expirationDate?: string | number | Date;
  date?: string | number | Date;
}): string | null {
  // QuoteMedia/TMX can vary the field name for expiration; probe common variants.
  return (
    readIsoDate(expiryGroup.expirationDate) ??
    readIsoDate(expiryGroup.expiryDate) ??
    readIsoDate(expiryGroup.expirydate) ??
    readIsoDate(expiryGroup.expiration) ??
    readIsoDate(expiryGroup.expiry) ??
    readIsoDate(expiryGroup.date)
  );
}

function readQuoteExpiryIsoDate(quote: QuoteMediaOptionQuote): string | null {
  // Different QuoteMedia payloads place expiry on either quote-level or contract-level fields.
  return (
    readIsoDate(quote.contract?.expirationDate) ??
    readIsoDate(quote.contract?.expiryDate) ??
    readIsoDate(quote.contract?.expirydate) ??
    readIsoDate(quote.contract?.expDate) ??
    readIsoDate(quote.contract?.expdate) ??
    readIsoDate(quote.contract?.maturityDate) ??
    readIsoDate(quote.contract?.expiration) ??
    readIsoDate(quote.contract?.expiry) ??
    readIsoDate(quote.expirationDate) ??
    readIsoDate(quote.expiryDate) ??
    readIsoDate(quote.expirydate) ??
    readIsoDate(quote.expiration) ??
    readIsoDate(quote.expiry) ??
    readIsoDate(quote.date)
  );
}

function extractPutContracts(data: QuoteMediaOptionsResponse): PutContractCandidate[] {
  const puts: PutContractCandidate[] = [];
  const groups = data.results?.expiryGroup ?? [];
  for (const expiryGroup of groups) {
    const expirationDate = readExpiryIsoDate(expiryGroup);
    const callPutGroups = expiryGroup.callputgroup ?? [];
    for (const callPutGroup of callPutGroups) {
      const quotes = callPutGroup.quote ?? [];
      for (const quote of quotes) {
        const callPut = (quote.contract?.callput ?? "").toLowerCase();
        if (callPut === "put") {
          const quoteExpirationDate = readQuoteExpiryIsoDate(quote);
          puts.push({ quote, expirationDate: quoteExpirationDate ?? expirationDate });
        }
      }
    }
  }
  return puts;
}

async function getQuoteMediaToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && quoteMediaTokenCache && quoteMediaTokenCache.expiresAt > Date.now()) {
    return quoteMediaTokenCache.token;
  }

  const toolHash = createHash("sha256").update(QUOTEMEDIA_OPTIONS_TOOL_NAME).digest("hex");
  const authUrl = `${QUOTEMEDIA_AUTH_BASE_URL}/${QUOTEMEDIA_WEBMASTER_ID}/${toolHash}`;
  const response = await fetch(authUrl, {
    method: "POST",
    cache: "no-store",
    headers: REQUEST_HEADERS,
  });
  if (!response.ok) {
    throw new Error("Unable to authenticate TMX options data source.");
  }

  const authJson = (await response.json()) as { token?: string };
  const token = typeof authJson.token === "string" ? authJson.token : "";
  if (!token) {
    throw new Error("TMX options authentication returned no token.");
  }

  quoteMediaTokenCache = {
    token,
    expiresAt: Date.now() + QUOTEMEDIA_TOKEN_TTL_MS,
  };
  return token;
}

async function fetchQuoteMediaDataToolJson<T>(
  endpointName: string,
  params: Record<string, string | number | boolean>,
): Promise<T> {
  const doRequest = async (forceRefreshToken: boolean) => {
    const token = await getQuoteMediaToken(forceRefreshToken);
    const url = new URL(`${QUOTEMEDIA_DATATOOL_BASE_URL}/${endpointName}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set("webmasterId", QUOTEMEDIA_WEBMASTER_ID);
    url.searchParams.set("token", token);
    return await fetch(url, {
      cache: "no-store",
      headers: REQUEST_HEADERS,
    });
  };

  let response = await doRequest(false);
  if (response.status === 403) {
    // Token expires periodically; refresh once before failing.
    response = await doRequest(true);
  }
  if (!response.ok) {
    throw new Error(`TMX data endpoint failed: ${endpointName}`);
  }
  return (await response.json()) as T;
}

async function fetchTmxQuoteMetrics(symbolUs: string): Promise<TmxQuoteMetrics> {
  const query = `
    query GetQuoteBySymbol($symbol: String, $locale: String) {
      getQuoteBySymbol(symbol: $symbol, locale: $locale) {
        price
        exchangeCode
        exchangeName
        dividendAmount
        exDividendDate
      }
    }
  `;

  try {
    const response = await fetch(TMX_GRAPHQL_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        ...REQUEST_HEADERS,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: {
          symbol: symbolUs,
          locale: "en",
        },
      }),
    });
    if (!response.ok) {
      return { closePrice: null, dividend: 0, exDividendDate: null, exchange: "NYSE" };
    }

    const json = (await response.json()) as TmxGraphQuoteBySymbolResponse;
    const quote = json.data?.getQuoteBySymbol;
    if (!quote) {
      return { closePrice: null, dividend: 0, exDividendDate: null, exchange: "NYSE" };
    }

    return {
      closePrice: readNumber(quote.price),
      dividend: readNumber(quote.dividendAmount) ?? 0,
      exDividendDate: readIsoDate(quote.exDividendDate),
      exchange: normalizeUsExchangeName(quote.exchangeName, quote.exchangeCode),
    };
  } catch {
    return { closePrice: null, dividend: 0, exDividendDate: null, exchange: "NYSE" };
  }
}

async function scanPutCondition(symbol: string, exchange: string): Promise<PutScanResult> {
  try {
    const symbolUs = toTmxUsSymbol(symbol);
    const [optionsData, quoteMetrics] = await Promise.all([
      fetchQuoteMediaDataToolJson<QuoteMediaOptionsResponse>("getOptionQuotes.json", {
        symbol: symbolUs,
        greeks: true,
        strike: 106.58,
        strikeLimit: 10,
        money: "All",
        adjOptions: true,
        inclExpired: false,
        groupDate: true,
        callput: "group",
        optionSize: "all",
      }),
      fetchTmxQuoteMetrics(symbolUs),
    ]);

    const closePrice = quoteMetrics.closePrice;
    if (closePrice === null) {
      return { symbol, qualifiedRow: null, evaluated: false };
    }

    const dividend = quoteMetrics.dividend;
    if (dividend <= 0) {
      return { symbol, qualifiedRow: null, evaluated: true };
    }
    if (!quoteMetrics.exDividendDate || !isOnOrAfterToday(quoteMetrics.exDividendDate)) {
      return { symbol, qualifiedRow: null, evaluated: true };
    }

    const puts = extractPutContracts(optionsData);
    let bestMatch: {
      strike: number;
      ask: number;
      askSize: number;
      lastPrice: number;
      expirationDate: string | null;
      edge: number;
    } | null = null;

    for (const putCandidate of puts) {
      const strike = readNumber(putCandidate.quote.contract?.strike);
      const ask = readNumber(putCandidate.quote.pricedata?.ask);
      const askSize = readNumber(putCandidate.quote.pricedata?.asksize) ?? 0;
      const lastPrice = readNumber(putCandidate.quote.pricedata?.last) ?? 0;
      if (strike === null || ask === null) {
        continue;
      }
      if (!isStrictlyAfterDate(putCandidate.expirationDate, quoteMetrics.exDividendDate)) {
        continue;
      }

      const leftSide = strike + dividend;
      const rightSide = closePrice + ask;
      if (leftSide <= rightSide) {
        continue;
      }

      const edge = leftSide - rightSide;
      if (!bestMatch || edge > bestMatch.edge) {
        bestMatch = {
          strike,
          ask,
          askSize,
          lastPrice,
          expirationDate: putCandidate.expirationDate,
          edge,
        };
      }
    }

    if (!bestMatch) {
      return { symbol, qualifiedRow: null, evaluated: true };
    }

    return {
      symbol,
      evaluated: true,
      qualifiedRow: {
        ticker: symbol,
        exchange: quoteMetrics.exchange || exchange,
        closePrice,
        dividend,
        exDividendDate: quoteMetrics.exDividendDate,
        putExpirationDate: bestMatch.expirationDate,
        putStrikePrice: bestMatch.strike,
        putAskPrice: bestMatch.ask,
        // Carry the selected contract's ask size for table display.
        putAskSize: bestMatch.askSize,
        putLastPrice: bestMatch.lastPrice,
      },
    };
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
      failedTickers: [],
    });
  }

  const exchangeMap = await fetchNyseOptionableSymbols(forceRefresh);
  const symbolsWithExchange = Array.from(exchangeMap.entries())
    .map(([symbol, listedExchange]) => ({
      symbol,
      exchange: listedExchange,
    }))
    // Sort before slicing so scan-size limits include a representative US mix.
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
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

  // Keep a separate bucket for symbols we could not evaluate (network/data gaps),
  // so scanned = qualified + rejected + failed always reconciles.
  const failedTickers = scanResults
    .filter((result) => !result.evaluated)
    .map((result) => result.symbol)
    .sort((left, right) => left.localeCompare(right));

  return NextResponse.json<OptionsArbitrageResponse>({
    asOf: new Date().toISOString(),
    market,
    scannedSymbols: symbolsWithExchange.length,
    scannedTickers,
    rows,
    rejectedTickers,
    failedTickers,
  });
}
