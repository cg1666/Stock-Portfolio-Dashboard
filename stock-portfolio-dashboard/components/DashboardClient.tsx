"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PortfolioControls } from "@/components/PortfolioControls";
import { StockComparisonTable } from "@/components/StockComparisonTable";
import { TickerInput } from "@/components/TickerInput";
import { usePortfolioStore } from "@/lib/portfolioStore";
import type {
  OptionsArbitrageResponse,
  OptionsArbitrageRow,
  QuotesResponse,
  StockRow,
} from "@/lib/types";

const EMPTY_TICKERS: string[] = [];

async function fetchQuotes(tickers: string[]): Promise<QuotesResponse> {
  const query = encodeURIComponent(tickers.join(","));
  const response = await fetch(`/api/quotes?symbols=${query}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to load quote data.");
  }
  return (await response.json()) as QuotesResponse;
}

function formatMoney(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSize(value: number): string {
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatShortDate(value: string | null): string {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleDateString();
}

export function DashboardClient() {
  const [isMounted, setIsMounted] = useState(false);
  // Keep tab state explicit so each asset class can render its own panel.
  const [activeTab, setActiveTab] = useState<"stocksEtfs" | "options">("stocksEtfs");
  // Track each options-market dropdown independently for future filtering logic.
  const [usOptionsSelection, setUsOptionsSelection] = useState("all");
  const [canadaOptionsSelection, setCanadaOptionsSelection] = useState("all");
  const {
    state,
    activePortfolio,
    createPortfolio,
    deletePortfolio,
    setActivePortfolio,
    renamePortfolio,
    addTicker,
    removeTicker,
    moveTicker,
  } = usePortfolioStore();

  const [rows, setRows] = useState<StockRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [optionsRows, setOptionsRows] = useState<OptionsArbitrageRow[]>([]);
  const [optionsDateSort, setOptionsDateSort] = useState<"asc" | "desc">("desc");
  const [optionsTickerSort, setOptionsTickerSort] = useState<"asc" | "desc">("asc");
  const [optionsSortField, setOptionsSortField] = useState<"ticker" | "exDividendDate">(
    "exDividendDate",
  );
  const [optionsIsLoading, setOptionsIsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [hasAutoScannedOptions, setHasAutoScannedOptions] = useState(false);
  const [optionsScannedSymbols, setOptionsScannedSymbols] = useState(0);
  const [optionsScannedTickers, setOptionsScannedTickers] = useState<string[]>([]);
  const [optionsAsOf, setOptionsAsOf] = useState<string | null>(null);
  const [optionsRejectedTickers, setOptionsRejectedTickers] = useState<string[]>([]);
  const [optionsFailedTickers, setOptionsFailedTickers] = useState<string[]>([]);
  const [optionsScanLimit, setOptionsScanLimit] = useState(10000);
  const activePortfolioId = activePortfolio?.id ?? "";
  const activeTickers = activePortfolio?.tickers ?? EMPTY_TICKERS;

  useEffect(() => {
    // Render portfolio UI only after mount to avoid server/client HTML mismatches.
    setIsMounted(true);
  }, []);

  const tickerKey = useMemo(() => activeTickers.join(","), [activeTickers]);

  useEffect(() => {
    if (!activePortfolioId) {
      return;
    }

    const tickers = tickerKey ? tickerKey.split(",") : [];
    if (tickers.length === 0) {
      setRows([]);
      setError(null);
      setLastUpdated(null);
      return;
    }

    let isCancelled = false;
    let isFetching = false;

    const load = async () => {
      // Skip this cycle if the previous refresh is still in-flight.
      if (isFetching) {
        return;
      }

      try {
        isFetching = true;
        setIsLoading(true);
        const data = await fetchQuotes(tickers);
        if (isCancelled) {
          return;
        }
        setRows(data.rows);
        setError(null);
        setLastUpdated(data.asOf);
      } catch (fetchError) {
        if (isCancelled) {
          return;
        }
        const message =
          fetchError instanceof Error ? fetchError.message : "Unknown error while loading quotes.";
        setError(message);
      } finally {
        isFetching = false;
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    load();
    // Keep quote polling moderate so options scans do not trigger Yahoo throttling.
    const intervalId = window.setInterval(load, 15_000);

    return () => {
      isCancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activePortfolioId, tickerKey]);

  const scanUsOptionsArbitrage = useCallback(async () => {
    try {
      setOptionsIsLoading(true);
      setOptionsError(null);
      const response = await fetch(`/api/options/arbitrage?market=us&maxScan=${optionsScanLimit}`, {
        cache: "no-store",
      });
      const data = (await response.json()) as OptionsArbitrageResponse | { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Failed to scan US options.");
      }

      setOptionsRows(Array.isArray(data.rows) ? data.rows : []);
      setOptionsScannedTickers(Array.isArray(data.scannedTickers) ? data.scannedTickers : []);
      setOptionsRejectedTickers(
        Array.isArray(data.rejectedTickers) ? data.rejectedTickers : [],
      );
      setOptionsFailedTickers(Array.isArray(data.failedTickers) ? data.failedTickers : []);
      setOptionsScannedSymbols(typeof data.scannedSymbols === "number" ? data.scannedSymbols : 0);
      setOptionsAsOf(typeof data.asOf === "string" ? data.asOf : null);
    } catch (scanError) {
      const message = scanError instanceof Error ? scanError.message : "Unable to scan US options.";
      setOptionsError(message);
      setOptionsScannedTickers([]);
      setOptionsRejectedTickers([]);
      setOptionsFailedTickers([]);
    } finally {
      setOptionsIsLoading(false);
    }
  }, [optionsScanLimit]);

  useEffect(() => {
    // Auto-scan only once; repeated retries can overwhelm Yahoo and break quote loading.
    if (activeTab !== "options" || hasAutoScannedOptions || optionsIsLoading) {
      return;
    }
    setHasAutoScannedOptions(true);
    void scanUsOptionsArbitrage();
  }, [activeTab, hasAutoScannedOptions, optionsIsLoading, scanUsOptionsArbitrage]);

  const sortedOptionsRows = useMemo(() => {
    const rows = [...optionsRows];
    rows.sort((left, right) => {
      const tickerCompare = left.ticker.localeCompare(right.ticker);
      const leftDate = left.exDividendDate ? new Date(left.exDividendDate).getTime() : Number.NEGATIVE_INFINITY;
      const rightDate = right.exDividendDate
        ? new Date(right.exDividendDate).getTime()
        : Number.NEGATIVE_INFINITY;
      const dateCompare = leftDate === rightDate ? 0 : optionsDateSort === "asc" ? leftDate - rightDate : rightDate - leftDate;

      if (optionsSortField === "exDividendDate") {
        // When date sort is active, date drives the table order and ticker only breaks ties.
        if (dateCompare !== 0) {
          return dateCompare;
        }
        return optionsTickerSort === "asc" ? tickerCompare : -tickerCompare;
      }

      // When ticker sort is active, ticker drives the table order and date only breaks ties.
      if (tickerCompare !== 0) {
        return optionsTickerSort === "asc" ? tickerCompare : -tickerCompare;
      }
      return dateCompare;
    });
    return rows;
  }, [optionsRows, optionsDateSort, optionsSortField, optionsTickerSort]);

  if (!isMounted || !activePortfolio) {
    return (
      <main className="dashboard-shell">
        <div className="panel">
          <p className="muted-text">Loading your portfolio...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="hero">
        <h1>Stock Portfolio Comparison</h1>
        <p>
          Track multiple portfolios and compare indicators side by side with an auto-refreshing
          grid.
        </p>
      </header>

      <section className="panel">
        <div className="ticker-tabs" role="tablist" aria-label="Market segment tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "stocksEtfs"}
            aria-controls="tab-panel-dashboard-stocks-etfs"
            id="tab-dashboard-stocks-etfs"
            className={activeTab === "stocksEtfs" ? "ticker-tab active" : "ticker-tab"}
            onClick={() => setActiveTab("stocksEtfs")}
          >
            Stocks and ETFs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "options"}
            aria-controls="tab-panel-dashboard-options"
            id="tab-dashboard-options"
            className={activeTab === "options" ? "ticker-tab active" : "ticker-tab"}
            onClick={() => setActiveTab("options")}
          >
            Options
          </button>
        </div>

        {activeTab === "stocksEtfs" ? (
          <div
            id="tab-panel-dashboard-stocks-etfs"
            role="tabpanel"
            aria-labelledby="tab-dashboard-stocks-etfs"
            className="ticker-tab-panel"
          >
            <PortfolioControls
              portfolios={state.portfolios}
              activePortfolioId={activePortfolio.id}
              activePortfolioName={activePortfolio.name}
              onSelectPortfolio={setActivePortfolio}
              onCreatePortfolio={createPortfolio}
              onRenameActivePortfolio={(name) => {
                renamePortfolio(activePortfolio.id, name);
              }}
              onDeleteActivePortfolio={() => {
                if (
                  window.confirm(
                    `Delete "${activePortfolio.name}"? This will remove the portfolio and its tickers.`,
                  )
                ) {
                  deletePortfolio(activePortfolio.id);
                }
              }}
              canDelete={state.portfolios.length > 1}
            />

            <TickerInput onAddTicker={addTicker} />

            <StockComparisonTable
              tickers={activePortfolio.tickers}
              rows={rows}
              isLoading={isLoading}
              error={error}
              onRemoveTicker={removeTicker}
              onMoveTicker={moveTicker}
              lastUpdated={lastUpdated}
            />
          </div>
        ) : null}
        {activeTab === "options" ? (
          <div
            id="tab-panel-dashboard-options"
            role="tabpanel"
            aria-labelledby="tab-dashboard-options"
            className="ticker-tab-panel"
          >
            <div className="options-dropdowns">
              <div className="options-dropdown-row">
                <label htmlFor="us-options-select">US Options</label>
                <select
                  id="us-options-select"
                  value={usOptionsSelection}
                  onChange={(event) => setUsOptionsSelection(event.target.value)}
                >
                  <option value="all">All US Options</option>
                  <option value="calls">Calls</option>
                  <option value="puts">Puts</option>
                </select>
              </div>
              <div className="options-dropdown-row">
                <label htmlFor="canada-options-select">Canada Options</label>
                <select
                  id="canada-options-select"
                  value={canadaOptionsSelection}
                  onChange={(event) => setCanadaOptionsSelection(event.target.value)}
                >
                  <option value="all">All Canada Options</option>
                  <option value="calls">Calls</option>
                  <option value="puts">Puts</option>
                </select>
              </div>
              <div className="options-dropdown-row">
                <label htmlFor="options-scan-size-select">Scan Size</label>
                <select
                  id="options-scan-size-select"
                  value={String(optionsScanLimit)}
                  onChange={(event) => {
                    // Restrict scan sizes to supported server-side limits only.
                    const requestedSize = Number(event.target.value);
                    if ([10000].includes(requestedSize)) {
                      setOptionsScanLimit(requestedSize);
                    }
                  }}
                >
                  <option value="10000">10000</option>
                </select>
              </div>
            </div>
            <div className="options-actions">
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  // Let users manually refresh opportunities without leaving the tab.
                  void scanUsOptionsArbitrage();
                }}
                disabled={optionsIsLoading}
              >
                {optionsIsLoading ? "Scanning US Options..." : "Scan US Options"}
              </button>
              <p className="muted-text options-condition-text">
                US universe (NYSE + NASDAQ) condition: Put Strike + Dividend &gt; Stock Close + Put
                Ask, and
                Expiration &gt; Ex Dividend Date
              </p>
              <p className="muted-text">
                Scanned symbols: {optionsScannedSymbols}
                {` | Qualified: ${optionsRows.length} | Rejected: ${optionsRejectedTickers.length} | Not evaluated: ${optionsFailedTickers.length}`}
                {optionsAsOf ? ` | Last scan: ${new Date(optionsAsOf).toLocaleTimeString()}` : ""}
              </p>
            </div>
            {optionsError ? <p className="error-text">{optionsError}</p> : null}
            <section className="panel table-panel options-results-panel">
              <div className="section-header">
                <h2>Qualified US Put Opportunities</h2>
              </div>
              {optionsRows.length === 0 && !optionsIsLoading && !optionsError ? (
                <p className="muted-text">No symbols currently meet the condition.</p>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <button
                            type="button"
                            className="sort-button"
                            onClick={() => {
                              // Make ticker the primary sort field, then toggle A-Z / Z-A.
                              setOptionsSortField("ticker");
                              setOptionsTickerSort((prev) => (prev === "asc" ? "desc" : "asc"));
                            }}
                          >
                            Ticker
                            {optionsSortField === "ticker"
                              ? optionsTickerSort === "asc"
                                ? " ↑"
                                : " ↓"
                              : ""}
                          </button>
                        </th>
                        <th>Exchange</th>
                        <th>Close Price</th>
                        <th>Put Ask</th>
                        <th>Buy Total</th>
                        <th>Ask Size</th>
                        <th>
                          <button
                            type="button"
                            className="sort-button"
                            onClick={() => {
                              // Make ex-dividend date the primary sort field, then toggle direction.
                              setOptionsSortField("exDividendDate");
                              setOptionsDateSort((prev) => (prev === "asc" ? "desc" : "asc"));
                            }}
                          >
                            Ex Dividend Date
                            {optionsSortField === "exDividendDate"
                              ? optionsDateSort === "asc"
                                ? " ↑"
                                : " ↓"
                              : ""}
                          </button>
                        </th>
                        <th>Expiration</th>
                        <th>Put Strike Price</th>
                        <th>Dividend</th>
                        <th>Sell Total</th>
                        <th className="profit-cell">Profit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedOptionsRows.map((row) => (
                        <tr key={`${row.ticker}-${row.putStrikePrice}-${row.putAskPrice}`}>
                          <td className="ticker-cell">{row.ticker}</td>
                          <td>{row.exchange}</td>
                          <td>{formatMoney(row.closePrice)}</td>
                          <td>{formatMoney(row.putAskPrice)}</td>
                          <td>{formatMoney(row.closePrice + row.putAskPrice)}</td>
                          <td>{formatSize(row.putAskSize)}</td>
                          <td>{formatShortDate(row.exDividendDate)}</td>
                          <td>{formatShortDate(row.putExpirationDate)}</td>
                          <td>{formatMoney(row.putStrikePrice)}</td>
                          <td>{formatMoney(row.dividend)}</td>
                          <td>{formatMoney(row.putStrikePrice + row.dividend)}</td>
                          <td className="profit-cell">
                            {formatMoney(
                              row.putStrikePrice + row.dividend - (row.closePrice + row.putAskPrice),
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <section className="panel table-panel options-results-panel">
              <div className="section-header">
                <h2>Scanned Tickers Not Meeting Condition</h2>
              </div>
              {optionsRejectedTickers.length === 0 ? (
                <p className="muted-text">
                  No evaluated tickers currently fail the condition.
                </p>
              ) : (
                <>
                  <p className="muted-text">Count: {optionsRejectedTickers.length}</p>
                  <div className="options-rejected-list">
                    {optionsRejectedTickers.join(", ")}
                  </div>
                </>
              )}
            </section>
            <section className="panel table-panel options-results-panel">
              <div className="section-header">
                <h2>Scanned Tickers Not Evaluated (Data/API Issues)</h2>
              </div>
              {optionsFailedTickers.length === 0 ? (
                <p className="muted-text">All scanned tickers were evaluated successfully.</p>
              ) : (
                <>
                  <p className="muted-text">Count: {optionsFailedTickers.length}</p>
                  <div className="options-rejected-list">{optionsFailedTickers.join(", ")}</div>
                </>
              )}
            </section>
            <section className="panel table-panel options-results-panel">
              <div className="section-header">
                <h2>All Scanned Tickers</h2>
              </div>
              {optionsScannedTickers.length === 0 ? (
                <p className="muted-text">No tickers scanned yet.</p>
              ) : (
                <>
                  <p className="muted-text">Count: {optionsScannedTickers.length}</p>
                  <div className="options-rejected-list">{optionsScannedTickers.join(", ")}</div>
                </>
              )}
            </section>
          </div>
        ) : null}
      </section>
    </main>
  );
}
