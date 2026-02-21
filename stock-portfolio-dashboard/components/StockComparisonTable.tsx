"use client";

import type { StockRow } from "@/lib/types";

type StockComparisonTableProps = {
  tickers: string[];
  rows: StockRow[];
  isLoading: boolean;
  error: string | null;
  onRemoveTicker: (ticker: string) => void;
  lastUpdated: string | null;
};

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

export function StockComparisonTable({
  tickers,
  rows,
  isLoading,
  error,
  onRemoveTicker,
  lastUpdated,
}: StockComparisonTableProps) {
  const rowMap = new Map(rows.map((row) => [row.ticker, row]));

  return (
    <section className="panel table-panel">
      <div className="section-header">
        <h2>Comparison Grid</h2>
        <p className="muted-text">Last updated: {formatTimestamp(lastUpdated)}</p>
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
                <th>RSI (14)</th>
                <th>MA (5)</th>
                <th>MA (20)</th>
                <th>MA (50)</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {tickers.map((ticker) => {
                const row = rowMap.get(ticker);
                const hasError = row?.error;

                return (
                  <tr key={ticker}>
                    <td className="ticker-cell">{ticker}</td>
                    <td>{formatNumber(row?.open ?? null)}</td>
                    <td>{formatNumber(row?.low ?? null)}</td>
                    <td>{formatNumber(row?.high ?? null)}</td>
                    <td>{formatNumber(row?.close ?? null)}</td>
                    <td>{formatVolume(row?.volume ?? null)}</td>
                    <td className={rsiClassName(row?.rsi14 ?? null)}>
                      {formatNumber(row?.rsi14 ?? null)}
                    </td>
                    <td>{formatNumber(row?.ma5 ?? null)}</td>
                    <td>{formatNumber(row?.ma20 ?? null)}</td>
                    <td>{formatNumber(row?.ma50 ?? null)}</td>
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
