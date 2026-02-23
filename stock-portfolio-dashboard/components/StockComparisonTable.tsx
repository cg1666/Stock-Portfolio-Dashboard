"use client";

import { useEffect, useMemo, useState } from "react";
import type { StockRow } from "@/lib/types";

type StockComparisonTableProps = {
  tickers: string[];
  rows: StockRow[];
  isLoading: boolean;
  error: string | null;
  onRemoveTicker: (ticker: string) => void;
  lastUpdated: string | null;
};

type SortKey = "peRatio" | "pbRatio" | "dividendOrDistributionYield" | "rsi14";
type SortDirection = "asc" | "desc";
const SORT_STORAGE_KEY = "stock-dashboard-table-sort-v1";
type SortState = {
  key: SortKey | null;
  direction: SortDirection;
};

function readInitialSortState(): SortState {
  if (typeof window === "undefined") {
    return { key: null, direction: "asc" };
  }

  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (!raw) {
      return { key: null, direction: "asc" };
    }

    const parsed = JSON.parse(raw) as {
      sortKey?: SortKey | null;
      sortDirection?: SortDirection;
    };
    const key: SortKey | null =
      parsed.sortKey === "peRatio" ||
      parsed.sortKey === "pbRatio" ||
      parsed.sortKey === "dividendOrDistributionYield" ||
      parsed.sortKey === "rsi14"
        ? parsed.sortKey
        : null;
    const direction: SortDirection =
      parsed.sortDirection === "asc" || parsed.sortDirection === "desc"
        ? parsed.sortDirection
        : "asc";

    return {
      key,
      direction,
    };
  } catch {
    return { key: null, direction: "asc" };
  }
}

function formatNumber(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatVolume(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return value.toLocaleString();
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return "—";
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not updated yet";
  }
  return new Date(value).toLocaleTimeString();
}

function rsiClassName(rsi: number | null): string {
  if (rsi === null) {
    return "cell-neutral";
  }
  if (rsi > 70) {
    return "cell-rsi-high";
  }
  if (rsi < 30) {
    return "cell-rsi-low";
  }
  return "cell-neutral";
}

function closeVsBollingerBandClassName(
  close: number | null,
  bbUpper: number | null,
  bbLower: number | null,
): string {
  if (close === null || bbUpper === null || bbLower === null) {
    return "cell-neutral";
  }
  if (close > bbUpper) {
    return "cell-breakout-high";
  }
  if (close < bbLower) {
    return "cell-breakout-low";
  }
  return "cell-neutral";
}

export function StockComparisonTable({
  tickers,
  rows,
  isLoading,
  error,
  onRemoveTicker,
  lastUpdated,
}: StockComparisonTableProps) {
  const [sortState, setSortState] = useState<SortState>(readInitialSortState);
  const sortKey = sortState.key;
  const sortDirection = sortState.direction;
  const rowMap = useMemo(() => new Map(rows.map((row) => [row.ticker, row])), [rows]);

  useEffect(() => {
    window.localStorage.setItem(
      SORT_STORAGE_KEY,
      JSON.stringify({
        sortKey,
        sortDirection,
      }),
    );
  }, [sortDirection, sortKey]);

  const displayedTickers = useMemo(() => {
    if (!sortKey) {
      return tickers;
    }

    const sorted = [...tickers];
    sorted.sort((leftTicker, rightTicker) => {
      const left = rowMap.get(leftTicker)?.[sortKey];
      const right = rowMap.get(rightTicker)?.[sortKey];

      // Keep missing values at the end so actionable data stays visible first.
      if (left === null || left === undefined) {
        return 1;
      }
      if (right === null || right === undefined) {
        return -1;
      }

      if (left === right) {
        return 0;
      }

      const delta = left - right;
      return sortDirection === "asc" ? delta : -delta;
    });

    return sorted;
  }, [sortDirection, sortKey, tickers, rowMap]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortState((prev) => ({
        ...prev,
        direction: prev.direction === "asc" ? "desc" : "asc",
      }));
      return;
    }
    setSortState({ key, direction: "asc" });
  };

  const sortLabel = (key: SortKey): string => {
    if (sortKey !== key) {
      return "";
    }
    return sortDirection === "asc" ? " ↑" : " ↓";
  };

  const resetSort = () => {
    setSortState({ key: null, direction: "asc" });
  };

  return (
    <section className="panel table-panel">
      <div className="section-header">
        <h2>Comparison Grid</h2>
        <div className="table-meta">
          <p className="muted-text">Last updated: {formatTimestamp(lastUpdated)}</p>
          {sortKey ? (
            <button type="button" className="secondary-button small-button" onClick={resetSort}>
              Reset Sort
            </button>
          ) : null}
        </div>
      </div>

      {error ? <p className="error-text">{error}</p> : null}
      {isLoading && tickers.length > 0 ? <p className="muted-text">Refreshing data...</p> : null}

      {tickers.length === 0 ? (
        <p className="muted-text">Add tickers to start comparing stocks.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Open</th>
                <th>Low</th>
                <th>High</th>
                <th>Close</th>
                <th>Volume</th>
                <th>
                  <button type="button" className="sort-button" onClick={() => toggleSort("peRatio")}>
                    P/E{sortLabel("peRatio")}
                  </button>
                </th>
                <th>
                  <button type="button" className="sort-button" onClick={() => toggleSort("pbRatio")}>
                    P/B{sortLabel("pbRatio")}
                  </button>
                </th>
                <th>
                  <button
                    type="button"
                    className="sort-button"
                    onClick={() => toggleSort("dividendOrDistributionYield")}
                  >
                    Div/Dist Yield{sortLabel("dividendOrDistributionYield")}
                  </button>
                </th>
                <th>
                  <button type="button" className="sort-button" onClick={() => toggleSort("rsi14")}>
                    RSI (14){sortLabel("rsi14")}
                  </button>
                </th>
                <th>MA (5)</th>
                <th>MA (20)</th>
                <th>MA (50)</th>
                <th>MACD</th>
                <th>MACD Signal</th>
                <th>MACD Hist</th>
                <th>BB Upper</th>
                <th>BB Middle</th>
                <th>BB Lower</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {displayedTickers.map((ticker) => {
                const row = rowMap.get(ticker);
                const hasError = row?.error;

                return (
                  <tr key={ticker}>
                    <td className="ticker-cell">{ticker}</td>
                    <td>{formatNumber(row?.open ?? null)}</td>
                    <td>{formatNumber(row?.low ?? null)}</td>
                    <td>{formatNumber(row?.high ?? null)}</td>
                    <td
                      className={closeVsBollingerBandClassName(
                        row?.close ?? null,
                        row?.bbUpper ?? null,
                        row?.bbLower ?? null,
                      )}
                    >
                      {formatNumber(row?.close ?? null)}
                    </td>
                    <td>{formatVolume(row?.volume ?? null)}</td>
                    <td>{formatNumber(row?.peRatio ?? null)}</td>
                    <td>{formatNumber(row?.pbRatio ?? null)}</td>
                    <td>{formatPercent(row?.dividendOrDistributionYield ?? null)}</td>
                    <td className={rsiClassName(row?.rsi14 ?? null)}>
                      {formatNumber(row?.rsi14 ?? null)}
                    </td>
                    <td>{formatNumber(row?.ma5 ?? null)}</td>
                    <td>{formatNumber(row?.ma20 ?? null)}</td>
                    <td>{formatNumber(row?.ma50 ?? null)}</td>
                    <td>{formatNumber(row?.macd ?? null)}</td>
                    <td>{formatNumber(row?.macdSignal ?? null)}</td>
                    <td>{formatNumber(row?.macdHistogram ?? null)}</td>
                    <td>{formatNumber(row?.bbUpper ?? null)}</td>
                    <td>{formatNumber(row?.bbMiddle ?? null)}</td>
                    <td>{formatNumber(row?.bbLower ?? null)}</td>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => onRemoveTicker(ticker)}
                      >
                        Remove
                      </button>
                      {hasError ? <p className="error-inline">{hasError}</p> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
